/** Last successful listing for first paint only; the backend still refreshes it. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { DATA_DIR } from '../../utils/paths.js'
import type { SessionSource } from './list.js'
import type { SessionSummary } from './types.js'

const directory = join(DATA_DIR, 'session-lists')
const generations = new Map<string, number>()

/** Only the known JSONL provider exposes a public, durable source configuration. */
function sourceKey(source: SessionSource): string | undefined {
  if (source.name !== 'session-persistence-jsonl') return undefined
  const config = source.config
  if (config === null || typeof config !== 'object') return undefined
  const { root, compression } = config as Record<string, unknown>
  // A relative config root could be reinterpreted after a workspace switch.
  // Decline caching rather than inspecting the backend's private resolved root.
  if (typeof root !== 'string' || !isAbsolute(root)) return undefined
  if (compression !== undefined && compression !== 'zstd' && compression !== 'none') return undefined
  const path = normalize(root)
  // Even Windows can host case-sensitive directories; alias misses are safer
  // than displaying a different store's rows.
  return JSON.stringify([source.name, path, compression ?? 'zstd'])
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string'
function isSummary(value: unknown): value is SessionSummary {
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.cwd !== 'string' ||
      !finite(value.createdAt) || !finite(value.updatedAt) || typeof value.hasPrompt !== 'boolean' ||
      !finite(value.childCount) || value.childCount < 0 ||
      (value.bytes !== undefined && (!finite(value.bytes) || value.bytes < 0)) ||
      !['agentPreset', 'model', 'label', 'branch'].every(key => optionalText(value[key]))) return false
  const { title, kind } = value
  if (!record(title) || typeof title.text !== 'string' || typeof title.source !== 'string' ||
      !['renamed', 'auto', 'prompt', 'fallback'].includes(title.source) || !record(kind)) return false
  return kind.kind === 'root' ||
    (kind.kind === 'fork' && typeof kind.parent === 'string') ||
    (kind.kind === 'subagent' && optionalText(kind.parent) && finite(kind.depth) && kind.depth >= 0)
}
function fileOf(key: string): string {
  return join(directory, createHash('sha256').update(key).digest('hex') + '.json')
}
function read(key: string): readonly SessionSummary[] | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(fileOf(key), 'utf8'))
    if (!record(value) || value.version !== 1 || value.source !== key || !Array.isArray(value.rows) || !value.rows.every(isSummary)) return undefined
    if (new Set(value.rows.map(row => row.id)).size !== value.rows.length) return undefined
    return value.rows
  } catch { return undefined }
}

/** Undefined is unknown; an empty snapshot is a successful empty listing. */
export function readListingSnapshot(source: SessionSource): readonly SessionSummary[] | undefined {
  const key = sourceKey(source)
  return key === undefined ? undefined : read(key)
}

/** Capture ordering before async work, including across distinct Context proxies. */
export function beginListingSnapshot(source: SessionSource): (rows: readonly SessionSummary[]) => void {
  const key = sourceKey(source)
  if (key === undefined) return () => {}
  const generation = (generations.get(key) ?? 0) + 1
  generations.set(key, generation)
  return rows => {
    if (generations.get(key) !== generation) return
    const file = fileOf(key)
    const temporary = file + '.' + process.pid + '.tmp'
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify({ version: 1, source: key, rows }), { mode: 0o600 })
      renameSync(temporary, file)
    } catch {
      try { rmSync(temporary, { force: true }) } catch { /* A cache never blocks listing. */ }
    }
  }
}
