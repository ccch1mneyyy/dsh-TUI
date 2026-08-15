import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { t } from '../i18n.js';
import { Box, Text, useTerminalSize } from '../ui.js';
import { Pane } from './design-system/Pane.js';
import { ListItem } from './design-system/ListItem.js';
import { HintLine } from './design-system/HintLine.js';
import { listWindow } from './listWindow.js';
/**
 * Double-Esc rewind picker (CC's "Double-tap esc to rewind the code and/or
 * conversation to a previous point in time"): lists the user's past messages
 * newest-first; selecting one and confirming rewinds the conversation to
 * that point (the message comes back into the input for re-editing).
 */
export function RewindPicker({ rows, focusIndex, confirmRow, }) {
    if (confirmRow !== null) {
        return (_jsx(Pane, { color: "permission", children: _jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: t('rewind-confirm-title') }) }), _jsx(ListItem, { isFocused: false, description: t('rewind-confirm-desc'), children: preview(confirmRow.text) }), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: t('hint-rewind-back') }) })] }) }));
    }
    const { rows: terminalRows } = useTerminalSize();
    // 焦点窗口化按行预算：首项带 'last message' 描述占 2 行、其余 1 行
    //（ListItem 保证单行截断）。rewind 是不可见确认的高危操作，焦点必须
    // 始终在屏。框架行：浮层预留 8 + Pane 2 + 标题块 3 + 页脚 1 = 14。
    const { start, end } = listWindow(rows.map((_, i) => (i === 0 ? 2 : 1)), focusIndex, Math.max(terminalRows - 14, 2));
    return (_jsxs(Pane, { color: "permission", children: [_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { color: "remember", bold: true, children: t('rewind-title') }), _jsx(Text, { dimColor: true, children: t('rewind-subtitle') })] }), rows.length === 0 ? (_jsx(ListItem, { isFocused: false, children: t('rewind-empty') })) : (rows.slice(start, end).map((row, index) => {
                        const absoluteIndex = start + index;
                        return (_jsx(ListItem, { isFocused: absoluteIndex === focusIndex, description: absoluteIndex === 0 ? t('rewind-last-message') : undefined, showScrollUp: absoluteIndex === start && start > 0, showScrollDown: absoluteIndex === end - 1 && end < rows.length, children: preview(row.text) }, row.id));
                    }))] }), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: t('hint-select-exit') }) })] }));
}
/** One-line preview of a message (newlines flattened, capped). */
function preview(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}
