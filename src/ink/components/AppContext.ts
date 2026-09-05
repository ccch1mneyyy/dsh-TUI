import { createContext } from 'react'

/**
 * The Ink app's exit handler and output stream.
 */
export type Props = {
  /** The output stream supplied to this app's render call. */
  readonly stdout: NodeJS.WriteStream
  /**
   * Exit (unmount) the whole Ink app.
   */
  readonly exit: (error?: Error) => void
}

/**
 * App-scoped services shared by the renderer and its descendants.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const AppContext = createContext<Props>({
  stdout: process.stdout,
  exit() {},
})

// eslint-disable-next-line custom-rules/no-top-level-side-effects
AppContext.displayName = 'InternalAppContext'

export default AppContext
