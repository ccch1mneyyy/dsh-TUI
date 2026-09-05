import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { recordedModelRoute } from '../../modelRoute.js'
import { touchAgentViewSession, touchSession, writeResumeTarget } from '../../sessionHistory.js'
import { agentViewHasTurns } from '../agent-view.js'
import { runningPresetOf } from '../presets.js'
import { resetSessionProjection } from './session-reset.js'
import type { createChannelBinding } from './binding.js'
import type { ChannelState, ResumeResult } from './types.js'

type Binding = ReturnType<typeof createChannelBinding>
type LiveAdoptionState = Pick<
  ChannelState,
  | 'status'
  | 'agentId'
  | 'cwd'
  | 'displayCwd'
  | 'agentPreset'
  | 'provider'
  | 'model'
  | 'loadedContext'
  | 'contextWindow'
  | 'effortLevels'
  | 'reasoningEffort'
  | 'tps'
  | 'tpsSamples'
  | 'lastUsage'
  | 'workingActivity'
  | 'working'
  | 'emit'
> & Parameters<typeof resetSessionProjection>[0]

/** Adopt an already-live agent, preserving a meaningful previous handle in the background ledger. */
export function createLiveAgentAdoption(
  state: LiveAdoptionState,
  deps: {
    binding: Pick<Binding, 'switchTo'>
    backgroundHandles: Map<string, AgentHandle>
    rowIds: { value: number }
    resetProjector(): void
    resetSubagents(): void
    resetJobs(): void
    replay(events: readonly import('@deepseek-ai/dsh-session').SessionEvent[]): void
    settleReplay(): void
    describeWorkspace(cwd: string): { description?: string }
    refreshGitBranch(): void
    refreshEffortLevels(): void
    bindAgent(): void
    refreshCommands(): void
    refreshLoadedContext(): Promise<void>
    refreshSkillCommands(): Promise<void>
    clearStagedImages(): void
    notifySessionSwitched(kind: 'agent-view', sessionId: string, previousSessionId: string): void
    notifyAgentView(): void
  },
) {
  return async (target: Agent): Promise<ResumeResult> => deps.binding.switchTo(
    target,
    deps.backgroundHandles.get(String(target.id)),
    (committed, disposePrevious) => {
      const previousHandle = committed.handle
      const previousSessionId = String(committed.agent.session.id)
      deps.backgroundHandles.delete(String(target.id))
      resetSessionProjection(state, deps.rowIds, deps.resetProjector, deps.resetSubagents, deps.resetJobs)
      state.status = target.status
      state.agentId = target.id
      state.cwd = target.session.header.cwd ?? state.cwd
      state.displayCwd = deps.describeWorkspace(state.cwd).description ?? state.cwd
      deps.refreshGitBranch()
      state.agentPreset = runningPresetOf(target.session)
      const route = recordedModelRoute(target.session.events)
      if (route !== undefined) {
        state.provider = route.provider
        state.model = route.model
      }
      state.loadedContext = undefined
      state.contextWindow = undefined
      state.effortLevels = undefined
      state.reasoningEffort = undefined
      deps.refreshEffortLevels()
      deps.replay(target.session.events)
      deps.settleReplay()
      state.working = target.status === 'running'
      deps.bindAgent()
      deps.refreshCommands()
      void deps.refreshLoadedContext()
      void deps.refreshSkillCommands()
      writeResumeTarget(String(target.id))
      touchSession(target.id)
      state.emit()
      const keepPrevious = previousHandle !== undefined
        && previousHandle.agent !== target
        && (previousHandle.agent.status === 'running' || agentViewHasTurns(previousHandle.agent.session.events))
      if (previousHandle !== undefined && previousHandle.agent !== target) {
        if (keepPrevious) {
          deps.backgroundHandles.set(previousSessionId, previousHandle)
          disposePrevious('park')
        } else {
          disposePrevious('dispose')
        }
      }
      touchAgentViewSession(String(target.id))
      touchAgentViewSession(previousSessionId)
      deps.clearStagedImages()
      deps.notifySessionSwitched('agent-view', String(target.id), previousSessionId)
      deps.notifyAgentView()
      return { ok: true }
    },
  )
}
