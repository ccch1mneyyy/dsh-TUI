import { EventEmitter as NodeEventEmitter } from 'events';
/**
 * Node-compatible event emitter that is aware of the `Event` class, so
 * `emit` respects `stopImmediatePropagation()` on dispatched events.
 */
export declare class EventEmitter extends NodeEventEmitter {
    constructor();
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
    emit(type: string | symbol, ...args: unknown[]): boolean;
}
//# sourceMappingURL=emitter.d.ts.map