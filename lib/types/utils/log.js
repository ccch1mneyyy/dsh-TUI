/**
 * Error logger for the ported Ink core. Always writes to stderr (an Ink
 * renderer failure must never pass silently).
 */
export function logError(error) {
    const text = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`[cc-tui] ${text}\n`);
}
//# sourceMappingURL=log.js.map