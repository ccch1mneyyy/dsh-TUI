import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from '../../ui.js';
import { POINTER } from '../../cc/figures.js';
/**
 * User prompt bubble: `❯ text` on the theme's userMessageBackground grey
 * (ported from the leak's `messages/UserPromptMessage.tsx` +
 * `HighlightedThinkingText.tsx`, with the ultrathink rainbow removed).
 */
export function UserPromptMessage({ text, addMargin, isSelected = false, isExpanded = false, onClick, }) {
    return (_jsx(Box, { flexDirection: "column", marginTop: addMargin ? 1 : 0, backgroundColor: isSelected
            ? 'messageActionsBackground'
            : isExpanded
                ? 'userMessageBackgroundHover'
                : 'userMessageBackground', paddingRight: 1, onClick: onClick, children: _jsxs(Text, { children: [_jsxs(Text, { color: "subtle", children: [POINTER, " "] }), _jsx(Text, { color: "text", children: text })] }) }));
}
