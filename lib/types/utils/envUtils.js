/**
 * Environment truthiness check for the ported Ink core. Accepts the common
 * shell truthy spellings (`1`, `true`, `yes`, `on`).
 * @param value - The environment value to interpret.
 * @returns True for booleans `true` and the truthy spellings, false otherwise.
 */
export function isEnvTruthy(value) {
    if (value === undefined || value === null)
        return false;
    if (typeof value === 'boolean')
        return value;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
