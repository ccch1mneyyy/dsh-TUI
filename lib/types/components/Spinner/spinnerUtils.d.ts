/**
 * Spinner animation utilities, ported from the leaked Claude Code source
 * (`src/components/Spinner/utils.ts`).
 */
export type RGBColor = {
    r: number;
    g: number;
    b: number;
};
/**
 * The platform-appropriate default spinner character set.
 * @returns The spinner frame characters for the current terminal/platform.
 */
export declare function getDefaultCharacters(): string[];
/**
 * Interpolate between two RGB colors.
 * @param color1 - Start color.
 * @param color2 - End color.
 * @param t - Interpolation factor, 0 to 1.
 * @returns The interpolated color, components rounded to integers.
 */
export declare function interpolateColor(color1: RGBColor, color2: RGBColor, t: number): RGBColor;
/**
 * Convert an RGB object to an `rgb()` color string for the Text component.
 * @param color - The RGB color to format.
 * @returns The `rgb(r,g,b)` string.
 */
export declare function toRGBColor(color: RGBColor): string;
/**
 * Convert an HSL hue to RGB, using voice-mode waveform parameters (s=0.7, l=0.6).
 * @param hue - Hue in degrees (0–360; wrapped into range).
 * @returns The RGB color for the hue.
 */
export declare function hueToRgb(hue: number): RGBColor;
/**
 * Parse an `rgb(r,g,b)` color string, memoized per input.
 * @param colorStr - The color string to parse.
 * @returns The parsed RGB color, or null when the string is not `rgb(r,g,b)`.
 */
export declare function parseRGB(colorStr: string): RGBColor | null;
//# sourceMappingURL=spinnerUtils.d.ts.map