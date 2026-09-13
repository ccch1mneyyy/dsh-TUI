/**
 * Error logger for the renderer. Always writes to stderr so a render failure
 * never passes silently.
 * @param error - The error to log; its stack trace when available.
 */
export function logError(error: unknown): void {
  const text = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`[dsh-tui] ${text}\n`)
}
