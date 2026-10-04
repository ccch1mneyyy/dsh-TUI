/**
 * The flag-settings layer (the SDK `settings` option) as a private file.
 *
 * The SDK turns an inline `settings` object into `--settings <json>` on the
 * CLI's command line, where any local user can read it (`ps`,
 * `/proc/<pid>/cmdline`), and a channel's token rides that layer. Passed as
 * a path instead, it is the same layer (the CLI reads the file into its flag
 * settings) and the token stays out of argv. The file is owner-only, inside
 * a fresh directory under the system temp directory (0700 on POSIX; the
 * per-user temp directory on Windows), and lives exactly as long as the CLI
 * that reads it: the caller disposes it when the run stops, and whatever is
 * still open when the process exits is removed then.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FlagSettingsFile {
  /** What to pass as the SDK `settings` option. */
  readonly path: string
  /** Remove the file (idempotent). */
  dispose(): void
}

/** Directories not yet disposed, removed on process exit. */
const live = new Set<string>()
let exitHooked = false

function remove(dir: string): void {
  live.delete(dir)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Already gone, or the platform holds it for a moment: nothing to do.
  }
}

/** Write one run's flag settings; throws when the file cannot be written
 *  (the caller must not fall back to the inline form). */
export function writeFlagSettingsFile(settings: { readonly env: Readonly<Record<string, string>> }): FlagSettingsFile {
  if (!exitHooked) {
    exitHooked = true
    process.once('exit', () => { for (const dir of [...live]) remove(dir) })
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-flags-'))
  live.add(dir)
  const path = join(dir, 'settings.json')
  try {
    writeFileSync(path, JSON.stringify({ env: settings.env }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    remove(dir)
    throw error
  }
  return { path, dispose: () => { if (live.has(dir)) remove(dir) } }
}
