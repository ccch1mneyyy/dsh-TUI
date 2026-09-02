/**
 * Agent view (CC `claude agents`) derivation helpers — pure functions over
 * session events that the channel folds into {@link AgentViewRow}s. Kept in
 * their own module so the focused regression (`scripts/verify-agent-view.mjs`)
 * can import them without spinning up a composition.
 *
 * @module @deepseek-harness-tui/dsh-tui/agent-view
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreviewEntry } from './sessions/index.js'
import type { AgentViewStatus } from './channel.js'

/** Agent-view row ordering: needs-input first, stopped last. */
export const AGENT_VIEW_STATUS_ORDER: readonly AgentViewStatus[] = [
  'needs-input', 'working', 'failed', 'completed', 'idle', 'stopped',
]

/** How long a row summary may be before the UI truncates it. */
export const AGENT_VIEW_SUMMARY_LIMIT = 160

/** The row name's budget: the fallback name is the first prompt compressed
 *  to this many cells (CC's auto-name is a short label, not a prompt dump). */
export const AGENT_VIEW_NAME_LIMIT = 28

/** Collapse every whitespace run (including newlines) into one space so a
 *  multi-paragraph reply always renders as a single row line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** The first non-empty text block of a user/assistant message content. */
export function agentViewTextOf(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record['type'] !== 'text') continue
    const text = record['text']
    if (typeof text === 'string' && text.trim().length > 0) return text.trim()
  }
  return undefined
}

/** True when any of the events is a human user message. */
export function agentViewHasTurns(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'user/message')
}

/**
 * One agent-view row's derived facts, folded incrementally from events.
 * `hasTurns`, `summary` and `title` only walk events appended since the last
 * fold — session logs are append-only, so the cache never rescans history.
 */
export interface AgentViewFold {
  hasTurns: boolean
  /** The first human prompt (the fallback title's source). */
  firstPrompt: string
  /** Last non-empty assistant text, else last tool-call name, else the
   *  first prompt — the one-line "what is it doing" summary. */
  summary: string
  /** Where the current summary came from: a tool call wins over a prompt,
   *  assistant text wins over both. */
  summaryKind: 'none' | 'prompt' | 'tool' | 'assistant'
  title: string
  /** `time` of the last folded event (the row's updatedAt). */
  updatedAt: number
  /** Whether the last folded turn ended with an error. */
  lastTurnFailed: boolean
}

/**
 * Fold events `[start, end)` into `base` and return the combined result.
 * @param events - The append-only session log.
 * @param start - First index to fold (the previously folded length).
 * @param base - The fold the cache already holds.
 * @returns The extended fold.
 */
export function foldAgentViewEvents(
  events: readonly SessionEvent[],
  start: number,
  base: AgentViewFold,
): AgentViewFold {
  const fold = { ...base }
  for (let i = start; i < events.length; i += 1) {
    const event = events[i]!
    fold.updatedAt = event.time
    switch (event.type) {
      case 'user/message': {
        fold.hasTurns = true
        const text = agentViewTextOf(event.data.content)
        if (fold.firstPrompt.length === 0 && text !== undefined) fold.firstPrompt = oneLine(text)
        // The prompt stands in for the summary only until the session
        // starts doing something (a tool call or assistant text replaces it).
        if (fold.summaryKind === 'none' && text !== undefined) {
          fold.summary = oneLine(text)
          fold.summaryKind = 'prompt'
        }
        break
      }
      case 'assistant/message': {
        const text = agentViewTextOf(event.data.message.content)
        if (text !== undefined) {
          fold.summary = oneLine(text)
          fold.summaryKind = 'assistant'
        }
        break
      }
      case 'tool/call': {
        // The current activity beats the prompt it was answering; assistant
        // text beats a tool call.
        if (fold.summaryKind === 'none' || fold.summaryKind === 'prompt') {
          fold.summary = String(event.data.name)
          fold.summaryKind = 'tool'
        }
        break
      }
      case 'session/title': {
        const title = (event.data as { title?: unknown }).title
        if (typeof title === 'string' && title.trim().length > 0) fold.title = oneLine(title)
        break
      }
      case 'turn/end': {
        const reason = (event.data as { reason?: { kind?: string } }).reason
        fold.lastTurnFailed = reason?.kind === 'error'
        break
      }
      default:
        break
    }
  }
  return fold
}

/** The trailing exchanges of a live session's in-memory log. */
export function agentViewLivePreview(events: readonly SessionEvent[], limit: number): PreviewEntry[] {
  const entries: PreviewEntry[] = []
  for (let i = events.length - 1; i >= 0 && entries.length < limit; i -= 1) {
    const event = events[i]!
    if (event.type === 'user/message') {
      const text = agentViewTextOf(event.data.content)
      if (text !== undefined) entries.push({ role: 'user', text, at: event.time })
    } else if (event.type === 'assistant/message') {
      const text = agentViewTextOf(event.data.message.content)
      if (text !== undefined) entries.push({ role: 'assistant', text, at: event.time })
    }
  }
  return entries.reverse()
}

/** A row title when the session never recorded one: the opening prompt's
 *  opening words, else the working directory's basename. */
export function sessionTitleFallback(fold: AgentViewFold, cwd: string | undefined): string {
  const source = fold.firstPrompt.length > 0 ? fold.firstPrompt : fold.summary
  if (source.length > 0) {
    const clipped = source.length <= AGENT_VIEW_NAME_LIMIT
      ? source
      : `${source.slice(0, AGENT_VIEW_NAME_LIMIT - 1)}…`
    return clipped
  }
  const base = (cwd ?? '').length > 0 ? (cwd ?? '').split('/').filter(Boolean).at(-1) ?? '' : ''
  return base.length > 0 ? base : 'untitled'
}

/**
 * The agent-view state for a live agent: a parked approval wins over a
 * running turn, a failed last turn over completion, and a conversation-less
 * idle agent stays plain idle.
 */
export function agentViewStatusOf(
  liveStatus: 'idle' | 'running',
  fold: AgentViewFold,
  needsInput: boolean,
): AgentViewStatus {
  if (needsInput) return 'needs-input'
  if (liveStatus === 'running') return 'working'
  if (fold.lastTurnFailed) return 'failed'
  if (fold.hasTurns) return 'completed'
  return 'idle'
}
