import React, { type PropsWithChildren, useContext, useInsertionEffect } from 'react'
import instances from '../instances.js'
import { logMouseDebug } from '../../utils/debug.js'
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from '../termio/dec.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'
import { handoffAckArmed, noteScreenAdopted, ownsAltScreenExit } from '../../handoffAck.js'
import Box from './Box.js'
import { TerminalSizeContext } from './TerminalSizeContext.js'

type Props = PropsWithChildren<{ mouseTracking?: boolean }>

/**
 * Own the alternate buffer and its input modes for the lifetime of this subtree.
 *
 * Kernel-switch handoff (S05 完整版): when the process booted as a handoff
 * replacement, the terminal is ALREADY in the alternate buffer — the old
 * parent entered it, kept it through the transition frame, and handed the
 * screen over instead of restoring the main buffer. Adoption then skips
 * ENTER_ALT_SCREEN (a second enter would push a stray save-cursor and can
 * double-buffer on some terminals) and reports "adopted" on the ACK pipe so
 * the old parent knows the screen has a new painter. Until the replacement
 * ACKs its first flushed frame, the 1049 EXIT also stays with the old parent
 * (a pre-ready death must be cleaned up by the process that still owns the
 * bracket — exactly one close for the whole attempt).
 */
export function AlternateScreen({ children, mouseTracking = true }: Props) {
  const size = useContext(TerminalSizeContext)
  const write = useContext(TerminalWriteContext)
  const adopting = handoffAckArmed()
  useInsertionEffect(() => {
    if (!write) return
    // Custom streams are supported only when a single renderer can be identified.
    const renderer = instances.get(process.stdout) ?? (instances.size === 1 ? instances.values().next().value : undefined)
    logMouseDebug('alt-screen enter', { mouseTracking, inkFound: !!renderer, adopting })
    write((adopting ? '' : ENTER_ALT_SCREEN) + '\x1b[2J\x1b[H' + (mouseTracking ? ENABLE_MOUSE_TRACKING : ''))
    renderer?.setAltScreenActive(true, mouseTracking)
    if (adopting) noteScreenAdopted()
    return () => {
      renderer?.setAltScreenActive(false)
      renderer?.clearTextSelection()
      // Pre-ready adoption: the old parent still owns the 1049 bracket —
      // this process must not close what it did not open (handoff exit rule).
      if (adopting && !ownsAltScreenExit()) {
        logMouseDebug('alt-screen exit skipped (handoff bracket owned by the old parent)', {})
        return
      }
      write((mouseTracking ? DISABLE_MOUSE_TRACKING : '') + EXIT_ALT_SCREEN)
      logMouseDebug('alt-screen exit', {})
    }
  }, [write, mouseTracking, adopting])
  return <Box flexDirection="column" height={size?.rows ?? 24} width="100%" flexShrink={0}>{children}</Box>
}
