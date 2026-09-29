/**
 * Minimal UI: one process-wide flag gating decorative UI (header splash,
 * emoji status glyphs, non-tool text colors, status-bar extras). The flag is
 * owned by the channel (settings key `dsh-tui.minimal`, applied live through
 * scope.watch); leaf components read it here instead of threading a prop
 * through four render layers. Code highlighting and tool-name colors are
 * deliberately NOT gated — the minimal UI keeps those.
 *
 * This is the INTERFACE switch only. It is unrelated to the kernel's agent
 * preset `minimal` (极简模式 / "Minimal"), which changes the model-facing
 * world (a single persistent-shell tool — bash on POSIX, pwsh on Windows —
 * with no compaction, no plan mode and no runtime context). Renamed from
 * `minimalMode` so the two concepts cannot be read as one.
 */

let minimalUi = false

/** True when the minimal UI is active (settings key `dsh-tui.minimal`). */
export function isMinimalUiMode(): boolean {
  return minimalUi
}

/** @internal channel-owned setter; also called once at boot. */
export function setMinimalUiMode(enabled: boolean): void {
  minimalUi = enabled
}
