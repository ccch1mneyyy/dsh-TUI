/**
 * Base class for events with immediate-propagation control.
 *
 * `stopImmediatePropagation()` marks the event so the emitter stops invoking
 * any further listeners for it.
 */
export declare class Event {
    private _didStopImmediatePropagation;
    /**
     * Whether `stopImmediatePropagation()` was called on this event.
     * @returns true when immediate propagation has been stopped.
     */
    didStopImmediatePropagation(): boolean;
    /**
     * Stop the emitter from invoking any further listeners for this event.
     */
    stopImmediatePropagation(): void;
}
//# sourceMappingURL=event.d.ts.map