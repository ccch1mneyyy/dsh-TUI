import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text } from '../ui.js';
import { Pane } from './design-system/Pane.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
/**
 * Reasoning-effort slider (`/effort`): a rheostat row of the live route's
 * adapter-owned levels in adapter order, ←/→ moving focus (each move applies
 * immediately through `channel.setEffort` — the slider IS the control; Enter
 * or Esc just closes it). The current level carries `✓`; the focused level's
 * description renders below the row.
 */
export function EffortSlider({ options, focusIndex, currentId, }) {
    const focused = options[focusIndex];
    return (_jsx(Pane, { color: "permission", children: _jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: "Reasoning effort" }) }), _jsx(Box, { flexDirection: "row", children: options.map((option, index) => (_jsxs(React.Fragment, { children: [index > 0 ? (_jsx(Text, { dimColor: true, children: " \u2500\u2500 " })) : null, _jsx(Text, { inverse: index === focusIndex, bold: index === focusIndex, children: option.name }), option.id === currentId ? _jsx(Text, { color: "remember", children: "\u2713" }) : null] }, option.id))) }), focused?.description !== undefined ? (_jsx(Text, { dimColor: true, children: focused.description })) : null, _jsx(Text, { dimColor: true, italic: true, children: _jsxs(Byline, { children: [_jsx(KeyboardShortcutHint, { shortcut: "\u2190/\u2192", action: "adjust", bold: true }), _jsx(KeyboardShortcutHint, { shortcut: "Enter/Esc", action: "done" })] }) })] }) }));
}
