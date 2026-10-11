import type { SubagentState } from '../../adapter/ports/channel-view.js'

/** UI acknowledgement survives sidebar unmounts; task outcomes remain untouched. */
type FailedRun = Pick<SubagentState, 'agentId' | 'runId' | 'status' | 'startedAt' | 'completedAt' | 'endedAt'>

type SessionState = { seen: Map<string, string> }
const sessions = new WeakMap<object, Map<string | undefined, SessionState>>()
/** Sessions this process has already cold-started, per channel. */
const coldStartedSessions = new WeakMap<object, Set<string | undefined>>()
const listeners = new Set<() => void>()
let version = 0

function stateOf(channel: object, sessionId: string | undefined): SessionState {
  let states = sessions.get(channel)
  if (states === undefined) {
    states = new Map()
    sessions.set(channel, states)
  }
  let state = states.get(sessionId)
  if (state === undefined) {
    state = { seen: new Map() }
    states.set(sessionId, state)
  }
  return state
}

function runKey(agent: FailedRun): string {
  return JSON.stringify(agent.runId ?? [agent.startedAt, agent.completedAt ?? agent.endedAt])
}

export const subagentFailureReads = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getVersion(): number { return version },
  unread(channel: object, sessionId: string | undefined, agents: readonly FailedRun[] | undefined): number {
    const state = stateOf(channel, sessionId)
    return (agents ?? []).filter(agent => agent.status === 'failed' && state.seen.get(agent.agentId) !== runKey(agent)).length
  },
  acknowledge(channel: object, sessionId: string | undefined, agents: readonly FailedRun[] | undefined): void {
    const state = stateOf(channel, sessionId)
    let changed = false
    for (const agent of agents ?? []) {
      if (agent.status !== 'failed') continue
      const key = runKey(agent)
      if (state.seen.get(agent.agentId) === key) continue
      state.seen.set(agent.agentId, key)
      changed = true
    }
    if (!changed) return
    version += 1
    for (const listener of [...listeners]) listener()
  },
  /**
   * First opening of one session in this process: its restored failures are
   * treated as read (the previous run's read state is not persisted). Each
   * session gets this once — failures that occur after the session was opened
   * are live failures and keep alerting.
   */
  coldStart(channel: object, sessionId: string | undefined, agents: readonly FailedRun[] | undefined): void {
    let started = coldStartedSessions.get(channel)
    if (started === undefined) {
      started = new Set()
      coldStartedSessions.set(channel, started)
    }
    if (started.has(sessionId)) return
    started.add(sessionId)
    this.acknowledge(channel, sessionId, agents)
  },
}
