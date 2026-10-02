/**
 * Lineage decision consulted by `/model` only.
 *
 * `/rewind`, `/fork` and the `/tree` branch also re-create the live session as
 * a child, but they always record `parentSession` and do not call this
 * helper. A blank log cannot reach them (`boundary < 0`). This module is not
 * their gate.
 *
 * The decision is load-bearing beyond grouping. Upstream's automatic session
 * title only ever runs on a session WITHOUT a parent: `dsh-session-title`
 * schedules its provider on the first human message under
 * `session.header.parentSession === undefined`, and a session that already has
 * one is never offered a generated title again — a fork keeps the title it
 * inherited, and only an explicit `ctx.sessionTitle.refresh()` retries, which
 * no TUI surface calls. A route switch on a session nobody has typed into
 * would therefore cost that user the title of their first real prompt, leaving
 * the deterministic fallback instead (a mid-word truncation of the prompt at
 * `fallbackMaxBytes`).
 *
 * A session with no human message has no conversation for the lineage to
 * describe, so its replacement stands as its own root. The seeded prefix is
 * unaffected either way: the child still inherits the source's session
 * scaffolding verbatim.
 *
 * @module
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Whether a re-created child must record the session it replaces as its parent.
 *
 * A `user/message` whose `source` is the person at the keyboard is a human turn
 * whether or not it carries text (an image-only prompt is still a prompt), so
 * its session is a conversation the lineage must describe. A user-role message
 * from any other producer — a plugin injection, an instruction snapshot, a
 * skill catalogue — is not: the child stays in the same family rather than
 * being promoted to a root on a technicality.
 *
 * @param seed - the exact events the child inherits.
 * @returns whether the child records `parentSession`.
 */
export function childRecordsLineage(seed: readonly SessionEvent[]): boolean {
  return seed.some(isHumanMessage)
}

/** One message the person at the keyboard sent, by `source.kind` alone. */
function isHumanMessage(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  // Durable data: the source is a merge-extensible sum type whose members are
  // declared by their producers, so narrow instead of trusting the union.
  const source = (event.data as { readonly source?: { readonly kind?: unknown } }).source
  return source?.kind === 'user'
}
