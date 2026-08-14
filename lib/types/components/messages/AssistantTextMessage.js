import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, NoSelect, Text } from '../../ui.js';
import { BLACK_CIRCLE } from '../../cc/figures.js';
import { Markdown } from '../Markdown.js';
/**
 * Assistant text message:  bullet + markdown body (ported from the
 * leak's  default branch).
 */
export function AssistantTextMessage({ text, addMargin, isSelected = false, isExpanded = false, onClick, }) {
    return (_jsx(Box, { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between", marginTop: addMargin ? 1 : 0, width: "100%", backgroundColor: isSelected
            ? 'messageActionsBackground'
            : isExpanded
                ? 'userMessageBackgroundHover'
                : undefined, onClick: onClick, children: _jsxs(Box, { flexDirection: "row", children: [_jsx(NoSelect, { fromLeftEdge: true, minWidth: 2, children: _jsx(Text, { color: isSelected ? 'suggestion' : 'text', children: BLACK_CIRCLE }) }), _jsx(Box, { flexDirection: "column", children: _jsx(Markdown, { children: text }) })] }) }));
}
