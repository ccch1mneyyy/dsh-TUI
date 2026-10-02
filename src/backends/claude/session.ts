/**
 * One Claude Agent session (docs/agent-backend-design.md §4.4, §4.7, §4.13):
 * a single long-lived streaming-input `query()` per session, fed by a
 * push-based inbox, consumed by one loop that translates every SDK message
 * and hands the batch to the channel.
 *
 * - Input placement (Phase 0 correction): `steer` → `priority:'next'` (joins
 *   the running turn after its tool round), `followup` → `priority:'later'`
 *   while a turn runs (a plain push when idle), `now` → `priority:'now'`;
 *   `uuid` = the channel's `clientMessageId`, so lifecycle frames and echoes
 *   name the input the channel tracks.
 * - Cancellation: `interrupt()`; a `user` cancel keeps queued inputs (they run
 *   next), an `interrupt` cancel drops them when the CLI can
 *   (`interrupt_cancel_queued_v1`) because the channel re-delivers them. Until
 *   a `result`/`idle` confirms, a 30 s timer stands by to force-close the turn
 *   (`turn.end{aborted}` + notice): an interrupted turn may never report.
 * - Permissions (Phase 3): the permission bridge (`permissions.ts`) parks
 *   every `canUseTool` prompt and announces it as `permission.request` /
 *   `question.request`; the user's answer returns through the
 *   `permissions` / `questions` capabilities. While prompts are parked the
 *   session is `requires-action`. Pending prompts are always settled: on
 *   answer, on the SDK's abort signal, at a forced turn close, on dispose.
 * - Disposal: deny pending callbacks → close the inbox (stdin EOF, the CLI
 *   exits on its own) → `close()` the query → abort the controller; then wait
 *   (bounded) for the consumer loop. Idempotent.
 * - Process death or a consumer error marks the session `disposed`, closes
 *   any open turn and says so in a notice.
 */
import type { AccountInfo, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { AccountView, RewindOutcome, RewindPreview, SessionAuthView } from '../../agent/capabilities.js'
import type { AgentEvent, AgentEventMeta } from '../../agent/events.js'
import type { AgentSessionRef } from '../../agent/refs.js'
import type { AgentInput, AgentSession, AgentSessionStatus, CancelCause, SubmitPlacement } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { CLAUDE_BACKEND_ID, CLI_CAPABILITY, cliVersionDrift, VALIDATED_CLI_VERSIONS, VALIDATED_SDK_VERSION } from './contract.js'
import { CLAUDE_OAUTH_PROVIDER, detectClaudeAuth, isAuthFailure, type ClaudeAuthPlan } from './auth.js'
import { accountView, createClaudeControls } from './controls.js'
import { buildQueryOptions, type StartPermissionMode } from './options.js'
import { createClaudePermissionBridge, WITHDRAWN_MESSAGE } from './permissions.js'
import { createStderrSink, type ClaudeExecutable } from './process.js'
import { memoryClaudePrefs, type ClaudePrefs } from './prefs.js'
import { createClaudeTranscriptHistory } from './older-history.js'
import { rewindCutPoint, type ClaudeReplay } from './replay.js'
import type { ClaudeSdkModule, ClaudeSessionStoreSdk } from './sdk.js'
import { readTaskOutputTail, taskOutputRoots } from './task-output.js'
import { claudeConfigDir } from './transcript-file.js'
import { createClaudeTranslator } from './translate.js'

declare module '../../agent/capabilities.js' {
  interface ClaudeNative {
    /** The SDK session id (also `ref.sessionId`). */
    readonly sessionId: string
    /** `system/init.claude_code_version`, once known. */
    readonly cliVersion: string | undefined
    /** `system/init.capabilities` (open set; feature-detect, never sniff). */
    readonly cliCapabilities: readonly string[]
  }
}

/** Timer seam (tests inject a manual clock). */
export interface ClaudeClock {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_CLOCK: ClaudeClock = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref()
    return handle
  },
  clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

export interface ClaudeSessionDeps {
  readonly sdk: Pick<ClaudeSdkModule, 'query'>
  /** The session-store API behind `/fork` and the conversation rewind
   *  (absent = neither capability). */
  readonly store?: Pick<ClaudeSessionStoreSdk, 'getSessionMessages' | 'forkSession'>
  readonly cwd: string
  readonly sessionId: string
  /**
   * Resume this persisted session instead of creating one (design §4.11):
   * its replayed transcript is the session's `history()`, the first run
   * passes `resume` (never `sessionId`), and live numbering continues where
   * the replay ended.
   */
  readonly resume?: ClaudeReplay
  readonly start: StartPermissionMode
  readonly executable: ClaudeExecutable
  /** The child environment when no credential plan is given (tests). */
  readonly env: Record<string, string>
  /** The credential the session spawns with and how to renew it after an
   *  authentication failure (design §4.12; auth.ts). */
  readonly auth?: {
    readonly plan: ClaudeAuthPlan
    /** A fresh plan; `rejected` is the token the CLI just refused (renew it
     *  only if the store still holds that one), absent for `/login`. */
    renew(renewal: { readonly rejected?: string }): Promise<ClaudeAuthPlan>
    /** The user-facing sentence for a failed renewal (no error details). */
    failureNotice?(error: unknown): string
  }
  /** The user's persisted `/model` and `/effort` choices (memory if absent). */
  readonly prefs?: ClaudePrefs
  /** A start model / effort when nothing is persisted (none = the CLI's). */
  readonly model?: string
  readonly effort?: string
  readonly host: {
    debug(message: string): void
    /** One child stderr line (deduplicated into notices by the host). */
    stderr?(line: string): void
  }
  /** The installed SDK version (diagnostics). */
  readonly sdkVersion?: string
  /** Notices to show once the channel subscribes (start-time findings). */
  readonly startNotices?: readonly string[]
  readonly clock?: ClaudeClock
  /** How long a cancel may go unconfirmed before the turn is force-closed. */
  readonly forceSettleMs?: number
  /** Bound on `initializationResult()` (a CLI that never answers). */
  readonly initTimeoutMs?: number
  /** Bound on waiting for the consumer loop after `close()`. */
  readonly closeTimeoutMs?: number
  /** Bound on a `/login` reconnect waiting for the running turn (120 s). */
  readonly reconnectDeferMs?: number
}

type Listener = (batch: readonly AgentEvent[], meta: AgentEventMeta) => void
type Rec = Readonly<Record<string, unknown>>
const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The CLI's answer to `resume` of a session it has no transcript for. */
const NO_CONVERSATION = /No conversation found with session ID/iu

/** A minimal push-based async iterable: the session's stdin. */
function createInbox<T>() {
  const queue: T[] = []
  const waiters: ((result: IteratorResult<T>) => void)[] = []
  let closed = false
  return {
    push(value: T): void {
      if (closed) throw new Error('dsh-tui: Claude session input is closed')
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter({ value, done: false })
      else queue.push(value)
    },
    close(): void {
      if (closed) return
      closed = true
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
    },
    get closed(): boolean { return closed },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: (): Promise<IteratorResult<T>> => {
          const value = queue.shift()
          if (value !== undefined) return Promise.resolve({ value, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise(resolve => { waiters.push(resolve) })
        },
        return: (): Promise<IteratorResult<T>> => {
          closed = true
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}

/** Renderer urgency of one translated message (design §3.3 `wake`). */
function wakeOf(message: unknown, events: readonly AgentEvent[]): AgentEventMeta['wake'] {
  const value = rec(message)
  if (value?.type === 'stream_event' && rec(value.event)?.type === 'content_block_delta') return 'frame'
  if (value?.type === 'system' && value.subtype === 'thinking_tokens') return 'frame'
  return events.every(event => event.type === 'session.status' || event.type === 'pending.changed') ? 'none' : 'sync'
}

/** `SDKUserMessage.priority` for a channel placement. */
function priorityOf(placement: SubmitPlacement, turnOpen: boolean): SDKUserMessage['priority'] {
  switch (placement) {
    case 'steer':
      return 'next'
    case 'now':
      return 'now'
    case 'followup':
      return turnOpen ? 'later' : undefined
    default:
      return undefined
  }
}

/** Open one session: start the query, wait for its handshake, start the
 *  consumer loop. Throws (after cleaning up) when the CLI cannot start. */
export async function openClaudeSession(deps: ClaudeSessionDeps): Promise<AgentSession> {
  const clock = deps.clock ?? REAL_CLOCK
  const forceSettleMs = deps.forceSettleMs ?? 30_000
  const prefs = deps.prefs ?? memoryClaudePrefs()
  const listeners = new Set<Listener>()
  /** Batches produced before the channel subscribed (handshake, start notices). */
  const backlog: [readonly AgentEvent[], AgentEventMeta][] = []
  let status: AgentSessionStatus = 'starting'
  let disposing = false
  let disposePromise: Promise<void> | undefined
  let cliVersion: string | undefined
  let cliCapabilities: readonly string[] = []
  /** `system/init.apiKeySource`: the CLI's own account of its credential. */
  let apiKeySource: string | undefined
  /** `accountInfo()` once fetched (never surfaces the email). */
  let account: AccountInfo | undefined
  let forceTimer: unknown
  /** The credential plan the live query runs on. */
  let authPlan: ClaudeAuthPlan = deps.auth?.plan ?? { source: 'claude-login', env: deps.env }
  /** Automatic reconnects after an authentication failure since the last
   *  successful turn (design §4.12: one, then the user is sent to /login). */
  let authAttempts = 0
  let authFailed = false
  /**
   * The CLI wrote this session's transcript (an input started, or a turn
   * reported its result). Until then a restart must CREATE the session with
   * the same id: `resume` of an id the CLI has no transcript for fails its
   * handshake ("No conversation found").
   */
  let persisted = deps.resume !== undefined
  /** What this session pushed, by input uuid, until the CLI starts it: a
   *  reconnect re-delivers what the old CLI never started. */
  const pushed = new Map<string, SDKUserMessage>()
  /** Callers waiting for the open turn to close (a deferred `/login`). */
  const idleWaiters: { resolve(): void; reject(error: Error): void }[] = []
  /** No turn open and nothing queued the CLI would start next. */
  const idle = (): boolean => !translator.turnOpen && translator.unstartedInputs().length === 0
  const settleIdleWaiters = (error?: Error): void => {
    if (error === undefined && !idle()) return
    for (const waiter of idleWaiters.splice(0)) {
      if (error === undefined) waiter.resolve()
      else waiter.reject(error)
    }
  }
  const translator = createClaudeTranslator({ cwd: deps.cwd, userRows: 'lifecycle', debug: deps.host.debug, ...(deps.resume === undefined ? {} : { start: deps.resume.start }) })
  translator.noteMode(deps.start.mode)

  const emit = (events: readonly AgentEvent[], wake: AgentEventMeta['wake'] = 'sync'): void => {
    if (events.length === 0) return
    const meta: AgentEventMeta = { replay: false, wake }
    if (listeners.size === 0) { backlog.push([events, meta]); return }
    for (const listener of [...listeners]) {
      try {
        listener(events, meta)
      } catch (error) {
        deps.host.debug(`claude: listener failed (${errorText(error)})`)
      }
    }
  }

  const clearForceTimer = (): void => {
    if (forceTimer === undefined) return
    clock.clearTimeout(forceTimer)
    forceTimer = undefined
  }

  /** Prompts are parked: the session needs the user (design §5.1). Only
   *  transitions are announced; the CLI's own `session_state_changed`
   *  frames say the same and are idempotent with these. */
  let asking = false
  const bridge = createClaudePermissionBridge({
    cwd: deps.cwd,
    emit: events => emit(events),
    debug: deps.host.debug,
    closing: () => disposing,
    onPendingChange: count => {
      const next = count > 0
      if (next === asking) return
      asking = next
      if (disposing) return
      if (next) emit([{ type: 'session.status', status: 'requires-action' }], 'none')
      else if (translator.turnOpen) emit([{ type: 'session.status', status: 'running' }], 'none')
    },
  })

  const stderrSink = createStderrSink(line => {
    deps.host.debug(`[claude-stderr] ${line}`)
    deps.host.stderr?.(line)
  })

  /** One live `query()`: its stdin, its controller and its generation. A
   *  reconnect (credential renewal) replaces the run; the session, its id
   *  and the translator state stay. */
  interface Run {
    readonly generation: number
    readonly inbox: ReturnType<typeof createInbox<SDKUserMessage>>
    readonly abortController: AbortController
    readonly query: ReturnType<ClaudeSessionDeps['sdk']['query']>
    consumer: Promise<void>
  }
  let generation = 0
  const startRun = (resume: boolean): Run => {
    generation += 1
    const inbox = createInbox<SDKUserMessage>()
    const abortController = new AbortController()
    const startModel = prefs.read().model ?? deps.model
    const startEffort = prefs.read().effort ?? deps.effort
    const query = deps.sdk.query({
      prompt: inbox,
      options: buildQueryOptions({
        cwd: deps.cwd,
        // A reconnect resumes the same session (same id, same transcript);
        // the SDK refuses `sessionId` together with `resume`.
        ...(resume ? { resume: deps.sessionId } : { sessionId: deps.sessionId }),
        permissionMode: (translator.mode ?? deps.start.mode) as StartPermissionMode['mode'],
        executable: deps.executable.path,
        env: authPlan.env,
        // The route pin of an injected subscription token (auth.ts).
        ...(authPlan.settings === undefined ? {} : { settings: authPlan.settings }),
        canUseTool: bridge.canUseTool,
        stderr: stderrSink,
        abortController,
        ...(startModel === undefined ? {} : { model: startModel }),
        ...(startEffort === undefined ? {} : { effort: startEffort }),
        // Echoes are the user-row fallback for a CLI without lifecycle
        // frames; requesting them is harmless when lifecycle frames win (the
        // translator ignores an echo of an input it already confirmed).
        replayUserMessages: true,
      }),
    })
    return { generation, inbox, abortController, query, consumer: Promise.resolve() }
  }
  let run = startRun(deps.resume !== undefined)

  /** Shut one run's CLI down; safe to call from any state. */
  const stopRun = (target: Run): void => {
    target.inbox.close()
    try { target.query.close() } catch (error) { deps.host.debug(`claude: close failed (${errorText(error)})`) }
    target.abortController.abort()
  }

  /** Shut the session down; safe to call from any state. */
  const teardown = (): void => {
    clearForceTimer()
    // Rule 4 (design §4.7): pending prompts are denied before the CLI goes.
    bridge.settleAll()
    stopRun(run)
  }

  /** The CLI went away (or the loop failed) without our dispose. */
  const onExit = (error: unknown): void => {
    if (disposing) return
    disposing = true
    status = 'disposed'
    const reason = error === undefined ? t('claude-process-ended') : errorText(error)
    teardown()
    emit([
      ...translator.forceCloseTurn({ kind: 'error', message: reason }),
      { type: 'notice', level: 'error', text: t('claude-process-exited', { reason }) },
      { type: 'session.status', status: 'disposed' },
    ])
    settleIdleWaiters(new Error(t('claude-session-closed')))
  }

  const fetchAccount = (target: Run): void => {
    const query = target.query as Partial<Pick<Query, 'accountInfo'>>
    if (typeof query.accountInfo !== 'function') return
    void query.accountInfo().then(info => { if (target === run) account = info }, (error: unknown) => {
      deps.host.debug(`claude: accountInfo failed (${errorText(error)})`)
    })
  }

  /** The handshake of one run: capabilities, model catalog, commands. */
  const handshake = async (target: Run): Promise<Rec | undefined> => {
    let timer: unknown
    const init = await Promise.race([
      target.query.initializationResult(),
      new Promise<never>((_, reject) => {
        timer = clock.setTimeout(() => reject(new Error(t('claude-start-timeout'))), deps.initTimeoutMs ?? 60_000)
      }),
    ]).finally(() => clock.clearTimeout(timer))
    const result = rec(init)
    const capabilities = result?.capabilities
    if (Array.isArray(capabilities)) cliCapabilities = capabilities.filter((item): item is string => typeof item === 'string')
    if (cliCapabilities.length > 0 && !cliCapabilities.includes(CLI_CAPABILITY.lifecycle)) translator.setUserRows('replay')
    fetchAccount(target)
    return result
  }

  const afterMessage = (message: unknown, events: readonly AgentEvent[]): void => {
    const value = rec(message)
    if (value?.type === 'result' || (value?.type === 'system' && value.subtype === 'session_state_changed' && value.state === 'idle')) {
      clearForceTimer()
    }
    if (value?.type === 'system' && value.subtype === 'init') {
      if (Array.isArray(value.capabilities)) cliCapabilities = value.capabilities.filter((item): item is string => typeof item === 'string')
      if (typeof value.apiKeySource === 'string') apiKeySource = value.apiKeySource
      if (Array.isArray(value.terminal_slash_commands)) controls.setTerminalOnly(value.terminal_slash_commands.filter((item): item is string => typeof item === 'string'))
    }
    if (value?.type === 'result' || (value?.type === 'command_lifecycle' && value.state === 'started')) persisted = true
    // While a reconnect is renewing the credential, the old CLI's late
    // failing turn is the failure being handled, not a new one.
    if (reconnecting === undefined && isAuthFailure(message)) authFailed = true
    if (value?.type === 'result') {
      if (reconnecting !== undefined) {
        authFailed = false
      } else if (authFailed) {
        authFailed = false
        onAuthFailure()
      } else if (value.is_error !== true) {
        authAttempts = 0
      }
      // Forget pushes the CLI has started (only unstarted ones are kept).
      const unstarted = new Set(translator.unstartedInputs())
      for (const uuid of pushed.keys()) if (!unstarted.has(uuid)) pushed.delete(uuid)
    }
    for (const event of events) {
      if (event.type !== 'session.ready' || event.backendVersion === undefined || cliVersion !== undefined) continue
      cliVersion = event.backendVersion
      // Drift is reported, never a stop (design §4.2).
      if (cliVersionDrift(cliVersion) !== undefined) {
        emit([{ type: 'notice', level: 'warning', text: t('claude-version-drift', { version: cliVersion, validated: VALIDATED_CLI_VERSIONS.join(', ') }) }])
      }
    }
  }

  /**
   * Runs stopped on purpose ahead of their replacement (an auth-failure
   * reconnect stops the old CLI before it renews the credential): their late
   * messages are not the session's any more, and their end is not a loss.
   */
  const retired = new WeakSet<Run>()

  /** Consume one run until it ends; an ended run that is no longer the
   *  current one was replaced on purpose (reconnect), not lost. */
  const consume = (target: Run): Promise<void> => (async (): Promise<void> => {
    try {
      for await (const message of target.query) {
        if (target !== run || retired.has(target)) return
        let events: readonly AgentEvent[]
        try {
          events = translator.translate(message)
        } catch (error) {
          // A translator bug must not take the session down with it.
          deps.host.debug(`claude: translate failed (${errorText(error)})`)
          continue
        }
        for (const event of events) {
          if (event.type === 'session.status' && event.status !== 'disposed' && !disposing) status = event.status
        }
        emit(events, wakeOf(message, events))
        afterMessage(message, events)
        if (idleWaiters.length > 0) settleIdleWaiters()
      }
      if (target === run && !retired.has(target)) onExit(undefined)
    } catch (error) {
      if (target === run && !retired.has(target)) onExit(error)
    }
  })()

  /**
   * Start a replacement run and complete its handshake. A session the CLI
   * has persisted is resumed; one it has not is created again under the
   * same id — and a resume the CLI answers with "No conversation found"
   * falls back to that create.
   */
  const openRun = async (): Promise<void> => {
    const resume = persisted
    // The replacement becomes the current run at once, so the old run's
    // consumer — ending as its CLI closes — knows it was replaced, not lost.
    run = startRun(resume)
    try {
      await handshake(run)
    } catch (error) {
      // A dispose during the handshake must not spawn the fallback: nothing
      // would ever stop it.
      if (disposing || !resume || !NO_CONVERSATION.test(errorText(error))) throw error
      deps.host.debug(`claude: resume refused (${errorText(error)}); creating the session again`)
      stopRun(run)
      run = startRun(false)
      await handshake(run)
    }
  }

  /**
   * Restart the CLI on the same session with a renewed credential (design
   * §4.12): the old CLI's prompts are withdrawn and an open turn closed, the
   * new query continues the session id, the translator keeps its state, and
   * the inputs the old CLI never started are pushed again, in order.
   *
   * After an authentication failure the old CLI is stopped FIRST — before
   * the renewal awaits — so its queue cannot start (and fail on the refused
   * credential) meanwhile: every input it had not started is re-pushed. A
   * `/login` reconnect instead waits for the running turn and the inputs
   * queued behind it (submits keep going to the old CLI meanwhile), for at
   * most {@link RECONNECT_DEFER_MS}; then it reconnects anyway, saying that
   * it interrupts the turn.
   */
  let reconnecting: Promise<void> | undefined
  /** A `/login` reconnect is waiting for the session to go idle. */
  let reconnectDeferred = false
  const RECONNECT_DEFER_MS = deps.reconnectDeferMs ?? 120_000

  /** Withdraw the old CLI's prompts, close its turn, stop it; what it never
   *  started is re-pushed to the replacement. */
  const stopForReconnect = (): { readonly unstarted: readonly string[] } => {
    const previous = run
    bridge.settleAll(WITHDRAWN_MESSAGE)
    clearForceTimer()
    emit(translator.forceCloseTurn({ kind: 'aborted' }))
    const unstarted = translator.unstartedInputs()
    retired.add(previous)
    stopRun(previous)
    return { unstarted }
  }

  /** Wait (bounded) until no turn runs and nothing queued would start. */
  const waitIdleBounded = async (): Promise<void> => {
    if (idle()) return
    let timer: unknown
    const timedOut = await Promise.race([
      new Promise<false>((resolve, reject) => { idleWaiters.push({ resolve: () => resolve(false), reject }) }),
      new Promise<true>(resolve => { timer = clock.setTimeout(() => resolve(true), RECONNECT_DEFER_MS) }),
    ]).finally(() => clock.clearTimeout(timer))
    if (timedOut && !disposing) emit([{ type: 'notice', level: 'warning', text: t('claude-auth-reconnect-forced') }])
  }

  const reconnect = (renewal: { readonly rejected?: string }, options: { readonly waitIdle?: boolean } = {}): Promise<void> => {
    if (disposing) return Promise.reject(new Error(t('claude-session-closed')))
    reconnecting ??= (async (): Promise<void> => {
      const deferred = options.waitIdle === true
      let stopped = deferred ? undefined : stopForReconnect()
      let renewError: unknown
      // A deferred reconnect leaves the old CLI serving submits until it
      // actually swaps (renewal and the idle wait included).
      reconnectDeferred = deferred
      try {
        if (deps.auth !== undefined) {
          try {
            authPlan = await deps.auth.renew(renewal)
          } catch (error) {
            // The old CLI is already gone: reconnect on the current
            // credential (its inputs still run), report the renewal after.
            if (stopped === undefined) throw error
            renewError = error
          }
        }
        if (deferred) await waitIdleBounded()
      } finally {
        reconnectDeferred = false
      }
      if (disposing) return
      stopped ??= stopForReconnect()
      const { unstarted } = stopped
      try {
        await openRun()
      } catch (error) {
        // Nothing can deliver them now: retire their previews, say so.
        const dropped = translator.dropInputs(unstarted)
        pushed.clear()
        if (dropped.length > 0) emit([...dropped, { type: 'notice', level: 'warning', text: t('claude-auth-inputs-dropped', { n: unstarted.length }) }])
        onExit(error)
        throw error
      }
      // A dispose during the handshake: the replacement must not outlive it.
      if (disposing) {
        stopRun(run)
        return
      }
      // Background work belonged to the old CLI process; the new one starts
      // with none (the level signal is per process).
      emit([{ type: 'tasks.snapshot', taskIds: [] }])
      const next = run
      const lost: string[] = []
      for (const uuid of unstarted) {
        const message = pushed.get(uuid)
        if (message === undefined) { lost.push(uuid); continue }
        // A fresh CLI is idle: each input is a plain push, in order.
        const { priority: _priority, ...plain } = message
        try {
          next.inbox.push(plain)
        } catch {
          lost.push(uuid)
        }
      }
      if (lost.length > 0) emit([...translator.dropInputs(lost), { type: 'notice', level: 'warning', text: t('claude-auth-inputs-dropped', { n: lost.length }) }])
      next.consumer = consume(next)
      if (renewError !== undefined) throw renewError
    })().finally(() => { reconnecting = undefined })
    return reconnecting
  }

  /** The token the live run spawned with, when it is the dsh-auth login. */
  const injectedToken = (): string | undefined =>
    authPlan.source === 'dsh-auth' ? authPlan.env.CLAUDE_CODE_OAUTH_TOKEN : undefined

  /** A failed renewal as the user sees it (details stay in the debug log). */
  const renewalFailed = (error: unknown): string => {
    deps.host.debug(`claude: reconnect failed (${errorText(error)})`)
    return deps.auth?.failureNotice?.(error) ?? t('claude-auth-reconnect-failed')
  }

  /** The CLI refused the credential: renew and resume once, then send the
   *  user to `/login` (never a loop of failing turns). */
  const onAuthFailure = (): void => {
    if (disposing) return
    if (authAttempts >= 1) {
      emit([{ type: 'notice', level: 'error', text: t('claude-auth-failed-login') }])
      return
    }
    authAttempts += 1
    reconnect({ rejected: injectedToken() }).then(() => {
      emit([{ type: 'notice', level: 'warning', text: t('claude-auth-reconnected') }])
    }, (error: unknown) => {
      emit([{ type: 'notice', level: 'error', text: renewalFailed(error) }])
    })
  }

  const controls = createClaudeControls({
    query: () => run.query,
    emit: events => emit(events),
    submitText: async text => {
      await session.submit({ text, clientMessageId: randomUUID() }, 'turn')
    },
    currentModel: () => translator.model,
    currentMode: () => translator.mode ?? deps.start.mode,
    noteModel: model => translator.noteModel(model),
    noteMode: mode => translator.noteMode(mode),
    prefs,
    debug: deps.host.debug,
  })

  try {
    const init = await handshake(run)
    controls.seed(init)
  } catch (error) {
    disposing = true
    teardown()
    throw error
  }
  status = 'idle'
  for (const text of deps.startNotices ?? []) emit([{ type: 'notice', level: 'warning', text }])
  // The start mode is the session's first mode (the CLI confirms it with its
  // first `init`); the status line shows it from the start.
  emit([{ type: 'mode.changed', modeId: translator.mode ?? deps.start.mode }], 'none')
  run.consumer = consume(run)
  // A resumed transcript does not record the context window (design §4.11):
  // ask the CLI once, so the status line has it before the first `result`.
  if (deps.resume !== undefined) {
    const query = run.query as Partial<Pick<Query, 'getContextUsage'>>
    if (typeof query.getContextUsage === 'function') {
      void query.getContextUsage({ detail: 'summary' }).then(usage => {
        if (disposing || !Number.isFinite(usage.maxTokens) || usage.maxTokens <= 0) return
        emit([{ type: 'context.capacity', contextWindow: usage.maxTokens }])
      }, (error: unknown) => {
        deps.host.debug(`claude: context usage after resume failed (${errorText(error)})`)
      })
    }
  }

  /** `/login` lines: where the credential comes from, never the token. */
  const authStatus = async (): Promise<SessionAuthView> => {
    const lines = [t('claude-auth-source', { source: authSourceLabel(authPlan) })]
    const route = routeLabel(authPlan)
    if (route !== undefined) lines.push(t('claude-auth-route', { route }))
    if (authPlan.source === 'claude-login' && await detectClaudeAuth(process.env, undefined) === 'missing' && account?.subscriptionType === undefined) {
      lines.push(t('claude-auth-missing-hint'))
    }
    lines.push(t('claude-auth-cli', { source: apiKeySource ?? t('doctor-unknown'), token: account?.tokenSource ?? t('doctor-unknown') }))
    if (account !== undefined) lines.push(...accountLines(accountView(account, apiKeySource)))
    return { lines }
  }

  /** This session in the backend's reference vocabulary. */
  const ownRef: AgentSessionRef = { backendId: CLAUDE_BACKEND_ID, sessionId: deps.sessionId }

  /** The live query's checkpoint restore (`enableFileCheckpointing`). */
  const rewindFiles = async (anchor: string, dryRun: boolean): Promise<RewindPreview> => {
    const query = run.query as Partial<Pick<Query, 'rewindFiles'>>
    if (typeof query.rewindFiles !== 'function') throw new Error(t('claude-rewind-files-unavailable'))
    const result = await query.rewindFiles(anchor, dryRun ? { dryRun: true } : undefined)
    if (!result.canRewind) throw new Error(result.error ?? t('claude-rewind-files-unavailable'))
    return {
      filesChanged: result.filesChanged ?? [],
      ...(result.insertions === undefined ? {} : { insertions: result.insertions }),
      ...(result.deletions === undefined ? {} : { deletions: result.deletions }),
    }
  }

  /**
   * `/fork` and the conversation rewind (design §4.11), both through the
   * session store: a fork is a persisted copy under a new id (the live
   * session is untouched); a conversation rewind forks up to the entry
   * right before the picked user message, for the channel to open and adopt.
   */
  function sessionStoreCapabilities(): Pick<AgentSession['capabilities'], 'fork' | 'rewind'> {
    const store = deps.store
    if (store === undefined) return {}
    const fork = async (options: { readonly upToMessageId?: string; readonly title?: string }): Promise<AgentSessionRef> => {
      // Nothing to copy before the CLI wrote the transcript.
      if (!persisted) throw new Error(t('claude-fork-empty'))
      const forked = await store.forkSession(deps.sessionId, { dir: deps.cwd, ...options })
      return { backendId: CLAUDE_BACKEND_ID, sessionId: forked.sessionId }
    }
    return {
      fork: {
        fork: (anchor, title) => fork({ ...(anchor === undefined ? {} : { upToMessageId: anchor }), ...(title === undefined ? {} : { title }) }),
      },
      rewind: {
        preview: anchor => rewindFiles(anchor, true),
        async rewind(anchor, mode): Promise<RewindOutcome> {
          let cut: string | undefined
          if (mode !== 'files') {
            // Resolve the cut before touching any file: a conversation the
            // rewind cannot cut must not leave the files rewound alone.
            const chain = await store.getSessionMessages(deps.sessionId, { dir: deps.cwd, includeSystemMessages: true })
            if (!chain.some(message => message.uuid === anchor)) return { kind: 'refused', reason: t('claude-rewind-not-found') }
            cut = rewindCutPoint(chain, anchor)
            if (cut === undefined) return { kind: 'refused', reason: t('rewind-first-message') }
          }
          let files: RewindPreview | undefined
          if (mode !== 'conversation') {
            try {
              files = await rewindFiles(anchor, false)
            } catch (error) {
              return { kind: 'refused', reason: errorText(error) }
            }
          }
          if (cut === undefined) return { kind: 'rewound', session: ownRef, ...(files === undefined ? {} : { files }) }
          try {
            const session = await fork({ upToMessageId: cut })
            return { kind: 'rewound', session, ...(files === undefined ? {} : { files }) }
          } catch (error) {
            // The files are restored already: that outcome must not be lost
            // with the failed conversation half.
            if (files === undefined) throw error
            return { kind: 'rewound', session: ownRef, files, conversationError: errorText(error) }
          }
        },
      },
    }
  }

  /** Stop a task (subagent or job) by the id the channel knows it by. */
  const stopTask = async (id: string): Promise<boolean> => {
    const taskId = translator.taskIdOf(id)
    const query = run.query as Partial<Pick<Query, 'stopTask'>>
    if (taskId === undefined || typeof query.stopTask !== 'function' || disposing) return false
    await query.stopTask(taskId)
    return true
  }

  const session: AgentSession = {
    ref: ownRef,
    cwd: deps.cwd,
    get status(): AgentSessionStatus {
      if (status === 'disposed') return 'disposed'
      if (bridge.size > 0) return 'requires-action'
      return translator.turnOpen ? 'running' : status
    },
    capabilities: {
      permissions: {
        respond: (requestId, decision) => bridge.respond(requestId, decision),
        pending: () => bridge.pendingViews(),
      },
      questions: {
        respond: (requestId, answers) => bridge.respondQuestion(requestId, answers),
        cancel: requestId => bridge.cancelQuestion(requestId),
      },
      ...controls.capabilities,
      ...sessionStoreCapabilities(),
      // Design §4.8: a subagent or background job is stopped by its task id
      // (`stopTask`; the CLI reports the stop as its notification).
      subagents: {
        interrupt: agentId => stopTask(agentId),
      },
      tasks: {
        stop: taskId => stopTask(taskId),
        readOutput: taskId => {
          const file = translator.outputFileOf(taskId)
          if (file === undefined) return Promise.reject(new Error(t('claude-task-output-unknown', { id: taskId })))
          try {
            return Promise.resolve(readTaskOutputTail(file, taskId, taskOutputRoots(authPlan.env)))
          } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)))
          }
        },
      },
      transcript: createClaudeTranscriptHistory({
        sessionId: deps.sessionId,
        cwd: deps.cwd,
        configDir: () => claudeConfigDir(authPlan.env.CLAUDE_CONFIG_DIR === undefined ? process.env : authPlan.env),
        ...(deps.resume?.compactedFrom === undefined ? {} : { compactedFrom: deps.resume.compactedFrom }),
        debug: deps.host.debug,
      }),
      account: {
        async info(): Promise<AccountView> {
          const query = run.query as Partial<Pick<Query, 'accountInfo'>>
          if (typeof query.accountInfo === 'function') account = await query.accountInfo()
          return accountView(account ?? {}, apiKeySource)
        },
      },
      auth: {
        oauthProvider: CLAUDE_OAUTH_PROVIDER,
        status: authStatus,
        async reconnect(): Promise<void> {
          authAttempts = 0
          // Never under a running turn: the restart would abort it and drop
          // what the user queued behind it. Reconnect once it ends.
          if (!idle()) emit([{ type: 'notice', level: 'info', text: t('claude-auth-reconnect-deferred') }])
          await reconnect({}, { waitIdle: true })
        },
      },
      native: {
        claude: {
          kind: 'claude',
          sessionId: deps.sessionId,
          get cliVersion() { return cliVersion },
          get cliCapabilities() { return cliCapabilities },
        },
      },
      diagnostics: {
        lines: (): readonly string[] => [
          t('claude-doctor-cli', { path: deps.executable.path ?? t('claude-doctor-bundled'), source: deps.executable.source, version: cliVersion ?? t('doctor-unknown') }),
          ...(cliVersionDrift(cliVersion) === undefined ? [] : [t('claude-version-drift', { version: cliVersion ?? '', validated: VALIDATED_CLI_VERSIONS.join(', ') })]),
          t('claude-doctor-sdk', { version: deps.sdkVersion ?? t('doctor-unknown'), validated: VALIDATED_SDK_VERSION }),
          t('claude-doctor-mode', { mode: translator.mode ?? deps.start.mode, source: deps.start.source }),
          t('claude-auth-source', { source: authSourceLabel(authPlan) }),
          ...(account === undefined ? [] : accountLines(accountView(account, apiKeySource))),
        ],
      },
    },
    // A created session has no durable history yet; a resumed one replays
    // the transcript read before the CLI started (backend.ts).
    history: () => Promise.resolve(deps.resume?.events ?? []),
    subscribe(listener: Listener) {
      listeners.add(listener)
      if (backlog.length > 0) {
        // Delivered after the subscriber's own setup returns (it may be
        // inside a binding transaction).
        queueMicrotask(() => {
          if (!listeners.has(listener)) return
          for (const [events, meta] of backlog.splice(0)) listener(events, meta)
        })
      }
      return () => { listeners.delete(listener) }
    },
    async submit(input: AgentInput, placement: SubmitPlacement) {
      // A credential reconnect is swapping the CLI: the input goes to the
      // new one (the old one's stdin is closed). A `/login` reconnect still
      // waiting for the session to go idle leaves the old CLI serving.
      if (reconnecting !== undefined && !reconnectDeferred) await reconnecting.catch(() => undefined)
      if (disposing || run.inbox.closed) throw new Error(t('claude-session-closed'))
      // Pasted images and `@image` mentions arrive as image blocks; sending
      // the text without them would silently drop part of the message.
      if ((input.images?.length ?? 0) > 0 || (input.blocks ?? []).some(block => block.type === 'image')) {
        throw new Error(t('claude-images-unsupported'))
      }
      const texts = (input.blocks ?? [{ type: 'text', text: input.text }])
        .flatMap(block => block.type === 'text' && typeof block.text === 'string' && block.text !== '' ? [block.text] : [])
      const content = texts.length <= 1 ? texts[0] ?? input.text : texts.map(text => ({ type: 'text' as const, text }))
      const priority = priorityOf(placement, translator.turnOpen)
      translator.registerInput(input.clientMessageId, input.text, placement)
      const message: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        uuid: input.clientMessageId as SDKUserMessage['uuid'],
        ...(priority === undefined ? {} : { priority }),
      }
      try {
        run.inbox.push(message)
      } catch (error) {
        translator.unregisterInput(input.clientMessageId)
        throw error instanceof Error ? error : new Error(String(error))
      }
      pushed.set(input.clientMessageId, message)
      return { accepted: true }
    },
    // No synchronous withdrawal (`retractPending` absent): never called.
    removePending: () => false,
    async cancel(cause: CancelCause) {
      if (disposing) return { stillQueued: [] }
      if (translator.turnOpen && forceTimer === undefined) {
        forceTimer = clock.setTimeout(() => {
          forceTimer = undefined
          if (disposing || !translator.turnOpen) return
          // The CLI never withdrew its prompts either: close the panels too.
          bridge.settleAll(WITHDRAWN_MESSAGE)
          emit([
            ...translator.forceCloseTurn({ kind: 'aborted' }),
            { type: 'notice', level: 'warning', text: t('claude-cancel-forced') },
            { type: 'session.status', status: 'requires-action' },
          ])
          settleIdleWaiters()
        }, forceSettleMs)
      }
      // `interrupt` re-delivers the queue itself, so the queued inputs go with
      // the turn when the CLI can drop them; a user cancel keeps them.
      const cancelQueued = cause !== 'user' && cliCapabilities.includes(CLI_CAPABILITY.interruptCancelQueued)
      // The documented `cancel_queued` interrupt field is reachable through
      // the runtime method's option bag (absent from the TS signature).
      const query = run.query
      const interrupt = query.interrupt as (options?: { cancelQueued?: boolean }) => Promise<unknown>
      try {
        const receipt = rec(await interrupt.call(query, cancelQueued ? { cancelQueued: true } : undefined))
        const stillQueued = Array.isArray(receipt?.still_queued) ? receipt.still_queued.filter((id): id is string => typeof id === 'string') : []
        return { stillQueued }
      } catch (error) {
        deps.host.debug(`claude: interrupt failed (${errorText(error)})`)
        return { stillQueued: [] }
      }
    },
    dispose(): Promise<void> {
      if (disposePromise !== undefined) return disposePromise
      disposePromise = (async () => {
        const wasDisposed = status === 'disposed'
        disposing = true
        status = 'disposed'
        teardown()
        let timer: unknown
        await Promise.race([
          run.consumer,
          new Promise<void>(resolve => { timer = clock.setTimeout(resolve, deps.closeTimeoutMs ?? 5000) }),
        ])
        clock.clearTimeout(timer)
        if (!wasDisposed) emit([{ type: 'session.status', status: 'disposed' }], 'none')
        settleIdleWaiters(new Error(t('claude-session-closed')))
        listeners.clear()
        backlog.length = 0
      })()
      return disposePromise
    },
  }
  return session
}

/** The `/login` and `/doctor` name of a credential source. */
function authSourceLabel(plan: ClaudeAuthPlan): string {
  switch (plan.source) {
    case 'dsh-auth':
      return plan.expiresAt === undefined ? t('claude-auth-source-dsh-auth') : t('claude-auth-source-dsh-auth-expires', { time: new Date(plan.expiresAt).toISOString() })
    case 'api-key':
      return 'ANTHROPIC_API_KEY'
    case 'auth-token':
      return 'ANTHROPIC_AUTH_TOKEN'
    case 'oauth-env':
      return 'CLAUDE_CODE_OAUTH_TOKEN'
    case 'cloud':
      return t('claude-auth-source-cloud', { provider: plan.cloud ?? '' })
    case 'claude-login':
      return t('claude-auth-source-claude-login')
    default: {
      const unknown: never = plan.source
      return unknown
    }
  }
}

/** Why the subscription sign-in is not in use, when the route is not
 *  first-party (the origin host at most — never a full URL). */
function routeLabel(plan: ClaudeAuthPlan): string | undefined {
  const route = plan.route
  if (route === undefined) return undefined
  switch (route.kind) {
    case 'first-party':
    case 'cloud':
      return undefined
    case 'custom-endpoint':
      return t('claude-route-custom-endpoint', { host: route.host })
    case 'custom-oauth':
      return t('claude-route-custom-oauth')
    case 'unix-socket':
      return t('claude-route-unix-socket')
    case 'gateway':
      return t('claude-route-gateway')
    case 'api-key-helper':
      return t('claude-route-api-key-helper')
    case 'settings-unreadable':
      return t('claude-route-settings-unreadable')
    default: {
      const unknown: never = route
      return unknown
    }
  }
}

/** Account lines (never the email). */
function accountLines(view: AccountView): string[] {
  const parts = [view.organization, view.subscription, view.provider].filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? [] : [t('claude-auth-account', { account: parts.join(' · ') })]
}
