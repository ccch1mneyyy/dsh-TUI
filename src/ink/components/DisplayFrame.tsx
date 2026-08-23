import React, { type PropsWithChildren, useContext, useInsertionEffect } from 'react'
import instances from '../instances.js'
import { logMouseDebug } from '../../utils/debug.js'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from '../termio/dec.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'
import Box from './Box.js'
import { TerminalSizeContext } from './TerminalSizeContext.js'

type Props = PropsWithChildren<{
  /** When true, enter the alternate screen. Children stay mounted across toggles. */
  active: boolean
  /** Enable SGR mouse tracking (wheel + click/drag). Default true. */
  mouseTracking?: boolean
}>

/**
 * Stable host wrapper for the session-wide fullscreen toggle.
 *
 * `<AlternateScreen>` enters/exits DEC 1049 by mounting and unmounting, which
 * remounts every child at that tree position. `/tui` and `/settings` need to
 * flip the alt screen without resetting Chat-local state (scroll position,
 * PromptInput buffer, expanded rows). This component always renders the same
 * `<Box>` and gates the terminal sequences on `active`, so toggling only
 * runs the insertion effect — it never changes element type.
 *
 * Overlay screens (session browser, settings, trajectory) still use
 * `<AlternateScreen>` in inline mode; they skip it when this frame is
 * already active so DEC 1049 does not nest.
 */
export function DisplayFrame({
  children,
  active,
  mouseTracking = true,
}: Props): React.ReactNode {
  const size = useContext(TerminalSizeContext)
  const writeRaw = useContext(TerminalWriteContext)

  useInsertionEffect(() => {
    if (!active) return
    // Same fallback as <AlternateScreen>: embedders and test harnesses
    // render with a stdout that is not process.stdout.
    const ink = instances.get(process.stdout) ?? instances.values().next().value
    logMouseDebug('display-frame enter', {
      mouseTracking,
      inkFound: ink !== undefined,
      writeRaw: !!writeRaw,
    })
    if (!writeRaw) return

    writeRaw(
      ENTER_ALT_SCREEN +
        '\x1B[2J\x1B[H' +
        (mouseTracking ? ENABLE_MOUSE_TRACKING : ''),
    )
    ink?.setAltScreenActive(true, mouseTracking)

    return () => {
      logMouseDebug('display-frame exit')
      ink?.setAltScreenActive(false)
      ink?.clearTextSelection()
      writeRaw((mouseTracking ? DISABLE_MOUSE_TRACKING : '') + EXIT_ALT_SCREEN)
    }
  }, [active, writeRaw, mouseTracking])

  return (
    <Box
      flexDirection="column"
      height={active ? (size?.rows ?? 24) : undefined}
      width="100%"
      flexShrink={active ? 0 : undefined}
    >
      {children}
    </Box>
  )
}
