import React from 'react'
import type { ChannelUi } from '../../adapter/channel/ui-policy.js'
import type { SubagentState } from '../../adapter/ports/channel-view.js'

type Failure = Pick<SubagentState, 'agentId' | 'runId' | 'startedAt' | 'completedAt' | 'endedAt' | 'status' | 'error' | 'stopReason'>

/** UI acknowledgement only; a failed task remains failed in the transcript. */
const failureKey = (agent: Failure): string => JSON.stringify([
  agent.runId, agent.startedAt, agent.completedAt ?? agent.endedAt, agent.error, agent.stopReason,
])

export function subagentFailureScope(channel: Pick<ChannelUi, 'sessionRef' | 'sessionId'>): string {
  return JSON.stringify([channel.sessionRef?.backendId ?? 'dsh', channel.sessionRef?.sessionId ?? channel.sessionId])
}

export function createSubagentFailureReadStore() {
  const read = new Map<string, Map<string, string>>()
  const listeners = new Set<() => void>()
  let version = 0
  const emit = (): void => {
    version += 1
    for (const listener of [...listeners]) listener()
  }
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: (): number => version,
    unread(scope: string, agents: readonly Failure[]): ReadonlySet<string> {
      const seen = read.get(scope)
      return new Set(agents.filter(agent => agent.status === 'failed'
        && seen?.get(agent.agentId) !== failureKey(agent)).map(agent => agent.agentId))
    },
    acknowledge(scope: string, agent: Failure): void {
      if (agent.status !== 'failed') return
      const key = failureKey(agent)
      const seen = read.get(scope) ?? new Map<string, string>()
      if (seen.get(agent.agentId) === key) return
      seen.set(agent.agentId, key)
      read.set(scope, seen)
      emit()
    },
    forgetRecovered(scope: string, agents: readonly Failure[]): void {
      const seen = read.get(scope)
      if (seen === undefined) return
      let changed = false
      for (const agent of agents) {
        if (agent.status !== 'failed' && seen.delete(agent.agentId)) changed = true
      }
      if (seen.size === 0) read.delete(scope)
      if (changed) emit()
    },
  }
}

// Survives panel/scene unmounts. Cold process starts intentionally begin unread.
export const subagentFailureRead = createSubagentFailureReadStore()

export function useUnreadSubagentFailures(channel: ChannelUi): ReadonlySet<string> {
  React.useSyncExternalStore(subagentFailureRead.subscribe, subagentFailureRead.getSnapshot)
  const scope = subagentFailureScope(channel)
  const subagents = channel.subagents ?? []
  React.useEffect(() => {
    subagentFailureRead.forgetRecovered(scope, subagents)
  }, [scope, subagents, channel.version])
  return subagentFailureRead.unread(scope, subagents)
}
