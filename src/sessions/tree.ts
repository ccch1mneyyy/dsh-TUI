import type { SessionSummary } from '../dsh-adapter/sessions/index.js'

export interface SessionTreeRow {
  readonly session: SessionSummary
  readonly depth: number
  readonly current: boolean
}

/** Build the visible fork lineage containing `currentId`. Sub-agent runs have
 * their own `/agents` surface and are deliberately excluded. */
export function buildSessionTree(
  sessions: readonly SessionSummary[],
  currentId: string,
): readonly SessionTreeRow[] {
  const conversations = sessions.filter(session => session.kind.kind !== 'subagent')
  const byId = new Map(conversations.map(session => [session.id, session]))
  const current = byId.get(currentId)
  if (current === undefined) return []

  let root = current
  const ancestors = new Set<string>([current.id])
  while (root.kind.kind === 'fork') {
    const parent = byId.get(root.kind.parent)
    if (parent === undefined || ancestors.has(parent.id)) break
    ancestors.add(parent.id)
    root = parent
  }

  const children = new Map<string, SessionSummary[]>()
  for (const session of conversations) {
    if (session.kind.kind !== 'fork') continue
    const siblings = children.get(session.kind.parent)
    if (siblings === undefined) children.set(session.kind.parent, [session])
    else siblings.push(session)
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  const rows: SessionTreeRow[] = []
  const visited = new Set<string>()
  const visit = (session: SessionSummary, depth: number): void => {
    if (visited.has(session.id)) return
    visited.add(session.id)
    rows.push({ session, depth, current: session.id === currentId })
    for (const child of children.get(session.id) ?? []) visit(child, depth + 1)
  }
  visit(root, 0)
  return rows
}
