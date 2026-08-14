import { Event } from './event.js';
/**
 * Base class for all terminal events with DOM-style propagation.
 *
 * Extends Event so existing event types (ClickEvent, InputEvent,
 * TerminalFocusEvent) share a common ancestor and can migrate later.
 *
 * Mirrors the browser's Event API: target, currentTarget, eventPhase,
 * stopPropagation(), preventDefault(), timeStamp.
 */
export class TerminalEvent extends Event {
    /**
     * The event type name, e.g. 'keydown', 'focus', or 'resize'.
     */
    type;
    /**
     * The time the event was created, in milliseconds via `performance.now()`.
     */
    timeStamp;
    /**
     * Whether the event bubbles from the target up through its ancestors.
     */
    bubbles;
    /**
     * Whether `preventDefault()` can cancel the event's default behavior.
     */
    cancelable;
    _target = null;
    _currentTarget = null;
    _eventPhase = 'none';
    _propagationStopped = false;
    _defaultPrevented = false;
    constructor(type, init) {
        super();
        this.type = type;
        this.timeStamp = performance.now();
        this.bubbles = init?.bubbles ?? true;
        this.cancelable = init?.cancelable ?? true;
    }
    /**
     * The node the event was dispatched to, or null before and after dispatch.
     */
    get target() {
        return this._target;
    }
    /**
     * The node whose listener is currently running, or null outside dispatch.
     */
    get currentTarget() {
        return this._currentTarget;
    }
    /**
     * The current propagation phase: 'none', 'capturing', 'at_target', or 'bubbling'.
     */
    get eventPhase() {
        return this._eventPhase;
    }
    /**
     * Whether `preventDefault()` was called on this event.
     */
    get defaultPrevented() {
        return this._defaultPrevented;
    }
    /**
     * Stop the event from reaching listeners on any further nodes; listeners on
     * the current node still run.
     */
    stopPropagation() {
        this._propagationStopped = true;
    }
    stopImmediatePropagation() {
        super.stopImmediatePropagation();
        this._propagationStopped = true;
    }
    /**
     * Cancel the event's default behavior when the event is cancelable.
     */
    preventDefault() {
        if (this.cancelable) {
            this._defaultPrevented = true;
        }
    }
    // -- Internal setters used by the Dispatcher
    /**
     * Set the node the event was dispatched to. Used by the dispatcher.
     * @internal
     * @param target - the dispatch target node.
     */
    _setTarget(target) {
        this._target = target;
    }
    /**
     * Set the node whose listener is currently running. Used by the dispatcher.
     * @internal
     * @param target - the current target node, or null outside dispatch.
     */
    _setCurrentTarget(target) {
        this._currentTarget = target;
    }
    /**
     * Set the current propagation phase. Used by the dispatcher.
     * @internal
     * @param phase - the phase to record.
     */
    _setEventPhase(phase) {
        this._eventPhase = phase;
    }
    /**
     * Whether `stopPropagation()` was called on this event. Used by the dispatcher.
     * @internal
     * @returns true when propagation has been stopped.
     */
    _isPropagationStopped() {
        return this._propagationStopped;
    }
    /**
     * Whether `stopImmediatePropagation()` was called on this event. Used by the
     * dispatcher.
     * @internal
     * @returns true when immediate propagation has been stopped.
     */
    _isImmediatePropagationStopped() {
        return this.didStopImmediatePropagation();
    }
    /**
     * Hook for subclasses to do per-node setup before each handler fires.
     * Default is a no-op.
     * @param _target - the node the next listener belongs to.
     */
    _prepareForTarget(_target) { }
}
