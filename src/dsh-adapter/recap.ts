import type { RecapOutcome } from '../adapter/ports/channel-catalog.js'
export type { RecapOutcome } from '../adapter/ports/channel-catalog.js'
/**
 * Session recap (`/recap`, pi-recap semantics): a single TOOL-LESS LLM
 * call that summarizes the session's RECENT activity into one line and
 * proposes a short title. Unlike `/btw` it does not replay the full
 * derived history — the recent-activity excerpt below IS the payload, so
 * the call stays cheap and the recap is about the tail of the session,
 * which is exactly what a glance at a resumed/unknown session needs.
 *
 * The answer never enters the session log — it is pure UI state (the
 * RecapPanel in the Chat screen); applying the proposed title goes
 * through the normal `/rename` path (channel.renameSession).
 *
 * @module
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Max chars of recent activity fed to the recap call. */
export const RECAP_RECENT_CHARS = 6000
/** How many exchanges (user + assistant) the recap looks back. */
const RECAP_RECENT_TURNS = 6

/** The first text block of a message `content` payload. */
function textOfContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record['type'] !== 'text') continue
    const value = record['text']
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * Collect the most recent user/assistant exchanges from a session event
 * log as plain `role: text` lines, capped to the tail turns and a char
 * budget. Rows derived from the log (tool cards, notices) are skipped —
 * the recap wants the conversation, not the chrome.
 */
export function collectRecentActivity(events: readonly SessionEvent[], limitChars: number): string {
  const entries: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const event of events) {
    const record = event as unknown as Record<string, unknown>
    if (record['type'] === 'user/message') {
      const data = record['data'] as Record<string, unknown> | undefined
      const text = textOfContent(data?.['content'])
      if (text !== undefined) entries.push({ role: 'user', text })
      continue
    }
    if (record['type'] === 'assistant/message') {
      const data = record['data'] as Record<string, unknown> | undefined
      const message = data?.['message'] as Record<string, unknown> | undefined
      const text = textOfContent(message?.['content'])
      if (text !== undefined) entries.push({ role: 'assistant', text })
    }
  }

  const tail = entries.slice(-RECAP_RECENT_TURNS * 2)
  let budget = limitChars
  // Admit NEWEST first: the recap exists to summarize where the session
  // STANDS, so the most recent exchanges must survive a long entry eating
  // the budget — oldest-first admission lets one oversized message starve
  // every exchange after it (the very ones a recap is for).
  const picked: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const entry of [...tail].reverse()) {
    if (budget <= 0) break
    const text = entry.text.length > budget ? entry.text.slice(0, budget) : entry.text
    picked.push({ role: entry.role, text })
    budget -= text.length + entry.role.length + 2
  }
  // Present in chronological order (oldest → newest) for readable quoting.
  picked.reverse()
  return picked.map(entry => `${entry.role}: ${entry.text}`).join('\n')
}

/** The recap prompt and its answer parser are backend-neutral (the Claude
 *  backend's `/recap` uses the same contract): src/channel/side-prompts.ts. */
export { parseRecapResponse, wrapRecapPrompt } from '../channel/side-prompts.js'
