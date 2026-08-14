import { type ParsedKey } from '../parse-keypress.js';
import { Event } from './event.js';
/**
 * Boolean flags describing which named keys (arrows, modifiers, home/end,
 * etc.) a parsed keypress reports as pressed.
 */
export type Key = {
    upArrow: boolean;
    downArrow: boolean;
    leftArrow: boolean;
    rightArrow: boolean;
    pageDown: boolean;
    pageUp: boolean;
    wheelUp: boolean;
    wheelDown: boolean;
    home: boolean;
    end: boolean;
    return: boolean;
    escape: boolean;
    ctrl: boolean;
    shift: boolean;
    fn: boolean;
    tab: boolean;
    backspace: boolean;
    delete: boolean;
    meta: boolean;
    super: boolean;
};
/**
 * Event fired for each input chunk received from stdin (a typed character or
 * a paste), carrying the parsed key flags and the text it produced.
 */
export declare class InputEvent extends Event {
    /**
     * The raw parsed keypress this event was built from.
     */
    readonly keypress: ParsedKey;
    /**
     * Named-key flags describing which keys the keypress reports as pressed.
     */
    readonly key: Key;
    /**
     * The text input produced by this keypress ('' for non-printing keys).
     */
    readonly input: string;
    /** True when this input arrived as a bracketed paste (terminal paste —
     *  Ctrl+Shift+V / right-click) rather than typed characters. Handlers use
     *  this to insert paste content verbatim instead of treating newlines as
     *  Enter/submit. */
    readonly isPasted: boolean;
    constructor(keypress: ParsedKey);
}
//# sourceMappingURL=input-event.d.ts.map