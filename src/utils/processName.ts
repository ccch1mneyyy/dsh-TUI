import { writeFileSync } from 'node:fs'

/**
 * Name the OS process, so process listings show `dsh-tui` (#1831).
 *
 * Linux reports a process by its thread group leader's name — field 2 of
 * `/proc/<pid>/stat` — which is what `ps -o comm`, `top` and desktop process
 * monitors display, and Node starts that thread as "MainThread". Writing
 * /proc/self/comm renames the leader and leaves argv alone, where
 * `process.title` would rewrite cmdline as well; tools and regressions
 * recognise the entry by its cmdline.
 *
 * Only Linux has this file and only Linux needs the rename (elsewhere `ps`
 * shows the executable). A read-only /proc rejects the write and the name then
 * stays as Node set it, exactly as before this ran.
 */
export function setProcessName(name: string): void {
  if (process.platform !== 'linux') return
  try {
    // No trailing newline: the kernel stores the bytes verbatim, and a newline
    // in comm makes `ps` print "dsh-tui?" and misparses /proc/<pid>/stat.
    writeFileSync('/proc/self/comm', name)
  } catch {
    // Read-only /proc (some containers): keep the inherited name.
  }
}
