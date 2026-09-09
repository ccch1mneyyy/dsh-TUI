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
 * NOTE: the copy path was built for the V2 event vocabulary on both sides;
 * whether a real rc.2-decoded session survives the 0.1.5 jsonl writer's V3
 * validation is not covered by the verify gate (which only exercises the
 * missing-source path) and needs a live fixture before any real migration
 * run.
 *
 *   pnpm tsx scripts/migrate-sessions-to-jsonl.mts [--from <sqlite>] [--to <root>] [--dry-run]
 *
 * Defaults: --from $DSH_TUI_SESSION_ROOT ?? ~/.dsh-tui/sessions.sqlite
 *           --to   $DSH_HOME/sessions ?? ~/.dsh/sessions
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
// Relative import, not a manifest dependency: a `workspace:*` devDependency
// would ship verbatim in the npm tarball (this package publishes via npm,
// which rewrites no workspace protocols) and break `dsh plugin add` in the
// profile workspace. The island stays a workspace package; its rc.2 peer
// closure is pinned by the pnpm-workspace overrides either way.
import SqliteSessionPersistence from '../vendor/sqlite-island/index.js'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

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

const src = new Context()
src.plugin(SessionStore)
src.plugin(SqliteSessionPersistence, { path: from })
const dst = new Context()
dst.plugin(SessionStore)
dst.plugin(JsonlSessionPersistence, { root: to })
// Cordis fibers start asynchronously; give both contexts a tick to come up.
await new Promise(r => setTimeout(r, 500))

const metas = await src.sessionPersistence.list()
const existing = new Set((await dst.sessionPersistence.list()).map(m => m.id))
console.log(`source: ${metas.length} session(s) in ${from}`)
console.log(`target: ${existing.size} already present in ${to}${dryRun ? '  (dry run — no writes)' : ''}`)

let migrated = 0
let skipped = 0
let failed = 0
for (const meta of metas) {
  if (existing.has(meta.id)) {
    skipped++
    continue
  }
  try {
    const { meta: stored, events } = await src.sessionPersistence.load(meta.id)
    if (!dryRun) {
      await dst.sessionPersistence.create(stored)
      await dst.sessionPersistence.append(stored.id, events)
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
process.exit(failed === 0 ? 0 : 1)
