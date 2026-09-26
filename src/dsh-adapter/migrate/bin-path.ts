/**
 * Locate this package's `bin/dsh-tui.js` from a module directory inside it.
 *
 * The TUI's `/migrate` spawns the CLI through the package bin so the import
 * runs in a child process. Callers live at DIFFERENT depths per layout:
 * `src/screens/` at dev time (three levels), `lib/types/screens/` when
 * installed (four levels) — a fixed dirname count lands inside the tree and
 * the spawn fails on every real install (the regression the probe-up walk
 * below replaces; found by the independent test session on a real profile).
 * Probing upward for `bin/dsh-tui.js` matches both layouts without knowing
 * which one we are in — the same spirit as src/update.ts's manifest walk.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/bin-path
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Upward probe bounds: covers src/screens and lib/types/screens layouts. */
const PROBE_UP = ['..', '../..', '../../..', '../../../..'] as const

/**
 * Resolve `bin/dsh-tui.js` for the package that contains `fromDir`, or
 * undefined when no ancestor within the probe bound carries it.
 */
export function resolveOwnBin(fromDir: string): string | undefined {
  for (const up of PROBE_UP) {
    const candidate = join(fromDir, up, 'bin', 'dsh-tui.js')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
