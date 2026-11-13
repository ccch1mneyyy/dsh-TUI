/**
 * Agent Teams in the agents surfaces (issue #1241, phase 2): fold the
 * session's `TeamView` and its subagent rows into what the dashboard
 * renders. Both upstream shapes arrive as the same `TeamView`: a legacy
 * roster wire's durable members, or the `0.2.2-rc.2` selection wire's Lead
 * plus named subagents composed in `team-roster.ts`. A teammate is a
 * continuable subagent of the Lead whose row id is the member id, so the two
 * join by id; neither side overwrites the other's state (see
 * `teamMemberStatus`). Pure: no I/O, no backend import.
 */
import type { TeamMember, TeamTask, TeamView } from '../adapter/ports/channel-view.js'
import type { SubagentState } from '../dsh-adapter/subagents.js'

/** A member's state as shown: durable `phase` first, then the run. `active`
 *  is an active member whose run this session cannot see (a teammate's own
 *  subagent rows never hold its siblings). */
export type TeamMemberStatus = 'provisioning' | 'running' | 'idle' | 'active' | 'failed'

/** One teammate, with its subagent row once the host has announced it. */
export interface TeamMemberRow {
  readonly member: TeamMember
  readonly subagent?: SubagentState
  readonly status: TeamMemberStatus
}

export interface TeamDashboardModel {
  readonly lead?: TeamMember
  /** Whether the session on screen is the Lead (its subagent rows are the teammates). */
  readonly viewedFromLead: boolean
  readonly teammates: readonly TeamMemberRow[]
  /** Subagent rows that are not team members (workflow / ralph spawns). */
  readonly others: readonly SubagentState[]
}

/**
 * A member's shown state. A failed `phase` is durable and wins; provisioning
 * has no run yet. An active member is running only while its row runs: a
 * finished turn leaves the member alive and waiting (a message wakes it),
 * so a completed — or failed, or absent — run reads as idle, never done.
 * @param member - Roster row.
 * @param subagent - The member's subagent row, if any.
 * @param runKnown - Whether the subagent rows are the Lead's (default).
 * @returns the state to render.
 */
export function teamMemberStatus(member: TeamMember, subagent: SubagentState | undefined, runKnown = true): TeamMemberStatus {
  if (member.phase === 'failed') return 'failed'
  if (member.phase === 'provisioning') return 'provisioning'
  if (!runKnown) return 'active'
  return subagent?.status === 'running' || subagent?.status === 'starting' ? 'running' : 'idle'
}

/**
 * Join the roster with the subagent rows.
 * @param team - The session's team.
 * @param subagents - The session's subagent rows.
 * @param sessionId - The session on screen; inside a teammate its rows are
 *   its own children, never joined with the roster.
 * @returns the Lead, teammates in roster order, and the remaining rows.
 */
export function teamDashboardModel(team: TeamView, subagents: readonly SubagentState[], sessionId?: string): TeamDashboardModel {
  const viewedFromLead = sessionId === undefined || sessionId === team.leadSessionId
  const byId = new Map<string, SubagentState>()
  if (viewedFromLead) for (const row of subagents) byId.set(row.agentId, row)
  const teammates: TeamMemberRow[] = []
  const memberIds = new Set<string>()
  for (const member of team.members) {
    if (member.role !== 'teammate') continue
    const subagent = byId.get(member.id)
    if (subagent !== undefined) memberIds.add(member.id)
    teammates.push({ member, status: teamMemberStatus(member, subagent, viewedFromLead), ...subagent === undefined ? {} : { subagent } })
  }
  const lead = team.members.find(member => member.role === 'lead')
  return {
    ...lead === undefined ? {} : { lead },
    viewedFromLead,
    teammates,
    others: subagents.filter(row => !memberIds.has(row.agentId)),
  }
}

/**
 * Teammates on the roster: those known to be running or provisioning, and
 * those that may be running. Inside a teammate a sibling's run is not
 * visible, so an active sibling is `unseen`; the teammate on screen itself
 * counts in neither.
 * @param team - The session's team.
 * @param subagents - The session's subagent rows.
 * @param sessionId - The session on screen.
 * @returns the three counts.
 */
export function teamMemberCounts(team: TeamView, subagents: readonly SubagentState[], sessionId?: string): { readonly total: number; readonly active: number; readonly unseen: number } {
  const { teammates } = teamDashboardModel(team, subagents, sessionId)
  const counted = teammates.filter(row => row.member.id !== sessionId)
  return {
    total: teammates.length,
    active: counted.filter(row => row.status === 'running' || row.status === 'provisioning').length,
    unseen: counted.filter(row => row.status === 'active').length,
  }
}

/** Completed / total of the task board. */
export function teamTaskProgress(tasks: readonly TeamTask[]): { readonly completed: number; readonly total: number } {
  return { completed: tasks.filter(task => task.status === 'completed').length, total: tasks.length }
}

/** A pending task some blocker still holds back. */
export function isTeamTaskBlocked(task: TeamTask): boolean {
  return task.status === 'pending' && !task.ready
}
