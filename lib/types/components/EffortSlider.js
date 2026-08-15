import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { t } from '../i18n.js';
import { Box, Text } from '../ui.js';
import { Pane } from './design-system/Pane.js';
import { HintLine } from './design-system/HintLine.js';
/**
 * Reasoning-effort slider (`/effort`): a rheostat row of the live route's
 * adapter-owned levels in adapter order, ←/→ moving focus (each move applies
 * immediately through `channel.setEffort` — the slider IS the control; Enter
 * or Esc just closes it). The current level carries `✓`; the focused level's
 * description renders below the row.
 */
export function EffortSlider({ options, focusIndex, currentId, }) {
    const focused = options[focusIndex];
    return (_jsx(Pane, { color: "permission", children: _jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: t('picker-title-effort') }) }), _jsx(Box, { flexDirection: "row", children: options.map((option, index) => (_jsxs(React.Fragment, { children: [index > 0 ? (_jsx(Text, { dimColor: true, children: " \u2500\u2500 " })) : null, _jsx(Text, { inverse: index === focusIndex, bold: index === focusIndex, children: option.name }), option.id === currentId ? _jsx(Text, { color: "remember", children: "\u2713" }) : null] }, option.id))) }), focused?.description !== undefined ? (_jsx(Text, { dimColor: true, children: focused.description })) : null, _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: t('hint-adjust-done') }) })] }) }));
}
