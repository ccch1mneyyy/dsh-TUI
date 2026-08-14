import type { Color, TextStyles } from './styles.js';
/** Whether chalk's color level was boosted to 3 for xterm.js terminals. */
export declare const CHALK_BOOSTED_FOR_XTERMJS: boolean;
/** Whether chalk's color level was clamped to 2 for tmux passthrough. */
export declare const CHALK_CLAMPED_FOR_TMUX: boolean;
/** Which part of a cell a color applies to: text or background. */
export type ColorType = 'foreground' | 'background';
/**
 * Apply a raw color value to a string using chalk.
 * @param str - the text to color.
 * @param color - the raw color value (ansi:*, hex, ansi256, or rgb); empty or unparsable values leave `str` unchanged.
 * @param type - whether the color applies to foreground or background.
 * @returns `str` wrapped in the chalk color sequence, or `str` unchanged when no color applies.
 */
export declare const colorize: (str: string, color: string | undefined, type: ColorType) => string;
/**
 * Apply TextStyles to a string using chalk.
 * This is the inverse of parsing ANSI codes - we generate them from structured styles.
 * Theme resolution happens at component layer, not here.
 * @param text - the text to style.
 * @param styles - the structured styles to apply.
 * @returns `text` wrapped in the chalk sequences for the enabled styles.
 */
export declare function applyTextStyles(text: string, styles: TextStyles): string;
/**
 * Apply a raw color value to text.
 * Theme resolution should happen at component layer, not here.
 * @param text - the text to color.
 * @param color - the raw foreground color value; undefined or empty leaves `text` unchanged.
 * @returns `text` wrapped in the foreground color sequence.
 */
export declare function applyColor(text: string, color: Color | undefined): string;
//# sourceMappingURL=colorize.d.ts.map