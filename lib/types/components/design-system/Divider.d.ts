import React from 'react';
import type { Theme } from '../../theme.js';
type DividerProps = {
    /**
     * Width of the divider in characters.
     * Defaults to terminal width.
     */
    width?: number;
    /**
     * Theme color for the divider.
     * If not provided, dimColor is used.
     */
    color?: keyof Theme;
    /**
     * Character to use for the divider line.
     * @default '─'
     */
    char?: string;
    /**
     * Padding to subtract from the width (e.g., for indentation).
     * @default 0
     */
    padding?: number;
    /**
     * Title shown in the middle of the divider.
     * May contain ANSI codes (e.g., chalk-styled text).
     */
    title?: string;
};
/**
 * A horizontal divider line, optionally with a title in the middle
 * (ported from the leak's design-system).
 *
 * @example
 * // ─────────── Title ───────────
 * <Divider title="Title" />
 */
export declare function Divider({ width, color, char, padding, title, }: DividerProps): React.ReactNode;
export {};
//# sourceMappingURL=Divider.d.ts.map