/**
 * Debug logger for the ported Ink core. Writes to stderr only when
 * `CC_TUI_DEBUG` is set, so normal runs stay quiet.
 */
export function logForDebugging(message, fields) {
    if (!process.env.CC_TUI_DEBUG)
        return;
    const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`;
    process.stderr.write(`[cc-tui] ${message}${suffix}\n`);
}
//# sourceMappingURL=debug.js.map