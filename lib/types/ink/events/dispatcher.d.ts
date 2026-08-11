import type { EventTarget, TerminalEvent } from './terminal-event.js';
type DiscreteUpdates = <A, B>(fn: (a: A, b: B) => boolean, a: A, b: B, c: undefined, d: undefined) => boolean;
/**
 * Owns event dispatch state and the capture/bubble dispatch loop.
 *
 * The reconciler host config reads currentEvent and currentUpdatePriority
 * to implement resolveUpdatePriority, resolveEventType, and
 * resolveEventTimeStamp — mirroring how react-dom's host config reads
 * ReactDOMSharedInternals and window.event.
 *
 * discreteUpdates is injected after construction (by InkReconciler)
 * to break the import cycle.
 */
export declare class Dispatcher {
    /**
     * The terminal event currently being dispatched, or null between dispatches.
     */
    currentEvent: TerminalEvent | null;
    /**
     * The update priority currently applied to updates triggered by dispatch,
     * or the default priority when none is set.
     */
    currentUpdatePriority: number;
    /**
     * The reconciler's `discreteUpdates` helper, injected after construction to
     * break the import cycle, or null before injection.
     */
    discreteUpdates: DiscreteUpdates | null;
    /**
     * Infer event priority from the currently-dispatching event.
     * Called by the reconciler host config's resolveUpdatePriority
     * when no explicit priority has been set.
     * @returns the current update priority, the dispatching event's mapped
     *   priority, or the default priority.
     */
    resolveEventPriority(): number;
    /**
     * Dispatch an event through capture and bubble phases.
     * Returns true if preventDefault() was NOT called.
     * @param target - the node the event is dispatched to.
     * @param event - the event to dispatch.
     * @returns true when `preventDefault()` was not called on the event.
     */
    dispatch(target: EventTarget, event: TerminalEvent): boolean;
    /**
     * Dispatch with discrete (sync) priority.
     * For user-initiated events: keyboard, click, focus, paste.
     * @param target - the node the event is dispatched to.
     * @param event - the event to dispatch.
     * @returns true when `preventDefault()` was not called on the event.
     */
    dispatchDiscrete(target: EventTarget, event: TerminalEvent): boolean;
    /**
     * Dispatch with continuous priority.
     * For high-frequency events: resize, scroll, mouse move.
     * @param target - the node the event is dispatched to.
     * @param event - the event to dispatch.
     * @returns true when `preventDefault()` was not called on the event.
     */
    dispatchContinuous(target: EventTarget, event: TerminalEvent): boolean;
}
export {};
//# sourceMappingURL=dispatcher.d.ts.map