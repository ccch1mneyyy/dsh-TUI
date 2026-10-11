/**
 * DSH session events and stream frames through the DSH translator
 * (`../backend/translate.ts`) into the shared projector
 * (`src/channel/projection.ts`), behind one `renderEvent` /
 * `renderStreamFrame` / `replayEvents` surface. The channel wires the two
 * halves itself; regression scripts that feed raw DSH events use this.
 */
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SelectionAttachment } from '../../adapter/ports/channel-view.js'
import { createChannelProjection as createSharedProjection, type ProjectionState } from '../../channel/projection.js'
import type { BackgroundJobStore } from '../jobs.js'
import type { TuiRendererHost } from '../renderers.js'
import { createDshTranslator, dshPricingWindow } from '../backend/translate.js'
import type { InputConvergence } from './input-actions.js'
import type { ChannelState, ToolsRegistryLike } from './types.js'

interface ProjectionDependencies {
 agent(): Agent
 rowIds: { value: number }
 resetContextWarning(): void
 jobs: Pick<BackgroundJobStore, 'onOutputSeen' | 'onStarted'>
 inputConvergence: Pick<InputConvergence, 'cancelInFlight'>
 checkContextWarning(): void
 notify: ChannelState['notify']
 tools?: ToolsRegistryLike
 renderer?: TuiRendererHost
 /** DSH attachment service, resolved at call time (a late-mounted provider
  *  must still serve images for rows projected earlier). */
 attachments(): unknown
 /** What a submitted message's IDE selection attached (keyed by the message
  *  id the durable event carries), for the user row's indicator line. */
 selectionAttached(messageId: string): SelectionAttachment | undefined
}

const LIVE = { replay: false } as const
const REPLAY = { replay: true } as const

/** One reducer for both durable replay and live session events. */
export function createChannelProjection(state: ProjectionState, deps: ProjectionDependencies) {
  const translator = createDshTranslator({
    tools: () => deps.tools,
    scope: () => deps.agent(),
    attachments: () => deps.attachments(),
  })
  const projector = createSharedProjection(state, {
    rowIds: deps.rowIds,
    resetContextWarning: () => deps.resetContextWarning(),
    checkContextWarning: () => deps.checkContextWarning(),
    notify: (...args) => deps.notify(...args),
    jobs: deps.jobs,
    inputConvergence: deps.inputConvergence,
    get renderer() { return deps.renderer },
    selectionAttached: messageId => deps.selectionAttached(messageId),
    pricingWindow: dshPricingWindow,
  })
  return {
    /** Forget every per-session ledger on both halves. */
    reset(): void {
      translator.reset()
      projector.reset()
    },
    replayEvents(events: readonly SessionEvent[]): void {
      projector.apply(translator.translateReplay(events), REPLAY)
    },
    renderEvent(event: SessionEvent): void {
      projector.apply(translator.translateEvent(event), LIVE)
    },
    renderStreamFrame(frame: AssistantStreamFrame): void {
      projector.apply(translator.translateFrame(frame), LIVE)
    },
    settleStreaming: projector.settleStreaming,
    updateSpinnerMode: projector.updateSpinnerMode,
  }
}
