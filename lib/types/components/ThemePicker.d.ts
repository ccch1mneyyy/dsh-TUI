import React from 'react';
import { type SelectOption } from './Select.js';
/**
 * The full selectable theme list: the three built-in palettes (display
 * order) followed by discovered user themes from ~/.dsh-tui/themes (sorted
 * by file name). Shared by ThemePicker (render) and the /theme command
 * (focus index), so both always see the same ordering.
 */
export declare function getThemeOptions(): SelectOption[];
/**
 * Color-theme picker in the ActivityPicker style: a permission-colored Pane
 * listing the built-in palettes first, then every user theme found in
 * ~/.dsh-tui/themes — each row shows the display name, its base and three
 * key color swatches; `❯` marks focus, `✓` the active theme. Enter applies
 * through the ThemeProvider setter (persists to ~/.dsh-tui/theme.json and
 * hot swaps), Esc cancels.
 */
export declare function ThemePicker({ focusIndex, currentTheme, }: {
    focusIndex: number;
    currentTheme: string | undefined;
}): React.ReactNode;
//# sourceMappingURL=ThemePicker.d.ts.map