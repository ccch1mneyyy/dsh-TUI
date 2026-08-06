import { Event } from './event.js';
/**
 * Event fired when the terminal window gains or loses focus.
 *
 * Uses DECSET 1004 focus reporting - the terminal sends:
 * - CSI I (\x1b[I) when the terminal gains focus
 * - CSI O (\x1b[O) when the terminal loses focus
 */
export class TerminalFocusEvent extends Event {
    type;
    constructor(type) {
        super();
        this.type = type;
    }
}
//# sourceMappingURL=terminal-focus-event.js.map