/**
 * Shared lightweight counting for the migration adapters.
 *
 * Bare `dsh-tui migrate` (and the TUI's `/migrate`) only prints a per-agent
 * count, but discover() parses EVERY file into memory (real-world scale:
 * ~9600 files / 5.5GB → 49s and ~880MB just to print five numbers —
 * deep-review M3). countSessions() walks the same trees matching only
 * directory-entry NAMES: no file is opened, no line is parsed.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/scan
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Walk-mode file/directory counter shared by every adapter's fast count. */
export function countEntries(
  roots: readonly string[],
  options: { readonly maxDepth: number, readonly fileMatch: (name: string) => boolean },
): number {
  let count = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > options.maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.isFile() && options.fileMatch(entry.name)) count += 1
    }
  }
  for (const root of roots) walk(root, 0)
  return count
}
