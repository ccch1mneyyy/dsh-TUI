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
 * Resolve the effective `ctrl` flag for a keypress with OS adaptation.
 *
 * On macOS with extended key reporting (Kitty protocol / modifyOtherKeys),
 * Cmd-qualified shortcuts are what `key.ctrl` bindings should respond to:
 * Cmd arrives as `super: true` while bare Ctrl keeps its literal meaning.
 * Outside that combination (non-macOS, or a terminal that never forwards
 * Cmd), Ctrl stays the trigger so shortcuts remain reachable — Terminal.app
 * and default iTerm2 do not deliver Cmd to the application at all.
 *
 * macOS keyboard-convention exceptions (muscle memory must not be violated):
 *   - Reserved letters/arrows (CMD_RESERVED_KEYS) keep bare-Ctrl semantics
 *     only; ⌘ does nothing there (e.g. ⌘C is handled by Chat as
 *     copy-the-selection, never the interrupt path).
 *   - `d`: Ctrl+D stays dual-triggered (Ctrl OR Cmd) as the exit hatch;
 *     mapping it Cmd-only would strand users without a way out.
 *
 * Platform/capability inputs are parameters so regressions can exercise
 * every branch deterministically.
 */
export declare function resolveCtrlFlag(name: string | undefined, ctrl: boolean, superKey: boolean, isMac?: boolean, extendedKeys?: boolean): boolean;
/**
 * macOS text-editing convention: ⌘←/⌘→ move to the start/end of the line
 * (the Home/End meaning), not a word jump. Returns which named-key flag the
 * Cmd-qualified arrow should carry, or null when the keypress keeps its
 * literal meaning. Inputs are parameters for deterministic regressions.
 */
export declare function resolveCmdHomeEnd(name: string | undefined, superKey: boolean, isMac?: boolean, extendedKeys?: boolean): 'home' | 'end' | null;
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