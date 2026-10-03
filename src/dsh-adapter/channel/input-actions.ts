/** Input actions own cancellation/requeue convergence, not session binding. */
import type { AgentSession } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { touchSession } from '../../sessionHistory.js'
import type { ChannelState, ComposerImageRef, ComposerSubmission } from './types.js'

export interface InputConvergence {
  cancelInFlight: boolean
  interruptSeq: number
  /** Cause of the abort currently converging, written by whoever fires the
   *  cancel and read to decide whether a queued-input drop is still needed
   *  (a 'user' cancel kept the backend queue; an 'interrupt' drops it). */
  cancelCause?: 'user' | 'interrupt'
}
export function createInputActions(
  getState: () => Pick<ChannelState, 'agentId' | 'pending' | 'cancelPending' | 'emit' | 'notify' | 'backendCapabilities'>,
  getSession: () => AgentSession,
  owner: { assertActive(): void },
  input: InputConvergence,
  composer: { includeLegacyImageRefs(text: string, images: readonly ComposerImageRef[]): readonly ComposerImageRef[] },
  dispatchUserText: (text: string, placement: 'steer' | 'followup', images?: readonly ComposerImageRef[]) => void,
  runLocalCommand: (command: string, includeInContext: boolean) => Promise<void>,
  /** Move the used session to the front of the `/resume` MRU (DSH session
   *  history); a backend whose sessions that list cannot open passes a no-op. */
  touch: (sessionId: string) => void = touchSession,
): Pick<ChannelState, 'submit' | 'steer' | 'removePending' | 'cancel' | 'interruptAndDeliver' | 'interruptAndDock' | 'deliverDocked'> {
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
      touch(state.agentId)
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
      touch(state.agentId)
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
      const session = getSession()
      const index = state.pending.findIndex(item => item.id === id)
      if (index === -1) return false
      // A docked preview is a channel-side asset: the backend dropped its
      // queued copy with the aborted turn, so pulling it back is purely
      // local and EVERY backend supports it — including those without
      // live-inbox withdrawal (`retractPending` false, the Claude CLI),
      // whose gate below only governs LIVE queue items.
      if (state.pending[index]!.docked === true) {
        state.pending = state.pending.filter(item => item.id !== id)
        state.emit()
        return true
      }
      // A backend that cannot withdraw synchronously is never asked: starting
      // an async removal and reporting failure here would leave the message
      // both "kept" in the UI and maybe-withdrawn in the backend. The caller
      // (PromptInput) keeps it queued and says it cannot be retracted.
      if (!state.backendCapabilities.retractPending) return false
      // The backend withdraws it (DSH: through the agent's inbox, which durably
      // records the cancellation and reports the discard that retires the
      // preview). Refuse when the message was already claimed so the UI never
      // pretends a ghost send was pulled back; this contract is synchronous.
      const removed = session.removePending(id)
      if (typeof removed !== 'boolean') {
        // Contract violation (retractPending declared, async answer): never
        // report a withdrawal that has not happened; the backend's own
        // pending.changed retires the preview if it does go through.
        void Promise.resolve(removed).catch(() => false)
        return false
      }
      if (!removed) return false
      state.pending = state.pending.filter(item => item.id !== id)
      state.emit()
      return true
    },

    cancel() {
      owner.assertActive()
      const state = getState()
      const session = getSession()
      // Keep the staged queue: an interrupt aborts the running turn but the
      // queued/steered messages are delivered as the next turn (web parity).
      // Cancellation converges asynchronously; ignore a repeated Esc/Ctrl+C
      // until the aborted turn has produced its terminal event. `cancelPending`
      // mirrors that window for the UI, where a repeated press force-exits.
      if (input.cancelInFlight) return
      input.cancelInFlight = true
      input.cancelCause = 'user'
      state.cancelPending = true
      void session.cancel('user')
    },

    /** Esc with queued input while a turn runs (Claude Code parity: "Press
     *  up to select a queued message to edit, or Enter to send them now"):
     *  the abort drops the backend's queued copies and the channel PARKS its
     *  previews as a dock — nothing re-delivers them until the user sends
     *  the dock (⏎ / deliverDocked) or retracts items (Alt+↑ / the ↑
     *  editor). Returns the count docked; 0 means nothing new was parked
     *  (already-docked rows stay put; the caller may still plain-cancel). */
    interruptAndDock(): number {
      owner.assertActive()
      const state = getState()
      const session = getSession()
      const dockable = state.pending.filter(item => item.docked !== true)
      if (dockable.length > 0) {
        // Mark BEFORE the cancel fires: the discard events the backend's
        // queue drop produces must not delete the previews — binding-feed
        // keeps `docked` rows alive on discard (the dock owns them now).
        state.pending = state.pending.map(item => item.docked === true ? item : { ...item, docked: true })
        state.emit()
      }
      state.cancelPending = true
      // A 'user' cancel already converging KEPT the backend queue
      // (keepInbox); docking over it must still drop that queue or the
      // parked previews would double with the backend's own next-turn run.
      // An 'interrupt' abort already in flight is already dropping it.
      if (!input.cancelInFlight || input.cancelCause === 'user') {
        input.cancelInFlight = true
        input.cancelCause = 'interrupt'
        void session.cancel('interrupt')
          .then(receipt => {
            // A backend that could not drop its queue answers with the
            // kept ids (Claude `still_queued`; a CLI without
            // interrupt_cancel_queued_v1 runs them itself): un-dock those
            // rows so their previews retire on claim instead of offering a
            // second send on top of the backend's own.
            const kept = new Set(receipt.stillQueued)
            if (kept.size === 0) return
            let undocked = false
            state.pending = state.pending.map(item => {
              if (item.docked !== true || !kept.has(item.id)) return item
              undocked = true
              return { ...item, docked: undefined }
            })
            if (undocked) state.emit()
          })
          .catch(() => { /* the dock stands; claims retire what really runs */ })
      }
      return dockable.length
    },

    /** Send every docked message now (⏎ on an empty draft, or the clickable
     *  dock hint): FIFO through the same dispatch chain a typed submit uses,
     *  exactly once — the docked rows leave first and their deliveries
     *  enqueue fresh pending previews. Returns the count sent. */
    deliverDocked(): number {
      owner.assertActive()
      const state = getState()
      const docked = state.pending.filter(item => item.docked === true)
      if (docked.length === 0) return 0
      state.pending = state.pending.filter(item => item.docked !== true)
      state.emit()
      for (const entry of docked) {
        touch(state.agentId)
        dispatchUserText(entry.text, 'followup', entry.images)
      }
      return docked.length
    },

    interruptAndDeliver(inputs: readonly (string | ComposerSubmission)[]): number {
      owner.assertActive()
      const state = getState()
      const session = getSession()
      const queued = inputs
        .map(input => typeof input === 'string'
          ? { text: input.trim(), images: [] as readonly ComposerImageRef[] }
          : { text: input.text.trim(), images: [...(input.images ?? [])] })
        .filter(input => input.text !== '')
      if (queued.length === 0) return 0
      // An `interrupt` cancel drops the parked copies (their discard events
      // retire the preview), then each message is re-queued as a fresh
      // followup. dsh-agent's cancel-convergence wake latch accepts this
      // wake immediately after cancel and starts it once the aborted turn
      // retires; waiting for whenIdle is unsafe because it also follows
      // replacement work and may never settle. If cancellation is already
      // in flight, keep the existing abort and still replace the pending
      // interrupt delivery; fake/embedded agents may not emit turn/end.
      // (Exception: an in-flight 'user' cancel KEPT the backend queue —
      // drop it now or the re-queue below would double with its own run.)
      if (!input.cancelInFlight || input.cancelCause === 'user') {
        input.cancelInFlight = true
        input.cancelCause = 'interrupt'
        void session.cancel('interrupt')
      }
      state.cancelPending = true
      const token = ++input.interruptSeq
      const deliver = (): void => {
        // A second interrupt while the abort is still settling must not
        // double-deliver: only the latest request's re-queue runs.
        if (input.interruptSeq !== token) return
        // The dock's rows ride this batch too: take them off the pending
        // list first (their re-deliveries enqueue fresh previews), ahead
        // of the given inputs — docked rows are the OLDEST texts (FIFO).
        const docked = state.pending.filter(item => item.docked === true)
        if (docked.length > 0) {
          state.pending = state.pending.filter(item => item.docked !== true)
          state.emit()
        }
        for (const entry of [...docked, ...queued]) {
          touch(state.agentId)
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
    },
  }
}
