/** Coalesce command output per call at 10 Hz; a result flushes first. */
import type { AgentEvent, AgentEventOf } from '../../../agent/events.js'
import type { RpcClock } from '../rpc/client.js'

export function createToolOutputBuffer(emit: (events: readonly AgentEvent[]) => void, clock: RpcClock) {
  const pending = new Map<string, { event: AgentEventOf<'tool.output'>; timer: unknown }>()
  const keyOf = (event: AgentEventOf<'tool.output'>): string => (event.parentCallId ?? '') + '\u0000' + event.callId
  const flush = (callId?: string): void => {
    for (const [id, value] of pending) {
      if (callId !== undefined && value.event.callId !== callId) continue
      pending.delete(id)
      clock.clearTimeout(value.timer)
      emit([value.event])
    }
  }
  return {
    push(event: AgentEventOf<'tool.output'>): void {
      const value = pending.get(keyOf(event))
      if (value !== undefined) {
        value.event = { ...event, text: value.event.text + event.text }
        return
      }
      pending.set(keyOf(event), { event, timer: clock.setTimeout(() => flush(event.callId), 100) })
    },
    flush,
    close(): void {
      for (const value of pending.values()) clock.clearTimeout(value.timer)
      pending.clear()
    },
  }
}
