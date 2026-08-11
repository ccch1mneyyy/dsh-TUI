import { useContext } from 'react'
import AppContext, { type Props } from '../components/AppContext.js'

/**
 * React hook exposing the manual app-exit function from `AppContext`.
 * @returns the `AppContext` value, whose `exit` function unmounts the app.
 */
const useApp = (): Props => useContext(AppContext)
export default useApp
