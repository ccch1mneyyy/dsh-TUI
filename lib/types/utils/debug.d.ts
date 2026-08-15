/**
 * Debug logger for the ported Ink core. Writes to stderr only when
 * `DSH_TUI_DEBUG` is set, so normal runs stay quiet.
 * @param message - The message to log.
 * @param fields - Optional JSON-serialized fields appended to the line.
 */
export declare function logForDebugging(message: string, fields?: Record<string, unknown>): void;
//# sourceMappingURL=debug.d.ts.map