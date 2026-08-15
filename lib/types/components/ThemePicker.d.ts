import React from 'react';
import { type SelectOption } from './Select.js';
/**
 * The full selectable theme list: the `auto` pseudo-theme (follows the
 * terminal background via OSC 11, light/dark) first, then the three
 * built-in palettes (display order), then discovered user themes from
 * ~/.dsh-tui/themes (sorted by file name). A user theme named `auto` is
 * shadowed by the built-in pseudo-theme (getTheme resolves `auto` first),
 * so it is filtered out to keep the list truthful. Shared by ThemePicker
 * (render) and the /theme command (focus index), so both always see the
 * same ordering.
 */
export declare function getThemeOptions(): SelectOption[];
/**
 * Color-theme picker in the ActivityPicker style: a permission-colored Pane
 * listing the `auto` pseudo-theme and the built-in palettes first, then
 * every user theme found in ~/.dsh-tui/themes — each row shows the display
 * name, its base and three key color swatches; `❯` marks focus, `✓` the
 * active theme. Enter applies through the ThemeProvider setter (persists to
 * ~/.dsh-tui/theme.json and hot swaps), Esc cancels.
 */
export declare function ThemePicker({ focusIndex, currentTheme, }: {
    focusIndex: number;
    currentTheme: string | undefined;
}): React.ReactNode;
//# sourceMappingURL=ThemePicker.d.ts.map