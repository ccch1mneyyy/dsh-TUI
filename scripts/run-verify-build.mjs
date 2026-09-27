#!/usr/bin/env node
/**
 * Run the `verify:build` chain under a throwaway HOME.
 *
 * The chain mounts the real composer in dozens of fixtures. Without isolation
 * any of them can append its own fixture text to the developer's real
 * `~/.dsh-tui/history.jsonl` — and once `↑` started walking that file (#986)
 * those leftovers also became user-visible. Measured on a developer machine:
 * `hello ZYXworldQ` twice (verify-word-jump), `/btw what is` and
 * `/btw again?` ten times each (verify-btw), plus 18 entries from a single
 * local `session-workspace` group run.
 *
 * CI runners are disposable so this only ever hurt local runs; the chain still
 * runs the same way, it just runs in a sandbox. The sandbox is shared by the
 * whole chain on purpose: scripts inside one job may keep sharing state
 * exactly as they do on a CI runner — they just no longer share the user's.
 *
 * `verify:build:inner` holds the chain itself.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-verify-home-'))
let status = 1
try {
  const r = spawnSync('npm run verify:build:inner', {
    stdio: 'inherit',
    shell: true,
    // HOME on POSIX, USERPROFILE on Windows: DATA_DIR resolves from
    // `os.homedir()`, so both have to move together.
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
  status = r.status ?? 1
} finally {
  rmSync(home, { recursive: true, force: true })
}
process.exit(status)
