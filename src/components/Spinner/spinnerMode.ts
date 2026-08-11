/**
 * Spinner presentation phase: the stage of the current turn the spinner
 * should convey.
 */
export type SpinnerMode =
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'tool-use'
  | 'tool-input'
