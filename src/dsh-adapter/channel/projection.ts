/**
 * DSH projection surface over the split pipeline: the DSH translator
 * (`../backend/translate.ts`) decodes session events and stream frames into
 * Agent Domain events, the shared projector (`src/channel/projection.ts`) folds
 * them into the channel state. This wrapper keeps the pre-split
 * `renderEvent`/`renderStreamFrame`/`replayEvents` surface for the channel
 * wiring and the regression scripts that drive it directly.
 */
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
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

// ContentBlockMap is merge-extensible: plugin-added block types are
// silently skipped (v1 renders text blocks only) — never crashes.
const textOf = (content: readonly ContentBlock[] | undefined): string =>
  (content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('').trim()

/** First text block only: the transcript-facing text of a user message. */
const firstTextOf = (content: readonly ContentBlock[] | undefined): string =>
  (content ?? []).find(block => block.type === 'text')?.text.trim() ?? ''

/** One authoritative reducer for both durable replay and live session events. */
export function createChannelProjection(state: ProjectionState, deps: ProjectionDependencies) {
  const translator = createDshTranslator({
    tools: deps.tools,
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
    renderer: deps.renderer,
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
    presentCallView: translator.presentCallView,
    presentResultView: translator.presentResultView,
    textOf,
    firstTextOf,
  }
}
