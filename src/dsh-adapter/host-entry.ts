/**
 * This package's own entry (docs/standalone-host-design.md), started by
 * bin/dsh-tui.js for every kernel: take over the installed dsh's root and
 * module resolution before any TUI module loads, mount the runtime on it, then
 * compose the dsh-tui profile (DSH) or the light profile (other kernels). A DSH
 * launch without a usable installed dsh is handed to `dsh --profile` unchanged.
 */
import '../force-production-react.js'
import { spawn } from 'node:child_process'
import { markBoot } from '../utils/bootTrace.js'
import { configuredBackend, entryKernel, hostProfile } from '../hostEntryRoute.js'
import { HANDOFF_ACK_FD_ENV } from '../handoffAck.js'
import { HOST_NOTICE_ENV, type KernelBackendId } from '../kernelPrefs.js'
import { logForDebugging } from '../utils/debug.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Config as TuiConfig } from './index.js'
import { ENTRY_ROW_DEFAULTS } from './lite-profile.js'
import { HostComposeError, loadHostDsh, NO_DSH_ON_PATH, prepareHostRoot, type HostRoot } from './host-dsh.js'
import { installEntrySignals, type ProcessExitSeam } from './process-exit.js'
import { disposeRootSettled, trackComposition } from './root-dispose.js'

markBoot('entry-start')
// DSH's native flock loader reads `process.report.getReport()`; with sockets
// already open, the network section's reverse lookups block the event loop.
if (process.report !== undefined) (process.report as { excludeNetwork?: boolean }).excludeNetwork = true
const profile = hostProfile()
await runInEntry(entryKernel(process.env, { configured: configuredBackend(profile) }))

/** bin/dsh-tui.js `MSG.noDsh`, newline-terminated. */
function noDshGuidance(): string {
  return process.env.DSH_TUI_LANG === 'en'
    ? '[dsh-tui] dsh CLI not found. Install the official client first:\n  npm install -g @deepseek-ai/dsh\n'
    : '[dsh-tui] 未检测到 dsh CLI。请先安装官方客户端：\n  npm install -g @deepseek-ai/dsh\n'
}

function delegateToDsh(): void {
  const appArgs = process.argv.slice(2)
  const args = ['--profile', profile, ...(appArgs.length > 0 ? ['--', ...appArgs] : [])]
  // A kernel-switch replacement's ACK pipe (fd 3) goes to dsh, which adopts the screen.
  const ack = process.env[HANDOFF_ACK_FD_ENV] === '3'
  const windows = process.platform === 'win32'
  const child = spawn('dsh', windows ? args.map(quoteForCmd) : args, {
    stdio: ack ? ['inherit', 'inherit', 'inherit', 3] : 'inherit',
    env: process.env,
    ...(windows ? { shell: true } : {}),
  })
  // The terminal's own signals reach dsh through the process group; one sent
  // to this pid alone is passed on (SIGINT only by the group: Ctrl+C would
  // otherwise reach dsh twice).
  const forwarders = new Map<NodeJS.Signals, () => void>([
    ['SIGTERM', () => { child.kill('SIGTERM') }],
    ['SIGHUP', () => { child.kill('SIGHUP') }],
    ['SIGINT', () => undefined],
  ])
  for (const [signal, forward] of forwarders) process.on(signal, forward)
  child.on('error', error => {
    process.stderr.write(`dsh-tui: cannot start dsh (${error.message})\n`)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') process.stderr.write(noDshGuidance())
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal === null) {
      process.exit(code ?? 0)
      return
    }
    // Mirror a signal death: the forwarders above would catch (and swallow)
    // the re-raised signal, ending this process with 0 instead.
    for (const [name, forward] of forwarders) process.removeListener(name, forward)
    process.kill(process.pid, signal)
  })
}

/**
 * Runs before anything renders, so the stderr line stays above the next
 * screen (skipped for a kernel-switch replacement, which draws without a
 * gap); the screen also gets it as a notice (HOST_NOTICE_ENV, read once).
 */
function noteHostUnavailable(kernel: KernelBackendId, error: unknown): void {
  const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
  const fallback = kernel === 'dsh' ? 'starting DSH through `dsh --profile`' : 'starting without its module resolution'
  const line = `dsh-tui: the installed dsh cannot host this launch (${reason}); ${fallback}`
  logForDebugging(line)
  if (process.env[HANDOFF_ACK_FD_ENV] === undefined && process.env.DSH_TUI_RESTART_CHILD !== '1') process.stderr.write(`${line}\n`)
  process.env[HOST_NOTICE_ENV] = reason
}

/** cmd.exe joins arguments with spaces and does not escape (bin/dsh-tui.js shellQuote). */
function quoteForCmd(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"^]/u.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}

/**
 * Fallback when the funnel is not up (or refused): also close what the
 * funnel's teardown closes — the codex hub pool is process-wide and no
 * session's dispose closes it. Dynamic import keeps backends off the entry's
 * load surface.
 */
async function disposeEntryRoot(ctx: Context): Promise<void> {
  try {
    await disposeRootSettled(ctx)
  } finally {
    try {
      const { unloadBackends } = await import('./backend-registry.js')
      await unloadBackends()
    } catch (error) {
      logForDebugging(`dsh-tui: closing backend resources on the entry's exit path failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

async function runInEntry(kernel: KernelBackendId): Promise<void> {
  // Without a usable dsh, DSH delegates to `dsh --profile`; the other kernels
  // run on this package's own cordis.
  let root: HostRoot | undefined
  const exitSeam: ProcessExitSeam = {}
  try {
    root = await prepareHostRoot(await loadHostDsh(), { profile, args: process.argv.slice(2), dsh: kernel === 'dsh', exitSeam })
    markBoot('entry-hijacked')
  } catch (error) {
    markBoot('entry-host-unavailable')
    // No dsh at all: stop with the install guidance rather than delegate into
    // a spawn failure (on Windows `shell: true` hides the ENOENT).
    if (kernel === 'dsh' && error instanceof Error && error.message === NO_DSH_ON_PATH) {
      process.stderr.write(noDshGuidance())
      process.exit(1)
    }
    noteHostUnavailable(kernel, error)
    if (kernel === 'dsh') {
      delegateToDsh()
      return
    }
  }
  const [{ Config }, { apply, handleStartupError }, { createEntrySlot }, { deferRootCapabilityGuard, armRootCapabilityGuard }, { processGuardActive }, { logRestartEvent }] = await Promise.all([
    import('./index.js'),
    import('./plugin.js'),
    import('./entry-slot.js'),
    import('./host-access.js'),
    import('../ink/update-overflow-guard.js'),
    import('../update.js'),
  ])
  markBoot('entry-modules')
  const ctx: Context = root?.ctx ?? new (await import('@deepseek-ai/cordis')).Context()
  const env = process.env
  // cordis.patch.yml's dsh-tui row, rebuilt from the same environment; the
  // editable fields come from ./tui-settings.ts on top.
  const config = Config({
    ...ENTRY_ROW_DEFAULTS,
    ...(env.DSH_TUI_PRESET === undefined ? {} : { preset: env.DSH_TUI_PRESET }),
    ...(env.DSH_TUI_WORKSPACE_TARGET === undefined ? {} : { workspace: env.DSH_TUI_WORKSPACE_TARGET }),
    ...(env.DSH_TUI_RESUME_SESSION === undefined ? {} : { sessionId: env.DSH_TUI_RESUME_SESSION }),
    ...(env.DSH_TUI_BACKEND === undefined ? {} : { backend: env.DSH_TUI_BACKEND as TuiConfig['backend'] }),
  })
  installEntrySignals({
    seam: exitSeam,
    disposeRoot: () => disposeEntryRoot(ctx),
    log: logRestartEvent,
  })
  // Only a host root gets a composition (DSH without one was delegated above).
  const slot = root === undefined ? undefined : createEntrySlot(kernel === 'dsh')
  // Plugins use root capabilities while they activate: hold the TUI's guard
  // back until composition arms it (./host-access.ts).
  const releaseRootGuard = slot === undefined ? undefined : deferRootCapabilityGuard(ctx)
  try {
    // `entryKernel`: the runtime must not re-resolve the kernel — its rebuilt
    // Config lacks the profile patch's row this route was decided on.
    await apply(ctx, config, ctx, { deferBackendOpen: true, profile, entryKernel: kernel, exitSeam, ...(slot === undefined ? {} : { entrySlot: slot }) })
  } catch (error) {
    handleStartupError(ctx, error)
    return
  }
  // One owner of a fatal error: with the TUI's process guard up, DSH's
  // fail-loud would exit 1 before the exit funnel ran.
  if (root !== undefined && processGuardActive()) root.uninstallFailLoud()
  if (root === undefined || slot === undefined) return
  // The "starting" frame must reach the terminal before the composition's
  // synchronous stretch.
  await slot.firstFrameFlushed?.()
  markBoot('entry-compose-start')
  armRootCapabilityGuard(ctx)
  const loaderOf = (): { await(): Promise<unknown> } | undefined => ctx.get('loader' as never) as { await(): Promise<unknown> } | undefined
  const composition = trackComposition(ctx, async () => { await loaderOf()?.await() })
  let failure: { readonly error: unknown } | undefined
  try {
    await root.compose(line => { logForDebugging(`dsh-tui: host composition: ${line.trimEnd()}`) }, () => composition.disposing)
  } catch (error) {
    failure = { error }
  } finally {
    composition.done()
    releaseRootGuard?.()
    markBoot('entry-compose-end')
  }
  if (!slot.dsh) {
    // A light-profile failure ends the process loudly: a kernel whose plugin
    // ecosystem did not come up must not pass as a boot.
    if (failure === undefined) {
      slot.composeSucceeded?.()
      return
    }
    const { error } = failure
    handleStartupError(ctx, error instanceof HostComposeError && error.logPath !== undefined ? `${error.message} — startup report: ${error.logPath}` : error)
    return
  }
  // DSH: past the mount nothing writes to the terminal; a failure lands in the screen.
  if (failure !== undefined) {
    const { error } = failure
    if (error instanceof HostComposeError) slot.composeFailed?.(error.original, error.logPath)
    else slot.composeFailed?.(error)
    return
  }
  if (composition.disposing) return
  if (!slot.rowSeen) slot.composeFailed?.(new Error(`the ${profile} profile has no dsh-tui row`))
  else slot.composeSucceeded?.()
}
