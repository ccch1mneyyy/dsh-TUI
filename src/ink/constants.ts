/** Shared frame interval for render throttling and animations (~60fps). */
export const FRAME_INTERVAL_MS = 16

/**
 * In-flight pty gate threshold (bytes) for scroll-drain frames — Grok
 * Build's Presenter in_flight gate. While stdout holds more unflushed
 * output than this, drain frames hold off instead of stacking latency
 * into a slow ConPTY/ssh link. Sized above one full-screen diff (~4KB at
 * 100 cols) so the gate only trips on genuine backlog, never on a single
 * in-transit frame.
 */
export const PTY_BACKLOG_BYTES = 8192
