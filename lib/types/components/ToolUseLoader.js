import { jsx as _jsx } from "react/jsx-runtime";
import Box from '../ink/components/Box.js';
import { Text } from '../ui.js';
import { useBlink } from '../hooks/useBlink.js';
import { BLACK_CIRCLE } from '../cc/figures.js';
/**
 * The status dot on tool-card headers (ported from the leak's
 * ToolUseLoader): blinking `●` while running, theme-blue on success, rose on
 * error, dim while queued.
 */
export function ToolUseLoader({ isError, isUnresolved, shouldAnimate, }) {
    const [ref, isBlinking] = useBlink(shouldAnimate);
    const color = isUnresolved ? undefined : isError ? 'error' : 'success';
    const char = !shouldAnimate || isBlinking || isError || !isUnresolved
        ? BLACK_CIRCLE
        : ' ';
    return (_jsx(Box, { ref: ref, minWidth: 2, children: _jsx(Text, { color: color, dimColor: isUnresolved, children: char }) }));
}
