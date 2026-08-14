/**
 * DEC (Digital Equipment Corporation) Private Mode Sequences
 *
 * DEC private modes use CSI ? N h (set) and CSI ? N l (reset) format.
 * These are terminal-specific extensions to the ANSI standard.
 */
/**
 * DEC private mode numbers
 */
export declare const DEC: {
    readonly CURSOR_VISIBLE: 25;
    readonly ALT_SCREEN: 47;
    readonly ALT_SCREEN_CLEAR: 1049;
    readonly MOUSE_NORMAL: 1000;
    readonly MOUSE_BUTTON: 1002;
    readonly MOUSE_ANY: 1003;
    readonly MOUSE_SGR: 1006;
    readonly FOCUS_EVENTS: 1004;
    readonly BRACKETED_PASTE: 2004;
    readonly SYNCHRONIZED_UPDATE: 2026;
};
/**
 * Generate a CSI ? N h sequence to set a DEC private mode.
 * @param mode - the DEC private mode number.
 * @returns the CSI sequence.
 */
export declare function decset(mode: number): string;
/**
 * Generate a CSI ? N l sequence to reset a DEC private mode.
 * @param mode - the DEC private mode number.
 * @returns the CSI sequence.
 */
export declare function decreset(mode: number): string;
/** Enable synchronized output updates (DECSET 2026). */
export declare const BSU: string;
/** Disable synchronized output updates (DECRESET 2026). */
export declare const ESU: string;
/** Enable bracketed paste mode (DECSET 2004). */
export declare const EBP: string;
/** Disable bracketed paste mode (DECRESET 2004). */
export declare const DBP: string;
/** Enable focus event reporting (DECSET 1004). */
export declare const EFE: string;
/** Disable focus event reporting (DECRESET 1004). */
export declare const DFE: string;
/** Show the cursor (DECSET 25). */
export declare const SHOW_CURSOR: string;
/** Hide the cursor (DECRESET 25). */
export declare const HIDE_CURSOR: string;
/** Enter the alternate screen, clearing it (DECSET 1049). */
export declare const ENTER_ALT_SCREEN: string;
/** Exit the alternate screen (DECRESET 1049). */
export declare const EXIT_ALT_SCREEN: string;
/**
 * Enable full mouse tracking: modes 1000 (click/release/wheel), 1002 (drag),
 * 1003 (hover), and 1006 (SGR format).
 */
export declare const ENABLE_MOUSE_TRACKING: string;
/** Disable all mouse tracking modes enabled by ENABLE_MOUSE_TRACKING. */
export declare const DISABLE_MOUSE_TRACKING: string;
//# sourceMappingURL=dec.d.ts.map