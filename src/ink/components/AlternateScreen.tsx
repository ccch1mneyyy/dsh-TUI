import React, { type PropsWithChildren, useContext, useInsertionEffect } from 'react'
import instances from '../instances.js'
import { logMouseDebug } from '../../utils/debug.js'
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, HIDE_CURSOR } from '../termio/dec.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'
import { handoffAckArmed, noteScreenAdopted, ownsAltScreenExit } from '../../handoffAck.js'
import Box from './Box.js'
import { TerminalSizeContext } from './TerminalSizeContext.js'

type Props = PropsWithChildren<{ mouseTracking?: boolean }>

/**
 * Own the alternate buffer and its input modes for the lifetime of this subtree.
 *
 * Kernel-switch handoff: when the process booted as a handoff replacement,
 * the terminal is already in the alternate buffer (the old parent entered
 * it and handed the screen over instead of restoring the main buffer).
 * Adoption skips ENTER_ALT_SCREEN (a second enter would push a stray
 * save-cursor and can double-buffer on some terminals) and reports
 * "adopted" on the ACK pipe. Until the replacement ACKs its first flushed
 * frame the 1049 exit stays with the old parent, so a replacement that dies
 * before it is ready leaves exactly one process to close the bracket.
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
    write(HIDE_CURSOR + (adopting ? '' : ENTER_ALT_SCREEN) + '\x1b[2J\x1b[H' + (mouseTracking ? ENABLE_MOUSE_TRACKING : ''))
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
