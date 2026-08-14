/**
 * Status-line metric renderers, ported from two pi extensions:
 *  - `pi-nano-context`: segmented context progress bar (morandi pastel
 *    segments by content type, free space right-aligned with the usage
 *    readout, largest-remainder column allocation).
 *  - `pi-tps-meter`: live 1/8-cell gauge while streaming and a min-max
 *    normalized sparkline after each completed turn; colors green ≥ 50 tps,
 *    yellow ≥ 20, red below.
 */
/** Context bar segments — DeepSeek blue family (dark-theme friendly: deep
 *  navy → brand blue, neutral grey free segment; labels adapt to width). */
declare const USED_SEGMENTS: readonly [{
    readonly key: "system";
    readonly color: "#22305F";
    readonly labels: readonly ["system", "sys", "s"];
}, {
    readonly key: "prompt";
    readonly color: "#2B3D78";
    readonly labels: readonly ["prompt", "pr", "p"];
}, {
    readonly key: "assistant";
    readonly color: "#344A92";
    readonly labels: readonly ["assistant", "ast", "a"];
}, {
    readonly key: "thinking";
    readonly color: "#4D6BFE";
    readonly labels: readonly ["think", "th", "t"];
}, {
    readonly key: "tools";
    readonly color: "#5A7CFF";
    readonly labels: readonly ["tools", "tl", "x"];
}];
/** Used tokens per context content type (system, prompt, assistant, thinking, tools). */
export type ContextSegments = Record<(typeof USED_SEGMENTS)[number]['key'], number>;
/** Compact token count like pi's: `988`, `3.4k`, `12k`, `1.0M`.
 * @param count - The raw token count; negative values clamp to zero.
 * @returns The compact count string.
 */
export declare function formatTokens(count: number): string;
/**
 * The segmented context bar: used segments by content type, the remainder as
 * a light free segment whose right edge carries the usage readout
 * (`ctx 12.3k/1.0M 1.2% 988.9k`, shrinking as width allows).
 * @param segments - Used tokens per content type.
 * @param usedTokens - Total used tokens, driving the usage readout.
 * @param contextWindow - The context window size in tokens.
 * @param width - Total bar width in terminal columns.
 * @returns The ANSI-styled segmented bar, or '' when `width` or `contextWindow` is non-positive.
 */
export declare function renderContextBar(segments: ContextSegments, usedTokens: number, contextWindow: number, width: number, colors?: {
    freeFill: string;
    freeText: string;
}): string;
/** Speed color: green ≥ 50, yellow ≥ 20, red below (pi-tps-meter).
 * @param tps - Tokens per second; selects the color threshold.
 * @param text - Text to color.
 * @returns The ANSI 24-bit color-wrapped text.
 */
export declare function speedColor(tps: number, text: string): string;
/** Live 1/8-cell horizontal gauge: `▕███████▋···▏`.
 * @param tps - Current tokens per second.
 * @param peak - Scaling peak; values below 40 scale against the floor instead.
 * @returns The ANSI gauge string.
 */
export declare function renderTpsGauge(tps: number, peak: number): string;
/** Min-max normalized 12-sample sparkline: `▁▄▇▅▂▁▇█▅▃▆▇`.
 * @param samples - Turn TPS samples; only the last 12 are rendered.
 * @returns The ANSI sparkline string.
 */
export declare function renderTpsSparkline(samples: readonly {
    tps: number;
}[]): string;
/** Rolling stats: 60s average, all-time mean and p95.
 * @param samples - Turn TPS samples with their timestamps in milliseconds.
 * @param nowMs - Current time in milliseconds; the 60s rolling window keeps samples with `nowMs - at <= 60_000`.
 * @returns The 60s average, all-time mean, and all-time p95 (all zero for an empty sample list).
 */
export declare function tpsStats(samples: readonly {
    tps: number;
    at: number;
}[], nowMs: number): {
    avg: number;
    mean: number;
    p95: number;
};
export {};
//# sourceMappingURL=StatusMetrics.d.ts.map