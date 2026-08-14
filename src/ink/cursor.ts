/**
 * Cursor position within a frame. The original module lived outside the
 * published ink tree; only the shape below is consumed (log-update.ts walks
 * cursor.x/y/visible while diffing frames).
 */
export interface Cursor {
  x: number
  y: number
  visible: boolean
}
