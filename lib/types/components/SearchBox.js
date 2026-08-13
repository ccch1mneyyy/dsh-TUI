import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
/**
 * A single-line search input in the round-bordered box of the leak's
 * SearchBox: `⌕ ` prefix, block cursor at `cursorOffset` (inverse cell).
 * When empty and focused, a solid block caret sits at the start and the
 * placeholder is right-aligned (dimmed) — kept off the caret's cell so the
 * terminal-painted IME preedit (pinyin) can never be overlaid on it during
 * CJK composition.
 */
export function SearchBox({ query, placeholder = 'Search…', isFocused, isTerminalFocused, prefix = '⌕', width, cursorOffset, borderless = false, }) {
    const offset = cursorOffset ?? query.length;
    const borderStyle = borderless ? undefined : 'round';
    const borderColor = isFocused ? 'suggestion' : undefined;
    const borderDimColor = !isFocused;
    // Focused + empty + terminal focused: inline caret row (block caret at the
    // start, placeholder right-aligned) instead of the inline placeholder.
    const inlineCaret = isFocused && query === '' && isTerminalFocused;
    let content;
    if (isFocused) {
        if (query) {
            content = isTerminalFocused ? (_jsxs(_Fragment, { children: [_jsx(Text, { children: query.slice(0, offset) }), _jsx(Text, { inverse: true, children: offset < query.length ? query[offset] : ' ' }), offset < query.length && _jsx(Text, { children: query.slice(offset + 1) })] })) : (_jsx(Text, { children: query }));
        }
        else if (!isTerminalFocused) {
            content = _jsx(Text, { dimColor: true, children: placeholder });
        }
    }
    else {
        content = query ? _jsx(Text, { children: query }) : _jsx(Text, { children: placeholder });
    }
    return (_jsx(Box, { flexShrink: 0, borderStyle: borderStyle, borderColor: borderColor, borderDimColor: borderDimColor, paddingX: borderless ? 0 : 1, width: width, children: inlineCaret ? (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsxs(Text, { children: [prefix, " "] }), _jsx(Text, { inverse: true, children: " " }), _jsx(Box, { flexGrow: 1 }), _jsx(Text, { dimColor: true, wrap: "truncate", children: placeholder })] })) : (_jsxs(Text, { dimColor: !isFocused, children: [prefix, " ", content] })) }));
}
