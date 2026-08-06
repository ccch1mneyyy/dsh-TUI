import { logForDebugging } from '../utils/debug.js';
export function ifNotInteger(value, name) {
    if (value === undefined)
        return;
    if (Number.isInteger(value))
        return;
    logForDebugging(`${name} should be an integer, got ${value}`, {
        level: 'warn',
    });
}
//# sourceMappingURL=warn.js.map