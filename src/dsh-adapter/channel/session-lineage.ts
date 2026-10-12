/**
 * `/model` records lineage only for a conversation. Policy-only cuts start
 * unseeded, so their first human prompt remains eligible for an automatic title.
 * Rewind and tree actions decide their own parentSession from the inherited cut.
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
