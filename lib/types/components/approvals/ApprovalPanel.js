import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The approval panel — Claude Code style permission prompt for the DSH
 * approval seam (`ctx.approval`). One ask per panel: a permission-colored
 * divider header naming the tool, the gated command recovered from the
 * paired tool call (CC verbose full-command semantics), the asker's reason,
 * "Do you want to proceed?", and a numbered Yes/No list.
 *
 * The protocol's outcome set is closed (allowed-once / rejected /
 * cancelled / unavailable) with no allow-always or feedback channel, so
 * the panel deliberately offers exactly two rows; Esc and Ctrl+C reject
 * (fail closed, CC's "Esc to cancel" semantics).
 */
import React from 'react';
import { t } from '../../i18n.js';
import { Box, Text, useInput } from '../../ui.js';
import { isPlainReturnInput } from '../../utils/modifiers.js';
import { Divider } from '../design-system/Divider.js';
import { POINTER } from '../../cc/figures.js';
const OUTCOMES = ['allowed-once', 'rejected'];
export function ApprovalPanel({ approval, onDecide }) {
    const [focusIndex, setFocusIndex] = React.useState(0);
    useInput((input, key) => {
        if (key.escape || (key.ctrl && input === 'c')) {
            onDecide('rejected');
            return;
        }
        if (key.upArrow) {
            setFocusIndex(index => (index + OUTCOMES.length - 1) % OUTCOMES.length);
            return;
        }
        if (key.downArrow) {
            setFocusIndex(index => (index + 1) % OUTCOMES.length);
            return;
        }
        if (input === '1' || input === '2') {
            onDecide(OUTCOMES[Number(input) - 1]);
            return;
        }
        if (isPlainReturnInput(input, key)) {
            onDecide(OUTCOMES[focusIndex]);
        }
    }, { isActive: true });
    const optionLabels = [t('approval-yes'), t('approval-no')];
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2, paddingRight: 2, width: "100%", children: [_jsx(Divider, { color: "permission", title: t('approval-waiting', { tool: approval.toolName }), padding: 4 }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [approval.command !== undefined && (_jsx(Box, { flexDirection: "column", paddingX: 2, children: _jsx(Text, { dimColor: true, wrap: "wrap", children: approval.command }) })), approval.reason !== undefined && (_jsx(Text, { dimColor: true, wrap: "wrap", children: approval.reason })), _jsx(Text, { dimColor: true, children: t('approval-proceed') })] }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: optionLabels.map((label, index) => {
                    const focused = index === focusIndex;
                    return (_jsxs(Box, { flexDirection: "row", marginTop: focused ? 1 : 0, children: [_jsx(Box, { width: 1, flexShrink: 0, children: _jsx(Text, { color: focused ? 'claude' : undefined, bold: focused, children: focused ? POINTER : ' ' }) }), _jsxs(Text, { bold: focused, color: focused ? 'claude' : undefined, wrap: "wrap", children: [index + 1, ". ", label] })] }, label));
                }) }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: t('approval-hint') }) })] }));
}
