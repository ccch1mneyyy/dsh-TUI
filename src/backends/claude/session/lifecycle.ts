/**
 * One Claude Agent session: a single long-lived streaming-input `query()` per session, fed by a
 * push-based inbox, consumed by one loop that translates every SDK message
 * and hands the batch to the channel.
 *
 * - Input placement: `steer` → `priority:'next'` (joins
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
 * - Permissions: the permission bridge (`permissions.ts`) parks
 *   every `canUseTool` prompt and announces it as `permission.request` /
 *   `question.request`; the user's answer returns through the
 *   `permissions` / `questions` capabilities. While prompts are parked the
 *   session is `requires-action`. Pending prompts are always settled: on
 *   answer, on the SDK's abort signal, at a forced turn close, on dispose.
 * - MCP elicitation and the CLI's user dialogs (dialogs.ts) park
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
import type { AccountView } from '../../../agent/capabilities.js'
import type { WorkingActivityView } from '../../../adapter/ports/channel-view.js'
import type { AgentEvent, AgentEventMeta } from '../../../agent/events.js'
import type { AgentSessionRef } from '../../../agent/refs.js'
import type { AgentInput, AgentSession, AgentSessionStatus, CancelCause, SubmitPlacement } from '../../../agent/session.js'
import { t } from '../../../i18n.js'
import { CLAUDE_BACKEND_ID, CLI_CAPABILITY, cliVersionDrift, VALIDATED_CLI_VERSIONS, VALIDATED_SDK_VERSION } from '../contract.js'
import { isAuthFailure, type ClaudeAuthPlan, CLAUDE_OAUTH_PROVIDER } from '../auth.js'
import { accountView } from '../controls.js'
import { buildQueryOptions, type StartPermissionMode } from '../options.js'
import { createClaudeDialogBridge, SUPPORTED_DIALOG_KINDS } from '../dialogs.js'
import { createClaudeActivityPublisher } from '../activity.js'
import { createClaudePermissionBridge, WITHDRAWN_MESSAGE } from '../permissions.js'
import { createStderrSink } from '../process.js'
import { memoryClaudePrefs } from '../prefs.js'
import { fileClaudeChannels } from '../channels.js'
import { fileClaudeChannelTokens } from '../../shared/channel-tokens.js'
import { createClaudeTranscriptHistory } from '../older-history.js'
import { join } from 'node:path'
import { DATA_DIR } from '../../../utils/paths.js'
import { envSlotsServeModel, mergedModelEnv } from '../modelEnv.js'
import { claudeConfigDir } from '../transcript-file.js'
import { CLAUDE_IMAGE_LIMITS, claudeImageBlocks } from '../images.js'
import { createClaudeSideQuery } from '../side-query.js'
import { writeFlagSettingsFile } from '../flag-settings.js'
import { createClaudeTranslator } from '../translate.js'
import { errorText, rec, type Rec } from '../narrow.js'
import { accountLines, authSourceLabel, createSessionAuth } from './auth.js'
import { createSessionControls } from './channels.js'
import { createInbox, priorityOf, wakeOf } from './input.js'
import { createSessionStore } from './store.js'
import { sessionTaskCapabilities } from './subagents.js'
import type { ClaudeClock, ClaudeSessionDeps, Run } from './types.js'

const REAL_CLOCK: ClaudeClock = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref()
    return handle
  },
  clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

type Listener = (batch: readonly AgentEvent[], meta: AgentEventMeta) => void

/** The CLI's answer to `resume` of a session it has no transcript for. */
const NO_CONVERSATION = /No conversation found with session ID/iu

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
  let settlingPrompts = false
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
  /** The CLI's config directory under the live plan's environment. */
  const configDir = (): string => claudeConfigDir(authPlan.env.CLAUDE_CONFIG_DIR === undefined ? process.env : authPlan.env)
  /** The model-routing env the CLI child applies (modelEnv.ts), read per
   *  run so a reconnect's renewed plan counts. */
  const childModelEnv = (): Record<string, string | undefined> => mergedModelEnv(
    configDir(),
    authPlan.env,
    new Set(Object.keys(authPlan.settings?.env ?? {})),
  )

  let authFailed = false
  /**
   * The CLI wrote this session's transcript (an input started, or a turn
   * reported its result). Until then a restart must create the session with
   * the same id: `resume` of an id the CLI has no transcript for fails its
   * handshake ("No conversation found").
   */
  let persisted = resumed

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
    // A resumed session continues the replay's numbering and task table.
    ...(resume === undefined ? {} : { start: { ...resume.start, ...(resume.tasks === undefined || resume.tasks.length === 0 ? {} : { tasks: resume.tasks }) } }),
  })
  translator.noteMode(deps.start.mode)

  // The working line's publisher (activity.ts): folded from the translator's
  // own state after every batch, never from a second parse of the stream. A
  // parked permission/dialog prompt is the waiting phase; the fold dedupes,
  // so folding after every emit publishes only real changes.
  const activityPublisher = createClaudeActivityPublisher()
  const publishActivity = (): void => {
    activityPublisher.fold(translator.activityState(), asking || dialogsOpen)
  }

  const emit = (events: readonly AgentEvent[], wake: AgentEventMeta['wake'] = 'sync', duringDispose = false): void => {
    if (disposing && !duringDispose) return
    if (events.length === 0) return
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

  /** Prompts are parked: the session needs the user. Only
   *  transitions are announced; the CLI's own `session_state_changed`
   *  frames say the same and are idempotent with these. */
  let asking = false
  const bridge = createClaudePermissionBridge({
    cwd: deps.cwd,
    emit: events => emit(events, 'sync', settlingPrompts),
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
    emit: events => emit(events, 'sync', settlingPrompts),
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

  const startRun = (resume: boolean): Run => {
    const inbox = createInbox<SDKUserMessage>()
    const abortController = new AbortController()
    const startModel = prefs.read().model ?? deps.model
    // The CLI checks an explicit `model` against its official catalog and
    // refuses a relay model name (`[claude-code:unrecognized_model]`), while
    // the same name in an env slot (ANTHROPIC_MODEL /
    // ANTHROPIC_DEFAULT_<TIER>_MODEL) routes fine. When the child's env
    // already routes to the model, the parameter is left out; anything
    // else is still pinned explicitly.
    const explicitModel = startModel !== undefined && envSlotsServeModel(childModelEnv(), startModel)
      ? undefined
      : startModel
    const startEffort = prefs.read().effort ?? deps.effort
    // The plan's flag layer (a channel token may ride it) goes by file, out
    // of the CLI's argv; it lives as long as this run.
    const flagSettings = authPlan.settings === undefined ? undefined : writeFlagSettingsFile(authPlan.settings)
    let query: Run['query']
    try {
      query = deps.sdk.query({
        prompt: inbox,
        options: buildQueryOptions({
          cwd: deps.cwd,
          // A reconnect resumes the same session (same id, same transcript);
          // the SDK refuses `sessionId` together with `resume`.
          ...(resume ? { resume: currentSessionId } : { sessionId: currentSessionId }),
          permissionMode: (translator.mode ?? deps.start.mode) as StartPermissionMode['mode'],
          executable: deps.executable.path,
          env: authPlan.env,
          ...(flagSettings === undefined ? {} : { settingsFile: flagSettings.path }),
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
    } catch (error) {
      flagSettings?.dispose()
      throw error
    }
    return { inbox, abortController, query, ...(flagSettings === undefined ? {} : { flagSettings }), consumer: Promise.resolve() }
  }
  let run = startRun(resumed)

  /** Shut one run's CLI down; safe to call from any state. */
  const stopRun = (target: Run): void => {
    target.inbox.close()
    try { target.query.close() } catch (error) { deps.host.debug(`claude: close failed (${errorText(error)})`) }
    target.abortController.abort()
    target.flagSettings?.dispose()
  }

  /** This session in the backend's reference vocabulary (its id follows a
   *  conversation reset). */
  const ownRef: AgentSessionRef = { backendId: CLAUDE_BACKEND_ID, get sessionId() { return currentSessionId } }
  const store = createSessionStore({
    deps,
    ownRef,
    emit,
    get run() { return run },
    get persisted() { return persisted },
    get currentSessionId() { return currentSessionId },
  })

  /** Shut the session down; safe to call from any state. */
  const teardown = (): void => {
    clearForceTimer()
    // Pending prompt settlements must reach the channel before the query closes.
    settlingPrompts = true
    bridge.settleAll()
    dialogs.settleAll()
    settlingPrompts = false
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
    ], 'sync', true)
    settleIdleWaiters(new Error(t('claude-session-closed')))
  }

  const fetchAccount = (target: Run): void => {
    const query = target.query as Partial<Pick<Query, 'accountInfo'>>
    if (typeof query.accountInfo !== 'function') return
    void query.accountInfo().then(info => { if (target === run) account = info }, (error: unknown) => {
      deps.host.debug(`claude: accountInfo failed (${errorText(error)})`)
    })
  }

  /** Seed the model before any UI asks for it, with `startRun`'s priority:
   *  the persisted choice, the start model, else what the handshake says
   *  (its `model`, else the `default` catalog row's resolved model). Only
   *  an empty model is seeded: a resumed session keeps the replay's, and a
   *  reconnect keeps a model the user switched to. */
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
    // Capabilities come from this handshake alone (a run that reports none
    // must not inherit the previous CLI's): without `msg_lifecycle_v1` user
    // rows come from the replay echo.
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
    // After a reset the CLI runs under a new session id, named by the frames
    // that follow (not by the reset frame's `new_conversation_id`).
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
      store.flushRename()
    }
    // While a reconnect is renewing the credential, the old CLI's late
    // failing turn is the failure being handled, not a new one.
    if (auth.reconnecting === undefined && isAuthFailure(message)) authFailed = true
    if (value?.type === 'result') {
      if (auth.reconnecting !== undefined) {
        authFailed = false
      } else if (authFailed) {
        authFailed = false
        auth.onAuthFailure()
      } else if (value.is_error !== true) {
        auth.attempts = 0
      }
      // Forget pushes the CLI has started (only unstarted ones are kept).
      const unstarted = new Set(translator.unstartedInputs())
      for (const uuid of pushed.keys()) if (!unstarted.has(uuid)) pushed.delete(uuid)
    }
    for (const event of events) {
      // Every confirmation of the model (a re-init's `model.changed`, the
      // first init's `session.ready`, a `message_start` drift) re-checks
      // the effort against what that model declares (controls.ts).
      if ((event.type === 'model.changed' || event.type === 'session.ready') && event.model !== '') {
        controls.noteConfirmedModel(event.model)
      }
      if (event.type !== 'session.ready' || event.backendVersion === undefined || cliVersion !== undefined) continue
      cliVersion = event.backendVersion
      // Drift is reported, never a stop.
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

  const auth = createSessionAuth({
    deps,
    clock,
    translator,
    pushed,
    idleWaiters,
    idle,
    stopForReconnect,
    openRun,
    emit,
    consume,
    onExit,
    stopRun,
    get run() { return run },
    get disposing() { return disposing },
    get authPlan() { return authPlan },
    set authPlan(value) { authPlan = value },
    get account() { return account },
    get apiKeySource() { return apiKeySource },
  })
  const controls = createSessionControls({
    deps,
    prefs,
    channels,
    channelTokens,
    translator,
    configDir,
    emit,
    get run() { return run },
    get authPlan() { return authPlan },
    get session() { return session },
  })

  try {
    const init = await handshake(run)
    controls.seed(init)
    // The model the session opened with is confirmed too (a resumed
    // session's replay model is never re-announced by a frame): with the
    // catalog seeded, the effort readout is checked before any UI asks.
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
  // The remembered effort level, same way: the CLI reports none back, so the
  // status line's effort readout would stay empty until the first /effort
  // switch without this seed.
  const seedEffort = prefs.read().effort ?? deps.effort
  if (seedEffort !== undefined) emit([{ type: 'effort.changed', effort: seedEffort }], 'none')
  // The session's `/color` accent (kept TUI-side per session id).
  const startColor = prefs.color(currentSessionId)
  if (startColor !== '') emit([{ type: 'session.color', color: startColor }])
  run.consumer = consume(run)
  // A resumed transcript does not record the context window: ask the CLI
  // once, so the status line has it before the first `result`.
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

  const session: AgentSession = {
    ref: ownRef,
    cwd: deps.cwd,
    get status(): AgentSessionStatus {
      if (status === 'disposed') return 'disposed'
      if (bridge.size > 0 || dialogs.size > 0) return 'requires-action'
      return translator.turnOpen ? 'running' : status
    },
    capabilities: {
      native: {},
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
      ...store.sessionStoreCapabilities(),
      sideQuery: createClaudeSideQuery({
        sdk: deps.sdk,
        cwd: deps.cwd,
        sessionId: () => currentSessionId,
        persisted: () => persisted,
        model: () => translator.model,
        spawn: () => ({ env: authPlan.env, ...(authPlan.settings === undefined ? {} : { settings: authPlan.settings }), executable: deps.executable.path }),
        debug: deps.host.debug,
      }),
      ...store.renameCapability(),
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
      ...sessionTaskCapabilities({
        deps,
        translator,
        get run() { return run },
        get disposing() { return disposing },
        get currentSessionId() { return currentSessionId },
        get authPlan() { return authPlan },
      }),
      transcript: createClaudeTranscriptHistory({
        sessionId: () => currentSessionId,
        cwd: deps.cwd,
        configDir,
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
        status: auth.authStatus,
        async reconnect(): Promise<void> {
          auth.attempts = 0
          // Never under a running turn: the restart would abort it and drop
          // what the user queued behind it. Reconnect once it ends.
          if (!idle()) emit([{ type: 'notice', level: 'info', text: t('claude-auth-reconnect-deferred') }])
          await auth.reconnect({}, { waitIdle: true })
        },
      },
      // The working-activity line this backend folds itself (activity.ts):
      // the channel subscribes per binding and forwards into the store the
      // DSH projection feed fills, so the UI's working line stays
      // backend-neutral. A late subscriber receives the latest value once —
      // a rebind shows the running line without waiting for a change.
      workingActivity: {
        subscribe(listener: (view: WorkingActivityView) => void) {
          return activityPublisher.subscribe(view => {
            try {
              listener(view)
            } catch (error) {
              deps.host.debug(`claude: activity listener failed (${errorText(error)})`)
            }
          })
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
      if (auth.reconnecting !== undefined && !auth.reconnectDeferred) await auth.reconnecting.catch(() => undefined)
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
      // An auth-failure reconnect may have started during the read (this
      // run's inbox is then closed until the replacement is up): wait for
      // it again before judging. A deferred `/login` reconnect is not waited
      // for; the old CLI keeps serving until it swaps.
      if (auth.reconnecting !== undefined && !auth.reconnectDeferred) await auth.reconnecting.catch(() => undefined)
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
      translator.clearInterruptedCalls()
      const cancelQueued = cause !== 'user' && cliCapabilities.includes(CLI_CAPABILITY.interruptCancelQueued)
      // The queued inputs this cancel covers, taken before the request (an
      // input pushed meanwhile belongs to a newer batch). Without a
      // `still_queued` answer they are reported as still queued: a failed
      // or answerless interrupt must not read as an empty queue, or the
      // dock would offer to re-send inputs the CLI still holds.
      const covered = translator.pendingInputs()
      // The documented `cancel_queued` interrupt field is reachable through
      // the runtime method's option bag (absent from the TS signature).
      const query = run.query
      const interrupt = query.interrupt as (options?: { cancelQueued?: boolean }) => Promise<unknown>
      try {
        const receipt = rec(await interrupt.call(query, cancelQueued ? { cancelQueued: true } : undefined))
        if (Array.isArray(receipt?.still_queued)) {
          // The receipt's `still_queued` is the CLI's live queue snapshot:
          // exactly the uuids that will still run (sdk.d.ts).
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
        if (!wasDisposed) emit([{ type: 'session.status', status: 'disposed' }], 'none', true)
        settleIdleWaiters(new Error(t('claude-session-closed')))
        listeners.clear()
        backlog.length = 0
      })()
      return disposePromise
    },
  }
  return session
}
