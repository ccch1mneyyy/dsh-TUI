/**
 * Token/byte display formatters, ported from the leaked Claude Code source
 * (src/utils/format.ts) minus the app-level formatter registry.
 */
/**
 * Format a number for display, switching to compact notation at 1000.
 * @param number - The value to format.
 * @returns The formatted number, lowercased (e.g. `1.2k`).
 */
export declare function formatNumber(number: number): string;
/**
 * Format a token count, dropping a trailing `.0` from compact values.
 * @param count - The token count to format.
 * @returns The formatted count (e.g. `988`, `3.4k`).
 */
export declare function formatTokens(count: number): string;
/**
 * Compact duration like `12s`, `3m 4s`, `1h 2m` (ported from the leak).
 * @param durationMs - Duration in milliseconds; negative values clamp to zero.
 * @param options - Formatting options; `mostSignificantOnly` stops after the first non-zero unit.
 * @returns The space-joined duration string with `h`/`m`/`s` units.
 */
export declare function formatDuration(durationMs: number, options?: {
    mostSignificantOnly?: boolean;
}): string;
//# sourceMappingURL=format.d.ts.map