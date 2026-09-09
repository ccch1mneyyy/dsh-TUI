import React, { createContext, type PropsWithChildren, useMemo, useSyncExternalStore } from 'react'
import { getTerminalFocusState, subscribeTerminalFocus, type TerminalFocusState } from '../terminal-focus-state.js'
export type { TerminalFocusState }
export type TerminalFocusContextProps = { readonly isTerminalFocused: boolean; readonly terminalFocusState: TerminalFocusState }
const TerminalFocusContext = createContext<TerminalFocusContextProps>({ isTerminalFocused: true, terminalFocusState: 'unknown' })
TerminalFocusContext.displayName = 'TerminalFocusContext'

export function TerminalFocusProvider({ children }: PropsWithChildren) {
  const terminalFocusState = useSyncExternalStore(subscribeTerminalFocus, getTerminalFocusState)
  const value = useMemo(() => ({ terminalFocusState, isTerminalFocused: terminalFocusState !== 'blurred' }), [terminalFocusState])
  return <TerminalFocusContext.Provider value={value}>{children}</TerminalFocusContext.Provider>
}
export default TerminalFocusContext
