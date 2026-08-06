/**
 * Environment truthiness check for the ported Ink core. Accepts the common
 * shell truthy spellings (`1`, `true`, `yes`, `on`).
 */
export function isEnvTruthy(value) {
    if (value === undefined || value === null)
        return false;
    if (typeof value === 'boolean')
        return value;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
//# sourceMappingURL=envUtils.js.map