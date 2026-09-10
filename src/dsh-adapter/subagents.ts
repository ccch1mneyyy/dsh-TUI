import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SubagentState, SubagentStatus, SubagentOutputLine, SubagentOutputKind, SubagentToolCall, SubagentTokenUsage } from '../adapter/ports/channel-view.js'
export type { SubagentState, SubagentStatus, SubagentOutputLine, SubagentOutputKind, SubagentToolCall, SubagentTokenUsage } from '../adapter/ports/channel-view.js'


const MAX_OUTPUT_EVENTS = 160
const MAX_OUTPUT_LINES = 160

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

  onSpawned(agentId: string, provider = 'subagent', model?: string, info: Partial<SubagentState> = {}): void {
    const existing = this.states.get(agentId)
    const state: SubagentState = existing ?? {
      agentId,
      runId: info.runId ?? agentId,
      description: info.description ?? 'Subagent task',
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
    }
    if (existing) {
      Object.assign(existing, info, { provider, model: model ?? existing.model, status: existing.status === 'completed' ? existing.status : 'running' })
    } else {
      this.states.set(agentId, state)
    }
    this.notify()
  }

  linkSession(agentId: string, session: unknown): void {
    if (session !== undefined && session !== null) this.sessionToAgent.set(session, agentId)
    const state = this.states.get(agentId)
    if (state && typeof session === 'string') state.sessionId = session
  }

  getSubagentIdBySession(session: unknown): string | undefined { return this.sessionToAgent.get(session) }

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
    const ev = event as { type?: string; seq?: number; data?: any }
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
        if (data.usage) this.setTokens(agentId, data.usage)
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
          tool.status = data.error !== undefined ? 'failed' : 'completed'
          tool.endedAt = Date.now()
          if (data.error !== undefined) tool.error = String(data.error)
          else {
            const block = data.message?.content?.[0]
            tool.resultPreview = block !== undefined && block.type === 'tool-result'
              ? this.previewOf(block.content)
              : undefined
          }
          this.notify()
        }
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

  onCompleted(agentId: string, summary?: string, stopReason = 'completed'): void { this.finish(agentId, 'completed', stopReason, summary) }
  onFailed(agentId: string, error: string): void { this.finish(agentId, 'failed', error, undefined) }
  onCancelled(agentId: string, reason = 'cancelled', summary?: string): void { this.finish(agentId, 'cancelled', reason, summary) }

  private finish(agentId: string, status: SubagentStatus, reason?: string, summary?: string): void {
    const state = this.states.get(agentId)
    if (!state || (state.status !== 'running' && state.status !== 'starting')) return
    const stream = this.streams.get(agentId)
    if (stream !== undefined) this.restoreAttempt(agentId, stream)
    state.status = status
    state.completedAt = Date.now()
    state.endedAt = state.completedAt
    state.stopReason = reason
    if (summary) state.summary = summary
    if (status === 'failed') state.error = reason
    this.notify()
  }

  /** Drop all tracked subagents and session links (session swap: the old
   * session's children were disposed with their parent — nothing may keep
   * routing events of a session the channel no longer projects). */
  reset(): void {
    this.states.clear()
    this.sessionToAgent.clear()
    this.streams.clear()
    this.notify()
  }

  snapshot(): SubagentState[] { return Array.from(this.states.values()).map(state => ({ ...state, output: [...state.output], outputEvents: [...state.outputEvents], toolCalls: state.toolCalls.map(tool => ({ ...tool })), tokens: state.tokens ? { ...state.tokens } : undefined })) }
  get(agentId: string): SubagentState | undefined { return this.snapshot().find(state => state.agentId === agentId) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private notify(): void { for (const listener of this.listeners) listener() }
}
