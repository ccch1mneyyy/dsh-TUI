/**
 * Interaction-time telemetry compatibility exports retained at the bootstrap
 * boundary. The pi-tui surface does not collect interaction time, so all
 * three hooks are deliberate no-ops.
 */
/** No-op interaction-time flush stub; dsh-tui does not track interaction time. */
export function flushInteractionTime(): void {}

/** No-op interaction-time update stub; dsh-tui does not track interaction time. */
export function updateLastInteractionTime(): void {}

/** No-op scroll-activity stub; dsh-tui does not track interaction time. */
export function markScrollActivity(): void {}
