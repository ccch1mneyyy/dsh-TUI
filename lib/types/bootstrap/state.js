/**
 * Interaction-time telemetry stubs consumed by the ported Ink core
 * (ink/ink.tsx, ink/components/App.tsx, ink/components/ScrollBox.tsx). The
 * original functions fed Claude Code's session-activity tracking; cc-tui does
 * not track interaction time.
 */
/** No-op interaction-time flush stub; cc-tui does not track interaction time. */
export function flushInteractionTime() { }
/** No-op interaction-time update stub; cc-tui does not track interaction time. */
export function updateLastInteractionTime() { }
/** No-op scroll-activity stub; cc-tui does not track interaction time. */
export function markScrollActivity() { }
//# sourceMappingURL=state.js.map