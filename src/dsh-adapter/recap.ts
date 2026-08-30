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

/**
 * Wrap the recent-activity excerpt with the single-response, JSON-only
 * recap contract. The model answers with a title + one-line summary in
 * the language of the activity (matching the user's own words).
 */
export function wrapRecapPrompt(activity: string): string {
  return `<system-reminder>You are a thoughtful assistant helping the user wrap up this session. Look at the recent activity below and give it a quick human review — like a colleague summarizing what the two of you just worked on.

TASK — do BOTH:
1. Write ONE short line (about 10-20 words) recapping the RECENT ACTIVITY: what was being worked on and where things stand. Write it in the same language the user writes in. Sound natural and professional — a warm recap, not a dry log.
2. Propose a short session title (about 2-6 words, same language) that captures what this session is about.

Respond with ONLY a JSON object, no markdown fences, no extra text:
{"title": "<short title>", "summary": "<one-line summary>"}

RECENT ACTIVITY:
${activity}</system-reminder>`
}

/**
 * Parse the model's recap response: extract the JSON object (tolerating
 * stray prose around it); on failure the whole text becomes the summary
 * and no title is proposed.
 */
export function parseRecapResponse(raw: string): { summary: string; title?: string } {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        const summary =
          typeof record['summary'] === 'string' && record['summary'].trim() !== ''
            ? record['summary'].trim()
            : undefined
        const title =
          typeof record['title'] === 'string' && record['title'].trim() !== ''
            ? record['title'].trim()
            : undefined
        if (summary !== undefined) {
          return title === undefined ? { summary } : { summary, title }
        }
      }
    } catch {
      // Fall through to the raw-text fallback below.
    }
  }
  return { summary: raw.trim() }
}

/** Outcome of one recap call, as surfaced on the Channel. */
export interface RecapOutcome {
  /** The one-line summary, or null when the call failed. */
  summary: string | null
  /** Proposed session title, when the model offered one. */
  title?: string
  /** Human-readable failure reason (llm missing, stream error, …). */
  error?: string
}
