import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { t } from '../../i18n.js'
import { logForDebugging } from '../../utils/debug.js'
import { dispatchTuiDecision } from '../extension-events.js'
import {
  firstStaleComposerToken,
  formatMissingReference,
  orderedComposerImages,
  type ComposerImages,
} from './composer-images.js'
import { expandComposerMentions } from './composer-mentions.js'
import { normalizeInputDecision } from './decisions.js'
import { mentionAttachments, mentionFs } from './mentions.js'
import type { ChannelOwner } from './owner.js'
import type {
  ChannelImageBlock,
  ChannelState,
  ComposerImageRef,
  MentionAttachments,
  MentionFs,
  PendingMessage,
  StagedImageInput,
} from './types.js'

/** One submission's enqueue-time world: the session it was typed in, the
 *  services that resolve its references, and the capabilities live then. */
interface UserTextOrigin {
  readonly agent: Agent
  readonly agentId: string
  readonly generation: number
  readonly cwd: string
  readonly fs: MentionFs | undefined
  readonly attachments: MentionAttachments | undefined
  readonly stagedImages: ReadonlyMap<string, ChannelImageBlock['attachment']>
}

/** Input FIFO, staged attachments and decision notice timers share one lifetime. */
export function createInputDelivery(
 ctx: Context, owner: ChannelOwner, binding: { readonly agent: Agent },
 state: () => Pick<ChannelState, 'cwd' | 'agentId' | 'agentBindingGeneration'>,
 notify: ChannelState['notify'],
 trackPending: (message: { id: string; text: string; images?: readonly ComposerImageRef[] }, placement: PendingMessage['placement']) => void,
 untrackPending: (id: string) => void,
 composer: ComposerImages,
) {
  /**
   * `@` file mentions (issue #15): expansion reads files asynchronously, so
   * every user-text delivery (submit / steer / interrupt-requeue) funnels
   * through this chain to keep the send order FIFO.
   */
  let inputChain: Promise<void> = Promise.resolve()

  /** D-6 fence: the submission belongs to the session it was typed in. */
  const current = (origin: UserTextOrigin): boolean =>
    owner.current() && binding.agent === origin.agent && state().agentBindingGeneration === origin.generation

  /** D-6: bind the submission to the session it was typed in AT ENQUEUE
   *  TIME. The FIFO chain may park this task behind a slow predecessor
   *  while the user /new's away — capturing the agent at run time would
   *  adopt the NEW session as this text's origin and deliver the old
   *  conversation's words into it. */
  const captureOrigin = (): UserTextOrigin => ({
    agent: binding.agent,
    agentId: state().agentId,
    generation: state().agentBindingGeneration,
    cwd: state().cwd,
    fs: mentionFs(ctx),
    attachments: mentionAttachments(ctx),
    stagedImages: composer.snapshot(),
  })

  /**
   * Expand the text's `@` mentions and deliver ONE user message: the typed
   * text stays the first content block (the transcript bubble renders it —
   * never the file dump) and each resolved reference appends a model-facing
   * attachment block. The pending preview tracks the typed text.
   */
  const deliverUserText = async (
    text: string,
    placement: PendingMessage['placement'],
    images: readonly ComposerImageRef[],
    origin: UserTextOrigin,
  ): Promise<void> => {
    const orderedImages = orderedComposerImages(text, images, origin.stagedImages)
    // A `[Image #N]` placeholder whose staging was evicted (FIFO cap) or
    // whose draft capability was lost (history/rewind/session switch) would
    // otherwise ship as plain text with no image attached — warn loudly,
    // deliver unchanged (the text is the user's; rewriting is worse).
    const stale = firstStaleComposerToken(text, orderedImages)
    if (stale !== undefined) {
      notify(t('input-image-token-stale', { token: stale }), { color: 'warning', timeoutMs: 5000 })
    }
    const expansion = await expandComposerMentions(
      origin.fs,
      origin.cwd,
      text,
      origin.attachments,
      orderedImages,
    )
    // Mention reads can park for arbitrary I/O. A session switch during that
    // await invalidates the whole submission; neither the old nor the new
    // agent may receive a message assembled for a different conversation.
    if (!current(origin)) {
      notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return
    }
    const message = createUserMessage({
      content: expansion.blocks,
      source: { kind: 'user' },
    })
    // Track BEFORE the agent call: a synchronous throw inside
    // followup/steer rolls the preview back; otherwise the inbox events
    // retire it once the message is claimed or discarded.
    trackPending({ id: message.id, text, images }, placement)
    try {
      if (placement === 'steer') origin.agent.steer(message)
      else origin.agent.followup(message)
    } catch (error) {
      untrackPending(message.id)
      throw error
    }
    if (expansion.attached.length > 0) {
      notify(t('mentions-attached', { count: expansion.attached.length }), { timeoutMs: 2500 })
    }
    if (expansion.missing.length > 0) {
      notify(t('mentions-missing', { paths: expansion.missing.map(formatMissingReference).join(' ') }), {
        color: 'warning',
        timeoutMs: 4000,
      })
    }
  }
  /**
   * RFC 0005 D-8: a flow parked on a plugin decision must be user-observable.
   * Decisions normally resolve in milliseconds, so the notice only fires
   * once the wait crosses a threshold — a slow plugin (e.g. one showing a
   * managed dialog) then explains the pause instead of looking like the TUI
   * ate the input.
   */
  const DECISION_PENDING_MS = 400
  /**
   * Session-scoped ledger of live pending-decision indicators. A session
   * replacement must cancel the notice timer and dismiss an already-visible
   * sticky notice even when the plugin's decision promise never settles; the
   * owner-scoped release alone would keep it up until channel teardown, and a
   * timer firing after the switch would raise the notice into the session that
   * replaced the one which parked the input (review finding: stale decision
   * notices were no longer dismissed or suppressed on session change).
   */
  const pendingDecisionCleanups = new Set<() => void>()
  const withDecisionPending = <T>(name: string, pending: Promise<T>, origin?: UserTextOrigin): Promise<T> => {
    let dismiss: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      const raised = dismiss
      dismiss = undefined
      raised?.()
      pendingDecisionCleanups.delete(cleanup)
    }
    timer = setTimeout(() => {
      // Sticky (timeoutMs 0), D-8: the indicator must cover the WHOLE wait —
      // an auto-expiring notice would vanish after ~4s while the decision,
      // the delivery and every queued FIFO task behind them stay parked,
      // leaving the user with no sign the flow is still waiting. It comes
      // down only when the decision settles (finally below); a decision
      // that never settles keeps its indicator up, which is the truthful
      // state.
      // A notice must never be raised for a session that has already been
      // replaced: the switch drains this ledger, and the origin fence covers
      // a timer that fires before that drain lands.
      if (origin !== undefined && !current(origin)) { cleanup(); return }
      if (!owner.current()) return
      dismiss = notify(t('ext-decision-pending', { event: name }), { timeoutMs: 0 })
    }, DECISION_PENDING_MS)
    pendingDecisionCleanups.add(cleanup)
    // Both exits are covered: a fast decision clears the timer before it
    // fires; a slow one dismisses the indicator it raised. The owner release
    // keeps the channel-teardown path working on top of the session drain.
    const release = owner.own(cleanup)
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
  const runUserTextDecision = async (
    text: string,
    placement: PendingMessage['placement'],
    images: readonly ComposerImageRef[],
    origin: UserTextOrigin,
  ): Promise<void> => {
    // Stale detection compares the AGENT REFERENCE, not the id: session ids
    // are reusable (A → /new → /resume A lands back on the same id with a
    // fresh agent), so an id check has an ABA hole. Both origin values are
    // ENQUEUE-time captures (see dispatchUserText): a decision parked behind
    // a slow predecessor must still be judged against the session its text
    // was typed in, not whichever session is live when it finally runs.
    const dropIfStale = (): boolean => {
      if (current(origin)) return false
      notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return true
    }
    // A follower can wait behind an older slow decision while /new replaces
    // the session. Do not even expose that stale text to plugins.
    if (dropIfStale()) return
    const decision = await withDecisionPending('tui/input', dispatchTuiDecision(ctx, 'tui/input', {
      text,
      delivery: placement === 'steer' ? 'steer' : 'followup',
      sessionId: origin.agentId,
      cwd: origin.cwd,
    }, normalizeInputDecision), origin)
    // Staleness wins over cancel/handled: an old plugin result must neither
    // toast into nor claim input from the replacement session.
    if (dropIfStale()) return
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
    try {
      await deliverUserText(text, placement, images, origin)
    } catch (error: unknown) {
      // The FIFO must survive a failed expansion/send: surface it, then let
      // the next input proceed through the settled inputChain.
      const message = error instanceof Error ? error.message : String(error)
      logForDebugging(`submit: delivery failed (${message})`)
      notify(t('send-failed', { err: message }), { color: 'error' })
    }
  }
  const dispatchUserText = (
    text: string,
    placement: PendingMessage['placement'],
    images: readonly ComposerImageRef[] = [],
  ): void => {
    const origin = captureOrigin()
    const capturedImages = composer.captureDraftImages(text, images)
    inputChain = inputChain.then(() => runUserTextDecision(text, placement, capturedImages, origin)).catch((error: unknown) => {
      // The chain must survive a failed decision: log, then continue with
      // the next queued submission.
      ctx.logger.warn('dsh-tui: tui/input dispatch failed: %o', error)
    })
  }
  /** Public companion for callers that own a line but not a draft (skill
   *  registrations): same decision pass and FIFO as a typed submit. */
  const deliverUserTextNow = (
    text: string,
    placement: PendingMessage['placement'],
    images: readonly ComposerImageRef[] = [],
  ): void => dispatchUserText(text, placement, images)
  /** Main's `clearStagedImages`: revoke capabilities AND release the FIFO so
   *  a task parked on the replaced session cannot wedge the new one, and drop
   *  every pending-decision indicator owned by the session being replaced. */
  const clearStagedImages = (): void => {
    composer.clearStagedImages()
    inputChain = Promise.resolve()
    for (const cleanup of [...pendingDecisionCleanups]) cleanup()
  }

  return {
    dispatchUserText,
    deliverUserText: deliverUserTextNow,
    withDecisionPending,
    clearStagedImages,
    stageImage: (input: StagedImageInput): Promise<string> => composer.stageImage(input),
    stagedImages: (): ReadonlyMap<string, ChannelImageBlock['attachment']> => composer.snapshot(),
    composer,
  }
}
