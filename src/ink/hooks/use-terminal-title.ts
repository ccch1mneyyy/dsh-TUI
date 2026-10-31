import { useContext, useEffect, useSyncExternalStore } from 'react'
import stripAnsi from 'strip-ansi'
import { getJumpBackState, subscribeJumpBack, type JumpBackState } from '../jumpback-state.js'
import { OSC, osc } from '../termio/osc.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'

/**
 * The pane-title suffix that names this pane to the jump-back helper, or ''
 * when the marker must not appear — disabled, not minted yet, or not Windows
 * (no other host can resolve it).
 * @param state - the published jump-back state.
 * @param platform - the host platform; injectable for verification.
 * @returns `' [dsh-tui:<16 hex>]'` when the marker belongs in the title.
 */
export function jumpBackTitleSuffix(
  state: JumpBackState,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32' || !state.enabled || state.marker === null) return ''
  return ` [dsh-tui:${state.marker}]`
}

/**
 * Declaratively set the terminal tab/window title.
 *
 * Pass a string to set the title. ANSI escape sequences are stripped
 * automatically so callers don't need to know about terminal encoding.
 * Pass `null` to opt out — the hook becomes a no-op and leaves the
 * terminal title untouched.
 *
 * On Windows, uses `process.title` (classic conhost doesn't support OSC).
 * Elsewhere, writes OSC 0 (set title+icon) via Ink's stdout.
 *
 * When jump-back is enabled on Windows, the pane marker is appended after
 * ANSI stripping. The hook subscribes to the jump-back state so flipping the
 * setting rewrites the title immediately, and the marker it appends is the
 * same published value the activation URI carries.
 * @param title - the title to set, or null to opt out.
 */
export function useTerminalTitle(title: string | null): void {
  const writeRaw = useContext(TerminalWriteContext)
  const jumpBack = useSyncExternalStore(subscribeJumpBack, getJumpBackState)

  useEffect(() => {
    if (title === null || !writeRaw) return

    const clean = stripAnsi(title) + jumpBackTitleSuffix(jumpBack)

    if (process.platform === 'win32') {
      process.title = clean
    } else {
      writeRaw(osc(OSC.SET_TITLE_AND_ICON, clean))
    }
  }, [title, writeRaw, jumpBack])
}
