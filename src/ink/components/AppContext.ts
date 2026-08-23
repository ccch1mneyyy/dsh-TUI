import { createContext } from 'react'

/**
 * Host controls for the Ink root that owns the current React tree.
 */
export type Props = {
  /**
   * Exit (unmount) the whole Ink app.
   */
  readonly exit: (error?: Error) => void

  /** Re-anchor the next inline frame to the current terminal viewport. */
  readonly reanchorViewport: () => void
}

/**
 * `AppContext` exposes controls for the owning Ink root.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const AppContext = createContext<Props>({
  exit() {},
  reanchorViewport() {},
})

// eslint-disable-next-line custom-rules/no-top-level-side-effects
AppContext.displayName = 'InternalAppContext'

export default AppContext
