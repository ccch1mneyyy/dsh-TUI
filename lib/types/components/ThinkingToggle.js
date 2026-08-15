import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { t } from '../i18n.js';
import { Box, Text } from '../ui.js';
import { Pane } from './design-system/Pane.js';
import { Select } from './Select.js';
import { HintLine } from './design-system/HintLine.js';
/**
 * The `/thinking` dialog, ported from the leak's ThinkingToggle.tsx: a
 * permission-colored Pane with a bold title, the Enabled/Disabled select
 * (with CC's option descriptions), and the Enter/Esc hint line.
 *
 * When `confirmationPending` is set (mid-conversation toggle), the select is
 * replaced by CC's yellow warning block and the hint line becomes
 * Enter confirm / Esc cancel; keyboard handling lives in the caller (Chat).
 */
export function ThinkingToggle({ currentValue, focusIndex, confirmationPending, }) {
    const options = [
        {
            value: 'true',
            label: t('thinking-enabled'),
            description: t('thinking-enabled-desc'),
        },
        {
            value: 'false',
            label: t('thinking-disabled'),
            description: t('thinking-disabled-desc'),
        },
    ];
    return (_jsxs(Pane, { color: "permission", children: [_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { marginBottom: 1, flexDirection: "column", children: [_jsx(Text, { color: "remember", bold: true, children: t('thinking-title') }), _jsx(Text, { dimColor: true, children: t('thinking-subtitle') })] }), confirmationPending !== null ? (_jsxs(Box, { flexDirection: "column", marginBottom: 1, gap: 1, children: [_jsx(Text, { color: "warning", children: t('thinking-mid-warning') }), _jsx(Text, { color: "warning", children: t('thinking-proceed') })] })) : (_jsx(Box, { flexDirection: "column", marginBottom: 1, children: _jsx(Select, { options: options, focusIndex: focusIndex, selectedValue: currentValue ? 'true' : 'false', visibleOptionCount: 2 }) }))] }), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: confirmationPending !== null ? t('hint-confirm-cancel') : t('hint-confirm-exit') }) })] }));
}
