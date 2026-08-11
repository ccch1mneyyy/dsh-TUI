import type { ParsedKey } from '../parse-keypress.js';
import { TerminalEvent } from './terminal-event.js';
/**
 * Keyboard event dispatched through the DOM tree via capture/bubble.
 *
 * Follows browser KeyboardEvent semantics: `key` is the literal character
 * for printable keys ('a', '3', ' ', '/') and a multi-char name for
 * special keys ('down', 'return', 'escape', 'f1'). The idiomatic
 * printable-char check is `e.key.length === 1`.
 */
export declare class KeyboardEvent extends TerminalEvent {
    /**
     * The pressed key: the literal character for printable keys ('a', '3', ' '),
     * a multi-char name for special keys ('down', 'return', 'escape', 'f1').
     */
    readonly key: string;
    /**
     * Whether the Ctrl modifier was held.
     */
    readonly ctrl: boolean;
    /**
     * Whether the Shift modifier was held.
     */
    readonly shift: boolean;
    /**
     * Whether the Meta (Alt/Option) modifier was held.
     */
    readonly meta: boolean;
    /**
     * Whether the Super (Cmd/Win) modifier was held; only reported by the kitty
     * keyboard protocol.
     */
    readonly superKey: boolean;
    /**
     * Whether the Fn modifier was held.
     */
    readonly fn: boolean;
    constructor(parsedKey: ParsedKey);
}
//# sourceMappingURL=keyboard-event.d.ts.map