/**
 * Signals and exit in this package's entry go through the TUI's exit funnel
 * (./plugin.ts) when it is up, else the entry disposes the root, bounded. A
 * termination signal ends the process by that signal, not `runProfile`'s 0 /
 * 130 (the launcher reads non-zero as a crash, 0 hides it from `timeout`,
 * tmux and service managers); a second signal forces the exit at once.
 */

export type TerminationSignal = 'SIGTERM' | 'SIGHUP' | 'SIGINT'
export const TERMINATION_SIGNALS: readonly TerminationSignal[] = ['SIGTERM', 'SIGHUP', 'SIGINT']

export type ExitRequest =
  | { readonly kind: 'signal'; readonly signal: TerminationSignal }
  /** `ctx.appExit(code)` (dsh-cmdline): a plugin asked the app to exit. */
  | { readonly kind: 'code'; readonly code: number }

/** The owner's answer. `exiting` / `pending` (already in flight) arm the backstop;
 *  `supervising` (a replacement that may run for hours) does not; `refused`
 *  makes the entry dispose the root itself. */
export type ExitRequestAnswer = 'exiting' | 'pending' | 'supervising' | 'refused'

export interface ProcessExitSeam {
  request?: (request: ExitRequest) => ExitRequestAnswer
}

/** dsh `profile-boot` PROCESS_SHUTDOWN_TIMEOUT_MS (0.2.0-rc.2): the dispose bound. */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5000
/** Last-resort bound for a funnel exit: outlasts its terminal cleanup plus the dispose bound. */
const BACKSTOP_MS = PROCESS_SHUTDOWN_TIMEOUT_MS + 2000
/** How long a re-raised signal may be held by foreign listeners before they go. */
const RERAISE_GRACE_MS = 500

const installed = new Map<TerminationSignal, () => void>()

/**
 * End the process by `signal`. Only the entry's own listeners come off, so the
 * renderer's signal-exit hook still restores the terminal; a foreign listener
 * would keep the process alive, so after a short grace every listener goes.
 */
export function dieBySignal(signal: TerminationSignal): void {
  for (const [name, listener] of installed) process.removeListener(name, listener)
  installed.clear()
  setTimeout(() => {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  }, RERAISE_GRACE_MS)
  process.kill(process.pid, signal)
}

export interface EntrySignalOptions {
  readonly seam: ProcessExitSeam
  /** Dispose the root without the funnel (no owner, or it refused). */
  readonly disposeRoot: () => Promise<unknown>
  /** restart.log / debug breadcrumb; must not write to the terminal. */
  readonly log?: (event: string, data?: Record<string, unknown>) => void
}

/** Once per process. */
export function installEntrySignals(options: EntrySignalOptions): void {
  let first: TerminationSignal | undefined
  const onSignal = (signal: TerminationSignal): void => {
    if (first !== undefined) {
      options.log?.('signal: second signal, forcing the exit', { first, signal })
      dieBySignal(signal)
      return
    }
    first = signal
    const answer = options.seam.request?.({ kind: 'signal', signal }) ?? 'refused'
    options.log?.('signal: received', { signal, answer })
    if (answer === 'supervising') {
      // The replacement decides; a second signal still forces this process.
      return
    }
    setTimeout(() => {
      options.log?.('signal: backstop reached, forcing the exit', { signal })
      dieBySignal(signal)
    }, answer === 'refused' ? PROCESS_SHUTDOWN_TIMEOUT_MS : BACKSTOP_MS)
    if (answer === 'refused') {
      void options.disposeRoot().then(() => { dieBySignal(signal) }, () => { dieBySignal(signal) })
    }
  }
  for (const signal of TERMINATION_SIGNALS) {
    const listener = (): void => { onSignal(signal) }
    installed.set(signal, listener)
    process.on(signal, listener)
  }
}
