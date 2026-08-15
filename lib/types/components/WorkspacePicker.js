import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from '../ui.js';
import { t } from '../i18n.js';
import { Pane } from './design-system/Pane.js';
import { ListItem } from './design-system/ListItem.js';
import { HintLine } from './design-system/HintLine.js';
const WINDOW = 8;
/** `/workspace` target picker contributed by local and optional providers. */
export function WorkspacePicker({ targets, focusIndex, currentCwd, }) {
    const start = Math.max(0, Math.min(focusIndex - Math.floor(WINDOW / 2), targets.length - WINDOW));
    const visible = targets.slice(start, start + WINDOW);
    return (_jsxs(Pane, { color: "permission", children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: t('workspace-picker-title') }) }), visible.map((target, index) => (_jsxs(ListItem, { isFocused: start + index === focusIndex, isSelected: target.cwd === currentCwd, description: target.description ?? target.uri, showScrollUp: index === 0 && start > 0, showScrollDown: index === visible.length - 1 && start + visible.length < targets.length, children: [target.badge, " \u00B7 ", target.label] }, target.uri)))] }), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: t('workspace-picker-hint') }) })] }));
}
