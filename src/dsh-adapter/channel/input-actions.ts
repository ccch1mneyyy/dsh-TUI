/** Input actions own cancellation/requeue convergence, not session binding. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { t } from '../../i18n.js'
import { touchSession } from '../../sessionHistory.js'
import type { ChannelState, ComposerImageRef, ComposerSubmission } from './types.js'

export interface InputConvergence { cancelInFlight: boolean; interruptSeq: number }
export function createInputActions(
  getState: () => Pick<ChannelState, 'agentId' | 'pending' | 'cancelPending' | 'emit' | 'notify'>,
  getAgent: () => Agent,
  owner: { assertActive(): void },
  input: InputConvergence,
  composer: { includeLegacyImageRefs(text: string, images: readonly ComposerImageRef[]): readonly ComposerImageRef[] },
  dispatchUserText: (text: string, placement: 'steer' | 'followup', images?: readonly ComposerImageRef[]) => void,
  runLocalCommand: (command: string, includeInContext: boolean) => Promise<void>,
): Pick<ChannelState, 'submit' | 'steer' | 'removePending' | 'cancel' | 'interruptAndDeliver'> {
  return {
    submit(text, images = []) {
      owner.assertActive()
      const state = getState()
      const trimmed = text.trim()
      if (!trimmed) return
      const submittedImages = composer.includeLegacyImageRefs(trimmed, images)
      // Non-UI callers do not pass through PromptInput's admission guard.
      // Shell routes have no image grammar: reject loudly before spawning
      // anything rather than silently ignoring the supplied capabilities.
      if (submittedImages.length > 0 && trimmed.startsWith('!')) {
        state.notify(t('shell-images-unsupported'), { color: 'warning', timeoutMs: 4000 })
        return
      }
      // Local shell mode: `!cmd` runs locally and only shows the output;
      // `!!cmd` additionally sends the output to the model as a user
      // message wrapped in `<bash-stdout>`.
      if (trimmed.startsWith('!!')) {
        void runLocalCommand(trimmed.slice(2).trim(), true)
        return
      }
      if (trimmed.startsWith('!')) {
        void runLocalCommand(trimmed.slice(1).trim(), false)
        return
      }
      // The current session is being used — move it to the MRU front
      // (/resume sorts by last-used).
      touchSession(state.agentId)
      dispatchUserText(trimmed, 'followup', submittedImages)
    },

    /** Steer a message into the RUNNING turn (Codex/pi semantics): it is
     *  injected at the next step boundary of the current turn and the agent
     *  continues without stopping — faster than followup, never an abort. */
    steer(text, images = []) {
      owner.assertActive()
      const state = getState()
      const trimmed = text.trim()
      if (!trimmed) return
      touchSession(state.agentId)
      // Same tui/input decision pass as submit; the delivery re-validates
      // the live agent after the await. Official dsh-agent rc.6: steer() is
      // synchronous void — the message enters the next-step inbox; a
      // rejected step leaves it parked for the next wake, and the inbox
      // events retire the preview (claimed → turn boundary, discarded →
      // cancel).
      dispatchUserText(trimmed, 'steer', images)
    },

    /** Pull a pending message back out of the inbox (Alt+Up): it returns to
     *  the input for editing instead of being delivered. */
    removePending(id: string): boolean {
      owner.assertActive()
      const state = getState()
      const agent = getAgent()
      const index = state.pending.findIndex(item => item.id === id)
      if (index === -1) return false
      // Official dsh-agent rc.6: withdrawal goes through the agent's inbox
      // projection — `Inbox.remove(messageId)` durably records the
      // cancellation (an `agent/inbox/spliced` session event) and publishes
      // `agent/inbox/discarded`, which retires the preview. Refuse when the
      // message was already claimed (remove returns false) so the UI never
      // pretends a ghost send was pulled back.
      if (!agent.inbox.remove(MessageId(id))) return false
      state.pending = state.pending.filter(item => item.id !== id)
      state.emit()
      return true
    },

    cancel() {
      owner.assertActive()
      const state = getState()
      const agent = getAgent()
      // Keep the staged queue: an interrupt aborts the running turn but the
      // queued/steered messages are delivered as the next turn (web parity).
      // Cancellation converges asynchronously; ignore a repeated Esc/Ctrl+C
      // until the aborted turn has produced its terminal event. `cancelPending`
      // mirrors that window for the UI, where a repeated press force-exits.
      if (input.cancelInFlight) return
      input.cancelInFlight = true
      state.cancelPending = true
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    },

    interruptAndDeliver(inputs: readonly (string | ComposerSubmission)[]): number {
      owner.assertActive()
      const state = getState()
      const agent = getAgent()
      const queued = inputs
        .map(input => typeof input === 'string'
          ? { text: input.trim(), images: [] as readonly ComposerImageRef[] }
          : { text: input.text.trim(), images: [...(input.images ?? [])] })
        .filter(input => input.text !== '')
      if (queued.length === 0) return 0
      // No keepInbox: the parked copies are dropped (their discard events
      // retire the preview), then each message is re-queued as a fresh
      // followup. dsh-agent's cancel-convergence wake latch accepts this
      // wake immediately after cancel and starts it once the aborted turn
      // retires; waiting for whenIdle is unsafe because it also follows
      // replacement work and may never settle. If cancellation is already
      // in flight, keep the existing abort and still replace the pending
      // interrupt delivery; fake/embedded agents may not emit turn/end.
      if (!input.cancelInFlight) {
        input.cancelInFlight = true
        agent.cancel({ kind: 'user' })
      }
      state.cancelPending = true
      const token = ++input.interruptSeq
      const deliver = (): void => {
        // A second interrupt while the abort is still settling must not
        // double-deliver: only the latest request's re-queue runs.
        if (input.interruptSeq !== token) return
        for (const entry of queued) {
          touchSession(state.agentId)
          // Same tui/input decision pass as a typed submit: Ctrl+Enter must
          // not bypass a plugin's cancel/transform policy, and re-queued
          // texts keep submission order through the one FIFO chain.
          dispatchUserText(entry.text, 'followup', entry.images)
        }
      }
      // Let cancel finish its synchronous inbox bookkeeping before waking.
      // A microtask also coalesces two same-tick interrupts: only the latest
      // token survives, so the user's text is never sent twice.
      queueMicrotask(deliver)
      return queued.length
    }
  }
}
