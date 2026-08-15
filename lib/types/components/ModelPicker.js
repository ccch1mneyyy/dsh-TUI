import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { t } from '../i18n.js';
import { Box, Text } from '../ui.js';
import { Pane } from './design-system/Pane.js';
import { ListItem } from './design-system/ListItem.js';
import { HintLine } from './design-system/HintLine.js';
/**
 * Model picker in the CC ModelPicker style: a permission-colored Pane with
 * the model list as Select rows (❯ focus pointer, ✓ on the active model,
 * descriptions), plus the Enter/Esc hint line. The DSH agent's model is
 * fixed at creation time, so a selection notifies "restart to apply".
 */
export function ModelPicker({ models, focusIndex, currentModel, }) {
    return (_jsxs(Pane, { color: "permission", children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: t('picker-title-model') }) }), models.map((model, index) => (_jsxs(ListItem, { isFocused: index === focusIndex, isSelected: `${model.provider}/${model.id}` === currentModel, description: model.description, children: [model.provider, " / ", model.name] }, `${model.provider}/${model.id}`)))] }), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: t('hint-confirm-exit') }) })] }));
}
