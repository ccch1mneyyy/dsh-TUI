/**
 * Factory for the single root TUI and the single native terminal of the
 * process (plan §1.1, WP-01 step 5).
 *
 * One process owns exactly ONE root TUI and ONE `ProcessTerminal`
 * (stdin/stdout owner). dsh injects no stream/writer of its own — the
 * concrete terminal is created here and handed out only through the public
 * `Terminal` interface. Scene/overlay/editor helpers must NEVER create a
 * second terminal or a second root TUI; the sole exceptions are strictly
 * sequential takeovers after the original TUI has stopped: the fullscreen
 * final exit, where `TuiLifecycle.stopFullscreenWithTranscript` runs a
 * temporary `TuiMainScreen` on the SAME terminal (plan §1.1), and `/reload`,
 * where the plugin fiber restarts and the re-run apply bootstraps a fresh
 * terminal + root only after the previous lifecycle's finalStop completed.
 *
 * This factory deliberately does NOT call `ui.start()`: the caller
 * (WP-04 plugin.ts) mounts the root component first and decides when
 * starting is safe, so the terminal never emits an unprompted first frame.
 */
import type { Component, Terminal, TUI, TuiAltScreenOptions } from './public.js'
import { ProcessTerminal, TuiAltScreen, TuiMainScreen } from './public.js'
import { isMouseClicksDisabled } from '../utils/fullscreen.js'
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

export interface AltScreenHooks {
  /**
   * Windows right-click paste (pi-tui fires this on win32 only): paste the
   * system clipboard into the prompt. The host decides whether the prompt
   * currently owns input; the callback fires for every right-click press.
   */
  readonly onRightClickPaste?: () => void
}

/**
 * The TuiAltScreen options for this boot (research §4.4 host wiring).
 *
 * - `mouse`: `DSH_TUI_DISABLE_MOUSE` maps to the granular `{ buttons: false }`
 *   — click/selection/right-click paste off, wheel scroll kept — mirroring
 *   source main, where `isMouseClicksDisabled()` gates only the mouse-button
 *   handler and wheel reaches the keybinding path. A plain `mouse: false`
 *   would kill wheel too (tracking never enabled), which is NOT equivalent.
 *   The flag is read once per boot; a `/reload` fiber restart re-reads it.
 * - `openUrl`: deliberately unwired — source main's `onHyperlinkClick` is
 *   never assigned either (dead option), so link-click is a no-op on both
 *   sides. Recorded gap: no browser-open wiring exists in dsh yet.
 * - `copySelection`: deliberately unwired — pi-tui's built-in raw OSC 52
 *   write is the copy path. `src/utils/clipboard.ts` is READ-only (Ctrl+V
 *   paste); source main additionally shells out to tmux `load-buffer -w` and
 *   native tools (pbcopy/wl-copy/xclip/xsel/clip.exe) when local. Recorded
 *   gap: under tmux without `set-clipboard on` + allow-passthrough, or
 *   terminals ignoring OSC 52, copy-on-select silently no-ops while the
 *   "Copied!" flash still shows.
 */
export function buildAltScreenOptions(hooks: AltScreenHooks = {}): TuiAltScreenOptions {
  return {
    mouse: isMouseClicksDisabled() ? { buttons: false } : true,
    ...(hooks.onRightClickPaste === undefined
      ? {}
      : { onRightClickPaste: hooks.onRightClickPaste }),
  }
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
