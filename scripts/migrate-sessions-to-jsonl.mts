/**
 * One-shot migration (#24): copy sessions out of the retired cc-tui SQLite
 * store (`~/.dsh-tui/sessions.sqlite`) into the shared JSONL store
 * (`$DSH_HOME/sessions`).
 *
 * Both sides are written/read through the official persistence backends — the
 * sqlite backend decodes its rows (torn-tail repair included), the jsonl
 * backend owns the physical encoding (zstd, packed chunk runs, project/session
 * layout). Sessions already present in the target are skipped, so the script
 * is safe to re-run. The source file is never modified or deleted.
 *
 * The sqlite backend was retired upstream at 0.1.2-alpha.3 and its rc.2 build
 * cannot link against the primary 0.1.5 tree (removed persistence exports),
 * so it is imported through the private wrapper in vendor/sqlite-island,
 * whose pnpm-workspace overrides pin a coherent 0.1.1-rc.2 peer closure —
 * by relative path, keeping the wrapper out of the published manifest.
 * The source is opened read-only for an SQLite backup. The retired backend
 * reads that disposable copy; the official format catalog converts its V0
 * records through the complete migration chain before the V3 writer opens.
 * Unsupported historical chronology is reported per session without writing
 * a target artifact; the catalog, not this script, owns admissible rewrites.
 *
 *   pnpm tsx scripts/migrate-sessions-to-jsonl.mts [--from <sqlite>] [--to <root>] [--dry-run]
 *
 * Defaults: --from $DSH_TUI_SESSION_ROOT ?? ~/.dsh-tui/sessions.sqlite
 *           --to   $DSH_HOME/sessions ?? ~/.dsh/sessions
 */
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
// Relative import, not a manifest dependency: a `workspace:*` devDependency
// would ship verbatim in the npm tarball (this package publishes via npm,
// which rewrites no workspace protocols) and break `dsh plugin add` in the
// profile workspace. The island stays a workspace package; its rc.2 peer
// closure is pinned by the pnpm-workspace overrides either way.
import SqliteSessionPersistence, { Context as LegacyContext, SessionStore as LegacySessionStore } from '../vendor/sqlite-island/index.js'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { settled } from './lib/term-test.mjs'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const from = argValue('--from') ?? process.env.DSH_TUI_SESSION_ROOT ?? join(homedir(), '.dsh-tui', 'sessions.sqlite')
const to = argValue('--to') ?? join(process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh'), 'sessions')
const dryRun = process.argv.includes('--dry-run')

if (!existsSync(from)) {
  console.log(`nothing to migrate: ${from} does not exist`)
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-sqlite-migration-'))
try {
  const { DatabaseSync, backup } = await import('node:sqlite')
  const sourceDb = new DatabaseSync(from, { readOnly: true })
  try {
    await backup(sourceDb, join(scratch, 'sessions.sqlite'))
    chmodSync(join(scratch, 'sessions.sqlite'), 0o600)
  } finally {
    sourceDb.close()
  }
  const src = new LegacyContext()
  const srcSessions = src.plugin(LegacySessionStore)
  const srcPlugin = src.plugin(SqliteSessionPersistence, { path: join(scratch, 'sessions.sqlite') })
  const dst = new Context()
  const dstPlugin = dst.plugin(JsonlSessionPersistence, { root: to })
  let failed = 0
  try {
    if (!await settled(() => src.get('sessionPersistence') !== undefined && dst.get('sessionPersistence') !== undefined)) {
      throw new Error(`session persistence services did not become ready (sqlite: ${srcPlugin.state}, jsonl: ${dstPlugin.state})`)
    }

    const metas = await src.sessionPersistence.list()
    const existing = new Set((await dst.sessionPersistence.list()).map(snapshot => String(snapshot.header.id)))
    console.log(`source: ${metas.length} session(s) in ${from}`)
    console.log(`target: ${existing.size} already present in ${to}${dryRun ? '  (dry run — no writes)' : ''}`)

    let migrated = 0
    let skipped = 0
    for (const meta of metas) {
      if (existing.has(meta.id)) {
        skipped++
        continue
      }
      try {
        const { meta: stored, events } = await src.sessionPersistence.inspect(meta.id)
        const restore = sessionFormatCatalog.createRestore({ type: 'session', ...stored, delegationDepth: stored.delegationDepth ?? 0 }, {
          recovery: 'strict', validation: 'current',
        })
        for (const event of events) restore.decodeRow(event)
        const migratedSession = restore.finish()
        if (!dryRun) {
          const handle = await dst.sessionPersistence.create(migratedSession.header as unknown as SessionHeader, {
            inheritedEventCount: SessionLogOffset(migratedSession.inheritedEventCount),
          })
          try {
            await handle.append(migratedSession.events as unknown as readonly SessionEvent[])
            await handle.flush()
          } finally {
            await handle.close()
          }
          const check = await dst.sessionPersistence.open(SessionId(String(stored.id)), 'read')
          try {
            if ((await check.read()).events.length !== migratedSession.events.length) throw new Error('migration read-back length mismatch')
          } finally {
            await check.close()
          }
        }
        migrated++
        console.log(`  ✓ ${stored.id}  ${events.length} event(s)${stored.cwd ? `  (${stored.cwd})` : ''}`)
      } catch (error) {
        failed++
        console.warn(`  ✗ ${meta.id}  ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    console.log(`done: ${migrated} migrated, ${skipped} skipped (already in target), ${failed} failed`)
    if (migrated > 0 && !dryRun) {
      console.log(`source left untouched at ${from} — delete it yourself once /resume and dsh web both look right`)
    }
  } finally {
    try {
      await dstPlugin.dispose()
    } finally {
      try { await srcPlugin.dispose() }
      finally { await srcSessions.dispose() }
    }
  }
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
