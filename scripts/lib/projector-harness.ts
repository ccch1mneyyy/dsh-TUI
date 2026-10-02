/**
 * Minimal shared-projector harness for translator gates: a fresh channel view
 * (`createInitialChannelView`) plus recording projector deps, so a script can
 * fold translated `AgentEvent`s through the ONE production reducer
 * (`src/channel/projection.ts`) and inspect the resulting rows/state without
 * mounting a channel. The golden pipeline keeps its own richer harness
 * (scripts/lib/projection-golden.ts); this one is for focused assertions.
 *
 * Import from TypeScript scripts run with `node --import tsx/esm`.
 */
import type { AgentEvent } from '../../src/agent/events.js'
import { createChannelProjection } from '../../src/channel/projection.js'
import { createInitialChannelView } from '../../src/dsh-adapter/channel/state.js'

type ProjectionArgs = Parameters<typeof createChannelProjection>

export interface ProjectorHarness {
  readonly state: ProjectionArgs[0]
  readonly projector: ReturnType<typeof createChannelProjection>
  readonly notices: string[]
  /** Fold one live batch (or a replay batch with `replay: true`). */
  apply(events: readonly AgentEvent[], replay?: boolean): void
}

export function createProjectorHarness(options: { agentPreset?: string; thinkingFold?: 'preview' | 'full'; model?: string } = {}): ProjectorHarness {
  const view = createInitialChannelView(
    { model: options.model ?? 'fixture-model', provider: 'fixture', cwd: '/fixture', agentPreset: options.agentPreset, thinkingFold: options.thinkingFold },
    { agentId: 'fixture-agent', sessionId: 'fixture-session', mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: '/fixture' },
  )
  const state: ProjectionArgs[0] = { ...view, emit: () => undefined } as ProjectionArgs[0]
  const notices: string[] = []
  const projector = createChannelProjection(state, {
    rowIds: { value: 0 },
    resetContextWarning: () => undefined,
    checkContextWarning: () => undefined,
    notify: text => {
      notices.push(text)
      return () => undefined
    },
    jobs: { onOutputSeen: () => undefined, onStarted: () => undefined },
    inputConvergence: { cancelInFlight: false },
    selectionAttached: () => undefined,
  })
  return {
    state,
    projector,
    notices,
    apply(events, replay = false) {
      projector.apply(events, { replay })
    },
  }
}
