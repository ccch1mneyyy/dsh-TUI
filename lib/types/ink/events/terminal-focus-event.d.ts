import { Event } from './event.js';
/**
 * The focus change kind: 'terminalfocus' when the terminal gains focus,
 * 'terminalblur' when it loses focus.
 */
export type TerminalFocusEventType = 'terminalfocus' | 'terminalblur';
/**
 * Event fired when the terminal window gains or loses focus.
 *
 * Uses DECSET 1004 focus reporting - the terminal sends:
 * - CSI I (\x1b[I) when the terminal gains focus
 * - CSI O (\x1b[O) when the terminal loses focus
 */
export declare class TerminalFocusEvent extends Event {
    /**
     * The focus change kind, 'terminalfocus' or 'terminalblur'.
     */
    readonly type: TerminalFocusEventType;
    constructor(type: TerminalFocusEventType);
}
//# sourceMappingURL=terminal-focus-event.d.ts.map