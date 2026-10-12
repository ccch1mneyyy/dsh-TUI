import { INITIAL_POLICY_EVENTS, isHumanSource } from './fresh-agent.js'

/** Whether an inherited cut contains no human message or started turn. */
export function holdsNoConversation(events: readonly unknown[]): boolean {
  return !events.some(event => {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return false
    const { type, data } = event as Record<string, unknown>
    if (type === 'turn/start') return true
    if (type !== 'user/message' && type !== 'agent/inbox/spliced') return false
    // An unreadable conversational event cannot prove an empty cut.
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return true
    const record = data as Record<string, unknown>
    if (type === 'user/message') return isHumanSource(record.source)
    if (!Array.isArray(record.inserted)) return true
    return record.inserted.some(message => {
      if (message === null || typeof message !== 'object') return false
      const entry = message as Record<string, unknown>
      return entry.role === 'user' && isHumanSource(entry.source)
    })
  })
}

export interface PolicyFact {
  readonly type: string
  readonly data: unknown
}

/** Last value of each policy fact, ordered by its last occurrence in the cut. */
export function latestPolicyFacts(events: readonly unknown[]): readonly PolicyFact[] {
  const facts = new Map<string, PolicyFact>()
  for (const event of events) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) continue
    const { type, data } = event as Record<string, unknown>
    if (typeof type !== 'string' || !INITIAL_POLICY_EVENTS.has(type)) continue
    facts.delete(type)
    facts.set(type, { type, data })
  }
  return [...facts.values()]
}

/** Replay after creation: appending during setup prevents the fresh-session gate from arming. */
export function replayPolicyFacts(session: unknown, facts: readonly PolicyFact[]): void {
  const target = session as { append(type: string, data: unknown): unknown }
  for (const fact of facts) target.append(fact.type, fact.data)
}
