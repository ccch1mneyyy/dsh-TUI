import { useContext } from 'react'
import AppContext, { type Props } from '../components/AppContext.js'

/**
 * Access this Ink app's output stream and manual exit handler.
 */
const useApp = (): Props => useContext(AppContext)
export default useApp
