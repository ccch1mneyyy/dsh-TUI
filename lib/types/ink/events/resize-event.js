import { Event } from './event.js';
/**
 * Terminal resize event. Not yet dispatched by the ported core; declared for
 * the event-handler props surface.
 */
export class ResizeEvent extends Event {
    columns;
    rows;
    constructor(columns, rows) {
        super();
        this.columns = columns;
        this.rows = rows;
    }
}
//# sourceMappingURL=resize-event.js.map