import { jsx as _jsx } from "react/jsx-runtime";
import Box from '../../ink/components/Box.js';
import Text from '../../ink/components/Text.js';
import { getTheme } from '../../theme.js';
import { useTheme } from '../design-system/ThemeProvider.js';
import { getDefaultCharacters, interpolateColor, parseRGB, toRGBColor } from './spinnerUtils.js';
const DEFAULT_CHARACTERS = getDefaultCharacters();
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];
const REDUCED_MOTION_DOT = '●';
const REDUCED_MOTION_CYCLE_MS = 2000; // 2-second cycle: 1s visible, 1s dim
const ERROR_RED = { r: 171, g: 43, b: 63 };
/**
 * The animated spinner glyph (·✢*✶✻✽ cycle), ported from the leak's
 * `Spinner/SpinnerGlyph.tsx`. Interpolates toward red when stalled.
 */
export function SpinnerGlyph({ frame, messageColor, stalledIntensity = 0, reducedMotion = false, time = 0, }) {
    const [themeName] = useTheme();
    const theme = getTheme(themeName);
    if (reducedMotion) {
        const isDim = Math.floor(time / (REDUCED_MOTION_CYCLE_MS / 2)) % 2 === 1;
        return (_jsx(Box, { flexWrap: "wrap", height: 1, width: 2, children: _jsx(Text, { color: messageColor, dimColor: isDim, children: REDUCED_MOTION_DOT }) }));
    }
    const spinnerChar = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    if (stalledIntensity > 0) {
        const baseColorStr = theme[messageColor];
        const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
        if (baseRGB) {
            const interpolated = interpolateColor(baseRGB, ERROR_RED, stalledIntensity);
            return (_jsx(Box, { flexWrap: "wrap", height: 1, width: 2, children: _jsx(Text, { color: toRGBColor(interpolated), children: spinnerChar }) }));
        }
        // Fallback for ANSI themes: use messageColor until fully stalled, then error
        const color = stalledIntensity > 0.5 ? 'error' : messageColor;
        return (_jsx(Box, { flexWrap: "wrap", height: 1, width: 2, children: _jsx(Text, { color: color, children: spinnerChar }) }));
    }
    return (_jsx(Box, { flexWrap: "wrap", height: 1, width: 2, children: _jsx(Text, { color: messageColor, children: spinnerChar }) }));
}
