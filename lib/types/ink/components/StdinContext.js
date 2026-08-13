import { createContext } from 'react';
import { EventEmitter } from '../events/emitter.js';
/**
 * `StdinContext` is a React context, which exposes input stream.
 */
const StdinContext = createContext({
    stdin: process.stdin,
    internal_eventEmitter: new EventEmitter(),
    setRawMode() { },
    isRawModeSupported: false,
    internal_exitOnCtrlC: true,
    internal_querier: null,
});
// eslint-disable-next-line custom-rules/no-top-level-side-effects
StdinContext.displayName = 'InternalStdinContext';
export default StdinContext;
