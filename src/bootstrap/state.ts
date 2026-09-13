/**
 * Interaction-time telemetry stubs used by the renderer's input and scroll
 * paths. dsh-tui does not track interaction time, so these hooks are no-ops.
 */
/** No-op interaction-time flush stub; dsh-tui does not track interaction time. */
export function flushInteractionTime(): void {}

/** No-op interaction-time update stub; dsh-tui does not track interaction time. */
export function updateLastInteractionTime(): void {}

/** No-op scroll-activity stub; dsh-tui does not track interaction time. */
export function markScrollActivity(): void {}
