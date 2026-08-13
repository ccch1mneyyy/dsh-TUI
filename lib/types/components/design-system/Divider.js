import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import Text from '../../ink/components/Text.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { useTerminalSize } from '../../ink/hooks/use-terminal-size.js';
/**
 * A horizontal divider line, optionally with a title in the middle
 * (ported from the leak's design-system).
 *
 * @example
 * // ─────────── Title ───────────
 * <Divider title="Title" />
 */
export function Divider({ width, color, char = '─', padding = 0, title, }) {
    const { columns } = useTerminalSize();
    const lineWidth = Math.max(0, (width ?? columns) - padding);
    const titleWidth = title ? stringWidth(title) : 0;
    if (title && titleWidth < lineWidth) {
        const lineLength = lineWidth - titleWidth;
        const leftLength = Math.floor(lineLength / 2);
        const rightLength = Math.ceil(lineLength / 2);
        return (_jsxs(Text, { dimColor: !color, color: color, children: [char.repeat(leftLength), title, char.repeat(rightLength)] }));
    }
    return (_jsx(Text, { dimColor: !color, color: color, children: char.repeat(lineWidth) }));
}
