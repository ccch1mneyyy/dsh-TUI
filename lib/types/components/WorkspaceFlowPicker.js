import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Box, Text } from '../ui.js';
import { t } from '../i18n.js';
import { Pane } from './design-system/Pane.js';
import { ListItem } from './design-system/ListItem.js';
import { HintLine } from './design-system/HintLine.js';
const WINDOW = 8;
/** Generic nested choice surface returned by a workspace provider command. */
export function WorkspaceFlowPicker({ title, choices, focusIndex, busy = false, input = null, }) {
    const start = Math.max(0, Math.min(focusIndex - Math.floor(WINDOW / 2), choices.length - WINDOW));
    const visible = choices.slice(start, start + WINDOW);
    return (_jsxs(Pane, { color: "permission", children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: title }) }), visible.map((choice, index) => (_jsxs(ListItem, { isFocused: start + index === focusIndex, isSelected: false, description: choice.description, showScrollUp: index === 0 && start > 0, showScrollDown: index === visible.length - 1 && start + visible.length < choices.length, children: [choice.badge ? `${choice.badge} · ` : '', choice.label] }, choice.id))), input !== null && (_jsxs(Box, { marginTop: 1, children: [_jsx(Text, { color: "remember", children: "\u276F " }), input.value.length === 0 ? (_jsxs(_Fragment, { children: [_jsx(Text, { inverse: true, children: " " }), _jsx(Text, { dimColor: true, children: input.placeholder ?? '' })] })) : (_jsxs(_Fragment, { children: [_jsx(Text, { children: input.value.slice(0, input.cursor) }), _jsx(Text, { inverse: true, children: input.value[input.cursor] ?? ' ' }), _jsx(Text, { children: input.value.slice(input.cursor + 1) })] }))] }))] }), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: busy
                        ? t('workspace-flow-loading')
                        : input !== null
                            ? t('workspace-flow-input-hint')
                            : choices[focusIndex]?.input !== undefined
                                ? t('workspace-flow-edit-hint')
                                : t('workspace-flow-hint') }) })] }));
}
