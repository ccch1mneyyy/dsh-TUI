import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { t } from '../i18n.js';
import { Box, Text, useTerminalSize } from '../ui.js';
import { Pane } from './design-system/Pane.js';
import { ListItem } from './design-system/ListItem.js';
import { HintLine } from './design-system/HintLine.js';
import { listWindow } from './listWindow.js';
/**
 * Model picker in the CC ModelPicker style: a permission-colored Pane with
 * the model list as Select rows (❯ focus pointer, ✓ on the active model,
 * descriptions), plus the Enter/Esc hint line. The DSH agent's model is
 * fixed at creation time, so a selection notifies "restart to apply".
 *
 * 长列表按焦点窗口化（Select 同款）：picker 经 OverlayAbove 浮层挂载后有
 * maxHeight 裁剪，全量渲染会让焦点行被裁掉（看不到焦点按 Enter）。
 */
export function ModelPicker({ models, focusIndex, currentModel, }) {
    const { rows: terminalRows } = useTerminalSize();
    // 焦点窗口化按行预算：ListItem 带 description 时占 2 行（正文+描述，均
    // truncate 成单行），只数项数会把焦点裁出浮层（二次审查实证）。
    // 框架行：浮层预留 8 + Pane 2 + 标题 2 + 页脚 1 = 13。
    const { start, end } = listWindow(models.map(m => (m.description ? 2 : 1)), focusIndex, Math.max(terminalRows - 13, 2));
    return (_jsxs(Pane, { color: "permission", children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: t('picker-title-model') }) }), models.slice(start, end).map((model, index) => {
                        const absoluteIndex = start + index;
                        return (_jsxs(ListItem, { isFocused: absoluteIndex === focusIndex, isSelected: `${model.provider}/${model.id}` === currentModel, description: model.description, showScrollUp: absoluteIndex === start && start > 0, showScrollDown: absoluteIndex === end - 1 && end < models.length, children: [model.provider, " / ", model.name] }, `${model.provider}/${model.id}`));
                    })] }), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: t('hint-confirm-exit') }) })] }));
}
