import React from 'react';
import type { PresetOption } from '../channel.js';
/**
 * Agent-preset picker (issue #8) in the CC ModelPicker style — same chrome
 * as the ActivityPicker: a permission-colored Pane listing every roster
 * preset with its display name and description, `❯` focus pointer and `✓`
 * on the preset the current session runs. Enter applies through
 * `channel.switchPreset`, Esc cancels. Broken presets are listed (the
 * roster's discovery contract) but marked with their reason; the roster
 * default is tagged.
 */
export declare function PresetPicker({ presets, focusIndex, currentPreset, }: {
    presets: readonly PresetOption[];
    focusIndex: number;
    currentPreset: string | undefined;
}): React.ReactNode;
//# sourceMappingURL=PresetPicker.d.ts.map