import { Event } from './event.js'

/**
 * Terminal resize event. Not yet dispatched by the ported core; declared for
 * the event-handler props surface.
 */
export class ResizeEvent extends Event {
  /** The new terminal width in columns. */
  readonly columns: number
  /** The new terminal height in rows. */
  readonly rows: number
  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }
}
