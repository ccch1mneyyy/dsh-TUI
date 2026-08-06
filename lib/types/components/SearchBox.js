import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
/**
 * A single-line search input in the round-bordered box of the leak's
 * SearchBox: `⌕ ` prefix, block cursor at `cursorOffset` (inverse cell),
 * placeholder with its first character as the cursor when empty.
 */
export function SearchBox({ query, placeholder = 'Search…', isFocused, isTerminalFocused, prefix = '⌕', width, cursorOffset, borderless = false, }) {
    const offset = cursorOffset ?? query.length;
    const borderStyle = borderless ? undefined : 'round';
    const borderColor = isFocused ? 'suggestion' : undefined;
    const borderDimColor = !isFocused;
    let content;
    if (isFocused) {
        if (query) {
            content = isTerminalFocused ? (_jsxs(_Fragment, { children: [_jsx(Text, { children: query.slice(0, offset) }), _jsx(Text, { inverse: true, children: offset < query.length ? query[offset] : ' ' }), offset < query.length && _jsx(Text, { children: query.slice(offset + 1) })] })) : (_jsx(Text, { children: query }));
        }
        else {
            content = isTerminalFocused ? (_jsxs(_Fragment, { children: [_jsx(Text, { inverse: true, children: placeholder.charAt(0) }), _jsx(Text, { dimColor: true, children: placeholder.slice(1) })] })) : (_jsx(Text, { dimColor: true, children: placeholder }));
        }
    }
    else {
        content = query ? _jsx(Text, { children: query }) : _jsx(Text, { children: placeholder });
    }
    return (_jsx(Box, { flexShrink: 0, borderStyle: borderStyle, borderColor: borderColor, borderDimColor: borderDimColor, paddingX: borderless ? 0 : 1, width: width, children: _jsxs(Text, { dimColor: !isFocused, children: [prefix, " ", content] }) }));
}
//# sourceMappingURL=SearchBox.js.map