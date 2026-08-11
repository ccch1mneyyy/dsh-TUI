import { Event } from './event.js';
/**
 * Terminal paste event (bracketed-paste protocol). Not yet dispatched by the
 * ported core; declared for the event-handler props surface.
 */
export declare class PasteEvent extends Event {
    /** The pasted text content. */
    readonly data: string;
    constructor(data: string);
}
//# sourceMappingURL=paste-event.d.ts.map