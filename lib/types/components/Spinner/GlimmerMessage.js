import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import Text from '../../ink/components/Text.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { getGraphemeSegmenter } from '../../utils/intl.js';
import { getTheme } from '../../theme.js';
import { interpolateColor, parseRGB, toRGBColor } from './spinnerUtils.js';
import { useTheme } from '../design-system/ThemeProvider.js';
const ERROR_RED = { r: 171, g: 43, b: 63 };
/**
 * The shimmering verb message next to the spinner glyph, ported from the
 * leak's `Spinner/GlimmerMessage.tsx`.
 */
export function GlimmerMessage({ message, mode, messageColor, glimmerIndex, flashOpacity, shimmerColor, stalledIntensity = 0, }) {
    const [themeName] = useTheme();
    const theme = getTheme(themeName);
    // Precompute grapheme segmentation + widths once per message instead of
    // per animation frame (the original component re-renders at ~20fps).
    const { segments } = React.useMemo(() => {
        const segs = [];
        for (const { segment } of getGraphemeSegmenter().segment(message)) {
            segs.push({ segment, width: stringWidth(segment) });
        }
        return { segments: segs };
    }, [message]);
    if (!message)
        return null;
    // When stalled, show text that smoothly transitions to red
    if (stalledIntensity > 0) {
        const baseColorStr = theme[messageColor];
        const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
        if (baseRGB) {
            const interpolated = interpolateColor(baseRGB, ERROR_RED, stalledIntensity);
            const color = toRGBColor(interpolated);
            return (_jsxs(_Fragment, { children: [_jsx(Text, { color: color, children: message }), _jsx(Text, { color: color, children: " " })] }));
        }
        // Fallback for ANSI themes: use messageColor until fully stalled, then error
        const color = stalledIntensity > 0.5 ? 'error' : messageColor;
        return (_jsxs(_Fragment, { children: [_jsx(Text, { color: color, children: message }), _jsx(Text, { color: color, children: " " })] }));
    }
    // tool-use mode: all chars flash with the same opacity, so render as a
    // single <Text> instead of N individual FlashingChar components.
    if (mode === 'tool-use') {
        const baseColorStr = theme[messageColor];
        const shimmerColorStr = theme[shimmerColor];
        const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
        const shimmerRGB = shimmerColorStr ? parseRGB(shimmerColorStr) : null;
        if (baseRGB && shimmerRGB) {
            const interpolated = interpolateColor(baseRGB, shimmerRGB, flashOpacity);
            const color = toRGBColor(interpolated);
            return (_jsxs(_Fragment, { children: [_jsx(Text, { color: color, children: message }), _jsx(Text, { color: color, children: " " })] }));
        }
        // Fallback for ANSI themes: render without flash animation
        return (_jsxs(_Fragment, { children: [_jsx(Text, { color: messageColor, children: message }), _jsx(Text, { color: messageColor, children: " " })] }));
    }
    // Shimmer: a highlight sweeps across the message text
    const baseColorStr = theme[messageColor];
    const shimmerColorStr = theme[shimmerColor];
    const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
    const shimmerRGB = shimmerColorStr ? parseRGB(shimmerColorStr) : null;
    if (!baseRGB || !shimmerRGB) {
        // Fallback for ANSI themes: render without shimmer animation
        return (_jsxs(_Fragment, { children: [_jsx(Text, { color: messageColor, children: message }), _jsx(Text, { color: messageColor, children: " " })] }));
    }
    return (_jsxs(_Fragment, { children: [segments.map(({ segment, width }, index) => {
                let charStart = 0;
                for (let i = 0; i < index; i++)
                    charStart += segments[i].width;
                // Character is highlighted if it falls within the glimmer window
                const isHighlighted = glimmerIndex >= 0 &&
                    charStart >= glimmerIndex &&
                    charStart + width <= glimmerIndex + 4;
                const color = isHighlighted
                    ? toRGBColor(interpolateColor(baseRGB, shimmerRGB, flashOpacity))
                    : messageColor;
                return (_jsx(Text, { color: color, children: segment }, index));
            }), _jsx(Text, { color: messageColor, children: " " })] }));
}
