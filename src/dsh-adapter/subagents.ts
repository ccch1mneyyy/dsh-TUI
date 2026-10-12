import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { addUsageToCostBuckets, cloneCostBuckets, emptyCostBuckets, isDeepSeekOfficialProvider, isPeakHour, priceForModel } from '../deepseekPricing.js'
import { toolResultPayload } from './compat/messages.js'
import type { CostTokenBuckets, SubagentCostEntry, SubagentState, SubagentStatus, SubagentOutputLine, SubagentOutputKind, SubagentToolCall, SubagentTokenUsage } from '../adapter/ports/channel-view.js'
export type { SubagentState, SubagentStatus, SubagentOutputLine, SubagentOutputKind, SubagentToolCall, SubagentTokenUsage, SubagentCostEntry } from '../adapter/ports/channel-view.js'


const MAX_OUTPUT_EVENTS = 160
const MAX_OUTPUT_LINES = 160
/** Keyed labels parked before their row exists (see `earlyLabels`). */
const MAX_EARLY_LABELS = 64

/** 子代理 durable 用量的费用快照：entries 供多模型计价，unpriced 是
 *  非官方/未收录用量的独立副本（展示与回归断言用）。 */
export interface SubagentCostSnapshot {
  entries: SubagentCostEntry[]
  unpriced: CostTokenBuckets
}

interface AssistantOutputStream {
  revision: number
  settledSeq?: number
  attempt?: {
    id: string
    turn?: number
    step?: number
    before: SubagentOutputLine[]
  }
}

export class SubagentActivityStore {
  private states = new Map<string, SubagentState>()
  private sessionToAgent = new Map<unknown, string>()
  private listeners = new Set<() => void>()
  private streams = new Map<string, AssistantOutputStream>()
  /** 会话级 durable usage 费用桶，key = `${provider}\u0000${model}`。 */
  private costByModel = new Map<string, SubagentCostEntry>()
  /** 非官方 provider / 未收录模型的用量副本（只展示 token，不计金额）。 */
  private costUnpriced = emptyCostBuckets()
  /** 每个 agent 已消费的最大 durable 事件 seq（同一事件重投不重复计费）。 */
  private costSeq = new Map<string, number>()
  /** 描述的来源。spawn 首帧的描述来自一条**无身份**的 FIFO 队列（并发派发
   *  时可能是别的 child 的），只有 childId-keyed 的权威 label
   *  （`subagent/catalog`、子会话 `subagent/descriptor`）能定案：`bound`
   *  之后不再改写，`queue`/`placeholder` 允许被 label 覆盖。 */
  private descriptionSource = new Map<string, 'queue' | 'bound' | 'placeholder'>()
  /** keyed label 可能比它那一行先到：子会话的 `subagent/descriptor` 在会话
   *  链接建立之前就已投递。丢掉它，这一行就只剩队列猜出来的名字，而外部
   *  子代理上游不写 catalog ⇒ 没有第二条 keyed 事实来救，永久错名。先寄存在
   *  这里，建行时直接当描述用：keyed 事实不因到达先后而失效。有界，理由同
   *  队列（没人建行时不能无界增长）。 */
  private earlyLabels = new Map<string, string>()

  private commitLine(agentId: string, kind: SubagentOutputKind, text: string): void {
    const state = this.states.get(agentId)
    if (!state) return
    this.pushLine(state, { kind, text, at: Date.now(), settled: true })
  }

  private pushLine(state: SubagentState, line: SubagentOutputLine): void {
    state.outputEvents.push(line)
    if (state.outputEvents.length > MAX_OUTPUT_EVENTS) state.outputEvents.splice(0, state.outputEvents.length - MAX_OUTPUT_EVENTS)
    state.output = state.outputEvents.map(entry => entry.text)
    if (state.output.length > MAX_OUTPUT_LINES) state.output.splice(0, state.output.length - MAX_OUTPUT_LINES)
  }

  onSpawned(agentId: string, provider = 'subagent', model?: string, info: Partial<SubagentState> & { descriptionFromQueue?: boolean } = {}): void {
    const existing = this.states.get(agentId)
    // A term off the identity-less spawn queue may belong to a concurrent
    // delegation, so it never overrides a description a keyed fact already
    // settled. The caller still consumes (shifts) the term either way — the
    // FIFO has no identity to hand back, and leaving it at the head would only
    // misalign the next spawn.
    const fromQueue = info.descriptionFromQueue === true
    const description = fromQueue && this.descriptionSource.get(agentId) === 'bound' ? undefined : info.description
    // A keyed label that outran its row (see `earlyLabels`) carries the same
    // authority as a live one: the row is born settled, and the queue term the
    // same spawn consumed is dropped instead of shown.
    const keyed = this.earlyLabels.get(agentId)
    if (keyed !== undefined) this.earlyLabels.delete(agentId)
    const settled = keyed ?? description
    const source: 'queue' | 'bound' | 'placeholder' = keyed !== undefined ? 'bound' : description === undefined ? 'placeholder' : fromQueue ? 'queue' : 'bound'
    if (!existing) {
      this.states.set(agentId, {
        agentId,
        runId: info.runId ?? agentId,
        description: settled ?? `${provider} task`,
        provider,
        model: model ?? info.model ?? provider,
        effort: info.effort,
        status: 'running',
        startedAt: info.startedAt ?? Date.now(),
        local: info.local,
        parentSessionId: info.parentSessionId,
        sessionId: info.sessionId,
        output: [],
        outputEvents: [],
        toolCalls: [],
        ...(info.parentAgentId === undefined ? {} : { parentAgentId: info.parentAgentId }),
      })
      this.descriptionSource.set(agentId, source)
      this.notify()
      return
    }
    // Continuable children re-use one agent id across residency epochs, and a
    // new epoch announces a NEW runId (the host's `subagent/start` pairing
    // key). A runId change therefore opens a fresh run: the previous epoch's
    // terminal state, timing, output and tools must not leak into it. The
    // description is the one thing a new epoch does not own *once a keyed
    // label settled it*: that label outranks the queue and survives every
    // epoch (see the guard above), while a row still living on a queue guess
    // takes the new epoch's term like any other fresh run. The same runId
    // re-announced only refreshes display metadata.
    if (info.runId !== undefined && info.runId !== existing.runId) {
      this.streams.delete(agentId)
      existing.runId = info.runId
      existing.status = 'running'
      existing.startedAt = info.startedAt ?? Date.now()
      existing.completedAt = undefined
      existing.endedAt = undefined
      existing.stopReason = undefined
      existing.summary = undefined
      existing.error = undefined
      existing.output = []
      existing.outputEvents = []
      existing.toolCalls = []
      existing.tokens = undefined
      existing.description = settled ?? existing.description
      if (settled !== undefined) this.descriptionSource.set(agentId, source)
      existing.local = info.local ?? existing.local
      existing.provider = provider
      existing.model = model ?? existing.model
      // A late parent fact heals an unknown one; never rewrites a known
      // parent (the same once-only rule the channel store applies).
      if (info.parentAgentId !== undefined && existing.parentAgentId === undefined) existing.parentAgentId = info.parentAgentId
    } else {
      existing.provider = provider
      existing.model = model ?? existing.model
      if (settled !== undefined) {
        existing.description = settled
        this.descriptionSource.set(agentId, source)
      }
      if (info.local !== undefined) existing.local = info.local
      if (info.parentAgentId !== undefined && existing.parentAgentId === undefined) existing.parentAgentId = info.parentAgentId
    }
    this.notify()
  }

  /** Park a keyed label whose row does not exist yet — a child session's
   *  `subagent/descriptor` can be published before the host's spawn edge, and
   *  dropping it there would leave the row with the identity-less queue's
   *  guess and no second keyed fact to correct it (an external child gets no
   *  catalog). `onSpawned` adopts it when the row is created. Bounded: when
   *  full, the oldest parked label goes first — the least likely to still be
   *  waiting for its row. */
  holdKeyedLabel(agentId: string, label: unknown): void {
    if (typeof label !== 'string' || label === '') return
    if (!this.earlyLabels.has(agentId) && this.earlyLabels.size >= MAX_EARLY_LABELS) {
      const oldest = this.earlyLabels.keys().next().value
      if (oldest !== undefined) this.earlyLabels.delete(oldest)
    }
    this.earlyLabels.set(agentId, label)
  }

  /** Bind the authoritative description of one child (a `subagent/catalog`
   *  label or a child session's own `subagent/descriptor`). The identity-less
   *  spawn queue may have handed this row a concurrent delegation's term, so
   *  the keyed fact wins, once, until it is the source of truth for this row.
   *  Returns whether the displayed description changed. */
  private describeFromLabel(agentId: string, label: unknown): boolean {
    if (typeof label !== 'string' || label === '') return false
    // A row-less call has no display to correct: the projection parks such a
    // label before it gets here (`holdKeyedLabel`) and the row adopts it when
    // it is created.
    const state = this.states.get(agentId)
    if (state === undefined || this.descriptionSource.get(agentId) === 'bound') return false
    this.descriptionSource.set(agentId, 'bound')
    if (state.description === label) return false
    state.description = label
    return true
  }

  /** Durable discovery (`subagent/catalog`, workflow member events, registry
   * back-fill): register a child WITHOUT disturbing an already-tracked run.
   * `live` marks a child the agents registry currently holds, which keeps the
   * row running; an idle historical child shows as `unknown` (the parent log
   * alone cannot prove how its last epoch ended). */
  onDiscovered(agentId: string, info: { label?: string; childCreatedAt?: number; live?: boolean; provider?: string; model?: string; mode?: 'one-shot' | 'continuable' | 'unknown' } = {}): void {
    const existing = this.states.get(agentId)
    if (existing !== undefined) {
      // A bus edge usually created the row first; the durable catalog fact
      // still carries the two things the edge never knows — the mode, and the
      // childId-keyed label that a queue-derived description only guessed at.
      let changed = false
      if (info.mode !== undefined && existing.mode === undefined) {
        existing.mode = info.mode
        changed = true
      }
      if (this.describeFromLabel(agentId, info.label)) changed = true
      if (changed) this.notify()
      return
    }
    // An empty label is not a fact: the row keeps a visible placeholder that a
    // later real label can still replace.
    const label = typeof info.label === 'string' && info.label !== '' ? info.label : undefined
    this.states.set(agentId, {
      agentId,
      description: label ?? `${info.provider ?? 'subagent'} task`,
      provider: info.provider ?? 'subagent',
      model: info.model ?? info.provider,
      status: info.live ? 'running' : 'unknown',
      startedAt: info.childCreatedAt ?? Date.now(),
      sessionId: agentId,
      ...(info.mode === undefined ? {} : { mode: info.mode }),
      output: [],
      outputEvents: [],
      toolCalls: [],
    })
    this.descriptionSource.set(agentId, label === undefined ? 'placeholder' : 'bound')
    this.notify()
  }

  linkSession(agentId: string, session: unknown): void {
    if (session !== undefined && session !== null) this.sessionToAgent.set(session, agentId)
    const state = this.states.get(agentId)
    if (state && typeof session === 'string') state.sessionId = session
  }

  getSubagentIdBySession(session: unknown): string | undefined { return this.sessionToAgent.get(session) }

  has(agentId: string): boolean { return this.states.has(agentId) }

  /** The run key of one tracked child: its current epoch's key, or `undefined`
   *  when the row is tracked but has no run fact yet (a durable discovery row
   *  carries none). That is the same value an untracked child yields, so a
   *  caller that must tell the two apart asks `has()` as well. */
  runIdOf(agentId: string): string | undefined { return this.states.get(agentId)?.runId }

  appendOutput(agentId: string, text: string, kind: SubagentOutputKind = 'text'): void {
    const state = this.states.get(agentId)
    if (!state || !text) return
    const last = state.outputEvents[state.outputEvents.length - 1]
    if (last === undefined || last.settled || last.kind !== kind) {
      if (last !== undefined && !last.settled) last.settled = true
      this.pushLine(state, { kind, text, at: Date.now(), settled: false })
      this.notify()
      return
    }
    last.text += text
    const parts = last.text.split('\n')
    if (parts.length > 1) {
      last.text = parts[0]!
      last.settled = true
      for (const middle of parts.slice(1, -1)) {
        this.pushLine(state, { kind, text: middle, at: Date.now(), settled: true })
      }
      const tail = parts[parts.length - 1] ?? ''
      if (tail) this.pushLine(state, { kind, text: tail, at: Date.now(), settled: false })
    } else {
      state.output = state.outputEvents.map(entry => entry.text)
    }
    this.notify()
  }

  /** Mark the streaming tail line complete (run settlement). */
  flushOutput(agentId: string): void {
    const state = this.states.get(agentId)
    const last = state?.outputEvents[state.outputEvents.length - 1]
    if (last !== undefined && !last.settled) {
      last.settled = true
      this.notify()
    }
  }

  /** 0.1.5 live stream: transient attempt frames replace `assistant/chunk`
   *  session events (the durable settlement keeps flowing as session events). */
  onStreamFrame(agentId: string, frame: AssistantStreamFrame): void {
    const state = this.states.get(agentId)
    if (!state || (state.status !== 'running' && state.status !== 'starting')) return
    let stream = this.streams.get(agentId)
    if (stream === undefined) {
      stream = { revision: -1 }
      this.streams.set(agentId, stream)
    }
    if (frame.revision <= stream.revision) return
    stream.revision = frame.revision
    if (frame.type === 'end') {
      if (stream.attempt?.id === frame.attemptId) this.restoreAttempt(agentId, stream)
      return
    }
    if (frame.type === 'start' || stream.attempt === undefined) {
      this.restoreAttempt(agentId, stream)
      this.flushOutput(agentId)
      // Retain at most the existing 160-line window, never the chunk history.
      stream.attempt = {
        id: frame.attemptId,
        ...(frame.type === 'start' ? { turn: frame.turn, step: frame.step } : {}),
        before: state.outputEvents.map(line => ({ ...line })),
      }
    }
    if (frame.type === 'start' || stream.attempt?.id !== frame.attemptId) return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta' && chunk.text) this.appendOutput(agentId, chunk.text, 'text')
    else if (chunk.type === 'reasoning-delta' && chunk.text) this.appendOutput(agentId, chunk.text, 'thinking')
    else if (chunk.type === 'usage' && chunk.usage) this.setTokens(agentId, chunk.usage)
  }

  private restoreAttempt(agentId: string, stream: AssistantOutputStream): void {
    const state = this.states.get(agentId)
    if (!state || stream.attempt === undefined) return
    state.outputEvents = stream.attempt.before
    state.output = state.outputEvents.map(line => line.text)
    stream.attempt = undefined
    this.notify()
  }

  private settleAssistant(agentId: string, content: unknown, turn: unknown, step: unknown, seq: unknown): void {
    if (!this.states.has(agentId) || !Array.isArray(content)) return
    let stream = this.streams.get(agentId)
    if (stream === undefined) {
      stream = { revision: -1 }
      this.streams.set(agentId, stream)
    }
    if (typeof seq === 'number') {
      if (stream.settledSeq !== undefined && seq <= stream.settledSeq) return
      stream.settledSeq = seq
    }
    const attempt = stream.attempt
    if (attempt !== undefined && (attempt.turn === undefined || (attempt.turn === turn && attempt.step === step))) {
      this.restoreAttempt(agentId, stream)
    }
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const value = block as { type?: unknown; text?: unknown }
      if ((value.type !== 'text' && value.type !== 'reasoning') || typeof value.text !== 'string' || value.text === '') continue
      const kind = value.type === 'text' ? 'text' : 'thinking'
      for (const line of value.text.split('\n').slice(-MAX_OUTPUT_EVENTS)) this.commitLine(agentId, kind, line)
    }
    this.notify()
  }

  onSessionEvent(agentId: string, event: unknown): void {
    if (!event || typeof event !== 'object') return
    const ev = event as { type?: string; seq?: number; time?: unknown; data?: any }
    const data = ev.data ?? {}
    switch (ev.type) {
      case 'assistant/chunk': {
        const chunk = data.chunk ?? {}
        if (chunk.type === 'text-delta' && chunk.text) this.appendOutput(agentId, chunk.text, 'text')
        else if (chunk.type === 'reasoning-delta' && chunk.text) this.appendOutput(agentId, chunk.text, 'thinking')
        else if (chunk.type === 'usage' && chunk.usage) this.setTokens(agentId, chunk.usage)
        break
      }
      case 'assistant/message': {
        if (Array.isArray(data.stream)) this.settleAssistant(agentId, data.message?.content, data.turn, data.step, ev.seq)
        if (data.usage) {
          this.setTokens(agentId, data.usage)
          // durable usage 才进费用累计：live assistant/chunk 的 usage 只更新
          // 展示 token（见 setTokens 调用点），两路同时到达也只计这一路。
          this.accumulateCost(agentId, data.usage, ev.time, ev.seq)
        }
        break
      }
      case 'assistant/attempt': {
        const stream = this.streams.get(agentId)
        const attempt = stream?.attempt
        if (stream !== undefined && attempt !== undefined && (attempt.turn === undefined || (attempt.turn === data.turn && attempt.step === data.step))) {
          this.restoreAttempt(agentId, stream)
        }
        break
      }
      case 'tool/call': {
        this.recordTool(agentId, { id: data.callId, name: data.name, status: 'running', startedAt: Date.now(), argsPreview: data.arguments })
        break
      }
      case 'tool/result': {
        const callId = data?.message?.source?.callId
        const state = this.states.get(agentId)
        const tool = callId !== undefined ? state?.toolCalls.find(entry => entry.id === callId) : undefined
        if (tool) {
          const payload = toolResultPayload(data.message)
          tool.status = data.error !== undefined || payload.isError ? 'failed' : 'completed'
          tool.endedAt = Date.now()
          if (data.error !== undefined) tool.error = String(data.error)
          else if (payload.isError) tool.error = this.previewOf(payload.content)
          else {
            tool.resultPreview = this.previewOf(payload.content)
          }
          this.notify()
        }
        break
      }
      case 'subagent/descriptor': {
        // The child session's own durable self-description: the same keyed
        // label the parent catalog carries, usable once the session link
        // exists.
        if (this.describeFromLabel(agentId, data.label)) this.notify()
        break
      }
      default:
        break
    }
  }

  /** Merge partial updates (model discovery, session id) into one subagent. */
  patch(agentId: string, partial: Partial<SubagentState>): void {
    const state = this.states.get(agentId)
    if (!state) return
    Object.assign(state, partial)
    // A description handed in directly is authoritative, never a queue guess.
    if (partial.description !== undefined) this.descriptionSource.set(agentId, 'bound')
    this.notify()
  }

  /** One-line preview of a tool-result content block (text or item list). */
  private previewOf(content: unknown): string | undefined {
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(item => (typeof item === 'object' && item !== null && 'text' in item ? String((item as { text?: unknown }).text ?? '') : '')).join(' ')
        : ''
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat ? (flat.length > 80 ? `${flat.slice(0, 80)}…` : flat) : undefined
  }

  recordTool(agentId: string, input: Partial<SubagentToolCall> & { name?: string }): void {
    const state = this.states.get(agentId)
    if (!state || !input.name) return
    const current = input.id ? state.toolCalls.find(tool => tool.id === input.id) : undefined
    if (current) Object.assign(current, input)
    else state.toolCalls.push({ name: input.name, status: input.status ?? 'completed', startedAt: input.startedAt ?? Date.now(), ...input })
    this.notify()
  }

  setTokens(agentId: string, usage: { inputTokens?: number; outputTokens?: number; input?: number; output?: number; total?: number; context?: number }): void {
    const state = this.states.get(agentId)
    if (!state) return
    const input = usage.input ?? usage.inputTokens
    const output = usage.output ?? usage.outputTokens
    if (input === undefined && output === undefined && usage.total === undefined) return
    state.tokens = { ...state.tokens, input, output, total: usage.total ?? ((input ?? 0) + (output ?? 0) || undefined) }
    this.notify()
  }

  /** durable usage 的计价字段；全零/非法返回 undefined（不建零桶）。 */
  private costDeltaOf(usage: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
    if (usage === null || typeof usage !== 'object') return undefined
    const value = usage as {
      inputTokens?: unknown
      outputTokens?: unknown
      cacheReadTokens?: unknown
      cacheWriteTokens?: unknown
      input?: unknown
      output?: unknown
    }
    const count = (raw: unknown): number => typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
    const delta = {
      input: count(value.inputTokens ?? value.input),
      output: count(value.outputTokens ?? value.output),
      cacheRead: count(value.cacheReadTokens),
      cacheWrite: count(value.cacheWriteTokens),
    }
    if (delta.input === 0 && delta.output === 0 && delta.cacheRead === 0 && delta.cacheWrite === 0) return undefined
    return delta
  }

  /** 一笔 durable usage 按发生时刻落 peak/idle 桶，model/provider 取事件
   *  发生时的子代理身份；非官方/未收录同时进 unpriced 副本。
   *
   *  `seq` 是同一 binding 内的事件序号：重放/回放把同一条 durable 事件再投
   *  一次时只计第一笔（重投即双计会让"并入子代理"的估算凭空变大）。判据与
   *  `settleAssistant` 的 `settledSeq` 同源但**各自独立**——两处都要消费
   *  同一个 seq，共用字段会让后消费的那处被前一处挡掉。 */
  private accumulateCost(agentId: string, usage: unknown, time: unknown, seq?: unknown): void {
    const state = this.states.get(agentId)
    const delta = this.costDeltaOf(usage)
    if (state === undefined || delta === undefined) return
    if (typeof seq === 'number') {
      const consumed = this.costSeq.get(agentId)
      if (consumed !== undefined && seq <= consumed) return
      this.costSeq.set(agentId, seq)
    }
    const provider = state.provider ?? 'subagent'
    const model = state.model ?? provider
    const key = `${provider}\u0000${model}`
    let entry = this.costByModel.get(key)
    if (entry === undefined) {
      entry = { provider, model, buckets: emptyCostBuckets() }
      this.costByModel.set(key, entry)
    }
    const at = typeof time === 'number' ? new Date(time) : new Date()
    const peak = isPeakHour(at)
    addUsageToCostBuckets(entry.buckets, delta, peak)
    if (!isDeepSeekOfficialProvider(provider) || priceForModel(model) === undefined) {
      addUsageToCostBuckets(this.costUnpriced, delta, peak)
    }
  }

  /** durable 用量的费用快照（深拷贝）：entries 供计价，unpriced 供展示。 */
  costSnapshot(): SubagentCostSnapshot {
    return {
      entries: Array.from(this.costByModel.values()).map(entry => ({
        provider: entry.provider,
        model: entry.model,
        buckets: cloneCostBuckets(entry.buckets),
      })),
      unpriced: cloneCostBuckets(this.costUnpriced),
    }
  }

  onCompleted(agentId: string, summary?: string, stopReason = 'completed', endedAt?: number): void { this.finish(agentId, 'completed', stopReason, summary, endedAt) }
  onFailed(agentId: string, error: string, endedAt?: number): void { this.finish(agentId, 'failed', error, undefined, endedAt) }
  onCancelled(agentId: string, reason = 'cancelled', summary?: string, endedAt?: number): void { this.finish(agentId, 'cancelled', reason, summary, endedAt) }

  private finish(agentId: string, status: SubagentStatus, reason?: string, summary?: string, endedAt?: number): void {
    const state = this.states.get(agentId)
    // `unknown` rows (durable discovery: catalog children, workflow members
    // folded from the log) accept their settlement edge the same as live
    // rows — a terminal edge is authoritative regardless of how the row was
    // born. Already-settled rows keep their first outcome.
    if (!state || (state.status !== 'running' && state.status !== 'starting' && state.status !== 'unknown')) return
    // A discovered row settling from `unknown` closes at the durable event's
    // wall time (`agent-end` stamps it), falling back to startedAt when even
    // that is missing: completedAt must stay a number so the row projection's
    // durationMs never ticks on a settled row.
    const discovered = state.status === 'unknown'
    const stream = this.streams.get(agentId)
    if (stream !== undefined) this.restoreAttempt(agentId, stream)
    state.status = status
    state.completedAt = discovered ? endedAt ?? state.startedAt : Date.now()
    state.endedAt = state.completedAt
    state.stopReason = reason
    if (summary) state.summary = summary
    if (status === 'failed') state.error = reason
    this.notify()
  }

  /** Drop all tracked subagents and session links (session swap: the old
   * session's children were disposed with their parent — nothing may keep
   * routing events of a session the channel no longer projects). The
   * session-scoped cost buckets reset with them. */
  reset(): void {
    this.states.clear()
    this.sessionToAgent.clear()
    this.streams.clear()
    this.costByModel.clear()
    this.costUnpriced = emptyCostBuckets()
    this.costSeq.clear()
    this.descriptionSource.clear()
    this.earlyLabels.clear()
    this.notify()
  }

  snapshot(): SubagentState[] { return Array.from(this.states.values()).map(state => ({ ...state, output: [...state.output], outputEvents: [...state.outputEvents], toolCalls: state.toolCalls.map(tool => ({ ...tool })), tokens: state.tokens ? { ...state.tokens } : undefined })) }
  get(agentId: string): SubagentState | undefined { return this.snapshot().find(state => state.agentId === agentId) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private notify(): void { for (const listener of this.listeners) listener() }
}
