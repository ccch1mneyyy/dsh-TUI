/**
 * One Codex thread as an `AgentSession` (docs/codex-backend-design.md §5.6):
 * the thread's traffic on the shared hub connection goes through the live
 * translator to the channel; input, cancellation and prompts go back as
 * `turn/*` requests and server-request answers.
 *
 * - Open: create = `thread/start` (cwd, the start mode, a remembered model);
 *   resume = `thread/resume` with the newest page of turns in full, replayed
 *   into the session's `history()` before anything live (the live
 *   translator continues the replay's numbering). Traffic that arrives
 *   while the resume is in flight waits for the replay.
 * - Events produced before the channel subscribed (`session.ready`, start
 *   notices) are kept and delivered on subscribe.
 * - Status follows `thread/status/changed` (waiting on an approval or an
 *   answer = `requires-action`).
 * - Connection loss: the open turn closes as an error, prompts are
 *   withdrawn, the queue waits; a restarted child gets `thread/resume`
 *   (missed turns are backfilled in C3).
 * - Dispose: withdraw prompts, interrupt a running turn, unsubscribe,
 *   detach and release the hub. Idempotent.
 */
import type { AgentEvent, AgentEventMeta } from '../../../agent/events.js'
import type { AgentSessionRef } from '../../../agent/refs.js'
import type { AgentInput, AgentSession, AgentSessionStatus, CancelCause, SubmitPlacement } from '../../../agent/session.js'
import { t } from '../../../i18n.js'
import { CODEX_BACKEND_ID, codexVersionDrift, VALIDATED_CODEX_VERSIONS } from '../contract.js'
import { CODEX_MODE_PARAMS, DEFAULT_CODEX_MODE, modeIdOf, type CodexModeId } from '../modes.js'
import { arr, errorText, num, rec, str, text, type Rec } from '../narrow.js'
import { CLIENT, NOTIFY } from '../protocol/index.js'
import { REAL_CLOCK, rpcCode, RPC_ERROR } from '../rpc/client.js'
import type { HubServerRequest, ThreadSink } from '../rpc/hub.js'
import { createItemContext } from '../translate/items.js'
import { createLiveTranslator, wakeOf, type SettingsSnapshot } from '../translate/live.js'
import { warningNotice } from '../translate/notices.js'
import { rateLimitOf } from '../translate/usage.js'
import { createApprovalBridge } from './approvals.js'
import { INITIAL_TURNS_PAGE, replayResumePage } from './history.js'
import { createInputQueue } from './input.js'
import type { CodexSessionDeps, OpenedThread } from './state.js'

type Listener = (batch: readonly AgentEvent[], meta: AgentEventMeta) => void

/** How long an interrupt may go unanswered before the turn closes here. */
const DEFAULT_FORCE_SETTLE_MS = 15_000

/** The thread facts of a `thread/start` / `thread/resume` answer. */
export function openedThread(response: Rec, fallbackCwd: string): OpenedThread {
  const thread = rec(response.thread) ?? {}
  const effort = response.reasoningEffort === null ? null : str(response.reasoningEffort) ?? null
  const name = text(thread.name)
  return {
    threadId: str(thread.id) ?? '',
    cwd: str(response.cwd) ?? str(thread.cwd) ?? fallbackCwd,
    model: str(response.model) ?? str(thread.model) ?? '',
    provider: str(response.modelProvider) ?? str(thread.modelProvider) ?? '',
    effort,
    modeId: modeIdOf(response.approvalPolicy, response.sandbox),
    ...(name === undefined ? {} : { title: name }),
    running: str(rec(thread.status)?.type) === 'active',
  }
}

/** A JSON-RPC failure of the open as a user-facing sentence (C0 V15). */
export function openFailureText(error: unknown, threadId: string | undefined): string {
  const message = errorText(error)
  if (/already has an active writer/iu.test(message)) return t('codex-thread-busy', { id: threadId ?? '' })
  if (threadId !== undefined && rpcCode(error) === RPC_ERROR.invalidRequest) return t('codex-resume-not-found', { id: threadId, err: message })
  return message
}

/** Open (create or resume) a thread and wrap it as a session. Throws a
 *  user-facing sentence when the thread cannot be opened; the hub retain is
 *  released then. */
export async function openCodexSession(deps: CodexSessionDeps): Promise<AgentSession> {
  const { hub } = deps
  const clock = deps.clock ?? REAL_CLOCK
  const debug = deps.host.debug
  const prefs = deps.prefs.read()
  const startMode: CodexModeId = prefs.mode ?? DEFAULT_CODEX_MODE
  const modeParams = CODEX_MODE_PARAMS[startMode]

  // Traffic for a resumed thread can arrive before the resume answers; it is
  // held until the replay fixed the numbering.
  const held: (() => void)[] = []
  let sink: ThreadSink | undefined
  const holding: ThreadSink = {
    notification: (method, params) => { held.push(() => sink?.notification(method, params)) },
    serverRequest: request => { held.push(() => sink?.serverRequest(request)) },
    connectionLost: (error, permanent) => { held.push(() => sink?.connectionLost(error, permanent)) },
    connectionRestored: () => { held.push(() => sink?.connectionRestored()) },
  }

  let response: Rec
  let detach: (() => void) | undefined
  try {
    if (deps.target.kind === 'resume') {
      detach = hub.attach(deps.target.sessionId, holding)
      response = rec(await hub.call(CLIENT.threadResume, {
        threadId: deps.target.sessionId,
        excludeTurns: true,
        initialTurnsPage: INITIAL_TURNS_PAGE,
        approvalPolicy: modeParams.approvalPolicy,
        sandbox: modeParams.sandbox,
        ...(deps.target.cwd === undefined ? {} : { cwd: deps.target.cwd }),
        ...(prefs.model === undefined ? {} : { model: prefs.model }),
      })) ?? {}
    } else {
      response = rec(await hub.call(CLIENT.threadStart, {
        cwd: deps.cwd,
        approvalPolicy: modeParams.approvalPolicy,
        sandbox: modeParams.sandbox,
        ...(prefs.model === undefined ? {} : { model: prefs.model }),
        ...(prefs.effort === undefined ? {} : { config: { model_reasoning_effort: prefs.effort } }),
      })) ?? {}
    }
  } catch (error) {
    detach?.()
    deps.release()
    throw new Error(openFailureText(error, deps.target.kind === 'resume' ? deps.target.sessionId : undefined), { cause: error })
  }
  const opened = openedThread(response, deps.cwd)
  if (opened.threadId === '') {
    detach?.()
    deps.release()
    throw new Error(t('codex-open-failed', { err: 'no thread id' }))
  }
  const threadId = opened.threadId

  const ctx = createItemContext({ cwd: opened.cwd, debug, model: opened.model, ...(deps.now === undefined ? {} : { now: deps.now }) })
  const settings: SettingsSnapshot = { model: opened.model, effort: opened.effort, modeId: opened.modeId }
  // The replay fixes the numbering before any live event (resume only).
  let replayHistory: readonly AgentEvent[] | undefined = deps.target.kind === 'resume' ? replayResumePage(response, ctx).events : []
  const live = createLiveTranslator(ctx, settings)

  const listeners = new Set<Listener>()
  const backlog: [readonly AgentEvent[], AgentEventMeta][] = []
  let status: AgentSessionStatus = opened.running ? 'running' : 'idle'
  let disposing = false
  let disposePromise: Promise<void> | undefined
  let connected = true
  let permanentlyLost = false
  /** The last aggregated diff of a turn (`/diff`, C2). */
  let lastDiff: string | undefined
  let bubblewrapWarned = deps.doctor?.bubblewrapMissing === true

  const emit = (events: readonly AgentEvent[], wake: AgentEventMeta['wake'] = 'sync', duringDispose = false): void => {
    if ((disposing && !duringDispose) || events.length === 0) return
    for (const event of events) {
      if (event.type === 'session.status' && event.status !== 'disposed' && !disposing) status = event.status
    }
    const meta: AgentEventMeta = { replay: false, wake }
    if (listeners.size === 0) {
      backlog.push([events, meta])
      return
    }
    for (const listener of [...listeners]) {
      try {
        listener(events, meta)
      } catch (error) {
        debug(`codex: listener failed (${errorText(error)})`)
      }
    }
  }

  const input = createInputQueue({
    threadId,
    call: (method, params) => hub.call(method, params),
    emit: events => emit(events),
    debug,
    overrides: () => ({}),
    closed: () => disposing || permanentlyLost,
    forceClose: () => emit(live.forceClose({ kind: 'interrupted' })),
    clock,
    forceSettleMs: deps.forceSettleMs ?? DEFAULT_FORCE_SETTLE_MS,
  })
  if (opened.running) {
    // A resumed thread mid-turn: the newest turn of the page is the running one.
    const newest = rec(arr(rec(response.initialTurnsPage)?.data)[0])
    const id = str(newest?.id)
    if (id !== undefined && str(newest?.status) === 'inProgress') input.onTurnStarted(id)
  }

  const approvals = createApprovalBridge({
    cwd: opened.cwd,
    emit: events => emit(events, 'sync', true),
    debug,
    enqueueFollowup: (id, followup) => input.enqueueFollowup(id, followup),
    interruptTurn: () => { void input.interrupt() },
  })

  sink = {
    notification(method: string, params: Rec): void {
      if (disposing) return
      const before: AgentEvent[] = []
      switch (method) {
        case NOTIFY.turnStarted: {
          const id = str(rec(params.turn)?.id)
          if (id !== undefined) input.onTurnStarted(id)
          break
        }
        case NOTIFY.itemStarted: {
          const item = rec(params.item)
          const clientId = item?.type === 'userMessage' ? str(item.clientId) : undefined
          if (clientId !== undefined) {
            const claimed = input.claim(clientId)
            if (claimed !== undefined) before.push(claimed)
          }
          break
        }
        case NOTIFY.turnDiffUpdated:
          lastDiff = str(params.diff) ?? lastDiff
          return
        case NOTIFY.serverRequestResolved:
          approvals.resolved(params.requestId)
          return
        default:
          break
      }
      const events = live.notification(method, params)
      if (method === NOTIFY.itemCompleted) {
        const itemId = str(rec(params.item)?.id)
        if (itemId !== undefined) approvals.itemCompleted(itemId)
      }
      if (method === NOTIFY.turnCompleted) {
        approvals.turnEnded()
        const turn = rec(params.turn)
        emit([...before, ...events], wakeOf(method, events))
        input.onTurnCompleted(str(turn?.id), str(turn?.status) === 'interrupted')
        return
      }
      emit([...before, ...events], wakeOf(method, [...before, ...events]))
    },
    serverRequest(request: HubServerRequest): void {
      if (disposing) {
        request.respondError(RPC_ERROR.internal, 'the session is closing')
        return
      }
      approvals.onRequest(request)
    },
    connectionLost(error: Error, permanent: boolean): void {
      if (disposing) return
      connected = false
      permanentlyLost = permanent
      approvals.withdrawAll()
      emit([
        ...live.forceClose({ kind: 'error', message: errorText(error) }),
        ...input.connectionLost(),
        { type: 'notice', level: permanent ? 'error' : 'warning', key: 'codex-connection', text: permanent ? t('codex-connection-failed', { err: errorText(error) }) : t('codex-connection-lost') },
        { type: 'session.status', status: 'idle' },
      ])
    },
    connectionRestored(): void {
      if (disposing) return
      void hub.call(CLIENT.threadResume, { threadId, excludeTurns: true }).then(() => {
        connected = true
        emit([{ type: 'notice', level: 'info', key: 'codex-connection', text: t('codex-reconnected') }])
        input.connectionRestored()
      }, (error: unknown) => {
        debug(`codex: resubscribe after restart failed (${errorText(error)})`)
        emit([{ type: 'notice', level: 'error', key: 'codex-connection', text: t('codex-connection-failed', { err: errorText(error) }) }])
      })
    },
  }
  detach?.()
  detach = hub.attach(threadId, sink)
  for (const deliver of held.splice(0)) deliver()

  // Thread-less traffic this session reads: rate limits, configuration
  // warnings that are not sandbox noise.
  const offGlobal = hub.onGlobal((method, params) => {
    if (disposing) return
    if (method === NOTIFY.accountRateLimitsUpdated) {
      const { view, reached } = rateLimitOf(params)
      const events: AgentEvent[] = []
      if (view !== undefined) events.push({ type: 'rate-limit', info: view })
      if (reached !== undefined) events.push({ type: 'notice', level: 'warning', key: 'codex-rate-limit', text: t('codex-rate-limit-reached', { kind: reached }) })
      emit(events)
      return
    }
    if (method === NOTIFY.configWarning || method === NOTIFY.warning || method === NOTIFY.deprecationNotice) {
      const summary = str(params.summary) ?? str(params.message) ?? ''
      if (method === NOTIFY.configWarning && /bubblewrap/iu.test(summary)) {
        bubblewrapWarned = true
        return
      }
      const notice = warningNotice(method, params)
      if (notice !== undefined) emit([notice])
    }
  })

  const ref: AgentSessionRef = { backendId: CODEX_BACKEND_ID, sessionId: threadId }
  const version = deps.executable.version
  const drift = codexVersionDrift(version)
  const window = num(rec(response.thread)?.modelContextWindow)
  emit([{
    type: 'session.ready',
    sessionId: threadId,
    cwd: opened.cwd,
    model: opened.model,
    ...(opened.provider === '' ? {} : { provider: opened.provider }),
    ...(opened.title === undefined ? {} : { title: opened.title }),
    permissionMode: opened.modeId,
    ...(opened.effort === null ? {} : { effort: opened.effort }),
    ...(window === undefined ? {} : { contextWindow: window }),
    ...(version === undefined ? {} : { backendVersion: version }),
  }])
  for (const notice of deps.startNotices ?? []) emit([{ type: 'notice', level: 'warning', text: notice }])
  if (drift !== undefined) emit([{ type: 'notice', level: 'warning', key: 'codex-drift', text: t('codex-version-drift', { version: drift, validated: VALIDATED_CODEX_VERSIONS.join(', ') }) }])
  emit([{ type: 'mode.changed', modeId: opened.modeId }], 'none')
  if (opened.effort !== null) emit([{ type: 'effort.changed', effort: opened.effort }], 'none')
  if (opened.running) emit([{ type: 'session.status', status: 'running' }], 'none')

  const session: AgentSession = {
    ref,
    cwd: opened.cwd,
    get status(): AgentSessionStatus {
      if (disposing) return 'disposed'
      return status
    },
    capabilities: {
      native: {},
      permissions: {
        respond: (requestId, decision) => approvals.respond(requestId, decision),
        pending: () => approvals.pendingViews(),
      },
      questions: {
        respond: (requestId, answers) => approvals.respondQuestion(requestId, answers),
        cancel: requestId => approvals.cancelQuestion(requestId),
      },
      pendingRetraction: { remove: id => input.remove(id) },
      diagnostics: {
        lines: (): readonly string[] => [
          t('codex-doctor-cli', { path: deps.executable.path, source: deps.executable.source, version: version ?? t('doctor-unknown') }),
          ...(drift === undefined ? [] : [t('codex-version-drift', { version: drift, validated: VALIDATED_CODEX_VERSIONS.join(', ') })]),
          t('codex-doctor-home', { home: hub.info?.codexHome ?? t('doctor-unknown') }),
          t('codex-doctor-thread', { id: threadId, provider: opened.provider === '' ? t('doctor-unknown') : opened.provider, model: settings.model === '' ? t('doctor-unknown') : settings.model }),
          t('codex-doctor-mode', { mode: settings.modeId }),
          ...(connected ? [] : [t('codex-connection-lost')]),
          ...((bubblewrapWarned || deps.doctor?.bubblewrapMissing === true) && process.platform === 'linux' ? [t('codex-doctor-bubblewrap')] : []),
        ],
      },
    },
    history(): Promise<readonly AgentEvent[]> {
      const events = replayHistory ?? []
      replayHistory = undefined
      return Promise.resolve(events)
    },
    subscribe(listener: Listener) {
      listeners.add(listener)
      if (backlog.length > 0) {
        queueMicrotask(() => {
          if (!listeners.has(listener)) return
          for (const [events, meta] of backlog.splice(0)) listener(events, meta)
        })
      }
      return () => { listeners.delete(listener) }
    },
    submit(next: AgentInput, placement: SubmitPlacement) {
      if (disposing) return Promise.reject(new Error(t('codex-session-closed')))
      if (permanentlyLost) return Promise.reject(new Error(t('codex-connection-failed', { err: '' })))
      return input.submit(next, placement)
    },
    async cancel(cause: CancelCause) {
      if (disposing) return { stillQueued: [], outcome: 'unknown' }
      if (cause === 'switch' || cause === 'dispose') approvals.withdrawAll()
      return input.cancel(cause)
    },
    dispose(): Promise<void> {
      if (disposePromise !== undefined) return disposePromise
      disposePromise = (async () => {
        approvals.withdrawAll()
        const busy = input.busy()
        disposing = true
        if (busy) await input.interrupt().catch(() => false)
        input.close()
        offGlobal()
        try {
          await hub.call(CLIENT.threadUnsubscribe, { threadId }, { timeoutMs: 5000 })
        } catch (error) {
          debug(`codex: unsubscribe failed (${errorText(error)})`)
        }
        detach?.()
        deps.release()
        emit([{ type: 'session.status', status: 'disposed' }], 'none', true)
        listeners.clear()
        backlog.length = 0
      })()
      return disposePromise
    },
  }
  return session
}
