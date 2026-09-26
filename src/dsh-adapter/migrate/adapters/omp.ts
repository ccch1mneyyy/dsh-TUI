/**
 * OMP adapter: `~/.omp/agent/sessions/--<munged-cwd>--/<timestamp>_<id>.jsonl`.
 * OMP shares the DSH lineage: a `session` header line plus `message` lines
 * whose `message.content` block shape is identical to ours, so this adapter
 * is a near-direct mapping.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/omp
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MigrationAdapter, MigrationDiscovery, MigrationSession, MigrationTurn } from '../types.js'

interface ContentBlock { readonly type?: unknown, readonly text?: unknown }

function blocksText(content: unknown, want: readonly string[]): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as ContentBlock[]) {
    if (block !== null && typeof block === 'object' && want.includes(block.type as string) && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text)
    }
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
  const nameMatch = /^[\dT:.Z-]*_([0-9a-zA-Z-]+)\.jsonl$/u.exec(path.split('/').pop() ?? '')
  const sourceId = nameMatch?.[1] ?? path
  let cwd: string | undefined
  let startedAt = 0
  let title: string | undefined
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
    const time = toMillis(entry.timestamp)
    if (entry.type === 'session' || entry.type === 'title') {
      if (typeof entry.cwd === 'string' && entry.cwd !== '') cwd = entry.cwd
      if (typeof entry.title === 'string' && entry.title !== '') title = entry.title
      startedAt = startedAt || toMillis(entry.timestamp)
      continue
    }
    if (entry.type !== 'message') continue
    const message = entry.message as { role?: unknown, content?: unknown } | undefined
    if (!message || typeof message !== 'object') continue  // !x also rejects JSON null (typeof null === 'object')
    if (message.role === 'user') {
      const text = blocksText(message.content, ['text'])
      if (text === '') continue
      turns.push({ role: 'user', text, time })
    } else if (message.role === 'assistant') {
      const text = blocksText(message.content, ['text'])
      const reasoning = blocksText(message.content, ['reasoning', 'thinking'])
      if (text === '' && reasoning === '') continue
      turns.push({ role: 'assistant', text, reasoning: reasoning === '' ? undefined : reasoning, time })
    }
  }
  if (turns.length === 0 || cwd === undefined) return undefined
  return { sourceId, cwd, title, startedAt: startedAt || turns[0]!.time, turns }
}

export const ompAdapter: MigrationAdapter = {
  id: 'omp',
  label: 'OMP',
  roots: () => [join(homedir(), '.omp', 'agent', 'sessions')],
  discover(): MigrationDiscovery {
    const roots = this.roots()
    const sessions: MigrationSession[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
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
