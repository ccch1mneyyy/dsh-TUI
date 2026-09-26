/**
 * Claude Code adapter: `~/.claude/projects/<munged-cwd>/<session>.jsonl`.
 * Lines are self-describing (`type` field); user/assistant message lines carry
 * `message.content` as a plain string OR a content-block array — both are
 * normalized here. Tool results surface as user lines with machine content
 * and are skipped (their `content` is an array of tool_result blocks).
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/claude-code
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MigrationAdapter, MigrationDiscovery, MigrationSession, MigrationTurn } from '../types.js'

interface CodeBlock { readonly type?: unknown, readonly text?: unknown }

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content === '' ? undefined : content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content as CodeBlock[]) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

/** Strip Claude Code's inline <system-reminder> machine blocks from user text. */
function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, '').trim()
}

function toMillis(iso: unknown): number {
  return typeof iso === 'string' ? Date.parse(iso) || 0 : 0
}

/** Extract the text of a user line, skipping tool_result-only lines. */
function userText(message: { content?: unknown } | undefined): string | undefined {
  if (message === undefined) return undefined
  const content = message.content
  if (Array.isArray(content)) {
    const blocks = content as CodeBlock[]
    if (blocks.some(block => block?.type === 'tool_result')) return undefined
  }
  const raw = textOf(content)
  if (raw === undefined) return undefined
  const stripped = stripReminders(raw)
  return stripped === '' ? undefined : stripped
}

function readOne(path: string, fallbackCwd: string): MigrationSession | undefined {
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    return undefined
  }
  const sourceId = path.split('/').pop()?.replace(/\.jsonl$/u, '') ?? path
  let startedAt = 0
  let turns: MigrationTurn[] = []
  let lineCwd: string | undefined
  for (const line of lines) {
    if (line === '') continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = entry.type
    if (type === 'session' && startedAt === 0) {
      startedAt = toMillis(entry.timestamp)
      continue
    }
    if (type !== 'user' && type !== 'assistant') continue
    if (entry.isSidechain === true || entry.isMeta === true) continue
    const message = entry.message as { role?: unknown, content?: unknown, model?: unknown } | undefined
    if (message === undefined || typeof message !== 'object') continue
    // Claude Code writes the authoritative cwd on every message line; the
    // dash-munged directory name cannot preserve `_`/`.`/`-` and the
    // system-reminder marker appears in only a small minority of logs.
    if (typeof entry.cwd === 'string' && entry.cwd !== '') lineCwd = entry.cwd
    const time = toMillis(entry.timestamp)
    if (type === 'user') {
      const text = userText(message as { content?: unknown })
      if (text === undefined) continue
      turns.push({ role: 'user', text, time })
    } else {
      const content = message.content
      const text = textOf(content) ?? ''
      const reasoning = Array.isArray(content)
        ? (content as CodeBlock[]).filter(block => block?.type === 'thinking').map(block => block.text).filter((t): t is string => typeof t === 'string').join('\n\n')
        : ''
      if (text === '' && reasoning === '') continue
      const model = typeof message.model === 'string' && message.model !== '' ? message.model : undefined
      turns.push({ role: 'assistant', text, reasoning: reasoning === '' ? undefined : reasoning, model, time })
    }
  }
  if (turns.length === 0) return undefined
  // cwd precedence: the per-line `cwd` field (authoritative, present on real
  // logs) → the first user prompt's system-reminder → the unmunged directory
  // name (lossy fallback for foreign/moved logs).
  let cwd = lineCwd ?? fallbackCwd
  const reminder = turns.find(turn => turn.role === 'user' && turn.text.includes('Primary working directory:'))
  if (cwd === fallbackCwd && reminder !== undefined) {
    const match = /Primary working directory: (\S+)/u.exec(reminder.text)
    if (match !== null) cwd = match[1]
  }
  // A sidechain-heavy log may carry nothing but tool chatter; keep it honest.
  const userTurns = turns.filter(turn => turn.role === 'user')
  if (userTurns.length === 0) return undefined
  turns = turns.filter(turn => turn.role === 'user' || turn.text !== '' || turn.reasoning !== undefined)
  return { sourceId, cwd, startedAt: startedAt || turns[0]!.time, turns }
}

export const claudeCodeAdapter: MigrationAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  roots: () => [join(homedir(), '.claude', 'projects')],
  discover(): MigrationDiscovery {
    const roots = this.roots()
    const sessions: MigrationSession[] = []
    const walk = (dir: string, depth: number, fallbackCwd: string): void => {
      if (depth > 3) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, depth + 1, unmunge(entry.name) ?? fallbackCwd)
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            if (statSync(path).size > 64 * 1024 * 1024) continue
          } catch {
            continue
          }
          const session = readOne(path, fallbackCwd)
          if (session !== undefined) sessions.push(session)
        }
      }
    }
    for (const root of roots) walk(root, 0, homedir())
    return { roots, sessions }
  },
}

/** Best-effort inverse of Claude Code's dash-munged directory names. */
function unmunge(name: string): string | undefined {
  if (!name.startsWith('-')) return undefined
  return `/${name.split('-').filter(Boolean).join('/')}`
}
