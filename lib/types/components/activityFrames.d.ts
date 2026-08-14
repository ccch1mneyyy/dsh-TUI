/**
 * Working-activity indicator presets, ported from the pi
 * working-activity extension (`FRAME_PRESETS`). The TUI renders the current
 * frame next to the live working line, tinted by the activity phase.
 * `\uFE0E` forces text rendering so Windows never paints the glyphs as
 * color emoji (the green-block problem).
 */
/** One working-activity preset: the frame sequence and the per-frame interval. */
export interface FramePreset {
    readonly frames: readonly string[];
    readonly intervalMs: number;
}
/** Named working-activity frame presets, keyed by preset name (`claude`, `moon`, `sand`, ...). */
export declare const FRAME_PRESETS: Record<string, FramePreset>;
/** The pi extension's default preset. */
export declare const DEFAULT_PRESET = "moon";
/** Every selectable preset name, `random` first (the pi selector order). */
export declare const PRESET_NAMES: readonly string[];
/**
 * Whether `name` selects a known preset or `random`.
 * @param name - Candidate preset name.
 * @returns True when the name resolves to a preset.
 */
export declare function isPresetName(name: string): boolean;
/**
 * Resolve a preset name (`random` picks one per process).
 * @param name - Preset name, or undefined for the default.
 * @returns The matching preset; unknown or absent names fall back to the default.
 */
export declare function resolvePreset(name: string | undefined): FramePreset;
//# sourceMappingURL=activityFrames.d.ts.map