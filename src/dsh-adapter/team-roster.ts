/**
 * Read side of DSH Agent Teams: the Lead session's `agentTeam` projection
 * (saved selection + non-deleted task board, and — on older hosts — the
 * durable member roster), folded for the session on screen. Inside a
 * teammate it reads the Lead's value, found through the teammate header's
 * `parentSession` (another child of the Lead reads none on a roster host).
 *
 * Two upstream wire shapes are told apart by shape, never by version:
 *
 * - `roster` — DSH `0.2.2-rc.1` and earlier: `agentTeam` carries
 *   `{members, tasks, failure?}`. The team exists only while the bundle that
 *   mounts the service is on, so an implicit one-member team is no team.
 * - `switch` — DSH `0.2.2-rc.2` and later: `agentTeam` carries
 *   `{enabled, tasks, failure?}` and no members; the service ships in
 *   `dsh-base` and each root session saves its own selection. Members are the
 *   Lead's current subagents, supplied by the parent `subagentCatalog`
 *   projection and joined here.
 *
 * Neither package is imported: both wire values are narrowed locally.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TeamMember, TeamTask, TeamView } from '../adapter/ports/channel-view.js'
import { attachSessionProjection, createSessionProjectionStore, type SessionProjectionStore, type WatchedSession } from './session-projection-store.js'

export const TEAM_PROJECTION_KEY = 'agentTeam'

/**
 * The parent Session's direct-child catalog, and on `switch` hosts the only
 * member source. Payload version 3 rows carry the child's model-facing `name`.
 */
export const SUBAGENT_CATALOG_KEY = 'subagentCatalog'

/**
 * The upstream bundle that mounts the team service on `0.2.2-rc.1` and
 * earlier hosts: the legacy switch. `0.2.2-rc.2` retires it (the service and
 * task tools ship in `dsh-base`, switched per root session), so the name only
 * serves the old-host flows and their migration hints.
 */
export const TEAM_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile'

/** What the channel reads: the team of one session, if any. */
export interface TeamSource {
  /** The team of `sessionId` — `undefined` unless it is the session last
   *  seeded (a non-DSH session never seeds, so it never reads a stale team). */
  teamOf(sessionId: string): TeamView | undefined
  subscribe(listener: () => void): () => void
}

export type TeamRosterStore = SessionProjectionStore<TeamView> & TeamSource

/** One direct child as the parent `subagentCatalog` projection publishes it. */
export interface CatalogChild {
  readonly id: string
  /** Model-facing name (payload v3): unique among the parent's children. */
  readonly name?: string
  /** Durable creation label: what the delegation asked the child to do. */
  readonly label?: string
}

const PHASES: ReadonlySet<string> = new Set(['provisioning', 'active', 'failed'])
const TASK_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed'])
const LEAD_NAME = 'lead'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function asMember(value: unknown): TeamMember | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, role, phase, error, description } = value
  if (typeof id !== 'string' || typeof name !== 'string') return undefined
  if (role !== 'lead' && role !== 'teammate') return undefined
  if (typeof phase !== 'string' || !PHASES.has(phase)) return undefined
  return {
    id, name, role, phase: phase as TeamMember['phase'],
    ...typeof description === 'string' && description !== '' ? { description } : {},
    ...typeof error === 'string' ? { error } : {},
  }
}

function asTask(value: unknown): TeamTask | undefined {
  if (!isRecord(value)) return undefined
  const { id, revision, subject, description, status, blockedBy, writeScopes, ownerName, owner, ready, writeScopeWarnings } = value
  if (typeof id !== 'string' || typeof revision !== 'number' || typeof subject !== 'string' || typeof description !== 'string') return undefined
  if (typeof status !== 'string' || !TASK_STATUSES.has(status)) return undefined
  if (!isStringArray(blockedBy) || !isStringArray(writeScopes) || !isStringArray(writeScopeWarnings) || typeof ready !== 'boolean') return undefined
  const ownerLabel = typeof ownerName === 'string' ? ownerName : typeof owner === 'string' ? owner : undefined
  return {
    id, revision, subject, description, status: status as TeamTask['status'], blockedBy, writeScopes, ready, writeScopeWarnings,
    ...ownerLabel === undefined ? {} : { ownerName: ownerLabel },
  }
}

/** Narrow one parent catalog wire value; absent/malformed rows are skipped. */
function asCatalog(value: unknown): readonly CatalogChild[] | undefined {
  if (!Array.isArray(value)) return undefined
  const children: CatalogChild[] = []
  for (const row of value) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id === '') continue
    const name = typeof row.name === 'string' && row.name !== '' ? row.name : undefined
    const label = typeof row.label === 'string' && row.label !== '' ? row.label : undefined
    children.push({ id: row.id, ...name === undefined ? {} : { name }, ...label === undefined ? {} : { label } })
  }
  return children
}

/**
 * The Lead plus its named current subagents: what a `switch` host means by
 * "team". The root is always `lead`; unnamed historical children cannot be
 * addressed by name, so they stay out of the roster (the agents surface still
 * lists their subagent rows under the remaining children).
 * @param leadSessionId - Root Session id the `agentTeam` value belongs to.
 * @param catalog - The root's direct-child catalog rows, if read yet.
 */
function membersFromCatalog(leadSessionId: string, catalog: readonly CatalogChild[] | undefined): TeamMember[] {
  const members: TeamMember[] = [{ id: leadSessionId, name: LEAD_NAME, role: 'lead', phase: 'active' }]
  const seen = new Set([leadSessionId])
  for (const child of catalog ?? []) {
    if (child.name === undefined || child.name === LEAD_NAME || seen.has(child.id)) continue
    seen.add(child.id)
    members.push({
      id: child.id, name: child.name, role: 'teammate', phase: 'active',
      ...child.label === undefined ? {} : { description: child.label },
    })
  }
  return members
}

/** The durable-roster wire (`0.2.2-rc.1` and earlier). */
function asRosterTeamView(value: Record<string, unknown>, leadSessionId: string): TeamView | undefined {
  if (!Array.isArray(value.tasks)) return undefined
  const members = value.members as unknown[]
  const roster = members.map(asMember)
  const tasks = (value.tasks as unknown[]).map(asTask)
  if (roster.includes(undefined) || tasks.includes(undefined)) return undefined
  const failure = typeof value.failure === 'string' ? value.failure : undefined
  const rows = roster as TeamMember[]
  const board = tasks as TeamTask[]
  if (!rows.some(member => member.role === 'teammate') && board.length === 0 && failure === undefined) return undefined
  return { leadSessionId, mode: 'roster', enabled: true, members: rows, tasks: board, ...failure === undefined ? {} : { failure } }
}

/** The per-session selection wire (`0.2.2-rc.2` and later). */
function asSwitchTeamView(value: Record<string, unknown>, leadSessionId: string, catalog: readonly CatalogChild[] | undefined): TeamView | undefined {
  if (typeof value.enabled !== 'boolean' || !Array.isArray(value.tasks)) return undefined
  const tasks = (value.tasks as unknown[]).map(asTask)
  if (tasks.includes(undefined)) return undefined
  const failure = typeof value.failure === 'string' ? value.failure : undefined
  const board = tasks as TeamTask[]
  // A root that never selected the team and has no record reads as none; a
  // disabled root that still keeps its board is shown read-only.
  if (!value.enabled && board.length === 0 && failure === undefined) return undefined
  return {
    leadSessionId, mode: 'switch', enabled: value.enabled,
    members: membersFromCatalog(leadSessionId, catalog), tasks: board,
    ...failure === undefined ? {} : { failure },
  }
}

/**
 * Narrow one `agentTeam` value into the view the UI renders. Both upstream
 * shapes are told apart by the value itself; a session's implicit team (the
 * Lead alone, no task, no failure) is no team on a roster host, while a
 * `switch` host publishes the saved selection.
 * @param value - Raw projection value.
 * @param leadSessionId - The session the value was published for.
 * @param catalog - The Lead's direct-child catalog (a `switch` host's member source).
 * @returns the team view, or `undefined` when there is nothing to show.
 */
export function asTeamView(value: unknown, leadSessionId: string, catalog?: readonly CatalogChild[]): TeamView | undefined {
  if (!isRecord(value)) return undefined
  if (Array.isArray(value.members)) return asRosterTeamView(value, leadSessionId)
  return asSwitchTeamView(value, leadSessionId, catalog)
}

interface SessionLike {
  readonly id: unknown
  readonly header?: { readonly origin?: unknown; readonly parentSession?: unknown }
}

interface AgentsLike {
  list(): Iterable<{ readonly session: { readonly id: unknown } }>
}

/**
 * The team a bound session belongs to is rooted at its top-level ancestor:
 * the Lead itself, or — for a delegated child — the root its creator chain
 * reaches. On a roster host teammates are direct children of the Lead; a
 * `switch` host can nest deeper. Loaded ancestors are followed by identity;
 * one that is gone stops the walk at its recorded parent id (the value there
 * is likely absent, which reads as no team rather than a stale one).
 * @param session - The bound session.
 * @param agents - Live agents, used to find loaded ancestors for traversal and baseline snapshots.
 * @returns the session whose `agentTeam` value to read.
 */
export function teamRootOf(session: unknown, agents: AgentsLike | undefined): WatchedSession {
  const own = session as SessionLike
  if (own.header?.origin !== 'subagent') return { id: String(own.id), session }
  const loaded = new Map<string, unknown>()
  for (const agent of agents?.list() ?? []) loaded.set(String(agent.session.id), agent.session)
  const seen = new Set<string>()
  let current: SessionLike = own
  let currentSession: unknown = session
  for (;;) {
    const parent = current.header?.parentSession
    if (typeof parent !== 'string' || parent === '' || seen.has(parent)) break
    seen.add(parent)
    const ancestor = loaded.get(parent)
    if (ancestor === undefined) return { id: parent }
    const next = ancestor as SessionLike
    if (next.header?.origin !== 'subagent') return { id: parent, session: ancestor }
    current = next
    currentSession = ancestor
  }
  return { id: String(current.id), session: currentSession }
}

/**
 * The watched team as seen from `sessionId`: the Lead's own, or — on a
 * roster host — a listed teammate's. A `switch` host's tree is the team, so
 * any session watched at that Lead reads it. Any other child of a roster
 * host's Lead (a plain subagent, a workflow spawn) belongs to no team.
 * @param team - The watched session's team.
 * @param sessionId - The bound session.
 * @returns the team, or `undefined` when the session is not on it.
 */
export function teamFor(team: TeamView | undefined, sessionId: string): TeamView | undefined {
  if (team === undefined || team.leadSessionId === sessionId) return team
  if (team.mode === 'switch') return team
  return team.members.some(member => member.role === 'teammate' && member.id === sessionId) ? team : undefined
}

/**
 * Create the composition root's team store and wire it to the host.
 * @param ctx - Host context of the composition root.
 * @returns the store the channel reads from.
 */
export function createTeamRosterStore(ctx: Context): TeamRosterStore {
  const agents = (): AgentsLike | undefined => ctx.get('agents') as AgentsLike | undefined
  const watch = (session: unknown): WatchedSession => teamRootOf(session, agents())
  // The member source of a `switch` host, watched at the same root as the team.
  const catalogStore = createSessionProjectionStore<readonly CatalogChild[]>({
    key: SUBAGENT_CATALOG_KEY,
    narrow: asCatalog,
    watch,
    warn: message => { ctx.logger.warn(message) },
  })
  const store = createSessionProjectionStore<TeamView>({
    key: TEAM_PROJECTION_KEY,
    // A team bundle switched off at run time takes the service down before
    // (or while) its projection definition leaves: no service, no team.
    narrow: (value, leadSessionId) => (ctx.get('agentTeams', false) === undefined
      ? undefined
      : asTeamView(value, leadSessionId, catalogStore.read())),
    watch,
    warn: message => { ctx.logger.warn(message) },
  })
  // The catalog arrives after (or before) the team wire, and either change
  // recomposes the members a `switch` host renders: re-narrow on every move.
  catalogStore.subscribe(() => { store.reseed() })
  // Attached in this order so the team feed stays the last listener on a
  // single-listener registry (the order the pre-switch store wired itself in).
  attachSessionProjection(ctx, SUBAGENT_CATALOG_KEY, catalogStore as SessionProjectionStore<unknown>)
  attachSessionProjection(ctx, TEAM_PROJECTION_KEY, store as SessionProjectionStore<unknown>)
  // The plugin manager announces every profile write it applied (`/team`,
  // `/plugin`, the Web UI). Unregistering a projection emits nothing on the
  // change feed, so the bound session is read again: an unmounted team clears
  // the view, a remounted one comes back from the Lead's log.
  ctx.on('plugin-manager/changed', () => { store.reseed() })
  // Not every service change is announced there (an HMR-applied CLI or hand
  // edit, a late or recovered activation), and the narrow reads the service:
  // follow it directly. A service that comes back before its projection
  // definition reads absent here; the manager event above reads it again.
  ctx.on('internal/service' as never, ((name: unknown) => {
    if (name === 'agentTeams') store.reseed()
  }) as never)
  // Seeding the bound session fills both watches at once: the channel binds
  // the team, and the catalog that supplies its members follows the same root.
  const seed = store.seed
  return Object.assign(store, {
    seed(session: unknown) {
      catalogStore.seed(session)
      seed(session)
    },
    teamOf: (sessionId: string) => (store.boundId === sessionId ? teamFor(store.read(), sessionId) : undefined),
  })
}
