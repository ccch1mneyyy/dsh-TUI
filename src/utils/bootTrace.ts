/**
 * Opt-in boot timeline for startup measurements. With
 * `DSH_TUI_BOOT_TRACE=<file>` each mark appends one JSON line to that file:
 * `{"mark","ms","at","pid"}`, where `ms` counts from this process's start and
 * `at` is the wall clock (for lining up with the launcher). Otherwise it does
 * nothing. Never writes to stdout/stderr.
 */
import { appendFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

export function markBoot(mark: string): void {
  const file = process.env.DSH_TUI_BOOT_TRACE
  if (file === undefined || file === '') return
  try {
    appendFileSync(file, `${JSON.stringify({ mark, ms: Math.round(performance.now()), at: Date.now(), pid: process.pid })}\n`)
  } catch {
    // A measurement aid must never affect the boot.
  }
}
