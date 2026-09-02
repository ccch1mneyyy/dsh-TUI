/** Shared frame interval for render throttling and animations (~60fps). */
export const FRAME_INTERVAL_MS = 16

/**
 * Backoff ladder for the scroll-drain re-probe while stdout is
 * backpressured: the stream's own 'drain' event is the fast path; this
 * bounded fallback (250ms → 500ms → 1s) covers streams that never emit it.
 * Deliberately far from a busy loop — each fire re-checks the backlog, so a
 * drained stream resumes at the normal quarter-interval cadence on the next
 * cycle.
 */
export const DRAIN_BACKOFF_BASE_MS = 250
export const DRAIN_BACKOFF_MAX_MS = 1000

/**
 * In-flight pty gate threshold (bytes) for scroll-drain frames — Grok
 * Build's Presenter in_flight gate. While stdout holds more unflushed
 * output than this, drain frames hold off instead of stacking latency
 * into a slow ConPTY/ssh link. Sized above one full-screen diff (~4KB at
 * 100 cols) so the gate only trips on genuine backlog, never on a single
 * in-transit frame.
 */
export const PTY_BACKLOG_BYTES = 8192
