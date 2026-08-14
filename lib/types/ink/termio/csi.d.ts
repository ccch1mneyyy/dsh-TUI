/**
 * CSI (Control Sequence Introducer) Types
 *
 * Enums and types for CSI command parameters.
 */
/** CSI introducer prefix: ESC followed by `[`. */
export declare const CSI_PREFIX: string;
/**
 * CSI parameter byte ranges
 */
export declare const CSI_RANGE: {
    readonly PARAM_START: 48;
    readonly PARAM_END: 63;
    readonly INTERMEDIATE_START: 32;
    readonly INTERMEDIATE_END: 47;
    readonly FINAL_START: 64;
    readonly FINAL_END: 126;
};
/**
 * Check if a byte is a CSI parameter byte.
 * @param byte - the byte value to check.
 * @returns true when the byte is in the parameter range (0x30-0x3F).
 */
export declare function isCSIParam(byte: number): boolean;
/**
 * Check if a byte is a CSI intermediate byte.
 * @param byte - the byte value to check.
 * @returns true when the byte is in the intermediate range (0x20-0x2F).
 */
export declare function isCSIIntermediate(byte: number): boolean;
/**
 * Check if a byte is a CSI final byte (@ through ~).
 * @param byte - the byte value to check.
 * @returns true when the byte is in the final range (0x40-0x7E).
 */
export declare function isCSIFinal(byte: number): boolean;
/**
 * Generate a CSI sequence: ESC [ p1;p2;...;pN final.
 * With a single argument it is treated as the raw body; with multiple
 * arguments the last is the final byte and the rest are parameters joined
 * by semicolons.
 * @param args - the sequence parts.
 * @returns the complete CSI sequence string.
 */
export declare function csi(...args: (string | number)[]): string;
/**
 * CSI final bytes - the command identifier
 */
export declare const CSI: {
    readonly CUU: 65;
    readonly CUD: 66;
    readonly CUF: 67;
    readonly CUB: 68;
    readonly CNL: 69;
    readonly CPL: 70;
    readonly CHA: 71;
    readonly CUP: 72;
    readonly CHT: 73;
    readonly VPA: 100;
    readonly HVP: 102;
    readonly ED: 74;
    readonly EL: 75;
    readonly ECH: 88;
    readonly IL: 76;
    readonly DL: 77;
    readonly ICH: 64;
    readonly DCH: 80;
    readonly SU: 83;
    readonly SD: 84;
    readonly SM: 104;
    readonly RM: 108;
    readonly SGR: 109;
    readonly DSR: 110;
    readonly DECSCUSR: 113;
    readonly DECSTBM: 114;
    readonly SCOSC: 115;
    readonly SCORC: 117;
    readonly CBT: 90;
};
/**
 * Erase in Display regions (ED command parameter)
 */
export declare const ERASE_DISPLAY: readonly ["toEnd", "toStart", "all", "scrollback"];
/**
 * Erase in Line regions (EL command parameter)
 */
export declare const ERASE_LINE_REGION: readonly ["toEnd", "toStart", "all"];
/**
 * Cursor styles (DECSCUSR)
 */
export type CursorStyle = 'block' | 'underline' | 'bar';
/**
 * Cursor style lookup table for DECSCUSR parameter 0-6, pairing each cursor
 * shape with its blinking flag.
 */
export declare const CURSOR_STYLES: Array<{
    style: CursorStyle;
    blinking: boolean;
}>;
/**
 * Move cursor up n lines (CSI n A).
 * @param n - number of lines to move; defaults to 1.
 * @returns the CSI sequence, or an empty string when n is 0.
 */
export declare function cursorUp(n?: number): string;
/**
 * Move cursor down n lines (CSI n B).
 * @param n - number of lines to move; defaults to 1.
 * @returns the CSI sequence, or an empty string when n is 0.
 */
export declare function cursorDown(n?: number): string;
/**
 * Move cursor forward n columns (CSI n C).
 * @param n - number of columns to move; defaults to 1.
 * @returns the CSI sequence, or an empty string when n is 0.
 */
export declare function cursorForward(n?: number): string;
/**
 * Move cursor back n columns (CSI n D).
 * @param n - number of columns to move; defaults to 1.
 * @returns the CSI sequence, or an empty string when n is 0.
 */
export declare function cursorBack(n?: number): string;
/**
 * Move cursor to column n (1-indexed) (CSI n G).
 * @param col - the 1-indexed target column.
 * @returns the CSI sequence.
 */
export declare function cursorTo(col: number): string;
/** Move cursor to column 1 (CSI G) */
export declare const CURSOR_LEFT: string;
/**
 * Move cursor to row, col (1-indexed) (CSI row ; col H).
 * @param row - the 1-indexed target row.
 * @param col - the 1-indexed target column.
 * @returns the CSI sequence.
 */
export declare function cursorPosition(row: number, col: number): string;
/** Move cursor to home position (CSI H) */
export declare const CURSOR_HOME: string;
/**
 * Move cursor relative to current position.
 * Positive x = right, negative x = left.
 * Positive y = down, negative y = up.
 * @param x - horizontal delta in columns.
 * @param y - vertical delta in rows.
 * @returns the concatenated CSI sequences, or an empty string when both deltas are 0.
 */
export declare function cursorMove(x: number, y: number): string;
/** Save cursor position (CSI s) */
export declare const CURSOR_SAVE: string;
/** Restore cursor position (CSI u) */
export declare const CURSOR_RESTORE: string;
/**
 * Erase from cursor to end of line (CSI K).
 * @returns the CSI sequence.
 */
export declare function eraseToEndOfLine(): string;
/**
 * Erase from cursor to start of line (CSI 1 K).
 * @returns the CSI sequence.
 */
export declare function eraseToStartOfLine(): string;
/**
 * Erase entire line (CSI 2 K).
 * @returns the CSI sequence.
 */
export declare function eraseLine(): string;
/** Erase entire line - constant form */
export declare const ERASE_LINE: string;
/**
 * Erase from cursor to end of screen (CSI J).
 * @returns the CSI sequence.
 */
export declare function eraseToEndOfScreen(): string;
/**
 * Erase from cursor to start of screen (CSI 1 J).
 * @returns the CSI sequence.
 */
export declare function eraseToStartOfScreen(): string;
/**
 * Erase entire screen (CSI 2 J).
 * @returns the CSI sequence.
 */
export declare function eraseScreen(): string;
/** Erase entire screen - constant form */
export declare const ERASE_SCREEN: string;
/** Erase scrollback buffer (CSI 3 J) */
export declare const ERASE_SCROLLBACK: string;
/**
 * Erase n lines starting from the cursor line, moving the cursor up.
 * This erases each line and moves up, ending at column 1.
 * @param n - the number of lines to erase.
 * @returns the combined erase and cursor sequences, or an empty string when
 *   n is 0 or negative.
 */
export declare function eraseLines(n: number): string;
/** Reset all SGR attributes (CSI 0 m). Erase/scroll sequences fill blank
 *  cells with the CURRENT background color (BCE) — prefix this before any
 *  such sequence that must not inherit a possibly-stuck background (e.g.
 *  after a truncated frame left a colored SGR active). */
export declare const SGR_RESET: string;
/**
 * Scroll up n lines (CSI n S).
 * @param n - number of lines to scroll; defaults to 1.
 * @returns the CSI sequence, or an empty string when n is 0.
 */
export declare function scrollUp(n?: number): string;
/**
 * Scroll down n lines (CSI n T).
 * @param n - number of lines to scroll; defaults to 1.
 * @returns the CSI sequence, or an empty string when n is 0.
 */
export declare function scrollDown(n?: number): string;
/**
 * Set scroll region (DECSTBM, CSI top;bottom r). 1-indexed, inclusive.
 * @param top - the 1-indexed first row of the region.
 * @param bottom - the 1-indexed last row of the region.
 * @returns the CSI sequence.
 */
export declare function setScrollRegion(top: number, bottom: number): string;
/** Reset scroll region to full screen (DECSTBM, CSI r). Homes the cursor. */
export declare const RESET_SCROLL_REGION: string;
/** Sent by terminal before pasted content (CSI 200 ~) */
export declare const PASTE_START: string;
/** Sent by terminal after pasted content (CSI 201 ~) */
export declare const PASTE_END: string;
/** Sent by terminal when it gains focus (CSI I) */
export declare const FOCUS_IN: string;
/** Sent by terminal when it loses focus (CSI O) */
export declare const FOCUS_OUT: string;
/**
 * Enable Kitty keyboard protocol with basic modifier reporting
 * CSI > 1 u - pushes mode with flags=1 (disambiguate escape codes)
 * This makes Shift+Enter send CSI 13;2 u instead of just CR
 */
export declare const ENABLE_KITTY_KEYBOARD: string;
/**
 * Disable Kitty keyboard protocol
 * CSI < u - pops the keyboard mode stack
 */
export declare const DISABLE_KITTY_KEYBOARD: string;
/**
 * Enable xterm modifyOtherKeys level 2.
 * tmux accepts this (not the kitty stack) to enable extended keys — when
 * extended-keys-format is csi-u, tmux then emits keys in kitty format.
 */
export declare const ENABLE_MODIFY_OTHER_KEYS: string;
/**
 * Disable xterm modifyOtherKeys (reset to default).
 */
export declare const DISABLE_MODIFY_OTHER_KEYS: string;
//# sourceMappingURL=csi.d.ts.map