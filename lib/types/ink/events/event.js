/**
 * Base class for events with immediate-propagation control.
 *
 * `stopImmediatePropagation()` marks the event so the emitter stops invoking
 * any further listeners for it.
 */
export class Event {
    _didStopImmediatePropagation = false;
    /**
     * Whether `stopImmediatePropagation()` was called on this event.
     * @returns true when immediate propagation has been stopped.
     */
    didStopImmediatePropagation() {
        return this._didStopImmediatePropagation;
    }
    /**
     * Stop the emitter from invoking any further listeners for this event.
     */
    stopImmediatePropagation() {
        this._didStopImmediatePropagation = true;
    }
}
