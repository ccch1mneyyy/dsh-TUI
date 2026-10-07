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
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentEventMeta } from '../../../agent/events.js'
import type { AgentSessionRef } from '../../../agent/refs.js'
import type { AgentInput, AgentSession, AgentSessionStatus, CancelCause, SubmitPlacement } from '../../../agent/session.js'
import { t } from '../../../i18n.js'
import { CODEX_BACKEND_ID, codexVersionDrift, VALIDATED_CODEX_VERSIONS } from '../contract.js'
import { CODEX_MODE_PARAMS, DEFAULT_CODEX_MODE, isCodexModeId, modeIdOf } from '../modes.js'
import { arr, errorText, num, rec, str, text, type Rec } from '../narrow.js'
import { CLIENT, NOTIFY } from '../protocol/index.js'
import { REAL_CLOCK, rpcCode, RPC_ERROR } from '../rpc/client.js'
import { threadOf, type HubServerRequest, type ThreadSink } from '../rpc/hub.js'
import { createItemContext } from '../translate/items.js'
import { createLiveTranslator, wakeOf, type SettingsSnapshot } from '../translate/live.js'
import { warningNotice } from '../translate/notices.js'
import { rateLimitOf } from '../translate/usage.js'
import { resolveCodexStartOptions } from '../prefs.js'
import { createCodexAuthCapability } from '../auth/status.js'
import { createApprovalBridge } from './approvals.js'
import { createCodexControls } from './controls.js'
import { createCodexCommands } from './commands.js'
import { createPlanReview, PLAN_IMPLEMENTATION_PROMPT } from './plan-review.js'
import { PLAN_CLEAR_CONTEXT_PREFIX } from './prompts.js'
import { createToolOutputBuffer } from './tool-output.js'
import { createCodexSideQuery } from './side-query.js'
import { createCodexActivity } from './activity.js'
import { createCodexGoals } from './goals.js'
import { createCodexTasks } from './tasks.js'
import { createCodexSubagents } from './subagents.js'
import { INITIAL_TURNS_PAGE, createCodexTranscriptHistory } from './history.js'
import { CODEX_IMAGE_LIMITS } from './images.js'
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
    modeId: rec(response.collaborationMode)?.mode === 'plan' ? 'plan' : modeIdOf(response.approvalPolicy, response.sandbox),
    permissionMode: modeIdOf(response.approvalPolicy, response.sandbox),
    approvalPolicy: response.approvalPolicy,
    sandboxPolicy: response.sandboxPolicy ?? response.sandbox,
    collaborationMode: rec(response.collaborationMode),
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
  const startOverrides = resolveCodexStartOptions(prefs, deps.config)

  // Traffic for a resumed thread can arrive before the resume answers; it is
  // held until the replay fixed the numbering.
  const held: (() => void)[] = []
  let sink: ThreadSink | undefined
  const holding: ThreadSink = {
    notification: (method, params) => { held.push(() => sink?.notification(method, params)) },
    serverRequest: request => { held.push(() => sink?.serverRequest(request)) },
    connectionLost: (error, permanent) => { held.push(() => sink?.connectionLost(error, permanent)) },
    connectionRestored: () => { held.push(() => sink?.connectionRestored()) },
    diagnostic: entry => { held.push(() => sink?.diagnostic?.(entry)) },
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
        ...startOverrides,
        ...(deps.target.cwd === undefined ? {} : { cwd: deps.target.cwd }),
      })) ?? {}
    } else {
      response = rec(await hub.call(CLIENT.threadStart, {
        cwd: deps.cwd,
        ...startOverrides,
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
  let threadId = opened.threadId

  const ctx = createItemContext({ cwd: opened.cwd, debug, model: opened.model, ...(deps.now === undefined ? {} : { now: deps.now }) })
  const settings: SettingsSnapshot = { model: opened.model, effort: opened.effort, modeId: opened.modeId, permissionMode: opened.permissionMode, approvalPolicy: opened.approvalPolicy, sandboxPolicy: opened.sandboxPolicy, collaborationMode: opened.collaborationMode }
  /** What a resubscribe sends: the same overrides the open sent, as they
   *  stand now (the mode and model the session runs). */
  const resumeOverrides = (): Rec => ({
    ...(isCodexModeId(settings.permissionMode) ? CODEX_MODE_PARAMS[settings.permissionMode] : {}),
    ...(settings.effort === null ? {} : { config: { model_reasoning_effort: settings.effort } }),
    ...(settings.model === '' ? {} : { model: settings.model }),
  })
  // The replay fixes the numbering before any live event (resume only).
  const historyResponse = deps.target.kind === 'resume' ? response : { initialTurnsPage: { data: [], nextCursor: null } }
  let history = createCodexTranscriptHistory({ hub, get threadId() { return threadId }, cwd: opened.cwd, response: historyResponse, ctx, notice: event => emit([event]) })
  let replayHistory: readonly AgentEvent[] | undefined = history.takeInitial()
  let live = createLiveTranslator(ctx, settings)

  const listeners = new Set<Listener>()
  const backlog: [readonly AgentEvent[], AgentEventMeta][] = []
  let status: AgentSessionStatus = opened.running ? 'running' : 'idle'
  let disposing = false
  let disposePromise: Promise<void> | undefined
  let connected = true
  let rejoining = false
  const reconnectHeld: (() => void)[] = []
  const seenTurns = new Map<string, { started: Set<string>; completed: Set<string>; ended: boolean }>()
  const seenOf = (id: string) => {
    let seen = seenTurns.get(id)
    if (seen === undefined) {
      seen = { started: new Set(), completed: new Set(), ended: false }
      seenTurns.set(id, seen)
      if (seenTurns.size > 64) {
        const oldest = [...seenTurns.keys()].find(key => key !== ctx.turnId)
        if (oldest !== undefined) seenTurns.delete(oldest)
      }
    }
    return seen
  }
  for (const turn of history.turns) {
    const id = str(turn.id)
    if (id === undefined) continue
    const seen = seenOf(id)
    seen.ended = turn.status !== 'inProgress'
    for (const item of arr(turn.items).map(rec)) {
      const itemId = str(item?.id)
      if (itemId === undefined) continue
      seen.started.add(itemId)
      if (seen.ended || item?.status !== 'inProgress') seen.completed.add(itemId)
    }
  }
  let permanentlyLost = false
  /** The last aggregated diff of a turn (`/diff`, C2). */
  let lastDiff: string | undefined
  let lastPlan: string | undefined
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
    get threadId() { return threadId },
    call: (method, params) => hub.call(method, params),
    emit: events => emit(events),
    debug,
    overrides: () => controls.turnOverrides(),
    startFailed: (error, overrides) => controls.turnFailed(error, overrides),
    closed: () => disposing || permanentlyLost,
    forceClose: () => { output.flush(); emit(live.forceClose({ kind: 'interrupted' })) },
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
    get threadId() { return threadId },
    emit: events => emit(events, 'sync', true),
    clock,
    debug,
    enqueueFollowup: (id, followup) => input.enqueueFollowup(id, followup),
    interruptTurn: () => { void input.interrupt() },
  })

  const activity = createCodexActivity({ clock, now: ctx.now, emit })
  const subagents = createCodexSubagents({ hub, cwd: opened.cwd, threadId: () => threadId, nextSeq: ctx.nextSeq, now: ctx.now, emit: (events, wake) => deliver(events, wake ?? 'sync'), debug })
  subagents.seed(replayHistory ?? [])
  const goals = createCodexGoals({ hub, threadId: () => threadId, emit, debug })
  const tasks = createCodexTasks({ hub, threadId: () => threadId, emit, now: ctx.now, clock, debug })
  const output = createToolOutputBuffer(events => emit(events, 'frame'), clock)
  const submitText = async (text: string): Promise<void> => {
    const result = await input.submit({ text, clientMessageId: randomUUID() }, 'followup')
    if (!result.accepted) throw new Error(result.reason ?? t('codex-turn-start-failed', { err: '' }))
  }
  const controls = createCodexControls({
    hub, prefs: deps.prefs, ctx, settings, cwd: opened.cwd,
    threadId: () => threadId, busy: () => input.busy(), emit, submitText, debug,
    ...(deps.auth === undefined ? {} : { account: () => deps.auth!.account() }),
    mappedModels: () => Object.entries(deps.channels?.active()?.models ?? {}).map(([id, actual]) => ({ id, label: actual })),
    actualModel: id => deps.channels?.active()?.models?.[id] ?? id,
  })
  const sideQueries = createCodexSideQuery({ hub, settings, cwd: opened.cwd, clock, threadId: () => threadId, closed: () => disposing || permanentlyLost, debug })
  const commands = createCodexCommands({
    hub, ctx, cwd: opened.cwd, threadId: () => threadId, busy: () => input.busy(), emit,
    lastDiff: () => lastDiff, planSupported: () => controls.planSupported,
    setPlan: () => controls.capabilities.modes!.set('plan'),
    submit: (next, placement, wire) => input.submit(next, placement, wire),
    noteTurnStarted: id => input.onTurnStarted(id),
  })
  const planReview = createPlanReview({
    emit: events => emit(events, 'sync', true),
    implement: async () => {
      await controls.capabilities.modes!.set(settings.permissionMode ?? DEFAULT_CODEX_MODE)
      await submitText(PLAN_IMPLEMENTATION_PROMPT)
    },
    clearContext: async plan => {
      await controls.capabilities.modes!.set(settings.permissionMode ?? DEFAULT_CODEX_MODE)
      await clearContext(plan)
    },
    followup: submitText,
  })
  const authBridge = deps.auth === undefined ? undefined : createCodexAuthCapability(deps.auth, events => emit(events, 'sync', true))
  const offAuth = deps.auth?.subscribe(notice => emit([{ type: 'notice', ...notice }]))

  function deliver(events: readonly AgentEvent[], wake: AgentEventMeta['wake']): void {
    const batch: AgentEvent[] = []
    for (const event of events) {
      if (event.type === 'tool.output') { output.push(event); continue }
      if (event.type === 'tool.result' || event.type === 'turn.end') {
        if (batch.length > 0) { emit(batch.splice(0), wake) }
        output.flush(event.type === 'tool.result' ? event.callId : undefined)
      }
      batch.push(event)
    }
    emit(batch, wake)
  }

  /** Subagent threads routed to this session (their approvals show here). */
  const childRoutes = new Map<string, () => void>()
  const routeChild = (child: string | undefined): void => {
    if (child === undefined || child === '' || child === threadId || childRoutes.has(child)) return
    childRoutes.set(child, hub.route(child, threadId))
  }
  /** A subagent spawn names its thread: route it here before it asks anything. */
  const routeChildrenOf = (item: Rec | undefined): void => {
    if (item?.type === 'subAgentActivity') routeChild(str(item.agentThreadId))
    if (item?.type === 'collabAgentToolCall') for (const child of arr(item.receiverThreadIds)) routeChild(str(child))
  }

  async function clearContext(plan: string): Promise<void> {
    const response = rec(await hub.call(CLIENT.threadStart, { cwd: opened.cwd, ...resumeOverrides() })) ?? {}
    const next = openedThread(response, opened.cwd)
    if (next.threadId === '') throw new Error(t('codex-open-failed', { err: 'no thread id' }))
    const previous = threadId
    approvals.withdrawAll()
    authBridge?.withdrawAll()
    output.close()
    for (const unroute of childRoutes.values()) unroute()
    childRoutes.clear()
    detach?.()
    threadId = next.threadId
    ref = { backendId: CODEX_BACKEND_ID, sessionId: threadId }
    activity.reset()
    goals.reset()
    tasks.reset()
    subagents.reset()
    sideQueries.reset()
    seenTurns.clear()
    reconnectHeld.length = 0
    rejoining = false
    ctx.turn = 0
    ctx.turnId = ''
    ctx.step = 0
    ctx.turnOpen = false
    ctx.stepOpen = false
    ctx.attempt = undefined
    ctx.openTools.clear()
    ctx.anchorTurns.clear()
    ctx.turnUsage = undefined
    ctx.compactionSeen = false
    lastDiff = undefined
    lastPlan = undefined
    history.reset({ initialTurnsPage: { data: [], nextCursor: null } })
    replayHistory = []
    settings.collaborationMode = rec(next.collaborationMode)
    settings.modeId = next.permissionMode
    live = createLiveTranslator(ctx, settings)
    detach = hub.attach(threadId, sink!)
    deps.prefs.write({ lastSession: threadId })
    deps.prefs.touch(threadId)
    emit([{ type: 'session.reset', trigger: 'clear-context' }, { type: 'session.ready', sessionId: threadId, cwd: opened.cwd, model: settings.model, permissionMode: settings.modeId }])
    try { await hub.call(CLIENT.threadUnsubscribe, { threadId: previous }) }
    catch (error) { debug(`codex: old thread unsubscribe failed (${errorText(error)})`) }
    await submitText(`${PLAN_CLEAR_CONTEXT_PREFIX}\n\n${plan}`)
  }

  sink = {
    diagnostic(entry): void {
      if (entry.kind === 'stderr' && /bubblewrap/iu.test(entry.message)) {
        bubblewrapWarned = true
        if (process.platform === 'linux' && settings.permissionMode !== 'full-access') emit([{ type: 'notice', level: 'warning', key: 'codex-bwrap', text: t('codex-bwrap-warning') }])
      }
    },
    notification(method: string, params: Rec): void {
      if (disposing || permanentlyLost) return
      if (rejoining) { reconnectHeld.push(() => sink?.notification(method, params)); return }
      if (method === NOTIFY.itemStarted || method === NOTIFY.itemCompleted) routeChildrenOf(rec(params.item))
      const from = threadOf(params)
      if (from !== undefined && from !== threadId) {
        if (method === NOTIFY.serverRequestResolved) approvals.resolved(params.requestId)
        subagents.notification(method, params)
        return
      }
      const nativeTurn = str(params.turnId) ?? str(rec(params.turn)?.id)
      if (nativeTurn !== undefined) {
        const seen = seenOf(nativeTurn)
        const itemId = str(rec(params.item)?.id)
        if (method === NOTIFY.itemStarted && itemId !== undefined) {
          if (seen.started.has(itemId)) return
          seen.started.add(itemId)
        } else if (method === NOTIFY.itemCompleted && itemId !== undefined) {
          if (seen.completed.has(itemId)) return
          seen.completed.add(itemId)
        } else if (method === NOTIFY.turnCompleted) {
          if (seen.ended) return
          seen.ended = true
        } else if (method === NOTIFY.turnStarted && seen.ended) return
      }
      subagents.notification(method, params)
      history.notification(method, params)
      activity.notification(method, params)
      tasks.notification(method, params)
      if (goals.notification(method, params)) return
      commands.note(method)
      if (controls.note(method, params)) return
      const before: AgentEvent[] = []
      switch (method) {
        case NOTIFY.turnStarted: {
          const id = str(rec(params.turn)?.id)
          if (id !== undefined) input.onTurnStarted(id)
          before.push({ type: 'session.status', status: 'running' })
          lastPlan = undefined
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
      const events = subagents.decorate(live.notification(method, params))
      if (method === NOTIFY.itemCompleted) {
        const item = rec(params.item)
        const itemId = str(item?.id)
        if (item?.type === 'plan') lastPlan = str(item.text)
        if (itemId !== undefined) approvals.itemCompleted(itemId)
      }
      if (method === NOTIFY.turnCompleted) {
        approvals.turnEnded()
        const turn = rec(params.turn)
        deliver([...before, ...events, { type: 'session.status', status: 'idle' }], wakeOf(method, events))
        input.onTurnCompleted(str(turn?.id), str(turn?.status) === 'interrupted')
        if (str(turn?.status) === 'completed' && settings.modeId === 'plan' && lastPlan !== undefined && approvals.size === 0 && !input.busy()) planReview.offer(str(turn?.id) ?? ctx.turnId, lastPlan)
        return
      }
      deliver([...before, ...events], wakeOf(method, [...before, ...events]))
    },
    serverRequest(request: HubServerRequest): void {
      if (disposing) {
        request.respondError(RPC_ERROR.internal, 'the session is closing')
        return
      }
      if (rejoining) { reconnectHeld.push(() => sink?.serverRequest(request)); return }
      approvals.onRequest(request)
    },
    connectionLost(error: Error, permanent: boolean): void {
      if (disposing) return
      connected = false
      rejoining = !permanent
      reconnectHeld.length = 0
      tasks.reset()
      sideQueries.reset()
      permanentlyLost = permanent
      approvals.withdrawAll()
      authBridge?.withdrawAll()
      activity.reset()
      planReview.withdraw()
      output.flush()
      emit([
        // A transport outage is not a durable failure of the native turn.
        ...(permanent ? live.forceClose({ kind: 'error', message: errorText(error) }) : []),
        ...input.connectionLost(),
        { type: 'notice', level: permanent ? 'error' : 'warning', key: 'codex-connection', text: permanent ? t('codex-connection-failed', { err: errorText(error) }) : t('codex-connection-lost') },
        { type: 'session.status', status: !permanent && ctx.turnOpen ? 'running' : 'idle' },
      ])
    },
    connectionRestored(): void {
      if (disposing) return
      const reconnectingId = threadId
      const reconnectGeneration = hub.generation
      const knownTurns = new Set(seenTurns.keys())
      void hub.call(CLIENT.threadResume, { threadId, excludeTurns: true, initialTurnsPage: INITIAL_TURNS_PAGE, ...resumeOverrides() }).then(async answer => {
        const current = (): boolean => !disposing && threadId === reconnectingId && hub.generation === reconnectGeneration
        if (!current()) return
        const response = rec(answer) ?? {}
        const initialPage = rec(response.initialTurnsPage)
        const turns = [...arr(initialPage?.data)]
        let cursor = str(initialPage?.nextCursor)
        let pages = 1
        const cursors = new Set<string>()
        const retainedActive = ctx.turnOpen ? ctx.turnId : undefined
        const atKnownTurn = (): boolean => turns.some(turn => retainedActive === undefined
          ? knownTurns.has(str(rec(turn)?.id) ?? '') : str(rec(turn)?.id) === retainedActive)
        const incomplete = (): void => {
          permanentlyLost = true
          rejoining = false
          reconnectHeld.length = 0
          emit([...live.forceClose({ kind: 'error', message: t('codex-reconnect-incomplete') }),
            { type: 'notice', level: 'warning', key: 'codex-connection', text: t('codex-reconnect-incomplete') },
            { type: 'session.status', status: 'idle' }])
        }
        while (cursor !== undefined && !atKnownTurn()) {
          if (pages >= 50 || turns.length >= 1000 || cursors.has(cursor)) {
            incomplete()
            return
          }
          cursors.add(cursor)
          const page = rec(await hub.call(CLIENT.threadTurnsList, { threadId: reconnectingId, cursor, limit: 20, sortDirection: 'desc', itemsView: 'full' }))
          if (!current()) return
          turns.push(...arr(page?.data))
          cursor = str(page?.nextCursor)
          pages += 1
        }
        // The exhausted page must include the retained unfinished turn too.
        if (retainedActive !== undefined && !atKnownTurn()) { incomplete(); return }
        const boundary = turns.findIndex(turn => retainedActive === undefined
          ? knownTurns.has(str(rec(turn)?.id) ?? '') : str(rec(turn)?.id) === retainedActive)
        const replayedTurns = boundary < 0 ? turns : turns.slice(0, boundary + 1)
        // Preserve original attempt/call IDs; only missing native item phases
        // pass through the same translator that painted this turn.
        rejoining = false
        let active: string | undefined
        for (const raw of [...replayedTurns].reverse()) {
          const turn = rec(raw)
          const id = str(turn?.id)
          if (turn === undefined || id === undefined || seenTurns.get(id)?.ended === true) continue
          const seen = seenOf(id)
          const running = turn.status === 'inProgress'
          sink!.notification(NOTIFY.turnStarted, { threadId, turn })
          for (const item of arr(turn.items).map(rec)) {
            const itemId = str(item?.id)
            if (item === undefined || itemId === undefined) continue
            if (!seen.started.has(itemId)) sink!.notification(NOTIFY.itemStarted, { threadId, turnId: id, item })
            if ((!running || item.status !== 'inProgress') && !seen.completed.has(itemId)) {
              sink!.notification(NOTIFY.itemCompleted, { threadId, turnId: id, item })
            }
          }
          if (running) active = id
          else sink!.notification(NOTIFY.turnCompleted, { threadId, turn })
        }
        history.reset({ ...response, initialTurnsPage: { data: turns, nextCursor: cursor } })
        connected = true
        if (active !== undefined) input.onTurnStarted(active)
        emit([{ type: 'notice', level: 'info', key: 'codex-connection', text: t('codex-reconnected') }, { type: 'session.status', status: active === undefined ? 'idle' : 'running' }])
        for (const deliver of reconnectHeld.splice(0)) deliver()
        await tasks.refresh()
        if (!current() || !connected) return
        input.connectionRestored()
      }).catch((error: unknown) => {
        if (disposing || threadId !== reconnectingId || hub.generation !== reconnectGeneration) return
        debug(`codex: resubscribe after restart failed (${errorText(error)})`)
        emit([{ type: 'notice', level: 'error', key: 'codex-connection', text: t('codex-connection-failed', { err: errorText(error) }) }])
      })
    },
  }
  detach?.()
  detach = hub.attach(threadId, sink)

  // Thread-less traffic this session reads: rate limits, configuration
  // warnings that are not sandbox noise.
  const offGlobal = hub.onGlobal((method, params) => {
    if (disposing) return
    commands.note(method)
    controls.note(method, params)
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
        if (process.platform === 'linux' && settings.permissionMode !== 'full-access') emit([{ type: 'notice', level: 'warning', key: 'codex-bwrap', text: t('codex-bwrap-warning') }])
        return
      }
      const notice = warningNotice(method, params)
      if (notice !== undefined) emit([notice])
    }
  })

  let ref: AgentSessionRef = { backendId: CODEX_BACKEND_ID, sessionId: threadId }
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
  const rememberedColor = deps.prefs.read().colors?.[threadId]
  if (rememberedColor !== undefined) emit([{ type: 'session.color', color: rememberedColor }], 'none')
  if (opened.effort !== null) emit([{ type: 'effort.changed', effort: opened.effort }], 'none')
  if (opened.running) emit([{ type: 'session.status', status: 'running' }], 'none')
  // Traffic that arrived while the resume was in flight follows the start-up
  // facts (nothing can arrive in between: no await since the attach).
  for (const deliver of held.splice(0)) deliver()

  const session: AgentSession = {
    get ref() { return ref },
    cwd: opened.cwd,
    get status(): AgentSessionStatus {
      if (disposing) return 'disposed'
      return status
    },
    capabilities: {
      native: {},
      ...controls.capabilities,
      commands: commands.capability,
      workingActivity: activity.capability,
      get goals() { return goals.capability },
      get tasks() { return tasks.capability },
      subagents: subagents.capability,
      images: { limits: CODEX_IMAGE_LIMITS },
      transcript: history.capability,
      color: {
        current: () => deps.prefs.read().colors?.[threadId] ?? '',
        set: color => {
          const colors = { ...deps.prefs.read().colors }
          delete colors[threadId]
          if (color !== '') colors[threadId] = color
          deps.prefs.write({ colors })
          emit([{ type: 'session.color', color }])
        },
      },
      fork: {
        async fork(anchor, title) {
          const lastTurnId = anchor === undefined ? undefined : ctx.anchorTurns.get(anchor) ?? str(history.turns.find(turn => arr(turn.items).some(item => str(rec(item)?.id) === anchor))?.id)
          if (anchor !== undefined && lastTurnId === undefined) throw new Error(t('codex-anchor-missing'))
          const response = rec(await hub.call(CLIENT.threadFork, { threadId, excludeTurns: true, ...(lastTurnId === undefined ? {} : { lastTurnId }) }))
          const id = str(rec(response?.thread)?.id)
          if (id === undefined) throw new Error(t('codex-open-failed', { err: 'no thread id' }))
          if (title !== undefined) await hub.call(CLIENT.threadNameSet, { threadId: id, name: title })
          await hub.call(CLIENT.threadUnsubscribe, { threadId: id })
          return { backendId: CODEX_BACKEND_ID, sessionId: id }
        },
      },
      rewind: {
        async rewind(anchor, mode) {
          if (mode !== 'conversation') return { kind: 'refused', reason: t('codex-rewind-files-unsupported') }
          const selected = ctx.anchorTurns.get(anchor) ?? str(history.turns.find(turn => arr(turn.items).some(item => str(rec(item)?.id) === anchor))?.id)
          if (selected === undefined) return { kind: 'refused', reason: t('codex-anchor-missing') }
          if (input.busy()) return { kind: 'refused', reason: t('codex-command-idle') }
          const previous = history.previousTurnId(anchor)
          const retained = history.turns
          const index = retained.findIndex(turn => str(turn.id) === selected)
          if (previous === undefined && (index < 0 || history.capability.hasOlder())) return { kind: 'refused', reason: t('codex-rewind-load-older') }
          const response = rec(await hub.call(previous === undefined ? CLIENT.threadStart : CLIENT.threadFork, previous === undefined
            ? { cwd: opened.cwd, ...resumeOverrides() }
            : { threadId, lastTurnId: previous, excludeTurns: true, ...resumeOverrides() }))
          const id = str(rec(response?.thread)?.id)
          if (id === undefined) throw new Error(t('codex-open-failed', { err: 'no thread id' }))
          await hub.call(CLIENT.threadUnsubscribe, { threadId: id })
          return { kind: 'rewound', session: { backendId: CODEX_BACKEND_ID, sessionId: id } }
        },
      },

      sideQuery: sideQueries.capability,
      ...(authBridge === undefined ? {} : { auth: authBridge.capability }),
      ...(deps.channels === undefined ? {} : { channels: deps.channels.capability }),
      permissions: {
        respond: (requestId, decision) => approvals.respond(requestId, decision),
        pending: () => approvals.pendingViews(),
      },
      questions: {
        respond: (requestId, answers) => {
          if (authBridge?.respondQuestion(requestId, answers)) return
          if (planReview.owns(requestId)) planReview.respond(requestId, answers)
          else approvals.respondQuestion(requestId, answers)
        },
        cancel: requestId => {
          if (authBridge?.cancelQuestion(requestId)) return
          if (planReview.owns(requestId)) planReview.cancel(requestId)
          else approvals.cancelQuestion(requestId)
        },
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
          ...((bubblewrapWarned || hub.bubblewrapMissing || deps.doctor?.bubblewrapMissing === true) && process.platform === 'linux' ? [t('codex-doctor-bubblewrap')] : []),
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
      planReview.withdraw()
      return commands.submit(next, placement).then(result => result ?? input.submit(next, placement))
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
        authBridge?.dispose()
        planReview.withdraw()
        output.close()
        offAuth?.()
        activity.close()
        goals.close()
        tasks.close()
        history.close()
        subagents.close()
        sideQueries.close()
        const busy = input.busy()
        disposing = true
        if (busy) await input.interrupt().catch(() => false)
        input.close()
        offGlobal()
        for (const unroute of childRoutes.values()) unroute()
        childRoutes.clear()
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
        reconnectHeld.length = 0
        seenTurns.clear()
      })()
      return disposePromise
    },
  }
  try {
    await Promise.all([controls.initialize(), tasks.initialize(), goals.initialize()])
    if (prefs.plan !== undefined && prefs.plan !== (settings.modeId === 'plan') && controls.planSupported) await controls.capabilities.modes!.set(prefs.plan ? 'plan' : settings.permissionMode ?? DEFAULT_CODEX_MODE)
    return session
  } catch (error) {
    await session.dispose()
    throw error
  }
}
