/** Input actions own cancellation/requeue convergence, not session binding. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { touchSession } from '../../sessionHistory.js'
import type { ChannelState } from './types.js'

export interface InputConvergence { cancelInFlight: boolean; interruptSeq: number }
export function createInputActions(
  getState: () => Pick<ChannelState, 'agentId' | 'pending' | 'cancelPending' | 'emit'>,
  getAgent: () => Agent,
  owner: { assertActive(): void },
  input: InputConvergence,
  dispatchUserText: (text: string, placement: 'steer' | 'followup') => void,
  runLocalCommand: (command: string, includeInContext: boolean) => Promise<void>,
): Pick<ChannelState, 'submit' | 'steer' | 'removePending' | 'cancel' | 'interruptAndDeliver'> {
  return {
    submit(text) {
      owner.assertActive()
      const state = getState()
      const agent = getAgent()
      const trimmed = text.trim()
      if (!trimmed) return
      // Claude Code's `!` mode: `!cmd` runs locally and only shows the
      // output; `!!cmd` additionally sends the output to the model as a
      // user message (CC's <bash-stdout> convention).
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
      void dispatchUserText(trimmed, 'followup')
    },

    /** Steer a message into the RUNNING turn (Codex/pi semantics): it is
     *  injected at the next step boundary of the current turn and the agent
     *  continues without stopping — faster than followup, never an abort. */
    steer(text) {
      owner.assertActive()
      const state = getState()
      const agent = getAgent()
      const trimmed = text.trim()
      if (!trimmed) return
      touchSession(state.agentId)
      // Same tui/input decision pass as submit; the delivery re-validates
      // the live agent after the await. Official dsh-agent rc.6: steer() is
      // synchronous void — the message enters the next-step inbox; a
      // rejected step leaves it parked for the next wake, and the inbox
      // events retire the preview (claimed → turn boundary, discarded →
      // cancel).
      void dispatchUserText(trimmed, 'steer')
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

    interruptAndDeliver(texts: readonly string[]): number {
      owner.assertActive()
      const state = getState()
      const agent = getAgent()
      const queued = texts.map(text => text.trim()).filter(text => text !== '')
      if (queued.length === 0) return 0
      // No keepInbox: the parked copies are dropped (their discard events
      // retire the preview), then each text is re-queued as a fresh
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
        for (const text of queued) {
          touchSession(state.agentId)
          // Same tui/input decision pass as a typed submit: Ctrl+Enter must
          // not bypass a plugin's cancel/transform policy, and re-queued
          // texts keep submission order through the one FIFO chain.
          dispatchUserText(text, 'followup')
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
