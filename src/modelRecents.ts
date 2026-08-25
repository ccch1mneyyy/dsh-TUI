/**
 * Persisted recently-used models (`/model` picker's 最近使用 group), kept at
 * `~/.dsh-tui/model-recents.json` so the list survives restarts — same
 * best-effort pattern as agent-preset.json: a missing/corrupt file simply
 * reads as empty, and a failed write never blocks the switch that caused it.
 * Entries are `{ provider, id }` refs, most-recent-first, deduped, capped at
 * {@link MODEL_RECENTS_LIMIT}.
 *
 * @module dsh-tui/modelRecents
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR

/** How many recent entries the file and the picker group keep. */
export const MODEL_RECENTS_LIMIT = 10

/** One persisted recent-model reference. */
export interface ModelRecentsRef {
  readonly provider: string
  readonly id: string
}

/** Narrow one parsed array element, or reject the whole file entry. */
function asRef(value: unknown): ModelRecentsRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  return typeof record['provider'] === 'string' && record['provider'] !== ''
    && typeof record['id'] === 'string' && record['id'] !== ''
    ? { provider: record['provider'], id: record['id'] }
    : undefined
}

/**
 * Parse a persisted `{ models: [...] }` document; invalid shapes yield an
 * empty list (the file is rewritten on the next record).
 * @param text - Raw file contents.
 * @returns Valid refs in file order, deduped, capped.
 */
export function parseModelRecents(text: string): readonly ModelRecentsRef[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const models = (parsed as Record<string, unknown>).models
  if (!Array.isArray(models)) return []
  const refs: ModelRecentsRef[] = []
  for (const entry of models) {
    const ref = asRef(entry)
    if (ref === undefined) continue
    if (refs.some(seen => seen.provider === ref.provider && seen.id === ref.id)) continue
    refs.push(ref)
    if (refs.length >= MODEL_RECENTS_LIMIT) break
  }
  return refs
}

/**
 * The persisted recent-model refs, most-recent-first.
 * @param dir - Prefs directory (injectable for tests).
 */
export function readModelRecents(dir: string = PREFS_DIR): readonly ModelRecentsRef[] {
  try {
    return parseModelRecents(readFileSync(join(dir, 'model-recents.json'), 'utf8'))
  } catch {
    return []
  }
}

/**
 * Record one use: move-to-front dedupe, cap at {@link MODEL_RECENTS_LIMIT},
 * best-effort persist. Never throws — a failed write must not block the
 * model switch that caused it.
 * @param ref - The provider/model just switched to.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The new list (also what a subsequent read returns on success).
 */
export function recordModelUse(ref: ModelRecentsRef, dir: string = PREFS_DIR): readonly ModelRecentsRef[] {
  const next: ModelRecentsRef[] = [ref]
  for (const seen of readModelRecents(dir)) {
    if (seen.provider === ref.provider && seen.id === ref.id) continue
    next.push(seen)
    if (next.length >= MODEL_RECENTS_LIMIT) break
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'model-recents.json'), `${JSON.stringify({ models: next }, null, 2)}\n`)
  } catch {
    // Best-effort like every other pref: the in-memory list still serves
    // this session; the next successful write re-persists.
  }
  return next
}
