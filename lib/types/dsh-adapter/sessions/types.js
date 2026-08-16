/**
 * What the TUI knows about a persisted session before opening it.
 *
 * The shape here is the whole point of this feature. The picker used to run on
 * `{ id, title, cwd, createdAt, updatedAt }`, and every defect it had was
 * downstream of that: it could not tell a delegated sub-agent run from a
 * conversation because it never carried the distinction, and it could not show
 * why a row was labelled the way it was because the label arrived without its
 * provenance. So the types below carry both — the kind as a closed sum, and
 * every derived label together with the evidence that produced it.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/types
 */
export {};
