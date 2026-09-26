/**
 * Cross-agent conversation migration: orchestration over the official
 * persistence backend.
 *
 * Discovery is read-only against foreign stores (adapters never write their
 * source). Import goes EXCLUSIVELY through `JsonlSessionPersistence` — the
 * same plugin the retired-store migration (scripts/migrate-sessions-to-jsonl.mts)
 * writes through — so physical encoding, `projectKey`/directory layout, zstd
 * frames, atomic writes and Windows path handling are upstream's, not ours.
 * Re-importing the same source conversation deterministically lands on the
 * same session id and is skipped when already present: repeats neither stack
 * duplicates nor rewrite existing logs.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate
 */
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeAdapter } from './adapters/claude-code.js'
import { codexAdapter } from './adapters/codex.js'
import { ompAdapter } from './adapters/omp.js'
import { sessionize } from './sessionize.js'
import type { MigrationAdapter, MigrationSession } from './types.js'
import { migrationUuid } from './uuid.js'

export const MIGRATION_ADAPTERS: readonly MigrationAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  ompAdapter,
]

/** The default import target: the shared DSH session store. */
export function defaultSessionRoot(): string {
  const dshHome = process.env.DSH_HOME?.trim()
  return join(dshHome ? dshHome : join(homedir(), '.dsh'), 'sessions')
}

/** Deterministic session id for one foreign conversation. */
export function migrationSessionId(adapter: MigrationAdapter, session: MigrationSession): SessionId {
  return SessionId(migrationUuid(`${adapter.id}:${session.sourceId}`))
}

/** What happened to one conversation during an import run. */
export type ImportOutcome = 'imported' | 'existing' | 'failed'

/** Structural slice of the persistence service this module consumes. */
interface PersistenceService {
  create(header: unknown): Promise<SessionWriteHandle>
  list(): Promise<readonly { header: { id: string } }[]>
}
interface SessionWriteHandle {
  append(events: readonly unknown[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

/** Wait until the plugin's service is published on the context. */
async function awaitPersistence(ctx: Context): Promise<PersistenceService> {
  for (let i = 0; i < 200; i++) {
    const service = ctx.get('sessionPersistence') as PersistenceService | undefined
    if (service !== undefined) return service
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('session persistence service did not become ready')
}

export interface ImportRun {
  readonly imported: number
  readonly existing: number
  readonly failed: number
  /** One-line cause per failed conversation, for the CLI summary. */
  readonly failures: readonly string[]
}

/**
 * Import every discovered conversation of one adapter into the DSH store.
 *
 * The persistence backend is mounted ONCE per run (one Context, one plugin
 * lifecycle) and disposed after the loop; sessions already present (same
 * deterministic id) are skipped, and a failed conversation never aborts the
 * batch — both properties the retired-store migration established first.
 *
 * @param adapter - the foreign agent to import from.
 * @param root - the DSH session root to write into.
 * @param sessions - the conversations to import (usually adapter.discover()).
 * @returns the per-run counters.
 */
export async function importSessions(
  adapter: MigrationAdapter,
  root: string,
  sessions: readonly MigrationSession[],
): Promise<ImportRun> {
  const ctx = new Context()
  const fiber = ctx.plugin(
    JsonlSessionPersistence as unknown as Parameters<Context['plugin']>[0],
    { root },
  )
  let imported = 0
  let existing = 0
  let failed = 0
  const failures: string[] = []
  try {
    const persistence = await awaitPersistence(ctx)
    const present = new Set((await persistence.list()).map(entry => entry.header.id))
    for (const session of sessions) {
      const id = migrationSessionId(adapter, session)
      if (present.has(id)) {
        existing += 1
        continue
      }
      try {
        const { header, events } = sessionize(id, adapter.id, session)
        const handle = await persistence.create(header)
        try {
          await handle.append(events)
          await handle.flush()
        } finally {
          await handle.close()
        }
        present.add(id)
        imported += 1
      } catch (error) {
        failed += 1
        failures.push(`${session.sourceId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    // The mounted plugin fiber owns the backend's file handles; dispose it
    // so a CLI process with nothing left to do can exit promptly.
    await Promise.resolve((fiber as { dispose(): unknown }).dispose()).catch(() => {})
  }
  return { imported, existing, failed, failures }
}
