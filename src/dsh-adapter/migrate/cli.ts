/**
 * CLI surface for migration, reached via `dsh-tui migrate ...` (the bin
 * launcher delegates here exactly like it delegates `update`; the TUI's
 * `/migrate` command spawns this same CLI in a child process).
 *
 * Usage:
 *   dsh-tui migrate                     # list agents and discoverable counts (writes nothing)
 *   dsh-tui migrate <agent>             # import every conversation found from that agent
 *   dsh-tui migrate <agent> --dry-run   # show what would land, write nothing
 *
 * Every string that originated OUTSIDE this machine (source ids, cwds, error
 * text embedding them) passes through cleanRenderText before printing: a
 * hostile session file must not be able to drive terminal escape sequences
 * through the preview/report paths (deep-review M2).
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/cli
 */
import { cleanRenderText } from '../sanitize.js'
import { MIGRATION_ADAPTERS, defaultSessionRoot, importSessions } from './index.js'

/** Exit code for "nothing to do / unknown agent". */
export const MIGRATE_CLI_USAGE_EXIT = 2

/** Bound for one cleaned external string in CLI output (display cells). */
const RENDER_CELL_BUDGET = 200

/** One external-origin string, sanitized to display-safe text. */
const safe = (value: string): string => cleanRenderText(value, RENDER_CELL_BUDGET)

/**
 * Run one migration CLI invocation.
 * @param argv - Arguments after the `migrate` word.
 * @returns Process exit code.
 */
export async function cliMigrate(argv: readonly string[]): Promise<number> {
  try {
    return await cliMigrateInner(argv)
  } catch (error) {
    // A top-level failure (e.g. persistence never becomes ready because the
    // target root is unwritable) must land as one CLI-style summary line,
    // not a bare Node stack trace (deep-review i1).
    process.stderr.write(`dsh-tui migrate: ${error instanceof Error ? safe(error.message) : String(error)}\n`)
    return 1
  }
}

async function cliMigrateInner(argv: readonly string[]): Promise<number> {
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
      // Name-only count when the adapter offers one: list mode must not pay
      // a full parse of every foreign file (deep-review M3). The count is
      // scan candidates; import filters unreadable/empty ones, so it may
      // land slightly above the imported total.
      const available = adapter.count !== undefined ? adapter.count() : adapter.discover().sessions.length
      console.log(`[${adapter.id}] ${available} session file(s) to scan (run \`dsh-tui migrate ${adapter.id}\` to import)`)
    }
    return 0
  }
  const agent = MIGRATION_ADAPTERS.find(adapter => adapter.id === wanted)
  if (agent === undefined) {
    process.stderr.write(`dsh-tui migrate: unknown agent "${safe(wanted)}"; known: ${MIGRATION_ADAPTERS.map(adapter => adapter.id).join(', ')}\n`)
    return MIGRATE_CLI_USAGE_EXIT
  }
  const found = agent.discover()
  if (found.sessions.length === 0) {
    console.log(`[${agent.id}] no conversations found`)
    return 0
  }
  if (dryRun) {
    console.log(`[${agent.id}] ${found.sessions.length} conversation(s) would be imported into ${defaultSessionRoot()} (dry run)`)
    for (const session of found.sessions.slice(0, 5)) {
      console.log(`  · ${safe(session.sourceId)}  (${session.turns.length} messages · cwd ${safe(session.cwd)})`)
    }
    if (found.sessions.length > 5) console.log(`  … and ${found.sessions.length - 5} more`)
    return 0
  }
  console.log(`[${agent.id}] importing ${found.sessions.length} conversation(s) into ${defaultSessionRoot()}`)
  const run = await importSessions(agent, defaultSessionRoot(), found.sessions)
  const parts = [`imported ${run.imported}`]
  if (run.existing > 0) parts.push(`already present ${run.existing}`)
  if (run.failed > 0) parts.push(`failed ${run.failed}`)
  console.log(`[${agent.id}] ${parts.join(' · ')}`)
  for (const failure of run.failures.slice(0, 10)) console.log(`  ✗ ${safe(failure)}`)
  if (run.failures.length > 10) console.log(`  … and ${run.failures.length - 10} more`)
  return run.failed > 0 ? 1 : 0
}
