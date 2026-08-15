import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { t } from '../i18n.js';
import { Box, Text } from '../ui.js';
import { Pane } from './design-system/Pane.js';
import { Select } from './Select.js';
import { HintLine } from './design-system/HintLine.js';
import { FRAME_PRESETS, PRESET_NAMES } from './activityFrames.js';
/**
 * Working-activity indicator picker in the CC ModelPicker style (ported
 * from the pi extension's `/activity` interactive select): a
 * permission-colored Pane listing every preset (random first) with its
 * frame preview, `❯` focus pointer and `✓` on the active preset. Enter
 * applies through `channel.setActivityFrames`, Esc cancels.
 */
export function ActivityPicker({ focusIndex, currentPreset, }) {
    return (_jsx(Pane, { color: "permission", children: _jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: t('picker-title-activity') }) }), _jsx(Select, { options: PRESET_NAMES.map(name => ({
                        value: name,
                        label: name,
                        description: name === 'random'
                            ? t('activity-random-each-preset')
                            : FRAME_PRESETS[name].frames.slice(0, 5).join(' '),
                    })), focusIndex: focusIndex, selectedValue: currentPreset }), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: t('hint-confirm-exit') }) })] }) }));
}
