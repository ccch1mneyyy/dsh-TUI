import { useContext } from 'react';
import StdinContext from '../components/StdinContext.js';
/**
 * React hook exposing the stdin stream and raw-mode helpers from `StdinContext`.
 * @returns the `StdinContext` value.
 */
const useStdin = () => useContext(StdinContext);
export default useStdin;
