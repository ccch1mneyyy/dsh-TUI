/**
 * dsh lifecycle coordinator for the single root TUI (plan §1.2).
 *
 * pi-tui has no quiesce/resume/finalStop/awaitStop — those four verbs are
 * dsh-side compositions over the existing pi API (`TUI.start()`,
 * `TUI.stop({ preserveScreen })`, `TUI.requestRender(true)`,
 * `Terminal.drainInput()`), fixed here so no caller re-derives the order.
 *
 * This class is the ONLY lifecycle coordinator: every signal/update/editor/
 * exit request is serialized through one internal promise chain; repeated
 * calls to the same operation are idempotent (they return the same promise);
 * once `finalStop` is established, every later request fails closed.
 *
 * Ordering contracts:
 * - `quiesce` (recoverable): input gate on →
 *   `TUI.stop({ preserveScreen: ui.mode === 'fullscreen' ? true : undefined })`.
 *   Inline must NOT preserve: stop moves the cursor below the content so a
 *   readline-style editor does not paint over the UI (Kimi
 *   `openExternalEditor`).
 * - `resume`: `process.stdin.pause()` → `TUI.start()` → `requestRender(true)`
 *   → generation bump + resync hook. `terminal.stop()` clears OSC 9;4
 *   progress while app-side flags may still read true, so the resync hook
 *   must reset that state and repaint (Kimi editor-keyboard.ts).
 * - `finalStop`: `Terminal.drainInput()` → `TUI.stop()` → wait for
 *   `process.stdout` drain. drainInput only drains stdin; Node's
 *   `stdout.write` is merely queued synchronously, so stdout is waited on
 *   separately before any child/exit. Note `TUI.stop()` already calls
 *   `terminal.stop()` internally — never stop the terminal a second time.
 *   A `quiesce`d TUI is already stopped, so finalStop skips the second
 *   `TUI.stop()` (the fullscreen transcript replay still runs). finalStop
 *   also moves the generation the moment it is established, so the
 *   command/controller fences drop every async result that settles late.
 * - Dead terminal (EIO) while running — including the drain/stop window of
 *   finalStop, whose `drainInput()` writes to stdout itself: stdout/stderr
 *   `error` listeners trigger an emergency restore + exit; cleanup that
 *   would write to the dead tty is skipped on purpose. The listeners stand
 *   down only once every tty write of the stop has completed.
 */
import type { Component, Terminal, TUI } from './public.js'
import { TuiMainScreen } from './public.js'

export type QuiesceReason = 'external-editor'

export type FinalStopReason = 'update' | 'shutdown' | 'signal' | 'exception'

export type LifecycleState = 'running' | 'quiesced' | 'final-stopping' | 'stopped'

export type LifecycleErrorCode =
  | 'TUI_FINAL_STOPPED'
  | 'TUI_NOT_QUIESCED'
  | 'TUI_NOT_FINAL_STOPPED'
  | 'TUI_STDOUT_DRAIN_TIMEOUT'

export class TuiLifecycleError extends Error {
  readonly code: LifecycleErrorCode

  constructor(code: LifecycleErrorCode, message: string) {
    super(message)
    this.name = 'TuiLifecycleError'
    this.code = code
  }
}

export interface FinalStopResult {
  readonly reason: FinalStopReason
  /** Set when the final stdout flush failed; exit still proceeds. */
  readonly stdoutDrainError?: string
}

export interface TuiLifecycleOptions {
  readonly ui: TUI
  /**
   * Fullscreen final exit: transcript containers replayed through a
   * temporary `TuiMainScreen` on the same terminal so native scrollback gets
   * the complete transcript (Kimi `stopUiForExit`; upstream
   * `TuiAltScreen.stop()` replays only the current viewport frame).
   */
  readonly getTranscript?: () => readonly Component[]
  /**
   * Runs at the end of every `resume`: reset terminal-derived flags
   * (e.g. OSC 9;4 progressActive) and repaint whatever they drive.
   */
  readonly onAfterResume?: () => void
  /** Dead-terminal exit path. Defaults to `process.exit(129)`. */
  readonly emergencyExit?: (code: number) => never
  /** Bound on the final stdout flush. Default 2000ms. */
  readonly stdoutDrainTimeoutMs?: number
}

function isDeadTerminalError(error: unknown): boolean {
  // EIO: tty revoked (SIGHUP, closed terminal). EBADF: fd already gone.
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EIO' || code === 'EBADF'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const STDOUT_DRAIN_POLL_MS = 10
const DEFAULT_STDOUT_DRAIN_TIMEOUT_MS = 2000

export class TuiLifecycle {
  private readonly ui: TUI
  private readonly options: TuiLifecycleOptions
  private readonly emergencyExit: (code: number) => never

  private lifecycleState: LifecycleState = 'running'
  /** Bumped on every resume and when finalStop is established; stale async
   *  results compare against it. */
  private generationValue = 0
  private inputGated = false
  private emergencyInProgress = false

  /** Serializes every lifecycle operation; never rejects. */
  private queue: Promise<void> = Promise.resolve()
  private quiescePromise: Promise<void> | undefined
  private resumePromise: Promise<void> | undefined
  private finalStopPromise: Promise<FinalStopResult> | undefined

  private readonly onStreamError = (error: NodeJS.ErrnoException): void => {
    if (isDeadTerminalError(error)) this.emergencyTerminalExit()
  }

  constructor(options: TuiLifecycleOptions) {
    this.options = options
    this.ui = options.ui
    this.emergencyExit = options.emergencyExit ?? ((code) => process.exit(code))

    // Input gate: swallow everything typed while quiesced/final-stopping so
    // late bytes cannot reach components or the about-to-run child process.
    this.ui.addInputListener(() => (this.inputGated ? { consume: true } : undefined))

    process.stdout.on('error', this.onStreamError)
    process.stderr.on('error', this.onStreamError)
  }

  get state(): LifecycleState {
    return this.lifecycleState
  }

  get generation(): number {
    return this.generationValue
  }

  get finalStopEstablished(): boolean {
    return this.finalStopPromise !== undefined
  }

  quiesce(reason: QuiesceReason): Promise<void> {
    if (this.finalStopPromise !== undefined) {
      return Promise.reject(
        new TuiLifecycleError('TUI_FINAL_STOPPED', `cannot quiesce (${reason}): finalStop already established`),
      )
    }
    if (this.quiescePromise !== undefined) return this.quiescePromise
    this.quiescePromise = this.enqueue(() => this.doQuiesce())
    return this.quiescePromise
  }

  resume(): Promise<void> {
    if (this.finalStopPromise !== undefined) {
      return Promise.reject(
        new TuiLifecycleError('TUI_FINAL_STOPPED', 'cannot resume: finalStop already established'),
      )
    }
    if (this.quiescePromise === undefined) return Promise.resolve()
    if (this.resumePromise !== undefined) return this.resumePromise
    this.resumePromise = this.enqueue(() => this.doResume())
    return this.resumePromise
  }

  finalStop(reason: FinalStopReason): Promise<FinalStopResult> {
    // Idempotent: the first reason wins, later calls join the same stop.
    if (this.finalStopPromise !== undefined) return this.finalStopPromise
    // Move the generation NOW, not when the queued stop runs: from this point
    // on, an async result captured before the stop belongs to a UI that is
    // going down, and the command/controller fences must drop it (plan §1.3).
    this.generationValue += 1
    this.finalStopPromise = this.enqueue(() => this.doFinalStop(reason))
    return this.finalStopPromise
  }

  /** Wait for the established finalStop to finish; not a new protocol. */
  awaitStop(): Promise<FinalStopResult> {
    if (this.finalStopPromise === undefined) {
      return Promise.reject(
        new TuiLifecycleError('TUI_NOT_FINAL_STOPPED', 'awaitStop requires finalStop to be established first'),
      )
    }
    return this.finalStopPromise
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async doQuiesce(): Promise<void> {
    if (this.lifecycleState === 'quiesced') return
    this.inputGated = true
    this.ui.stop({ preserveScreen: this.ui.mode === 'fullscreen' ? true : undefined })
    this.lifecycleState = 'quiesced'
    // Let the terminal settle before the child process inherits stdio
    // (Kimi openExternalEditor does the same setImmediate yield).
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }

  private async doResume(): Promise<void> {
    if (typeof process.stdin.pause === 'function') process.stdin.pause()
    this.ui.start()
    this.inputGated = false
    this.ui.requestRender(true)
    this.generationValue += 1
    this.options.onAfterResume?.()
    this.lifecycleState = 'running'
    this.quiescePromise = undefined
    this.resumePromise = undefined
  }

  private async doFinalStop(reason: FinalStopReason): Promise<FinalStopResult> {
    this.inputGated = true
    // A quiesced TUI is already stopped (quiesce ran TUI.stop()); stopping
    // again would double terminal.stop(). The fullscreen transcript replay
    // below still runs — only the stop itself is skipped.
    const wasQuiesced = this.lifecycleState === 'quiesced'
    this.lifecycleState = 'final-stopping'
    // The dead-terminal listeners stay up through drain/stop: the fork's
    // drainInput() writes to stdout itself, and an EIO in this window must
    // still reach the emergency path. They stand down only once every tty
    // write of the stop is done — after that, exit/restart logic owns stdout
    // (plan §4's third time window).
    try {
      await this.ui.terminal.drainInput()
    } catch {
      // Best effort — the terminal may already be dead (SIGHUP/EIO).
    }
    if (this.ui.mode === 'fullscreen') {
      this.stopFullscreenWithTranscript(this.ui, wasQuiesced)
    } else if (!wasQuiesced) {
      this.ui.stop()
    }
    process.stdout.off('error', this.onStreamError)
    process.stderr.off('error', this.onStreamError)
    let stdoutDrainError: string | undefined
    try {
      await this.waitStdoutDrain()
    } catch (error) {
      // A blocked/dead tty must never hang shutdown: TUI.stop() already did
      // the best-effort restore, so record and let the caller proceed.
      stdoutDrainError = errorMessage(error)
    }
    this.lifecycleState = 'stopped'
    return { reason, stdoutDrainError }
  }

  /**
   * Kimi `stopUiForExit`: preserve the alt frame, then replay the transcript
   * through a temporary main-screen renderer on the SAME terminal. The
   * original TUI has already stopped, so this is a sequential takeover, not
   * a concurrent one — the only such case allowed (plan §1.1).
   */
  private stopFullscreenWithTranscript(ui: TUI, alreadyStopped: boolean): void {
    if (!alreadyStopped) ui.stop({ preserveScreen: true })
    const transcript = this.options.getTranscript?.() ?? []
    const terminal: Terminal = ui.terminal
    const main = new TuiMainScreen(terminal)
    for (const component of transcript) main.addChild(component)
    // First paint of a main-screen renderer writes every line sequentially,
    // landing the whole transcript in native scrollback.
    main.renderNow()
    // Plan §1.2 orders renderNow() -> main.stop(): beforeTerminalStop moves
    // the cursor below the replayed content and writes the trailing newline,
    // so the shell prompt does not collide with the last transcript line. The
    // upstream terminal.stop() inside is idempotent, so re-stopping the
    // terminal that ui.stop() already stopped is safe.
    main.stop()
  }

  /**
   * `Terminal.drainInput()` proves nothing about stdout. `stdout.write` only
   * queues synchronously, so finalStop waits for the buffer to empty before
   * child/exit — via `drain` when backpressure is signalled, plus a poll for
   * the queued-but-not-backpressured case that emits no event.
   */
  private waitStdoutDrain(): Promise<void> {
    const stdout = process.stdout
    if (stdout.destroyed || stdout.writableLength === 0) return Promise.resolve()
    const timeoutMs = this.options.stdoutDrainTimeoutMs ?? DEFAULT_STDOUT_DRAIN_TIMEOUT_MS
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout)
        clearInterval(poll)
        stdout.off('drain', onSettled)
        stdout.off('error', onError)
      }
      const onSettled = (): void => {
        if (!stdout.destroyed && stdout.writableLength > 0) return
        cleanup()
        resolve()
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(
          new TuiLifecycleError(
            'TUI_STDOUT_DRAIN_TIMEOUT',
            `stdout drain timed out after ${timeoutMs}ms (${stdout.writableLength} bytes pending)`,
          ),
        )
      }, timeoutMs)
      const poll = setInterval(onSettled, STDOUT_DRAIN_POLL_MS)
      stdout.once('drain', onSettled)
      stdout.once('error', onError)
    })
  }

  /**
   * Dead terminal while the TUI owns it: restore modes best effort, then
   * exit. Any further write would EIO-loop, so cleanup stops at
   * `terminal.stop()` and nothing writes to the tty afterwards.
   */
  private emergencyTerminalExit(): void {
    if (this.emergencyInProgress) return
    this.emergencyInProgress = true
    try {
      this.ui.terminal.stop()
    } catch {
      // Dead tty: restoring is best effort by definition.
    }
    this.emergencyExit(129)
  }

  /**
   * Emergency path for a dead tty detected AFTER the stop (a failed final
   * stdout flush): same restore + exit semantics as a mid-run EIO
   * (plan §1.2). Never returns.
   */
  emergencyRestoreAndExit(): never {
    this.emergencyTerminalExit()
    // A test double's emergencyExit may return where process.exit would not;
    // never let the caller's handoff run after a declared emergency.
    throw new Error('dsh-tui: emergency exit did not terminate the process')
  }
}
