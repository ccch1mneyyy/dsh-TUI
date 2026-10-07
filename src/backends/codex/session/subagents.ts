/** Parent-owned Codex subagents: independent translators and bounded history pages. */
import type { SessionCapabilities, SubagentTranscriptPage, SubagentTranscriptWindow } from '../../../agent/capabilities.js'
import type { AgentEvent, AgentEventMeta, AgentEventOf } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { arr, num, rec, str, type Rec } from '../narrow.js'
import { CLIENT, NOTIFY } from '../protocol/index.js'
import { threadOf, type CodexHub } from '../rpc/hub.js'
import { createItemContext } from '../translate/items.js'
import { createLiveTranslator, wakeOf, type LiveTranslator } from '../translate/live.js'
import { replayTurns } from '../translate/replay.js'

type Child = { id: string; lane: string; parent: string; description: string; depth: number; live: LiveTranslator; activeTurn?: string; summary?: string; ended: boolean; prompt?: string; model?: string; nickname?: string; spawnId?: string }
type Traffic = { method: string; params: Rec }
const MAX_CHILDREN = 200
const MAX_HELD = 128
const HISTORY_TURNS = 20
const LEAVES = new Set<AgentEvent['type']>(['assistant.attempt.start', 'assistant.delta', 'assistant.message', 'tool.call', 'tool.result', 'tool.progress', 'tool.output'])

/** Only the child's transcript leaves enter its lane; its own turn/context
 * events never reach the foreground reducer. Sequence is the parent's stream. */
function leaf(event: AgentEvent, lane: string, agentId: string, nextSeq: () => number): AgentEvent | undefined {
  switch (event.type) {
    case 'assistant.attempt.start':
    case 'assistant.delta':
    case 'assistant.message':
      return { ...event, attemptId: agentId + ':' + event.attemptId, parentCallId: lane, ...('seq' in event && event.seq !== undefined ? { seq: nextSeq() } : {}) }
    case 'tool.call':
    case 'tool.result':
      return { ...event, seq: nextSeq(), parentCallId: lane }
    case 'tool.progress':
    case 'tool.output':
      return { ...event, parentCallId: lane }
    default:
      return undefined
  }
}

export function createCodexSubagents(deps: {
  readonly hub: Pick<CodexHub, 'call'>
  readonly cwd: string
  threadId(): string
  /** One monotonic sequence shared with the parent's ItemContext. */
  nextSeq(): number
  emit(events: readonly AgentEvent[], wake?: AgentEventMeta['wake']): void
  readonly now?: () => number
  debug?(message: string): void
}) {
  const now = deps.now ?? Date.now
  const children = new Map<string, Child>()
  const held = new Map<string, Traffic[]>()
  const loading = new Map<string, Promise<Child | undefined>>()
  let generation = 0
  let closed = false
  const current = (root: string, epoch: number): boolean => !closed && epoch === generation && root === deps.threadId()
  const remember = (id: string, lane: string, parent: string, description: string, depth: number): Child => {
    const existing = children.get(id)
    if (existing !== undefined) return existing
    const child: Child = { id, lane, parent, description, depth, ended: false,
      live: createLiveTranslator(createItemContext({ cwd: deps.cwd, now, debug: deps.debug }), { model: '', effort: null, modeId: 'auto' }) }
    children.set(id, child)
    if (children.size > MAX_CHILDREN) {
      const stale = [...children.values()].find(entry => entry.ended)
      if (stale !== undefined) children.delete(stale.id)
    }
    return child
  }
  const startEvent = (child: Child, time = now()): AgentEventOf<'subagent.start'> => ({
    type: 'subagent.start', agentId: child.id, parentCallId: child.lane, parentAgentId: child.parent,
    description: child.prompt === undefined ? child.nickname ?? child.description : child.nickname === undefined ? child.prompt : child.nickname + ': ' + child.prompt,
    ...(child.model === undefined ? {} : { model: child.model }),
    background: false, depth: child.depth, time,
  })
  const decorate = (events: readonly AgentEvent[], parent = deps.threadId()): AgentEvent[] => events.map(event => {
    if (event.type === 'subagent.start') {
      const child = remember(event.agentId, event.parentCallId ?? event.agentId, parent, event.description, event.depth ?? 1)
      child.ended = false
      return { ...event, ...startEvent(child, event.time) }
    }
    if (event.type === 'subagent.end') {
      const child = children.get(event.agentId)
      if (child !== undefined) child.ended = true
      return child?.summary === undefined ? event : { ...event, summary: child.summary }
    }
    return event
  })

  /** Validate lineage from the authoritative thread metadata (no history scan). */
  const ownership = async (id: string): Promise<{ parent: string; depth: number; thread: Rec }> => {
    const root = deps.threadId()
    const epoch = generation
    let next = id
    let direct: string | undefined
    let first: Rec | undefined
    for (let depth = 1; depth <= 8; depth += 1) {
      const response = rec(await deps.hub.call(CLIENT.threadRead, { threadId: next, includeTurns: false }))
      const thread = rec(response?.thread)
      const spawn = rec(rec(rec(thread?.source)?.subAgent)?.thread_spawn)
      const parent = str(thread?.parentThreadId) ?? str(spawn?.parent_thread_id)
      if (!current(root, epoch) || thread === undefined || str(thread.id) !== next || parent === undefined || parent === next) throw new Error(t('codex-subagent-unavailable'))
      if (first === undefined) { first = thread; direct = parent }
      if (parent === root) return { parent: direct!, depth, thread: first }
      next = parent
    }
    throw new Error(t('codex-subagent-unavailable'))
  }
  /** Spawn items report a requested model/prompt, not execution telemetry. */
  const noteSpawn = (method: string, params: Rec, parent: string): void => {
    if (method !== NOTIFY.itemStarted && method !== NOTIFY.itemCompleted) return
    const item = rec(params.item)
    if (item?.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') return
    const receivers = arr(item.receiverThreadIds).filter((id): id is string => typeof id === 'string')
    for (const id of receivers) {
      const known = children.get(id)
      const child = remember(id, known?.lane ?? (receivers.length === 1 ? str(item.id) ?? id : id), parent, known?.description ?? id, (children.get(parent)?.depth ?? 0) + 1)
      const before = startEvent(child).description
      const beforeModel = child.model
      const prompt = str(item.prompt)
      if (prompt !== undefined) child.prompt = prompt.slice(0, 16 * 1024)
      child.model = str(item.model) ?? child.model
      if (!child.ended && (known === undefined || before !== startEvent(child).description || beforeModel !== child.model)) deps.emit([startEvent(child)])
      const spawnId = str(item.id) ?? id
      if (child.spawnId === spawnId) continue
      child.spawnId = spawnId
      const root = deps.threadId()
      const epoch = generation
      void ownership(id).then(owned => {
        if (!current(root, epoch) || children.get(id) !== child) return
        const before = startEvent(child).description
        const beforeModel = child.model
        child.nickname = str(owned.thread.agentNickname) ?? child.nickname
        child.model ??= str(owned.thread.model)
        child.parent = owned.parent
        child.depth = owned.depth
        if (!child.ended && (before !== startEvent(child).description || beforeModel !== child.model)) deps.emit([startEvent(child)])
      }).catch(error => { if (current(root, epoch)) deps.debug?.('codex: spawn metadata unavailable (' + (error instanceof Error ? error.message : String(error)) + ')') })
    }
  }
  const discover = (id: string): Promise<Child | undefined> => {
    const pending = loading.get(id)
    if (pending !== undefined) return pending
    const root = deps.threadId()
    const epoch = generation
    const request = (async () => {
      try {
        const owned = await ownership(id)
        if (!current(root, epoch)) return undefined
        let child = children.get(id)
        if (child === undefined) {
          // A child can speak before its activity notification. The parent's
          // latest page may already contain its durable spawn anchor.
          const response = rec(await deps.hub.call(CLIENT.threadTurnsList, { threadId: owned.parent, limit: HISTORY_TURNS, sortDirection: 'desc', itemsView: 'full' }))
          const activity = arr(response?.data).flatMap(turn => arr(rec(turn)?.items)).map(rec)
            .find(item => item?.type === 'subAgentActivity' && item.kind === 'started' && item.agentThreadId === id)
          if (!current(root, epoch)) return undefined
          const path = (str(activity?.agentPath) ?? '').split('/').filter(Boolean)
          child = remember(id, str(activity?.id) ?? id, owned.parent, str(owned.thread.agentNickname) ?? path.at(-1) ?? id, owned.depth)
          child.nickname = str(owned.thread.agentNickname)
          child.model = str(owned.thread.model)
          deps.emit([startEvent(child)])
        }
        for (const traffic of held.get(id) ?? []) deliver(child, traffic.method, traffic.params)
        held.delete(id)
        return child
      } catch (error) {
        held.delete(id)
        if (current(root, epoch)) deps.debug?.('codex: child metadata unavailable (' + (error instanceof Error ? error.message : String(error)) + ')')
        return undefined
      }
    })()
    loading.set(id, request)
    void request.finally(() => { if (loading.get(id) === request) loading.delete(id) })
    return request
  }
  const deliver = (child: Child, method: string, params: Rec): void => {
    noteSpawn(method, params, child.id)
    if (method === NOTIFY.turnStarted) child.activeTurn = str(rec(params.turn)?.id)
    if (method === NOTIFY.turnCompleted) child.activeTurn = undefined
    const item = rec(params.item)
    if (method === NOTIFY.itemCompleted && item?.type === 'agentMessage' && item.phase === 'final_answer') child.summary = (str(item.text) ?? '').slice(0, 16 * 1024)
    const batch: AgentEvent[] = []
    for (const event of decorate(child.live.notification(method, params), child.id)) {
      const mapped = leaf(event, child.lane, child.id, deps.nextSeq)
      if (mapped !== undefined) batch.push(mapped)
      else if (event.type === 'subagent.start' || event.type === 'subagent.progress' || event.type === 'subagent.end') batch.push(event)
    }
    if (method === NOTIFY.threadTokenUsageUpdated) {
      const usage = rec(rec(params.tokenUsage)?.total)
      if (usage !== undefined) batch.push({ type: 'subagent.progress', agentId: child.id, usage: {
        ...(num(usage.inputTokens) === undefined ? {} : { input: num(usage.inputTokens) }),
        ...(num(usage.outputTokens) === undefined ? {} : { output: num(usage.outputTokens) }),
        ...(num(usage.totalTokens) === undefined ? {} : { total: num(usage.totalTokens) }),
      } })
    }
    if (batch.length > 0) deps.emit(batch, wakeOf(method, batch))
  }
  const capability: NonNullable<SessionCapabilities['subagents']> = {
    messaging: 'parent-mediated', messagingTool: 'send_input',
    async interrupt(id): Promise<boolean> {
      if (closed || !children.has(id)) return false
      const root = deps.threadId()
      const epoch = generation
      await ownership(id)
      const child = children.get(id)!
      let turnId = child.activeTurn
      if (turnId === undefined) {
        const response = rec(await deps.hub.call(CLIENT.threadTurnsList, { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'summary' }))
        const active = arr(response?.data).map(rec).find(turn => turn?.status === 'inProgress')
        turnId = str(active?.id)
      }
      if (!current(root, epoch) || turnId === undefined) return false
      await deps.hub.call(CLIENT.turnInterrupt, { threadId: id, turnId })
      return current(root, epoch)
    },
    async history(id: string, window?: SubagentTranscriptWindow): Promise<SubagentTranscriptPage> {
      if (closed || !children.has(id)) throw new Error(t('codex-subagent-unavailable'))
      const root = deps.threadId()
      const epoch = generation
      const owned = await ownership(id)
      const response = rec(await deps.hub.call(CLIENT.threadTurnsList, { threadId: id, limit: HISTORY_TURNS, sortDirection: 'desc', itemsView: 'full', ...(window?.sourceCursor === undefined ? {} : { cursor: window.sourceCursor }) }))
      if (!current(root, epoch)) throw new Error(t('codex-subagent-unavailable'))
      const turns = [...arr(response?.data)].reverse()
      const context = createItemContext({ cwd: str(owned.thread.cwd) ?? deps.cwd, now })
      const child = children.get(id)!
      let seq = 0
      const events = replayTurns(turns, context).flatMap(event => {
        // History is a leaf-only page: it cannot mutate the parent's state,
        // nor create another agent roster while a detail page is opened.
        if (!LEAVES.has(event.type)) return []
        const mapped = leaf(event, child.lane, id, () => ++seq)
        return mapped === undefined ? [] : [mapped]
      })
      const sourceCursor = str(response?.nextCursor)
      return { events, parentAgentId: owned.parent === root ? null : owned.parent,
        uuids: turns.flatMap(turn => arr(rec(turn)?.items).map(item => str(rec(item)?.id)).filter((id): id is string => id !== undefined)),
        hasOlder: sourceCursor !== undefined, skippedFromStart: 0, ...(sourceCursor === undefined ? {} : { sourceCursor }) }
    },
  }
  return {
    capability,
    decorate: (events: readonly AgentEvent[]) => decorate(events),
    seed(events: readonly AgentEvent[]): void { decorate(events) },
    notification(method: string, params: Rec): boolean {
      if (closed) return false
      const from = threadOf(params)
      if (from === undefined) return false
      if (from === deps.threadId()) { noteSpawn(method, params, from); return false }
      const child = children.get(from)
      if (child !== undefined) deliver(child, method, params)
      else {
        if (!held.has(from) && held.size >= MAX_CHILDREN) return true
        const buffer = held.get(from) ?? []
        if (buffer.length < MAX_HELD) buffer.push({ method, params })
        held.set(from, buffer)
        void discover(from)
      }
      return true
    },
    reset(): void { generation += 1; children.clear(); held.clear(); loading.clear() },
    close(): void { closed = true; generation += 1; children.clear(); held.clear(); loading.clear() },
  }
}
