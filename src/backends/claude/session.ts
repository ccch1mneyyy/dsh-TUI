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
 *   (`interrupt_cancel_queued_v1`) — the channel parks the dropped copies as
 *   a dock and re-delivers nothing until the user asks (Claude Code parity).
 *   Until a `result`/`idle` confirms, a 30 s timer stands by to force-close
 *   the turn (`turn.end{aborted}` + notice): an interrupted turn may never
 *   report.
 * - Permissions (Phase 3): the permission bridge (`permissions.ts`) parks
 *   every `canUseTool` prompt and announces it as `permission.request` /
 *   `question.request`; the user's answer returns through the
 *   `permissions` / `questions` capabilities. While prompts are parked the
 *   session is `requires-action`. Pending prompts are always settled: on
 *   answer, on the SDK's abort signal, at a forced turn close, on dispose.
 * - MCP elicitation and the CLI's user dialogs (Phase 5b, dialogs.ts) park
 *   the same way (`question.request`), answered through the same
 *   `questions` capability; `system/elicitation_complete` closes a URL one.
 * - A `conversation_reset` (a plan-mode exit that clears the context) moves
 *   the CLI to a new session id: the next frame names it, and from then on
 *   it is this session's id (ref, fork, rewind, reconnect, transcript).
 * - Disposal: deny pending callbacks → close the inbox (stdin EOF, the CLI
 *   exits on its own) → `close()` the query → abort the controller; then wait
 *   (bounded) for the consumer loop. Idempotent.
 * - Process death or a consumer error marks the session `disposed`, closes
 *   any open turn and says so in a notice.
 */
import type { AccountInfo, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { AccountView, RewindOutcome, RewindPreview, SessionAuthView } from '../../agent/capabilities.js'
import type { AgentMessageView, WorkingActivityView } from '../../adapter/ports/channel-view.js'
import type { AgentEvent, AgentEventMeta } from '../../agent/events.js'
import { foldAgentMessage } from '../../agent/messages.js'
import type { AgentSessionRef } from '../../agent/refs.js'
import type { AgentInput, AgentSession, AgentSessionStatus, CancelCause, SubmitPlacement } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { CLAUDE_BACKEND_ID, CLI_CAPABILITY, cliVersionDrift, VALIDATED_CLI_VERSIONS, VALIDATED_SDK_VERSION } from './contract.js'
import { CLAUDE_OAUTH_PROVIDER, detectClaudeAuth, isAuthFailure, refreshFailureDebugDetail, type ClaudeAuthPlan } from './auth.js'
import { accountView, createClaudeControls } from './controls.js'
import { buildQueryOptions, type StartPermissionMode } from './options.js'
import { createClaudeDialogBridge, SUPPORTED_DIALOG_KINDS } from './dialogs.js'
import { createClaudeActivityPublisher } from './activity.js'
import { createClaudePermissionBridge, WITHDRAWN_MESSAGE } from './permissions.js'
import { createStderrSink, type ClaudeExecutable } from './process.js'
import { memoryClaudePrefs, type ClaudePrefs } from './prefs.js'
import { activeProfileOf, fileClaudeChannels, type ClaudeChannels } from './channels.js'
import { fileClaudeChannelTokens, type ClaudeChannelTokens } from './channelTokens.js'
import { createClaudeTranscriptHistory } from './older-history.js'
import { replayClaudeSubagentLane, rewindCutPoint, type ClaudeReplay } from './replay.js'
import type { ClaudeSdkModule, ClaudeSessionStoreSdk } from './sdk.js'
import { readTaskOutputTail, taskOutputRoots } from './task-output.js'
import { join } from 'node:path'
import { DATA_DIR } from '../../utils/paths.js'
import { envSlotsServeModel, importedModelEnv, mergedModelEnv, modelTruthFrom, readLocalModelNames } from './modelEnv.js'
import { claudeConfigDir } from './transcript-file.js'
import { CLAUDE_IMAGE_LIMITS, claudeImageBlocks } from './images.js'
import { createClaudeSideQuery } from './side-query.js'
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

/** The subagent transcript's newest page (messages); older windows of the
 *  same size load on demand (design agent-team-panels §2, MVP pagination). */
const SUBAGENT_TRANSCRIPT_PAGE = 400

export interface ClaudeSessionDeps {
  readonly sdk: Pick<ClaudeSdkModule, 'query'>
  /** The session-store API behind `/fork` and the conversation rewind
   *  (absent = neither capability). */
  readonly store?: Pick<ClaudeSessionStoreSdk, 'getSessionMessages' | 'forkSession'> & Partial<Pick<ClaudeSessionStoreSdk, 'renameSession' | 'getSubagentMessages'>>
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
  /** The relay channel profiles (channels.json; the file store if absent). */
  readonly channels?: ClaudeChannels
  /** The channel-token credential seam (channelTokens.ts; the file store
   *  under the DSH home if absent). Token material only ever moves between
   *  this seam and the spawn pipeline's env. */
  readonly channelTokens?: ClaudeChannelTokens
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
export async function openClaudeSession(input: ClaudeSessionDeps): Promise<AgentSession> {
  // The replayed history goes to the channel once (`history()`) and is then
  // let go: a long transcript's events must not live as long as the session.
  const { resume, ...deps } = input
  const resumed = resume !== undefined
  const compactedFrom = resume?.compactedFrom
  let replayHistory: readonly AgentEvent[] | undefined = resume?.events
  /** The CLI's current session id: the opened one until a
   *  `conversation_reset` moves the CLI to a new one. */
  let currentSessionId = deps.sessionId
  /** A reset was seen; the next frame naming another id adopts it. */
  let resetPending = false
  const clock = deps.clock ?? REAL_CLOCK
  const forceSettleMs = deps.forceSettleMs ?? 30_000
  const prefs = deps.prefs ?? memoryClaudePrefs()
  // The relay channel profiles: the file store under ~/.dsh-tui by default,
  // injectable like prefs (tests run an in-memory store).
  const channels = deps.channels ?? fileClaudeChannels(join(DATA_DIR, 'backends', 'claude'), message => deps.host.debug(message))
  // The channel-token seam: ~/.dsh/.credentials.yaml by default (the
  // /provider precedent), injectable for tests.
  const channelTokens = deps.channelTokens ?? fileClaudeChannelTokens(undefined, message => deps.host.debug(message))
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
  /** The model-routing env the CLI child actually applies for the live
   *  run: the settings `env` of its config dir with the live auth-plan env
   *  on top, in the CLI's own flag > settings > inherited order (the same
   *  merged truth the model list reads — modelEnv.ts). Read per run, so a
   *  reconnect's renewed plan is what the next child applies. */
  const childModelEnv = (): Record<string, string | undefined> => mergedModelEnv(
    claudeConfigDir(authPlan.env.CLAUDE_CONFIG_DIR === undefined ? process.env : authPlan.env),
    authPlan.env,
    new Set(Object.keys(authPlan.settings?.env ?? {})),
  )
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
  let persisted = resumed
  /** A `/rename` made before the CLI wrote the transcript (flushRename). */
  let pendingTitle: string | undefined
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
  const translator = createClaudeTranslator({
    cwd: deps.cwd,
    userRows: 'lifecycle',
    debug: deps.host.debug,
    // The replayed conversation's task table continues live (R2 review):
    // resume carries it beside the counters the numbering needs.
    ...(resume === undefined ? {} : { start: { ...resume.start, ...(resume.tasks === undefined || resume.tasks.length === 0 ? {} : { tasks: resume.tasks }) } }),
  })
  translator.noteMode(deps.start.mode)

  // The working line's publisher (activity.ts): folded from the translator's
  // own state after every batch, never from a second parse of the stream. A
  // parked permission/dialog prompt is the waiting phase; the fold dedupes,
  // so folding after every emit publishes only real changes.
  const activityPublisher = createClaudeActivityPublisher()
  const activityListeners = new Set<(view: WorkingActivityView) => void>()
  const publishActivity = (): void => {
    const view = activityPublisher.fold(translator.activityState(), asking || dialogsOpen)
    if (view === undefined) return
    for (const listener of [...activityListeners]) {
      try {
        listener(view)
      } catch (error) {
        deps.host.debug(`claude: activity listener failed (${errorText(error)})`)
      }
    }
  }

  /**
   * Observed agent↔agent relay facts (agent-team §5.4): the SendMessage tool
   * traffic the translator observes, folded live at this funnel and from the
   * replay seed at `history()` — one store, monotone by message id.
   */
  const agentMessages: AgentMessageView[] = []
  const foldAgentMessages = (events: readonly AgentEvent[]): void => {
    for (const event of events) {
      if (event.type === 'agent.message') foldAgentMessage(agentMessages, event.message)
    }
  }

  const emit = (events: readonly AgentEvent[], wake: AgentEventMeta['wake'] = 'sync'): void => {
    if (events.length === 0) return
    foldAgentMessages(events)
    const meta: AgentEventMeta = { replay: false, wake }
    if (listeners.size === 0) { backlog.push([events, meta]); publishActivity(); return }
    for (const listener of [...listeners]) {
      try {
        listener(events, meta)
      } catch (error) {
        deps.host.debug(`claude: listener failed (${errorText(error)})`)
      }
    }
    publishActivity()
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
      if (next && !dialogsOpen) emit([{ type: 'session.status', status: 'requires-action' }], 'none')
      else if (!next && !dialogsOpen && translator.turnOpen) emit([{ type: 'session.status', status: 'running' }], 'none')
    },
  })

  /** MCP elicitation and user dialogs (dialogs.ts): parked like prompts. */
  let dialogsOpen = false
  const dialogs = createClaudeDialogBridge({
    emit: events => emit(events),
    debug: deps.host.debug,
    closing: () => disposing,
    onPendingChange: count => {
      const next = count > 0
      if (next === dialogsOpen) return
      dialogsOpen = next
      if (disposing) return
      if (next && !asking) emit([{ type: 'session.status', status: 'requires-action' }], 'none')
      else if (!next && !asking && translator.turnOpen) emit([{ type: 'session.status', status: 'running' }], 'none')
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
    // The CLI's SDK path (2.1.284+) resolves an EXPLICIT `model` against
    // its bundled official catalog and fail-fasts a non-official name (a
    // relay model) as `[claude-code:unrecognized_model]`; the env slot
    // routing (ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_<TIER>_MODEL) serves
    // those names fine. When the env the child actually applies already
    // routes to the model the session would pin, the parameter is
    // omitted — the CLI lands on the same model without the catalog
    // check. Any other value keeps the explicit pin: a switch to an
    // official model must still reach the CLI.
    const explicitModel = startModel !== undefined && envSlotsServeModel(childModelEnv(), startModel)
      ? undefined
      : startModel
    const startEffort = prefs.read().effort ?? deps.effort
    const query = deps.sdk.query({
      prompt: inbox,
      options: buildQueryOptions({
        cwd: deps.cwd,
        // A reconnect resumes the same session (same id, same transcript);
        // the SDK refuses `sessionId` together with `resume`.
        ...(resume ? { resume: currentSessionId } : { sessionId: currentSessionId }),
        permissionMode: (translator.mode ?? deps.start.mode) as StartPermissionMode['mode'],
        executable: deps.executable.path,
        env: authPlan.env,
        // The route pin of an injected subscription token (auth.ts).
        ...(authPlan.settings === undefined ? {} : { settings: authPlan.settings }),
        canUseTool: bridge.canUseTool,
        onElicitation: dialogs.onElicitation,
        onUserDialog: dialogs.onUserDialog,
        supportedDialogKinds: SUPPORTED_DIALOG_KINDS,
        stderr: stderrSink,
        abortController,
        ...(explicitModel === undefined ? {} : { model: explicitModel }),
        ...(startEffort === undefined ? {} : { effort: startEffort }),
        // Echoes are the user-row fallback for a CLI without lifecycle
        // frames; requesting them is harmless when lifecycle frames win (the
        // translator ignores an echo of an input it already confirmed).
        replayUserMessages: true,
      }),
    })
    return { generation, inbox, abortController, query, consumer: Promise.resolve() }
  }
  let run = startRun(resumed)

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
    dialogs.settleAll()
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
      // The process's background work went with it (the level is per process).
      { type: 'tasks.snapshot', taskIds: [] },
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

  /** Seed the translator's (and so the channel's) model once, before any
   *  UI asks for it — the model this session spawned with, at exactly the
   *  priority `startRun` uses: the persisted choice, then the explicit
   *  start model, else the CLI's own handshake account of its default —
   *  the scalar `model` when it provides one, else the catalog's
   *  `default` alias row (its resolvedModel, never a hardcoded name; no
   *  default row at all leaves the model unknown). Only an EMPTY model is
   *  seeded: a resumed session keeps the replay's model, and a later
   *  reconnect must not overwrite a model the user switched to (the CLI's
   *  own frames still correct it). */
  const seedModel = (init: Rec | undefined): void => {
    if (translator.model !== '') return
    const catalog = (Array.isArray(init?.models) ? init.models : []).flatMap((row): { readonly value: string; readonly resolvedModel?: unknown }[] => {
      if (typeof row !== 'object' || row === null) return []
      const value = (row as Rec).value
      return typeof value === 'string' ? [{ value, resolvedModel: (row as Rec).resolvedModel }] : []
    })
    const defaultRow = catalog.find(row => row.value === 'default')
    const fromRow = defaultRow === undefined ? undefined
      : typeof defaultRow.resolvedModel === 'string' && defaultRow.resolvedModel !== '' ? defaultRow.resolvedModel : defaultRow.value
    const handshakeModel = typeof init?.model === 'string' && init.model !== '' ? init.model : fromRow
    const model = prefs.read().model ?? deps.model ?? handshakeModel
    if (model === undefined) return
    emit(translator.noteModel(model), 'none')
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
    // Every handshake starts from scratch: a run that reports no
    // capabilities at all must not inherit the previous CLI's — an older
    // CLI without `msg_lifecycle_v1` confirms inputs by their replay
    // echo, so the user-row source is picked explicitly each time.
    const capabilities = result?.capabilities
    cliCapabilities = Array.isArray(capabilities) ? capabilities.filter((item): item is string => typeof item === 'string') : []
    translator.setUserRows(cliCapabilities.includes(CLI_CAPABILITY.lifecycle) ? 'lifecycle' : 'replay')
    seedModel(result)
    fetchAccount(target)
    return result
  }

  /** The CLI continues under another session id (after a reset). */
  const adoptSessionId = (next: string): void => {
    const previous = currentSessionId
    currentSessionId = next
    deps.host.debug(`claude: the session continues as ${next} (was ${previous})`)
    try {
      prefs.touch(next)
      if (prefs.read().lastSession === previous) prefs.write({ lastSession: next })
      // The accent belongs to the TUI's session, which continues.
      const color = prefs.color(previous)
      if (color !== '') prefs.setColor(next, color)
    } catch (error) {
      deps.host.debug(`claude: prefs update after reset failed (${errorText(error)})`)
    }
  }

  const afterMessage = (message: unknown, events: readonly AgentEvent[]): void => {
    const value = rec(message)
    if (value?.type === 'system' && value.subtype === 'elicitation_complete' && typeof value.mcp_server_name === 'string' && typeof value.elicitation_id === 'string') {
      dialogs.complete(value.mcp_server_name, value.elicitation_id)
    }
    // Probe (Phase 5b, claude-sdk-probe-5b `reset`): after a reset the CLI
    // runs under a NEW session id, named by the frames that follow (not the
    // frame's `new_conversation_id`).
    if (value?.type === 'conversation_reset') {
      resetPending = true
    } else if (resetPending && typeof value?.session_id === 'string' && value.session_id !== '' && value.session_id !== currentSessionId) {
      resetPending = false
      adoptSessionId(value.session_id)
    }
    if (value?.type === 'result' || (value?.type === 'system' && value.subtype === 'session_state_changed' && value.state === 'idle')) {
      clearForceTimer()
    }
    if (value?.type === 'system' && value.subtype === 'init') {
      if (Array.isArray(value.capabilities)) cliCapabilities = value.capabilities.filter((item): item is string => typeof item === 'string')
      if (typeof value.apiKeySource === 'string') apiKeySource = value.apiKeySource
      if (Array.isArray(value.terminal_slash_commands)) controls.setTerminalOnly(value.terminal_slash_commands.filter((item): item is string => typeof item === 'string'))
    }
    if (value?.type === 'result' || (value?.type === 'command_lifecycle' && value.state === 'started')) {
      persisted = true
      flushRename()
    }
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
      // R2-4: every authoritative confirmation of the model — a re-init's
      // `model.changed`, the first init's `session.ready`, a
      // `message_start` drift — converges the effort readout with the
      // serving model's DECLARED capabilities (the explicit-refusal rule;
      // missing metadata keeps the user's choice).
      if ((event.type === 'model.changed' || event.type === 'session.ready') && event.model !== '') {
        controls.noteConfirmedModel(event.model)
      }
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
    dialogs.settleAll()
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

  /** A failed renewal as the user sees it. The debug log gets a fixed
   *  failure category and at most the HTTP status: a real refresh rejection
   *  carries the OAuth endpoint's response body, which may echo request
   *  material (auth.ts contract) — the error's own text is never logged. */
  const renewalFailed = (error: unknown): string => {
    deps.host.debug(`claude: reconnect failed (${refreshFailureDebugDetail(error)})`)
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

  /** The env keys the TUI itself injected into the spawn env — exactly the
   *  auth plan's flag layer (the channel connection, or the first-party
   *  pin; auth.ts re-states precisely these keys there). They are OURS, not
   *  the user's settings: the settings import excludes them (reading them
   *  back would re-import the channel the TUI itself activated), while the
   *  model truth keeps them deliberately ABOVE the settings file — the
   *  flag > settings > inherited order the CLI itself applies (R3-5). */
  const injectedEnvKeys = (): ReadonlySet<string> => new Set(Object.keys(authPlan.settings?.env ?? {}))

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
    channels,
    tokens: channelTokens,
    debug: deps.host.debug,
    // The settings-import source (R3-5): the user's own settings file plus
    // the truly inherited env (settings first, the CLI's own order) — the
    // TUI's own injections are NOT settings material and are excluded, so a
    // cc-switch-written settings.json is what "import from settings" sees.
    settingsEnv: () => importedModelEnv(
      claudeConfigDir(authPlan.env.CLAUDE_CONFIG_DIR === undefined ? process.env : authPlan.env),
      authPlan.env,
      injectedEnvKeys(),
    ),
    // Channel model truth, lazily (the list reads it on demand): the ACTIVE
    // channel profile first (channels.json — the user's own data), then the
    // settings env of the same config dir the transcripts use, plus the
    // live auth env on top. A cosmetic tier name a relay channel wrote
    // must not hide the model that actually serves the request.
    modelTruth: () => {
      const active = activeProfileOf(channels.read())
      return modelTruthFrom(
        claudeConfigDir(authPlan.env.CLAUDE_CONFIG_DIR === undefined ? process.env : authPlan.env),
        authPlan.env,
        readLocalModelNames(join(DATA_DIR, 'backends', 'claude')),
        active === undefined ? undefined : { models: active.models, tiers: active.tiers },
        injectedEnvKeys(),
      )
    },
  })

  try {
    const init = await handshake(run)
    controls.seed(init)
    // R2-4: the seed itself is an authoritative confirmation — the model
    // this session opened with (a fresh seed from prefs/handshake, or a
    // resumed session's replay model, which no frame will re-announce).
    // The catalog is in place now, so the effort readout converges with
    // the serving model's DECLARED capabilities before any UI asks.
    controls.noteConfirmedModel(translator.model)
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
  // The session's `/color` accent (kept TUI-side per session id).
  const startColor = prefs.color(currentSessionId)
  if (startColor !== '') emit([{ type: 'session.color', color: startColor }])
  run.consumer = consume(run)
  // A resumed transcript does not record the context window (design §4.11):
  // ask the CLI once, so the status line has it before the first `result`.
  if (resumed) {
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
  /** This session in the backend's reference vocabulary (its id follows a
   *  conversation reset). */
  const ownRef: AgentSessionRef = { backendId: CLAUDE_BACKEND_ID, get sessionId() { return currentSessionId } }

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
      const forked = await store.forkSession(currentSessionId, { dir: deps.cwd, ...options })
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
            const chain = await store.getSessionMessages(currentSessionId, { dir: deps.cwd, includeSystemMessages: true })
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

  /**
   * The child transcript source (design agent-team-panels §2): the
   *  subagent's own messages, read from the store and replayed through the
   *  same translator the live lane uses. Absent when this session has no
   *  store read API (tests, a store-less open); a read that fails rejects
   *  and the transcript view says unavailable — an unreadable transcript is
   *  never presented as an empty one.
   */
  function subagentHistory(): Pick<NonNullable<AgentSession['capabilities']['subagents']>, 'history'> {
    const read = deps.store?.getSubagentMessages
    if (read === undefined) return {}
    return {
      async history(agentId, window) {
        const laneOf = (messages: readonly unknown[], hasOlder: boolean, skippedFromStart: number) => {
          const lane = replayClaudeSubagentLane(agentId, messages, { cwd: deps.cwd, debug: message => deps.host.debug(message) })
          return { events: lane.events, parentAgentId: lane.parentAgentId, uuids: lane.uuids, hasOlder, skippedFromStart }
        }
        if (window !== undefined) {
          // An older slice: [skipFromStart - count, skipFromStart) of the disk
          // transcript (the SDK paginates by offset from the START).
          const count = Math.max(1, Math.min(window.count, window.skipFromStart))
          const slice = await read(currentSessionId, agentId, { dir: deps.cwd, offset: window.skipFromStart - count, limit: count })
          return laneOf(slice, window.skipFromStart - count > 0, window.skipFromStart - slice.length)
        }
        // The newest page: one full read (bounded below), the tail kept.
        const all = await read(currentSessionId, agentId, { dir: deps.cwd })
        if (all.length <= SUBAGENT_TRANSCRIPT_PAGE) return laneOf(all, false, 0)
        return laneOf(all.slice(all.length - SUBAGENT_TRANSCRIPT_PAGE), true, all.length - SUBAGENT_TRANSCRIPT_PAGE)
      },
    }
  }

  /**
   * `/rename` (design §4.11): `renameSession()` writes the title into the
   * transcript (the browser and `claude --resume` read it), and the live
   * session reports it at once. Before the CLI wrote the transcript there is
   * no file to append to: the title is kept and written with the first
   * persisted frame.
   */
  function flushRename(): void {
    const title = pendingTitle
    const rename = deps.store?.renameSession
    if (title === undefined || rename === undefined || !persisted) return
    pendingTitle = undefined
    void rename(currentSessionId, title, { dir: deps.cwd }).catch((error: unknown) => {
      deps.host.debug(`claude: deferred rename failed (${errorText(error)})`)
      emit([{ type: 'notice', level: 'warning', text: t('rename-failed', { err: errorText(error) }) }])
    })
  }
  function renameCapability(): Pick<AgentSession['capabilities'], 'rename'> {
    const rename = deps.store?.renameSession
    if (rename === undefined) return {}
    return {
      rename: {
        async rename(title: string): Promise<void> {
          const trimmed = title.trim()
          if (trimmed === '') throw new Error(t('rename-usage'))
          if (persisted) await rename(currentSessionId, trimmed, { dir: deps.cwd })
          else pendingTitle = trimmed
          emit([{ type: 'session.title', title: trimmed, source: 'user' }])
        },
      },
    }
  }

  const session: AgentSession = {
    ref: ownRef,
    cwd: deps.cwd,
    get status(): AgentSessionStatus {
      if (status === 'disposed') return 'disposed'
      if (bridge.size > 0 || dialogs.size > 0) return 'requires-action'
      return translator.turnOpen ? 'running' : status
    },
    capabilities: {
      permissions: {
        respond: (requestId, decision) => bridge.respond(requestId, decision),
        pending: () => bridge.pendingViews(),
      },
      questions: {
        respond: (requestId, answers) => {
          if (dialogs.owns(requestId)) dialogs.respond(requestId, answers)
          else bridge.respondQuestion(requestId, answers)
        },
        cancel: requestId => {
          if (dialogs.owns(requestId)) dialogs.cancel(requestId)
          else bridge.cancelQuestion(requestId)
        },
      },
      ...controls.capabilities,
      ...sessionStoreCapabilities(),
      sideQuery: createClaudeSideQuery({
        sdk: deps.sdk,
        cwd: deps.cwd,
        sessionId: () => currentSessionId,
        persisted: () => persisted,
        model: () => translator.model,
        spawn: () => ({ env: authPlan.env, ...(authPlan.settings === undefined ? {} : { settings: authPlan.settings }), executable: deps.executable.path }),
        debug: deps.host.debug,
      }),
      ...renameCapability(),
      // Images go in the message itself (base64 blocks), staged by the
      // channel under these limits (images.ts).
      images: { limits: CLAUDE_IMAGE_LIMITS },
      color: {
        current: () => prefs.color(currentSessionId),
        set(color: string): void {
          prefs.setColor(currentSessionId, color)
          emit([{ type: 'session.color', color }])
        },
      },
      // Design §4.8: a subagent or background job is stopped by its task id
      // (`stopTask`; the CLI reports the stop as its notification).
      subagents: {
        interrupt: agentId => stopTask(agentId),
        ...subagentHistory(),
        // agent-team §5.2/§5.4: the parent-mediated message support — the
        // relay observations this session folds itself. The channel core
        // composes the submit path (directed instruction + fixed followup)
        // around this; the composer hides itself when the member is absent.
        message: { messages: () => [...agentMessages] },
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
        sessionId: () => currentSessionId,
        cwd: deps.cwd,
        configDir: () => claudeConfigDir(authPlan.env.CLAUDE_CONFIG_DIR === undefined ? process.env : authPlan.env),
        ...(compactedFrom === undefined ? {} : { compactedFrom }),
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
          get sessionId() { return currentSessionId },
          get cliVersion() { return cliVersion },
          get cliCapabilities() { return cliCapabilities },
        },
      },
      // The working-activity line this backend folds itself (activity.ts):
      // the channel subscribes per binding and forwards into the store the
      // DSH projection feed fills, so the UI's working line stays
      // backend-neutral. A late subscriber receives the latest value once —
      // a rebind shows the running line without waiting for a change.
      workingActivity: {
        subscribe(listener: (view: WorkingActivityView) => void) {
          activityListeners.add(listener)
          const last = activityPublisher.last()
          if (last !== undefined) listener(last)
          return () => { activityListeners.delete(listener) }
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
    // Handed over once: the channel paints it at adoption and never asks
    // again (a later call has nothing to repaint from memory).
    history: () => {
      const events = replayHistory ?? []
      replayHistory = undefined
      // The replay seed carries the SAME relay observations the live lane
      // emits (replay runs the same translator); fold them once here so a
      // resumed session's Messages page starts populated.
      foldAgentMessages(events)
      return Promise.resolve(events)
    },
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
      // Pasted images and `@image` mentions arrive as image blocks with their
      // staged facades (`input.images`, block order): each is read back and
      // sent as a base64 block after the text. An image block without its
      // facade (dropped from memory meanwhile) refuses the message — never
      // the text without part of it.
      const imageBlocks = (input.blocks ?? []).filter(block => block.type === 'image').length
      const staged = input.images ?? []
      if (imageBlocks > staged.length) throw new Error(t('claude-image-unreadable', { name: `#${staged.length + 1}`, err: t('claude-image-gone') }))
      const images = staged.length === 0 ? [] : await claudeImageBlocks(staged)
      // The read may straddle a reconnect: an authentication failure
      // stopped THIS run (its inbox is closed — temporarily, while the
      // renewal and the replacement handshake are in flight). Pass the
      // non-deferred gate again and only then judge: a deferred `/login`
      // reconnect still leaves the old CLI serving submits, so waiting for
      // it here would stall behind the running turn.
      if (reconnecting !== undefined && !reconnectDeferred) await reconnecting.catch(() => undefined)
      if (disposing || run.inbox.closed) throw new Error(t('claude-session-closed'))
      const texts = (input.blocks ?? [{ type: 'text', text: input.text }])
        .flatMap(block => block.type === 'text' && typeof block.text === 'string' && block.text !== '' ? [block.text] : [])
      const content = images.length === 0 && texts.length <= 1
        ? texts[0] ?? input.text
        : [...texts.map(text => ({ type: 'text' as const, text })), ...images]
      const priority = priorityOf(placement, translator.turnOpen)
      translator.registerInput(input.clientMessageId, input.text, placement, staged)
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
      // The session is going away; nothing queues behind a disposed CLI.
      if (disposing) return { stillQueued: [], outcome: 'unknown' }
      if (translator.turnOpen && forceTimer === undefined) {
        forceTimer = clock.setTimeout(() => {
          forceTimer = undefined
          if (disposing || !translator.turnOpen) return
          // The CLI never withdrew its prompts either: close the panels too.
          bridge.settleAll(WITHDRAWN_MESSAGE)
          dialogs.settleAll()
          emit([
            ...translator.forceCloseTurn({ kind: 'aborted' }),
            { type: 'notice', level: 'warning', text: t('claude-cancel-forced') },
            { type: 'session.status', status: 'requires-action' },
          ])
          settleIdleWaiters()
        }, forceSettleMs)
      }
      // An `interrupt` parks the queue in the channel (the dock) instead of
      // re-delivering it, so the queued inputs go with the turn when the CLI
      // can drop them; a user cancel keeps them (they run as the next turn).
      // A CLI without the capability keeps its queue and runs it — the
      // cancel receipt's `still_queued` tells the channel, which un-docks.
      const cancelQueued = cause !== 'user' && cliCapabilities.includes(CLI_CAPABILITY.interruptCancelQueued)
      // The queued-input previews this cancel covers and has not confirmed
      // deleted, snapshotted BEFORE the request fires: an input pushed while
      // the request is in flight belongs to a newer batch and never rides
      // this receipt. Without a confirmed `still_queued` answer the snapshot
      // IS the receipt's stillQueued — an answerless or failed interrupt
      // must never read as a definite empty queue (the dock would sell a
      // still-live backend copy as safe to re-send).
      const covered = translator.pendingInputs()
      // The documented `cancel_queued` interrupt field is reachable through
      // the runtime method's option bag (absent from the TS signature).
      const query = run.query
      const interrupt = query.interrupt as (options?: { cancelQueued?: boolean }) => Promise<unknown>
      try {
        const receipt = rec(await interrupt.call(query, cancelQueued ? { cancelQueued: true } : undefined))
        if (Array.isArray(receipt?.still_queued)) {
          // The receipt's `still_queued` is the CLI's live queue snapshot:
          // exactly the uuids that WILL still run (sdk.d.ts).
          const stillQueued = receipt.still_queued.filter((id): id is string => typeof id === 'string')
          return { stillQueued, outcome: 'confirmed' }
        }
        // An older CLI resolves interrupt() to undefined (sdk.d.ts): no
        // snapshot came back, nothing is confirmed deleted.
        return { stillQueued: covered, outcome: 'unknown' }
      } catch (error) {
        deps.host.debug(`claude: interrupt failed (${errorText(error)})`)
        return { stillQueued: covered, outcome: 'failed' }
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
