/** DSH provider scope over the shared, first-paint-only listing snapshot. */
import { isAbsolute, normalize } from 'node:path'
import { beginListingSnapshot as begin, readListingSnapshot as read } from '../../sessions/listSnapshot.js'
import type { SessionSource } from './list.js'
import type { SessionSummary } from './types.js'

/** Only the known JSONL provider exposes a public, durable source configuration. */
function sourceKey(source: SessionSource): string | undefined {
  if (source.name !== 'session-persistence-jsonl') return undefined
  const config = source.config
  if (config === null || typeof config !== 'object') return undefined
  const { root, compression } = config as Record<string, unknown>
  // Relative roots can change meaning after a workspace switch. Keep exact
  // path case, including on Windows, rather than sharing another store's rows.
  if (typeof root !== 'string' || !isAbsolute(root)) return undefined
  if (compression !== undefined && compression !== 'zstd' && compression !== 'none') return undefined
  return JSON.stringify([source.name, normalize(root), compression ?? 'zstd'])
}

export function readListingSnapshot(source: SessionSource): readonly SessionSummary[] | undefined {
  const key = sourceKey(source)
  return key === undefined ? undefined : read(key)
}

export function beginListingSnapshot(source: SessionSource): (rows: readonly SessionSummary[]) => void {
  const key = sourceKey(source)
  return key === undefined ? () => {} : begin(key)
}
