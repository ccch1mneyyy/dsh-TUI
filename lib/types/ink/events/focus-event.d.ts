import { type EventTarget, TerminalEvent } from './terminal-event.js';
/**
 * Focus event for component focus changes.
 *
 * Dispatched when focus moves between elements. 'focus' fires on the
 * newly focused element, 'blur' fires on the previously focused one.
 * Both bubble, matching react-dom's use of focusin/focusout semantics
 * so parent components can observe descendant focus changes.
 */
export declare class FocusEvent extends TerminalEvent {
    /**
     * The other element involved in the focus change: the previously focused
     * element for 'focus' events, the newly focused element for 'blur' events,
     * or null when there is none.
     */
    readonly relatedTarget: EventTarget | null;
    constructor(type: 'focus' | 'blur', relatedTarget?: EventTarget | null);
}
//# sourceMappingURL=focus-event.d.ts.map