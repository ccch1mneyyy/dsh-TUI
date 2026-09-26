/**
 * zcode adapter: `~/.zcode/v2/sessions/<dir>/<taskId>.json` — one JSON
 * object per conversation (`{ meta, messages }`), the simplest of the
 * foreign stores: plain-string contents and epoch-millisecond timestamps.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/zcode
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MigrationAdapter, MigrationDiscovery, MigrationSession, MigrationTurn } from '../types.js'

interface ZcodeMessage { readonly role?: unknown, readonly content?: unknown, readonly timestamp?: unknown }

function readOne(path: string): MigrationSession | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return undefined
  }
  // A legal `null` (or scalar) document is not a conversation; member
  // access on it would throw and kill the whole scan.
  if (!doc || typeof doc !== 'object') return undefined
  const meta = (doc as { meta?: unknown }).meta
  const messages = (doc as { messages?: unknown }).messages
  // !x also rejects JSON null (typeof null === 'object').
  if (!meta || typeof meta !== 'object' || !Array.isArray(messages)) return undefined
  const taskId = (meta as { taskId?: unknown }).taskId
  const cwd = (meta as { workspacePath?: unknown }).workspacePath
  const title = (meta as { title?: unknown }).title
  const createdAt = (meta as { createdAt?: unknown }).createdAt
  if (typeof taskId !== 'string' || taskId === '') return undefined
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const turns: MigrationTurn[] = []
  for (const message of messages as readonly ZcodeMessage[]) {
    if (!message || typeof message !== 'object') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (typeof message.content !== 'string' || message.content === '') continue
    const time = typeof message.timestamp === 'number' ? message.timestamp : 0
    turns.push({ role: message.role, text: message.content, time })
  }
  if (turns.length === 0) return undefined
  return {
    sourceId: taskId,
    cwd,
    title: typeof title === 'string' && title !== '' ? title : undefined,
    startedAt: typeof createdAt === 'number' ? createdAt : turns[0]!.time,
    turns,
  }
}

export const zcodeAdapter: MigrationAdapter = {
  id: 'zcode',
  label: 'zcode',
  roots: () => [join(homedir(), '.zcode', 'v2', 'sessions')],
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
        else if (entry.isFile() && entry.name.endsWith('.json')) {
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
