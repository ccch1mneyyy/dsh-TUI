/**
 * Codex adapter: `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl`. The log
 * interleaves `session_meta`, `response_item` (OpenAI Responses items —
 * `message` with `input_text`/`output_text` blocks; `reasoning` is encrypted
 * and stays unreadable) and `event_msg` housekeeping, which we skip.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/codex
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MigrationAdapter, MigrationDiscovery, MigrationSession, MigrationTurn } from '../types.js'

interface ContentBlock { readonly type?: unknown, readonly text?: unknown }

function blocksText(content: unknown, want: string): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as ContentBlock[]) {
    if (block?.type === want && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n\n')
}

function toMillis(iso: unknown): number {
  return typeof iso === 'string' ? Date.parse(iso) || 0 : 0
}

function readOne(path: string): MigrationSession | undefined {
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    return undefined
  }
  const match = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(path)
  const sourceId = match?.[1] ?? path
  let cwd: string | undefined
  let startedAt = 0
  let lastModel: string | undefined
  const turns: MigrationTurn[] = []
  for (const line of lines) {
    if (line === '') continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    // A legal `null` (or scalar) line is not a record; reading .type on it
    // would throw and kill the whole scan (codex adversarial review).
    if (entry === null || typeof entry !== 'object') continue
    const payload = entry.payload as Record<string, unknown> | undefined
    if (payload === undefined || typeof payload !== 'object') continue
    const time = toMillis(entry.timestamp)
    if (entry.type === 'session_meta') {
      if (typeof payload.cwd === 'string' && payload.cwd !== '') cwd = payload.cwd
      startedAt = startedAt || toMillis(payload.timestamp) || time
      continue
    }
    // Codex records the active model per turn in `turn_context`; carry the
    // latest forward so assistant turns can cite the model that wrote them.
    if (entry.type === 'turn_context' && typeof payload.model === 'string' && payload.model !== '') {
      lastModel = payload.model
      continue
    }
    if (entry.type !== 'response_item' || payload.type !== 'message') continue
    if (payload.role === 'user') {
      const text = blocksText(payload.content, 'input_text')
      if (text === '') continue
      turns.push({ role: 'user', text, time })
    } else if (payload.role === 'assistant') {
      const text = blocksText(payload.content, 'output_text')
      if (text === '') continue
      turns.push({ role: 'assistant', text, model: lastModel, time })
    }
  }
  if (turns.length === 0 || cwd === undefined) return undefined
  return { sourceId, cwd, startedAt: startedAt || turns[0]!.time, turns }
}

export const codexAdapter: MigrationAdapter = {
  id: 'codex',
  label: 'Codex',
  roots: () => [join(homedir(), '.codex', 'sessions')],
  discover(): MigrationDiscovery {
    const roots = this.roots()
    const sessions: MigrationSession[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 5) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          try {
            if (statSync(path).size > 64 * 1024 * 1024) continue
          } catch {
            continue
          }
          const session = readOne(path)
          if (session !== undefined) sessions.push(session)
        }
      }
    }
    for (const root of roots) walk(root, 0)
    return { roots, sessions }
  },
}
