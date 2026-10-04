/** Streaming inbox, input placement and renderer wake policy. */
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, AgentEventMeta } from '../../../agent/events.js'
import type { SubmitPlacement } from '../../../agent/session.js'
import { rec } from '../narrow.js'

/** A minimal push-based async iterable: the session's stdin. */
export function createInbox<T>() {
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

/** Renderer urgency of one translated message. */
export function wakeOf(message: unknown, events: readonly AgentEvent[]): AgentEventMeta['wake'] {
  const value = rec(message)
  if (value?.type === 'stream_event' && rec(value.event)?.type === 'content_block_delta') return 'frame'
  if (value?.type === 'system' && value.subtype === 'thinking_tokens') return 'frame'
  return events.every(event => event.type === 'session.status' || event.type === 'pending.changed') ? 'none' : 'sync'
}

/** `SDKUserMessage.priority` for a channel placement. */
export function priorityOf(placement: SubmitPlacement, turnOpen: boolean): SDKUserMessage['priority'] {
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
