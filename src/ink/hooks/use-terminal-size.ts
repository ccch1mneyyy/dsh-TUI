import { useContext } from 'react'
import {
  type TerminalSize,
  TerminalSizeContext,
} from '../components/TerminalSizeContext.js'

/** Terminal dimensions from the Ink app shell (ported from the leak).
 * @returns the current terminal dimensions.
 */
export function useTerminalSize(): TerminalSize {
  const size = useContext(TerminalSizeContext)

  if (!size) {
    throw new Error('useTerminalSize must be used within an Ink App component')
  }

  return size
}
