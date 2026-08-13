import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import Box from '../../ink/components/Box.js';
import Text from '../../ink/components/Text.js';
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js';
import { SpinnerGlyph } from '../Spinner/SpinnerGlyph.js';
import { getDefaultCharacters } from '../Spinner/spinnerUtils.js';
const SPINNER_FRAMES = [
    ...getDefaultCharacters(),
    ...[...getDefaultCharacters()].reverse(),
];
/**
 * A spinner with a loading message for async operations, ported from the
 * leak's design-system/LoadingState.tsx (using the small animated glyph).
 *
 * @example
 * <LoadingState message="Loading models" bold subtitle="Querying the provider…" />
 */
export function LoadingState({ message, bold = false, dimColor = false, subtitle, }) {
    const [ref, time] = useAnimationFrame(80);
    const frame = Math.floor(time / 80) % SPINNER_FRAMES.length;
    return (_jsxs(Box, { ref: ref, flexDirection: "column", children: [_jsxs(Box, { flexDirection: "row", children: [_jsx(SpinnerGlyph, { frame: frame, messageColor: "text", time: time }), _jsxs(Text, { bold: bold, dimColor: dimColor, children: [' ', message] })] }), subtitle && _jsx(Text, { dimColor: true, children: subtitle })] }));
}
