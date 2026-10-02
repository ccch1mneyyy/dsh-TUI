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
import type { AccountView, SessionAuthView } from '../../agent/capabilities.js'
import type { AgentEvent, AgentEventMeta } from '../../agent/events.js'
import type { AgentInput, AgentSession, AgentSessionStatus, CancelCause, SubmitPlacement } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { CLAUDE_BACKEND_ID, CLI_CAPABILITY, cliVersionDrift, VALIDATED_CLI_VERSIONS, VALIDATED_SDK_VERSION } from './contract.js'
import { CLAUDE_OAUTH_PROVIDER, detectClaudeAuth, isAuthFailure, type ClaudeAuthPlan } from './auth.js'
import { accountView, createClaudeControls } from './controls.js'
import { buildQueryOptions, type StartPermissionMode } from './options.js'
import { createClaudePermissionBridge, WITHDRAWN_MESSAGE } from './permissions.js'
import { createStderrSink, type ClaudeExecutable } from './process.js'
import { memoryClaudePrefs, type ClaudePrefs } from './prefs.js'
import type { ClaudeSdkModule } from './sdk.js'
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
  readonly cwd: string
  readonly sessionId: string
  readonly start: StartPermissionMode
  readonly executable: ClaudeExecutable
  /** The child environment when no credential plan is given (tests). */
  readonly env: Record<string, string>
  /** The credential the session spawns with and how to renew it after an
   *  authentication failure (design §4.12; auth.ts). */
  readonly auth?: {
    readonly plan: ClaudeAuthPlan
    renew(): Promise<ClaudeAuthPlan>
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
}

type Listener = (batch: readonly AgentEvent[], meta: AgentEventMeta) => void
type Rec = Readonly<Record<string, unknown>>
const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

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
  const translator = createClaudeTranslator({ cwd: deps.cwd, userRows: 'lifecycle', debug: deps.host.debug })
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
  let run = startRun(false)

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
    if (isAuthFailure(message)) authFailed = true
    if (value?.type === 'result') {
      if (authFailed) {
        authFailed = false
        onAuthFailure()
      } else if (value.is_error !== true) {
        authAttempts = 0
      }
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

  /** Consume one run until it ends; an ended run that is no longer the
   *  current one was replaced on purpose (reconnect), not lost. */
  const consume = (target: Run): Promise<void> => (async (): Promise<void> => {
    try {
      for await (const message of target.query) {
        if (target !== run) return
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
      }
      if (target === run) onExit(undefined)
    } catch (error) {
      if (target === run) onExit(error)
    }
  })()

  /**
   * Restart the CLI on the same session with a renewed credential (design
   * §4.12): the old CLI's prompts are withdrawn and an open turn closed, the
   * new query resumes the session id, and the translator keeps its state.
   */
  let reconnecting: Promise<void> | undefined
  const reconnect = (): Promise<void> => {
    if (disposing) return Promise.reject(new Error(t('claude-session-closed')))
    reconnecting ??= (async (): Promise<void> => {
      if (deps.auth !== undefined) authPlan = await deps.auth.renew()
      if (disposing) return
      const previous = run
      bridge.settleAll(WITHDRAWN_MESSAGE)
      clearForceTimer()
      emit(translator.forceCloseTurn({ kind: 'aborted' }))
      stopRun(previous)
      run = startRun(true)
      try {
        await handshake(run)
      } catch (error) {
        onExit(error)
        throw error
      }
      run.consumer = consume(run)
    })().finally(() => { reconnecting = undefined })
    return reconnecting
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
    reconnect().then(() => {
      emit([{ type: 'notice', level: 'warning', text: t('claude-auth-reconnected') }])
    }, (error: unknown) => {
      emit([{ type: 'notice', level: 'error', text: t('claude-auth-refresh-failed', { err: errorText(error) }) }])
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

  /** `/login` lines: where the credential comes from, never the token. */
  const authStatus = async (): Promise<SessionAuthView> => {
    const lines = [t('claude-auth-source', { source: authSourceLabel(authPlan) })]
    if (authPlan.source === 'claude-login' && await detectClaudeAuth(process.env, undefined) === 'missing' && account?.subscriptionType === undefined) {
      lines.push(t('claude-auth-missing-hint'))
    }
    lines.push(t('claude-auth-cli', { source: apiKeySource ?? t('doctor-unknown'), token: account?.tokenSource ?? t('doctor-unknown') }))
    if (account !== undefined) lines.push(...accountLines(accountView(account, apiKeySource)))
    return { lines }
  }

  const session: AgentSession = {
    ref: { backendId: CLAUDE_BACKEND_ID, sessionId: deps.sessionId },
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
          await reconnect()
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
    // A created session has no durable history yet; resume (Phase 4) reads
    // the CLI's session store.
    history: () => Promise.resolve([]),
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
      // new one (the old one's stdin is closed).
      if (reconnecting !== undefined) await reconnecting.catch(() => undefined)
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
      try {
        run.inbox.push({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          uuid: input.clientMessageId as SDKUserMessage['uuid'],
          ...(priority === undefined ? {} : { priority }),
        })
      } catch (error) {
        translator.unregisterInput(input.clientMessageId)
        throw error instanceof Error ? error : new Error(String(error))
      }
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

/** Account lines (never the email). */
function accountLines(view: AccountView): string[] {
  const parts = [view.organization, view.subscription, view.provider].filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? [] : [t('claude-auth-account', { account: parts.join(' · ') })]
}
