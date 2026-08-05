/**
 * Working-activity indicator presets, ported from the pi
 * working-activity extension (`FRAME_PRESETS`). The TUI renders the current
 * frame next to the live working line, tinted by the activity phase.
 * `\uFE0E` forces text rendering so Windows never paints the glyphs as
 * color emoji (the green-block problem).
 */
export interface FramePreset {
    readonly frames: readonly string[];
    readonly intervalMs: number;
}
export declare const FRAME_PRESETS: Record<string, FramePreset>;
/** The pi extension's default preset. */
export declare const DEFAULT_PRESET = "moon";
/** Resolve a preset name (`random` picks one per process). */
export declare function resolvePreset(name: string | undefined): FramePreset;
//# sourceMappingURL=activityFrames.d.ts.map