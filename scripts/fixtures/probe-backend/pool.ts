/**
 * The probe backend's process-wide pool ledger (F-1 fixture).
 *
 * Deliberately a **separate module** from `index.ts`: the gate has to read
 * "was this backend's module ever imported, and was its pool closed?" *without*
 * importing the backend module — reading a counter is not loading a backend.
 * Importing this file has no effect of its own.
 *
 * The pool it stands for is the real thing codex has (`closeAllCodexHubs`): a
 * process-wide resource keyed by nothing session-specific, which no session's
 * `dispose()` can own, so the registry books it and the one exit funnel closes it
 * (P0 D4).
 */
let opens = 0
let closes = 0

/** Called at `index.ts` module evaluation: importing the backend module is what
 *  opens the pool it stands for. */
export function notePoolOpen(): void {
  opens += 1
}

/** Called by `index.ts`'s exported `closeProbePool` (the manifest's
 *  `unloadExport`), which the registry calls only for entries it loaded. */
export function notePoolClose(): void {
  closes += 1
}

/** What the gate reads: how many times the backend module was evaluated, and how
 *  many times its pool was closed. */
export function probePoolState(): { readonly opens: number; readonly closes: number } {
  return { opens, closes }
}
