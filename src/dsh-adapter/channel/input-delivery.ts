import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { t } from '../../i18n.js'
import { logForDebugging } from '../../utils/debug.js'
import { dispatchTuiDecision } from '../extension-events.js'
import { normalizeInputDecision } from './decisions.js'
import { expandMentions, mentionFs, mentionAttachments } from './mentions.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState, ChannelImageBlock, PendingMessage, StagedImageInput } from './types.js'

/** Input FIFO, staged attachments and decision notice timers share one lifetime. */
export function createInputDelivery(
 ctx: Context, owner: ChannelOwner, binding: { readonly agent: Agent },
 state: () => Pick<ChannelState, 'cwd' | 'agentId' | 'agentBindingGeneration'>,
 notify: ChannelState['notify'],
 trackPending: (message: { id: string; text: string }, placement: PendingMessage['placement']) => void,
 untrackPending: (id: string) => void,
) {
  /**
   * `@` file mentions (issue #15): expansion reads files asynchronously, so
   * every user-text delivery (submit / steer / interrupt-requeue) funnels
   * through this chain to keep the send order FIFO.
   */
  let sendChain: Promise<void> = Promise.resolve()
  let stagedImageSequence = 0
  const stagedImages = new Map<string, ChannelImageBlock['attachment']>()
  const clearStagedImages = (): void => {
    stagedImages.clear()
    stagedImageSequence = 0
  }
  /**
   * Expand the text's `@` mentions and deliver ONE user message: the typed
   * text stays the first content block (the transcript bubble renders it —
   * never the file dump) and each resolved reference appends a model-facing
   * attachment block. The pending preview tracks the typed text.
   */
  const deliverUserText = (text: string, placement: PendingMessage['placement']): void => {
    const origin = binding.agent
    const generation = state().agentBindingGeneration
    const cwd = state().cwd
    const images = new Map(stagedImages)
    const current = () => owner.current() && binding.agent === origin && state().agentBindingGeneration === generation
    sendChain = sendChain.then(async () => {
      if (!current()) return
      const expansion = await expandMentions(
        mentionFs(ctx),
        cwd,
        text,
        mentionAttachments(ctx),
        images,
      )
      if (!current()) return
      const message = createUserMessage({
        content: expansion.blocks,
        source: { kind: 'user' },
      })
      // Track BEFORE the agent call: a synchronous throw inside
      // followup/steer rolls the preview back; otherwise the inbox events
      // retire it once the message is claimed or discarded.
      trackPending({ id: message.id, text }, placement)
      try {
        if (placement === 'steer') origin.steer(message)
        else origin.followup(message)
      } catch (error) {
        untrackPending(message.id)
        throw error
      }
      if (expansion.attached.length > 0) {
        notify(t('mentions-attached', { count: expansion.attached.length }), { timeoutMs: 2500 })
      }
      if (expansion.missing.length > 0) {
        notify(t('mentions-missing', { paths: expansion.missing.map(path => `@${path}`).join(' ') }), {
          color: 'warning',
          timeoutMs: 4000,
        })
      }
    }).catch((error: unknown) => {
      if (!current()) return
      // The chain must survive a failed send: log and notify, then continue
      // with the next queued delivery.
      const message = error instanceof Error ? error.message : String(error)
      logForDebugging(`submit: delivery failed (${message})`)
      notify(t('send-failed', { err: message }), { color: 'error' })
    })
  }
  /**
   * RFC 0005 D-8: a flow parked on a plugin decision must be user-observable.
   * Decisions normally resolve in milliseconds, so the notice only fires
   * once the wait crosses a threshold — a slow plugin (e.g. one showing a
   * managed dialog) then explains the pause instead of looking like the TUI
   * ate the input.
   */
  const DECISION_PENDING_MS = 400
  const withDecisionPending = <T>(name: string, pending: Promise<T>): Promise<T> => {
    let dismiss: (() => void) | undefined
    const timer = setTimeout(() => {
      // Sticky (timeoutMs 0), D-8: the indicator must cover the WHOLE wait —
      // an auto-expiring notice would vanish after ~4s while the decision,
      // the delivery and every queued FIFO task behind them stay parked,
      // leaving the user with no sign the flow is still waiting. It comes
      // down only when the decision settles (finally below); a decision
      // that never settles keeps its indicator up, which is the truthful
      // state.
      if (!owner.current()) return
      dismiss = notify(t('ext-decision-pending', { event: name }), { timeoutMs: 0 })
    }, DECISION_PENDING_MS)
    // Both exits are covered: a fast decision clears the timer before it
    // fires; a slow one dismisses the indicator it raised.
    const release = owner.own(() => { clearTimeout(timer); dismiss?.() })
    return pending.finally(release)
  }
  /**
   * The `tui/input` decision event (pi's `input` seam): the FIRST plugin
   * returning a valid decision wins — transform the text, mark it handled,
   * or cancel it. No listeners (or only crashing/malformed ones) means
   * delivery proceeds unchanged, so a broken plugin can never wedge the
   * input path — and can never skip a later veto listener either
   * (dispatchTuiDecision isolates crashes and normalizes returns per
   * listener instead of bailing on the first object).
   *
   * Decision AND delivery enter one FIFO chain in submission order: a slow
   * listener on A parks A's delivery AND any later submissions behind it —
   * without the chain, B's decision could resolve first and the model would
   * receive B before A. Each submission binds its origin agent AT ENQUEUE,
   * so a session switch landing before OR during its decision drops the
   * stale text with a notice instead of sending the old conversation's
   * words to the new session.
   */
  let inputChain: Promise<void> = Promise.resolve()
  const runUserTextDecision = async (
    text: string,
    placement: PendingMessage['placement'],
    originAgent: Agent,
    originAgentId: string,
    generation: number,
    cwd: string,
  ): Promise<void> => {
    const current = () => owner.current() && binding.agent === originAgent && state().agentBindingGeneration === generation
    if (!current()) return
    // Stale detection compares the AGENT REFERENCE, not the id: session ids
    // are reusable (A → /new → /resume A lands back on the same id with a
    // fresh agent), so an id check has an ABA hole. Both origin values are
    // ENQUEUE-time captures (see dispatchUserText): a decision parked behind
    // a slow predecessor must still be judged against the session its text
    // was typed in, not whichever session is live when it finally runs.
    const decision = await withDecisionPending('tui/input', dispatchTuiDecision(ctx, 'tui/input', {
      text,
      delivery: placement === 'steer' ? 'steer' : 'followup',
      sessionId: originAgentId,
      cwd,
    }, normalizeInputDecision))
    if (!current()) return
    if (decision !== undefined) {
      // Both intercepts toast — a bare {cancel}/{handled} must not make the
      // typed line vanish silently (the host-localized fallback mirrors the
      // other decision events' ext-action-cancelled handling).
      if ('cancel' in decision) {
        notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
        return
      }
      if ('handled' in decision) {
        notify(decision.notice ?? t('ext-action-handled'), { timeoutMs: 4000 })
        return
      }
      text = decision.text.trim()
    }
    if (binding.agent !== originAgent) {
      notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return
    }
    deliverUserText(text, placement)
  }
  const dispatchUserText = (text: string, placement: PendingMessage['placement']): void => {
    // D-6: bind the submission to the session it was typed in AT ENQUEUE
    // TIME. The FIFO chain may park this task behind a slow predecessor
    // while the user /new's away — capturing the agent at run time would
    // adopt the NEW session as this text's origin and deliver the old
    // conversation's words into it.
    const originAgent = binding.agent
    const originAgentId = state().agentId
    const generation = state().agentBindingGeneration
    const cwd = state().cwd
    inputChain = inputChain.then(() => runUserTextDecision(text, placement, originAgent, originAgentId, generation, cwd)).catch((error: unknown) => {
      // The chain must survive a failed decision: log, then continue with
      // the next queued submission.
      ctx.logger.warn('dsh-tui: tui/input dispatch failed: %o', error)
    })
  }

  async function stageImage(input: StagedImageInput): Promise<string> {
      owner.assertActive()
      const origin = binding.agent
      const generation = state().agentBindingGeneration
      const attachments = mentionAttachments(ctx)
      if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
      if (!attachments.imageLimits.mediaTypes.includes(input.mediaType)) {
        throw new Error(`${input.mediaType} images are not accepted by this profile`)
      }
      if (input.data.byteLength > attachments.imageLimits.maxImageBytes) {
        throw new Error(`image exceeds this profile's per-image size limit`)
      }
      const attachment = await attachments.saveImage(input)
      owner.assertActive()
      if (binding.agent !== origin || state().agentBindingGeneration !== generation) throw new Error('dsh-tui: stale image staging')
      stagedImageSequence += 1
      const token = `[Image #${stagedImageSequence}]`
      stagedImages.set(token, attachment)
      // References are content-addressed and durable. This map only connects
      // editable prompt placeholders to them; cap it to bound a long TUI run.
      while (stagedImages.size > 128) {
        const oldest = stagedImages.keys().next().value as string | undefined
        if (oldest === undefined) break
        stagedImages.delete(oldest)
      }
      return token
    }
  return {
    dispatchUserText, deliverUserText, withDecisionPending, stageImage, clearStagedImages,
    stagedImages: (): ReadonlyMap<string, ChannelImageBlock['attachment']> => new Map(stagedImages),
  }
}
