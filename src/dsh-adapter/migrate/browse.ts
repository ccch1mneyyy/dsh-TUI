/**
 * Browsing other coding agents' conversations for the session screen's source
 * tabs: which agents have any, what they are, and importing one.
 *
 * Everything that knows how a foreign agent stores its conversations stays in
 * this directory. The channel forwards these three calls unchanged, and the UI
 * sees rows whose `key` it only hands back — never a path, a fingerprint or a
 * source id.
 *
 * Nothing is persisted, and the cost is paid only by the tab that needs it:
 * - opening the session screen probes presence alone — each source's walk
 *   stops at its first candidate, a handful of directory reads;
 * - a source is listed when its tab is opened, and within this run an
 *   unchanged conversation (same mtime and size) is not read a second time.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/browse
 */
import type { ForeignImportOutcome, ForeignSessionRow, ForeignSource } from '../../adapter/ports/channel-session.js'
import { walkFiles } from './adapters/scan-fs.js'
import { createForeignImporter, type ImportPersistence } from './import-one.js'
import { MIGRATION_ADAPTERS } from './index.js'
import type { Fingerprint, ForeignSessionSummary, MigrationAdapter } from './types.js'

/** What a listing learned about one artifact, reused while it is unchanged. */
interface Known {
  readonly fp: Fingerprint
  /** null: read before and not a conversation. */
  readonly summary: ForeignSessionSummary | null
}

/** Whether an adapter can be browsed (summary scan + full load). */
export function isBrowsable(adapter: MigrationAdapter): boolean {
  return adapter.walk !== undefined && adapter.scan !== undefined && adapter.load !== undefined
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

const newestFirst = (a: ForeignSessionRow, b: ForeignSessionRow): number => b.updatedAt - a.updatedAt

function toRow(summary: ForeignSessionSummary): ForeignSessionRow {
  return { agentId: summary.agentId, key: summary.ref, title: summary.title, cwd: summary.cwd, updatedAt: summary.lastMessageAt }
}

/**
 * The browser behind one channel.
 * @param persistence - The host's session persistence (imports go through it,
 *   so an imported session is immediately visible to resume).
 * @param signal - Aborts in-flight walks when the channel is torn down.
 * @param adapters - Every registered adapter; only browsable ones are used.
 */
export function createForeignBrowser(
  persistence: () => unknown,
  signal?: AbortSignal,
  adapters: readonly MigrationAdapter[] = MIGRATION_ADAPTERS,
) {
  const browsable = adapters.filter(isBrowsable)
  const known = new Map<string, ReadonlyMap<string, Known>>()
  const generations = new Map<string, number>()
  const importer = createForeignImporter(() => persistence() as ImportPersistence | undefined)
  const adapterOf = (agentId: string): MigrationAdapter | undefined => browsable.find(adapter => adapter.id === agentId)

  const rowsOf = (agentId: string): ForeignSessionRow[] => {
    const rows: ForeignSessionRow[] = []
    for (const entry of known.get(agentId)?.values() ?? []) if (entry.summary !== null) rows.push(toRow(entry.summary))
    return rows.sort(newestFirst)
  }

  /** Whether a source has at least one candidate; the walk stops at the first. */
  const hasCandidate = async (adapter: MigrationAdapter): Promise<boolean> => {
    for await (const _file of walkFiles(adapter.roots(), { ...adapter.walk!, signal })) return true
    return false
  }

  return {
    /** Sources with at least one candidate, in registry order. */
    async listSources(): Promise<readonly ForeignSource[]> {
      const present = await Promise.all(browsable.map(adapter => hasCandidate(adapter).catch(() => false)))
      return browsable.filter((_adapter, index) => present[index]).map(adapter => ({ agentId: adapter.id, label: adapter.label }))
    },

    /**
     * One source's conversations, newest first. A listing superseded by a
     * newer one of the same source resolves to what is known, without
     * publishing its own result.
     */
    async listSessions(agentId: string, onRow?: (row: ForeignSessionRow) => void): Promise<readonly ForeignSessionRow[]> {
      const adapter = adapterOf(agentId)
      if (adapter === undefined) return []
      const generation = (generations.get(agentId) ?? 0) + 1
      generations.set(agentId, generation)
      const previous = known.get(agentId)
      let scanned
      try {
        scanned = await adapter.scan!({
          signal,
          cached: (ref, fp) => {
            const entry = previous?.get(ref)
            return entry !== undefined && entry.fp.mtimeMs === fp.mtimeMs && entry.fp.size === fp.size ? entry.summary : undefined
          },
          onEntry: onRow === undefined ? undefined : summary => onRow(toRow(summary)),
        })
      } catch (error) {
        // Channel teardown mid-walk: what is known stands.
        if (isAbort(error)) return rowsOf(agentId)
        throw error
      }
      if (generations.get(agentId) === generation) {
        known.set(agentId, new Map(scanned.map(entry => [entry.ref, { fp: entry.fp, summary: entry.summary }])))
      }
      return rowsOf(agentId)
    },

    /** Import one listed conversation (or find the copy already imported). */
    importSession(agentId: string, key: string): Promise<ForeignImportOutcome> {
      const adapter = adapterOf(agentId)
      if (adapter === undefined) return Promise.resolve({ kind: 'failed', reason: 'unknown-source' })
      // A key this run never listed still imports: with no known identity the
      // existence check misses, and the id is derived from what is loaded.
      const summary = known.get(agentId)?.get(key)?.summary ?? undefined
      return importer.import(adapter, { sessionKey: summary?.sessionKey ?? '', ref: key, cwd: summary?.cwd ?? '' })
    },
  }
}

export type ForeignBrowser = ReturnType<typeof createForeignBrowser>
