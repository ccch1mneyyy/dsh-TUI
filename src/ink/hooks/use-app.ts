import { useContext } from 'react'
import AppContext, { type Props } from '../components/AppContext.js'

/**
 * React hook exposing controls for the Ink root that owns this component.
 * @returns The current root's exit and viewport re-anchor functions.
 */
const useApp = (): Props => useContext(AppContext)
export default useApp
