import { logForDebugging } from '../utils/debug.js';
/**
 * Log a warning when a value is present but not an integer.
 * @param value - the value to check; undefined is skipped silently.
 * @param name - the value's name, used in the warning message.
 */
export function ifNotInteger(value, name) {
    if (value === undefined)
        return;
    if (Number.isInteger(value))
        return;
    logForDebugging(`${name} should be an integer, got ${value}`, {
        level: 'warn',
    });
}
