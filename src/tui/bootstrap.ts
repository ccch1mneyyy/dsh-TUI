/**
 * Factory for the single root TUI and the single native terminal of the
 * process (plan §1.1, WP-01 step 5).
 *
 * One process owns exactly ONE root TUI and ONE `ProcessTerminal`
 * (stdin/stdout owner). dsh injects no stream/writer of its own — the
 * concrete terminal is created here and handed out only through the public
 * `Terminal` interface. Scene/overlay/editor helpers must NEVER create a
 * second terminal or a second root TUI; the sole exception is the
 * fullscreen final exit, where `TuiLifecycle.stopFullscreenWithTranscript`
 * runs a temporary `TuiMainScreen` on the SAME terminal as a strictly
 * sequential takeover after the original TUI has stopped (plan §1.1).
 *
 * This factory deliberately does NOT call `ui.start()`: the caller
 * (WP-04 plugin.ts) mounts the root component first and decides when
 * starting is safe, so the terminal never emits an unprompted first frame.
 */
import type { Component, Terminal, TUI, TuiAltScreenOptions } from './public.js'
import { ProcessTerminal, TuiAltScreen, TuiMainScreen } from './public.js'
import { TuiLifecycle } from './lifecycle.js'
import { ScreenTakeover } from './screen-takeover.js'

export interface TuiBootstrapOptions {
  /**
   * Screen mode: unset/inline → `TuiMainScreen`, fullscreen → `TuiAltScreen`.
   */
  readonly fullscreen?: boolean
  /** Forwarded to `TuiAltScreen`; ignored in inline mode. */
  readonly altScreenOptions?: TuiAltScreenOptions
  /** Fullscreen final-exit transcript source, forwarded to `TuiLifecycle`. */
  readonly getTranscript?: () => readonly Component[]
  /** Post-resume resync hook, forwarded to `TuiLifecycle`. */
  readonly onAfterResume?: () => void
  /** Dead-terminal exit path, forwarded to `TuiLifecycle`. */
  readonly emergencyExit?: (code: number) => never
}

export interface TuiBootstrap {
  /**
   * The process's only terminal, exposed as the public `Terminal` interface
   * so no caller depends on the concrete `ProcessTerminal`.
   */
  readonly terminal: Terminal
  /** The process's only root TUI. Not started yet — see module header. */
  readonly ui: TUI
  /** Sole lifecycle coordinator for quiesce/resume/finalStop (plan §1.2). */
  readonly lifecycle: TuiLifecycle
  /** Sole root/overlay swap helper for this root TUI (plan §1.2). */
  readonly takeover: ScreenTakeover
}

/**
 * Create the root terminal + TUI + coordinators. Call once per process;
 * start the returned `ui` only after the root component is mounted.
 */
export function bootstrapTui(options: TuiBootstrapOptions = {}): TuiBootstrap {
  const terminal = new ProcessTerminal()
  const ui: TUI = options.fullscreen
    ? new TuiAltScreen(terminal, undefined, undefined, options.altScreenOptions)
    : new TuiMainScreen(terminal)
  const lifecycle = new TuiLifecycle({
    ui,
    getTranscript: options.getTranscript,
    onAfterResume: options.onAfterResume,
    emergencyExit: options.emergencyExit,
  })
  const takeover = new ScreenTakeover(ui)
  return { terminal, ui, lifecycle, takeover }
}
