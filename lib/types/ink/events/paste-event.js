import { Event } from './event.js';
/**
 * Terminal paste event (bracketed-paste protocol). Not yet dispatched by the
 * ported core; declared for the event-handler props surface.
 */
export class PasteEvent extends Event {
    /** The pasted text content. */
    data;
    constructor(data) {
        super();
        this.data = data;
    }
}
