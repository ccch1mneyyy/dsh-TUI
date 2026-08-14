import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { t } from '../i18n.js';
import { Box, Text } from '../ui.js';
import { Pane } from './design-system/Pane.js';
import { Select } from './Select.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
/**
 * Agent-preset picker (issue #8) in the CC ModelPicker style — same chrome
 * as the ActivityPicker: a permission-colored Pane listing every roster
 * preset with its display name and description, `❯` focus pointer and `✓`
 * on the preset the current session runs. Enter applies through
 * `channel.switchPreset`, Esc cancels. Broken presets are listed (the
 * roster's discovery contract) but marked with their reason; the roster
 * default is tagged.
 */
export function PresetPicker({ presets, focusIndex, currentPreset, }) {
    return (_jsx(Pane, { color: "permission", children: _jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: "Agent preset" }) }), _jsx(Select, { options: presets.map(preset => ({
                        value: preset.id,
                        label: (preset.name ?? preset.id) +
                            (preset.isDefault ? t('preset-default-tag') : '') +
                            (preset.broken !== undefined ? t('preset-broken-tag') : ''),
                        description: preset.broken ?? preset.description ?? preset.id,
                    })), focusIndex: focusIndex, selectedValue: currentPreset }), _jsx(Text, { dimColor: true, italic: true, children: _jsxs(Byline, { children: [_jsx(KeyboardShortcutHint, { shortcut: "Enter", action: "confirm", bold: true }), _jsx(KeyboardShortcutHint, { shortcut: "Esc", action: "exit" })] }) })] }) }));
}
