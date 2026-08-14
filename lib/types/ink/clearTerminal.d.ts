/**
 * Cross-platform terminal clearing with scrollback support.
 * Detects modern terminals that support ESC[3J for clearing scrollback.
 */
/**
 * Returns the ANSI escape sequence to blank the screen while PRESERVING the
 * scrollback (user-scrolled history).
 *
 * NOT using ESC[2J / ESC[3J: inside a DEC 2026 sync-output block (BSU/ESU)
 * Windows Terminal snaps the viewport back to the top on those sequences
 * (claude-code#35580), and dsh-tui's full resets run inside sync blocks.
 * Scrolling the content far above the viewport (CSI <n> S) blanks the
 * screen the same way — everything is pushed into the scrollback, the
 * viewport shows empty rows — without moving the viewport.
 * @returns the escape sequence that pushes content into the scrollback and homes the cursor.
 */
export declare function getClearTerminalSequence(rows?: number): string;
/**
 * Clears the terminal screen. On supported terminals, also clears scrollback.
 */
export declare const clearTerminal: string;
//# sourceMappingURL=clearTerminal.d.ts.map