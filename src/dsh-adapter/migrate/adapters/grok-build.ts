/**
 * grok-build adapter: `~/.grok/sessions/<encoded-cwd>/<uuid>/` — each session
 * directory holds a `summary.json` (metadata) and a `chat_history.jsonl`
 * whose rows are tagged `ConversationItem`s: `user` rows carry block-array
 * content, `assistant` rows plain strings, and a `reasoning` row precedes
 * the assistant turn it belongs to. Rows carry no per-row timestamp, so
 * turns inherit the summary's clock. The legacy v0 shape (`{role, content}`)
 * is accepted alongside v1.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/grok-build
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MigrationAdapter, MigrationDiscovery, MigrationSession, MigrationTurn } from '../types.js'
import { countEntries } from './scan.js'

interface TextPart { readonly type?: unknown, readonly text?: unknown }

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content as readonly TextPart[]) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
      parts.push(part.text)
    }
  }
  return parts.join('\n\n')
}

function reasoningText(row: Record<string, unknown>): string {
  const summary = row.summary
  if (!Array.isArray(summary)) return ''
  const parts: string[] = []
  for (const part of summary as readonly TextPart[]) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string' && part.text !== '') parts.push(part.text)
  }
  return parts.join('\n\n')
}

function toMillis(iso: unknown): number {
  return typeof iso === 'string' ? Date.parse(iso) || 0 : 0
}

function readOne(dir: string): MigrationSession | undefined {
  let rawSummary: string
  let rawLines: string
  try {
    rawSummary = readFileSync(join(dir, 'summary.json'), 'utf8')
    rawLines = readFileSync(join(dir, 'chat_history.jsonl'), 'utf8')
  } catch {
    return undefined
  }
  let summaryDoc: unknown
  try {
    summaryDoc = JSON.parse(rawSummary)
  } catch {
    return undefined
  }
  // A legal `null` (or scalar) summary is not a session; member access on it
  // would throw and kill the whole scan.
  if (!summaryDoc || typeof summaryDoc !== 'object') return undefined
  const summary = summaryDoc as { info?: unknown, created_at?: unknown, updated_at?: unknown, generated_title?: unknown, session_summary?: unknown }
  // !x also rejects JSON null (typeof null === 'object').
  if (!summary.info || typeof summary.info !== 'object') return undefined
  const info = summary.info as { id?: unknown, cwd?: unknown }
  if (typeof info.id !== 'string' || info.id === '') return undefined
  if (typeof info.cwd !== 'string' || info.cwd === '') return undefined
  const startedAt = toMillis(summary.created_at) || toMillis(summary.updated_at)
  const generatedTitle = summary.generated_title
  const fallbackTitle = summary.session_summary
  const title = typeof generatedTitle === 'string' && generatedTitle !== ''
    ? generatedTitle
    : typeof fallbackTitle === 'string' && fallbackTitle !== '' ? fallbackTitle : undefined
  const turns: MigrationTurn[] = []
  let pendingReasoning: string | undefined
  for (const line of rawLines.split('\n')) {
    if (line === '') continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!row || typeof row !== 'object') continue
    const role = row.type === undefined ? row.role : row.type
    if (role === 'user') {
      // Tagged synthetic injections (system reminders, compaction meta, …)
      // are not the human's words; the default `human` tag is omitted.
      const reason = row.synthetic_reason
      if (reason !== undefined && reason !== 'human') continue
      const text = blocksText(row.content)
      if (text === '') continue
      turns.push({ role: 'user', text, time: startedAt })
    } else if (role === 'assistant') {
      const text = blocksText(row.content)
      if (text === '' && pendingReasoning === undefined) continue
      const model = row.model_id
      turns.push({
        role: 'assistant',
        text,
        reasoning: pendingReasoning,
        model: typeof model === 'string' && model !== '' ? model : undefined,
        time: startedAt,
      })
      pendingReasoning = undefined
    } else if (role === 'reasoning') {
      // A reasoning row is the pre-sibling of the assistant turn it explains.
      const text = reasoningText(row)
      if (text !== '') pendingReasoning = pendingReasoning === undefined ? text : `${pendingReasoning}\n\n${text}`
    }
  }
  if (turns.length === 0) return undefined
  return { sourceId: info.id, cwd: info.cwd, title, startedAt: startedAt || turns[0]!.time, turns }
}

export const grokBuildAdapter: MigrationAdapter = {
  id: 'grok-build',
  label: 'Grok Build',
  roots(): readonly string[] {
    const grokHome = process.env.GROK_HOME?.trim()
    return [join(grokHome !== undefined && grokHome !== '' ? grokHome : join(homedir(), '.grok'), 'sessions')]
  },
  discover(): MigrationDiscovery {
    const roots = this.roots()
    const sessions: MigrationSession[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 2) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (entry.isFile() && entry.name === 'chat_history.jsonl') {
          try {
            if (statSync(path).size > 64 * 1024 * 1024) continue
          } catch {
            continue
          }
          const session = readOne(dir)
          if (session !== undefined) sessions.push(session)
        }
      }
    }
    for (const root of roots) walk(root, 0)
    return { roots, sessions }
  },
  count(): number {
    return countEntries(this.roots(), { maxDepth: 2, fileMatch: name => name === 'chat_history.jsonl' })
  },
}
