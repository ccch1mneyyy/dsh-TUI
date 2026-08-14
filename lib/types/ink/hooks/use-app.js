import { useContext } from 'react';
import AppContext from '../components/AppContext.js';
/**
 * React hook exposing the manual app-exit function from `AppContext`.
 * @returns the `AppContext` value, whose `exit` function unmounts the app.
 */
const useApp = () => useContext(AppContext);
export default useApp;
