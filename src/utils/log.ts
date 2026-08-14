/**
 * Error logger for the ported Ink core. Always writes to stderr (an Ink
 * renderer failure must never pass silently).
 * @param error - The error to log; its stack trace when available.
 */
export function logError(error: unknown): void {
  const text = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`[dsh-tui] ${text}\n`)
}
