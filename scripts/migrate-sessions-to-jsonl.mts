/**
 * One-shot migration (#24): copy sessions out of the retired cc-tui SQLite
 * store (`~/.dsh-cc/sessions.sqlite`) into the shared JSONL store
 * (`$DSH_HOME/sessions`, i.e. what dsh web and post-#24 cc-tui both use).
 *
 * Both sides are written/read through the official persistence backends — the
 * sqlite backend decodes its rows (torn-tail repair included), the jsonl
 * backend owns the physical encoding (zstd, packed chunk runs, project/session
 * layout). Sessions already present in the target are skipped, so the script
 * is safe to re-run. The source file is never modified or deleted.
 *
 *   pnpm tsx scripts/migrate-sessions-to-jsonl.mts [--from <sqlite>] [--to <root>] [--dry-run]
 *
 * Defaults: --from $DSH_CC_SESSION_ROOT ?? ~/.dsh-cc/sessions.sqlite
 *           --to   $DSH_HOME/sessions ?? ~/.dsh/sessions
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const from = argValue('--from') ?? process.env.DSH_CC_SESSION_ROOT ?? join(homedir(), '.dsh-cc', 'sessions.sqlite')
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
