/**
 * `--import` preload for the fast launcher (`dst`).
 *
 * The launcher starts dsh as
 * `node --import <this file> <dsh/lib/bin.js> --profile dsh-tui`; Node
 * evaluates this module — top-level await included — before the dsh entry
 * runs, so the root tree is on screen (against a boot channel) before dsh
 * composes the profile and loads its plugin tree. `plugin.ts` later brings
 * the live session in through the slot (`./handle.ts`).
 *
 * Fail-soft by design: any problem here is swallowed and dsh boots exactly
 * as it would without the preload (the launcher only opts in when the
 * marker env is set and the terminal is interactive).
 */
import { enableCompileCache } from 'node:module'
import { join } from 'node:path'
import '../force-production-react.js'
import { HANDOFF_ACK_FD_ENV } from '../handoffAck.js'
import { DATA_DIR } from '../utils/paths.js'
import { PREBOOT_ENV } from './handle.js'

/**
 * V8 compile cache for everything this process loads from here on — the
 * boot screen's import graph and then dsh's own plugin tree. Both are
 * dominated by parsing and compiling (~750 modules before the first frame),
 * so reusing bytecode moves the first frame and the live handoff earlier
 * (~70ms / ~150ms measured on dsh 0.2.0-rc.2). Node keys entries by source
 * content, so upgrades invalidate them; the first launch after one fills the
 * cache again. An explicit `NODE_COMPILE_CACHE` keeps its own directory and
 * `NODE_DISABLE_COMPILE_CACHE=1` turns it off (both are Node's contract).
 * Best-effort: a failure leaves compilation as it was.
 */
if (process.env[PREBOOT_ENV] === '1') {
  try {
    const own = process.env.NODE_COMPILE_CACHE
    enableCompileCache(own !== undefined && own !== '' ? undefined : join(DATA_DIR, 'compile-cache'))
  } catch {
    // Compile cache unsupported or its directory unwritable.
  }
}

/**
 * dsh's own print-and-exit switches (the launcher's `dshSwitches`, in the
 * host prefix before `--`): those runs never mount dsh-tui, and a boot screen
 * would both hide their output and turn their success into a failed boot.
 */
const HOST_INFO_SWITCHES = new Set(['--dump-config', '--dump-default-config', '--dump-config-schema', '-V', '--version'])
const hostArgs = (() => {
  const argv = process.argv.slice(2)
  const separator = argv.indexOf('--')
  return separator === -1 ? argv : argv.slice(0, separator)
})()

/**
 * A fullscreen kernel-switch replacement (restartTui respawns with this
 * process's execArgv, so the preload comes along): the old process still
 * holds the alternate screen and waits for this one's ACKs on fd 3
 * (handoffAck.ts). A boot screen would open a second 1049h before the
 * plugin adopts the screen, and its own teardown could close the screen the
 * old process owns — the replacement boots the plain way instead.
 */
const kernelSwitchHandoff = process.env[HANDOFF_ACK_FD_ENV] !== undefined

if (
  process.env[PREBOOT_ENV] === '1'
  && process.stdout.isTTY === true
  && process.stdin.isTTY === true
  && !hostArgs.some(arg => HOST_INFO_SWITCHES.has(arg))
  && !kernelSwitchHandoff
) {
  try {
    const { mountPreboot } = await import('./mount.js')
    await mountPreboot()
  } catch (error) {
    if (process.env.DSH_TUI_DEBUG !== undefined && process.env.DSH_TUI_DEBUG !== '') {
      process.stderr.write(`[dsh-tui] preboot skipped: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}
