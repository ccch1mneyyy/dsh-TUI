import { EventEmitter as NodeEventEmitter } from 'events';
import { Event } from './event.js';
/**
 * Node-compatible event emitter that is aware of the `Event` class, so
 * `emit` respects `stopImmediatePropagation()` on dispatched events.
 */
export class EventEmitter extends NodeEventEmitter {
    constructor() {
        super();
        // Disable the default maxListeners warning. In React, many components
        // can legitimately listen to the same event (e.g., useInput hooks).
        // The default limit of 10 causes spurious warnings.
        this.setMaxListeners(0);
    }
    /**
     * Emit an event to all registered listeners.
     * `error` events delegate to Node's implementation; other events stop at the
     * first listener that calls `stopImmediatePropagation()` on an `Event` first
     * argument.
     * @param type - the event name.
     * @param args - arguments passed to each listener.
     * @returns true when at least one listener received the event; false when
     *   no listeners were registered, or Node's result for `error` events.
     */
    emit(type, ...args) {
        // Delegate to node for `error`, since it's not treated like a normal event
        if (type === 'error') {
            return super.emit(type, ...args);
        }
        const listeners = this.rawListeners(type);
        if (listeners.length === 0) {
            return false;
        }
        const ccEvent = args[0] instanceof Event ? args[0] : null;
        for (const listener of listeners) {
            listener.apply(this, args);
            if (ccEvent?.didStopImmediatePropagation()) {
                break;
            }
        }
        return true;
    }
}
