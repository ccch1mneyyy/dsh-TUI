import { Event } from './event.js';
type EventPhase = 'none' | 'capturing' | 'at_target' | 'bubbling';
type TerminalEventInit = {
    bubbles?: boolean;
    cancelable?: boolean;
};
/**
 * Base class for all terminal events with DOM-style propagation.
 *
 * Extends Event so existing event types (ClickEvent, InputEvent,
 * TerminalFocusEvent) share a common ancestor and can migrate later.
 *
 * Mirrors the browser's Event API: target, currentTarget, eventPhase,
 * stopPropagation(), preventDefault(), timeStamp.
 */
export declare class TerminalEvent extends Event {
    /**
     * The event type name, e.g. 'keydown', 'focus', or 'resize'.
     */
    readonly type: string;
    /**
     * The time the event was created, in milliseconds via `performance.now()`.
     */
    readonly timeStamp: number;
    /**
     * Whether the event bubbles from the target up through its ancestors.
     */
    readonly bubbles: boolean;
    /**
     * Whether `preventDefault()` can cancel the event's default behavior.
     */
    readonly cancelable: boolean;
    private _target;
    private _currentTarget;
    private _eventPhase;
    private _propagationStopped;
    private _defaultPrevented;
    constructor(type: string, init?: TerminalEventInit);
    /**
     * The node the event was dispatched to, or null before and after dispatch.
     */
    get target(): EventTarget | null;
    /**
     * The node whose listener is currently running, or null outside dispatch.
     */
    get currentTarget(): EventTarget | null;
    /**
     * The current propagation phase: 'none', 'capturing', 'at_target', or 'bubbling'.
     */
    get eventPhase(): EventPhase;
    /**
     * Whether `preventDefault()` was called on this event.
     */
    get defaultPrevented(): boolean;
    /**
     * Stop the event from reaching listeners on any further nodes; listeners on
     * the current node still run.
     */
    stopPropagation(): void;
    stopImmediatePropagation(): void;
    /**
     * Cancel the event's default behavior when the event is cancelable.
     */
    preventDefault(): void;
    /**
     * Set the node the event was dispatched to. Used by the dispatcher.
     * @internal
     * @param target - the dispatch target node.
     */
    _setTarget(target: EventTarget): void;
    /**
     * Set the node whose listener is currently running. Used by the dispatcher.
     * @internal
     * @param target - the current target node, or null outside dispatch.
     */
    _setCurrentTarget(target: EventTarget | null): void;
    /**
     * Set the current propagation phase. Used by the dispatcher.
     * @internal
     * @param phase - the phase to record.
     */
    _setEventPhase(phase: EventPhase): void;
    /**
     * Whether `stopPropagation()` was called on this event. Used by the dispatcher.
     * @internal
     * @returns true when propagation has been stopped.
     */
    _isPropagationStopped(): boolean;
    /**
     * Whether `stopImmediatePropagation()` was called on this event. Used by the
     * dispatcher.
     * @internal
     * @returns true when immediate propagation has been stopped.
     */
    _isImmediatePropagationStopped(): boolean;
    /**
     * Hook for subclasses to do per-node setup before each handler fires.
     * Default is a no-op.
     * @param _target - the node the next listener belongs to.
     */
    _prepareForTarget(_target: EventTarget): void;
}
/**
 * A node in the component tree that can receive events: its parent node and
 * its per-event-type handler maps.
 */
export type EventTarget = {
    parentNode: EventTarget | undefined;
    _eventHandlers?: Record<string, unknown>;
};
export {};
//# sourceMappingURL=terminal-event.d.ts.map