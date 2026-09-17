/**
 * CLI surface for migration, reached via `dsh-tui migrate ...` (the bin
 * launcher delegates here exactly like it delegates `update`).
 *
 * Usage:
 *   dsh-tui migrate                     # list agents and discoverable counts (writes nothing)
 *   dsh-tui migrate <agent>             # import every conversation found from that agent
 *   dsh-tui migrate <agent> --dry-run   # show what would land, write nothing
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/cli
 */
import { MIGRATION_ADAPTERS, importSession, mungeCwd } from './index.js'

/** Exit code for "nothing to do / unknown agent". */
export const MIGRATE_CLI_USAGE_EXIT = 2

/**
 * Run one migration CLI invocation.
 * @param argv - Arguments after the `migrate` word.
 * @returns Process exit code.
 */
export async function cliMigrate(argv: readonly string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run')
  const words = argv.filter(word => word !== '--dry-run')
  if (words.length > 1) {
    process.stderr.write('usage: dsh-tui migrate [<agent>] [--dry-run]\n')
    return MIGRATE_CLI_USAGE_EXIT
  }
  const wanted = words[0]
  if (wanted === undefined) {
    // Bare `migrate` only reports; importing requires an explicit agent.
    for (const adapter of MIGRATION_ADAPTERS) {
      const found = adapter.discover()
      console.log(`[${adapter.id}] ${found.sessions.length} conversation(s) available (run \`dsh-tui migrate ${adapter.id}\` to import)`)
    }
    return 0
  }
  const agent = MIGRATION_ADAPTERS.find(adapter => adapter.id === wanted)
  if (agent === undefined) {
    process.stderr.write(`dsh-tui migrate: unknown agent "${wanted}"; known: ${MIGRATION_ADAPTERS.map(adapter => adapter.id).join(', ')}\n`)
    return MIGRATE_CLI_USAGE_EXIT
  }
  const found = agent.discover()
  if (found.sessions.length === 0) {
    console.log(`[${agent.id}] no conversations found`)
    return 0
  }
  if (dryRun) {
    console.log(`[${agent.id}] ${found.sessions.length} conversation(s) would be imported (dry run)`)
    for (const session of found.sessions.slice(0, 5)) {
      console.log(`  · ${session.sourceId}  (${session.turns.length} turns → sessions/${mungeCwd(session.cwd)}/…)`)
    }
    if (found.sessions.length > 5) console.log(`  … and ${found.sessions.length - 5} more`)
    return 0
  }
  let imported = 0
  let existing = 0
  let skipped = 0
  let failed = 0
  for (const session of found.sessions) {
    try {
      const outcome = await Promise.resolve(importSession(agent, session))
      if (outcome === undefined) skipped += 1
      else if (outcome.wrote) imported += 1
      else existing += 1
    } catch {
      failed += 1 // one bad conversation must never abort the batch
    }
  }
  const parts = [`imported ${imported}`]
  if (existing > 0) parts.push(`${existing} already present`)
  if (skipped > 0) parts.push(`${skipped} skipped (no user turns)`)
  if (failed > 0) parts.push(`${failed} failed`)
  console.log(`[${agent.id}] ${parts.join(', ')}`)
  console.log('done — /resume lists the migrated conversations under their original directories')
  return failed > 0 ? 1 : 0
}
