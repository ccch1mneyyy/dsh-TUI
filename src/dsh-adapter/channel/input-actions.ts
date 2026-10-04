/** Input actions own cancellation/requeue convergence, not session binding. */
import { randomUUID } from 'node:crypto'
import type { AgentSession, CancelOutcome } from '../../agent/session.js'
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
  /** True while an interrupt cancel's receipt has not settled yet: rows
   *  docked in that window sit outside the receipt's queue snapshot. */
  interruptReceiptPending?: boolean
  /** The docked-row ids parked while the current receipt was in flight.
   *  Its snapshot predates them, so it cannot vouch for their backend
   *  copies; they are un-docked (with the unconfirmed notice) when it
   *  settles. Owned by the pending request; undefined when none is. */
  uncoveredDockIds?: string[]
  /** Docked-row ids whose vouching interrupt receipt has not settled yet.
   *  They still render as docked, but edit / re-send / swap are held: a
   *  late failed/unknown/still_queued answer can only revoke rows still on
   *  the pending list, so anything already delivered, edited out or
   *  swapped under a new id would double with the backend copy that
   *  receipt says may still run. A confirmed receipt graduates its rows;
   *  every other answer revokes them. Owned by the pending request;
   *  undefined when none is. */
  provisionalDockIds?: string[]
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
): Pick<ChannelState, 'submit' | 'steer' | 'removePending' | 'cancel' | 'interruptAndDeliver' | 'interruptAndDock' | 'deliverDocked' | 'swapDockedForDraft'> {
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
      // local and works on every backend, including backends without
      // pending-message withdrawal; the gate below only governs live queue items.
      if (state.pending[index]!.docked === true) {
        // A dock the pending receipt has not vouched for is view-only:
        // its backend copy may still run, so editing the row out now would
        // strand a copy the late revocation can no longer reach. The caller
        // keeps the row queued and says it cannot be retracted.
        if (input.provisionalDockIds?.includes(id) === true) return false
        state.pending = state.pending.filter(item => item.id !== id)
        state.emit()
        return true
      }
      const retraction = session.capabilities.pendingRetraction
      if (retraction === undefined) return false
      const removed = retraction.remove(id)
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
     *  the abort drops the backend's queued copies and the channel parks its
     *  previews as a dock, which nothing re-delivers until the user sends it
     *  (⏎ / deliverDocked) or retracts items (Alt+↑ / the ↑ editor).
     *  Docking assumes the backend dropped its copies, so only a confirmed
     *  cancel receipt keeps the dock (minus the ids it says it kept); an
     *  unknown or failed receipt, and rows docked after the request fired,
     *  un-dock with a notice so the still-live backend copy is not sent
     *  twice. Returns the count docked; 0 means nothing new was parked
     *  (already-docked rows stay put; the caller may still plain-cancel). */
    interruptAndDock(): number {
      owner.assertActive()
      const state = getState()
      const session = getSession()
      const dockable = state.pending.filter(item => item.docked !== true)
      const dockedNow = dockable.map(item => item.id)
      if (dockable.length > 0) {
        // Mark before the cancel fires: the discard events the backend's
        // queue drop produces must not delete the previews (binding-feed
        // keeps `docked` rows alive on discard; the dock owns them now).
        state.pending = state.pending.map(item => item.docked === true ? item : { ...item, docked: true })
        state.emit()
      }
      state.cancelPending = true
      if (input.cancelInFlight && input.cancelCause === 'interrupt' && input.interruptReceiptPending === true) {
        // The in-flight receipt's queue snapshot predates these rows: it
        // cannot vouch for their backend copies. They join its uncovered
        // set and are un-docked when it settles rather than riding a
        // receipt that never saw them.
        input.uncoveredDockIds?.push(...dockedNow)
        // They are provisional dock rows for exactly the same reason (the
        // receipt cannot vouch for them yet): view-only until it settles.
        // Mutate, never replace: settle() clears this exact array.
        if (input.provisionalDockIds === undefined) input.provisionalDockIds = [...dockedNow]
        else input.provisionalDockIds.push(...dockedNow)
        return dockable.length
      }
      // A 'user' cancel already converging kept the backend queue
      // (keepInbox); docking over it must still drop that queue or the
      // parked previews would double with the backend's own next-turn run.
      // An 'interrupt' abort whose receipt already settled is no longer
      // dropping anything: the new rows need their own request.
      input.cancelInFlight = true
      input.cancelCause = 'interrupt'
      input.interruptReceiptPending = true
      const uncovered: string[] = []
      input.uncoveredDockIds = uncovered
      // Every row this request parks is provisional until its receipt
      // vouches for it: the batch that fired the request (the receipt's
      // own snapshot covers it) and every later joiner above alike.
      // Rows an earlier request still holds stay held: that receipt can be
      // outlived by this request (the aborted turn ended before it came
      // back), and this one's later queue snapshot vouches for them too.
      const provisional: string[] = [...input.provisionalDockIds ?? [], ...dockedNow]
      input.provisionalDockIds = provisional
      let settled = false
      const settle = (outcome: CancelOutcome, stillQueued: readonly string[]): void => {
        if (settled) return
        settled = true
        // A newer request owns the bookkeeping once it replaced ours.
        if (input.uncoveredDockIds === uncovered) {
          input.uncoveredDockIds = undefined
          input.interruptReceiptPending = false
        }
        if (input.provisionalDockIds === provisional) input.provisionalDockIds = undefined
        // The channel moved to another session: its dock and its queue are
        // not the ones this receipt speaks about.
        if (getSession() !== session) return
        // Every docked row this receipt cannot confirm dropped: the ids the
        // backend says it kept, plus every row docked after the request
        // fired (outside its snapshot). Those copies are still live: their
        // previews go back to the normal claim/discard retirement and the
        // dock never offers a second send on top of them. Only a confirmed
        // answer graduates the provisional rows; any other verdict un-docks
        // them too, so nothing keeps edit/re-send rights a late revocation
        // could no longer reach.
        const revoke = new Set([...stillQueued, ...uncovered])
        if (outcome !== 'confirmed') for (const id of provisional) revoke.add(id)
        // A newer request that carried our rows over holds them no longer
        // than this answer needs.
        const held = input.provisionalDockIds
        if (outcome === 'confirmed' && held !== undefined && held !== provisional) {
          for (const id of provisional) {
            const index = held.indexOf(id)
            if (index !== -1 && !revoke.has(id)) held.splice(index, 1)
          }
        }
        if (revoke.size > 0) {
          let undocked = false
          state.pending = state.pending.map(item => {
            if (item.docked !== true || !revoke.has(item.id)) return item
            undocked = true
            return { ...item, docked: undefined }
          })
          if (undocked) state.emit()
        }
        // The unconfirmed legs are loud: a failed or answerless interrupt
        // must not leave a success-shaped dock (or a silently failed Esc).
        const notice = outcome === 'failed' ? t('interrupt-failed')
          : revoke.size === 0 ? undefined
          : t('interrupt-unconfirmed')
        if (notice !== undefined) state.notify(notice, { color: 'warning', timeoutMs: 6000 })
      }
      void session.cancel('interrupt')
        .then(receipt => { settle(receipt.outcome, receipt.stillQueued) })
        // A backend that breaks the receipt contract by throwing gets the
        // same revocation; the catch must not keep the dock.
        .catch(() => { settle('failed', dockedNow) })
      return dockable.length
    },

    /** Send every docked message now (⏎ on an empty draft, or the clickable
     *  dock hint): FIFO through the same dispatch chain a typed submit uses,
     *  exactly once; the docked rows leave first and their deliveries
     *  enqueue fresh pending previews. Rows still awaiting their interrupt
     *  receipt are held (their backend copies may yet run) and stay parked,
     *  with a notice, until the receipt confirms. Returns the count sent. */
    deliverDocked(): number {
      owner.assertActive()
      const state = getState()
      const held = (id: string): boolean => input.provisionalDockIds?.includes(id) === true
      const docked = state.pending.filter(item => item.docked === true)
      if (docked.length === 0) return 0
      // Provisional rows are always the newest dock batches, so the confirmed
      // remainder is a FIFO prefix; holding the tail never reorders anyone.
      const ready = docked.filter(item => !held(item.id))
      if (ready.length < docked.length) {
        state.notify(t('input-dock-confirming', { n: docked.length - ready.length }), { color: 'warning', timeoutMs: 4000 })
      }
      if (ready.length === 0) return 0
      state.pending = state.pending.filter(item => item.docked !== true || held(item.id))
      state.emit()
      for (const entry of ready) {
        touch(state.agentId)
        dispatchUserText(entry.text, 'followup', entry.images)
      }
      return ready.length
    },

    /**
     * Lossless swap: retract the docked row `id` and park the live draft
     * (text + staged images) at the pending tail as a new docked row, in one
     * queue write; nothing sends. The draft's id is prefixed and purely
     * local: the backend never saw this text, so no inbox event can match
     * it, and the row stays out of the in-flight interrupt receipt's
     * uncovered set (that fence is for rows the backend may still hold).
     * False when `id` is no longer docked (the receipt un-docked it, a claim
     * retired it, another editor took it) or while an unsettled interrupt
     * receipt holds it: the caller keeps its draft and says so.
     */
    swapDockedForDraft(id: string, draft: { text: string; images?: readonly ComposerImageRef[] }): boolean {
      owner.assertActive()
      const state = getState()
      const index = state.pending.findIndex(item => item.id === id)
      if (index === -1 || state.pending[index]!.docked !== true) return false
      // The clicked row's backend copy may still run while its receipt
      // is in flight; swapping its text into the composer now would hand
      // the user a second copy the late revocation cannot reach.
      if (input.provisionalDockIds?.includes(id) === true) return false
      // A docked retract is purely local on every backend (see removePending).
      state.pending = [
        ...state.pending.filter(item => item.id !== id),
        {
          id: `dock-swap-${randomUUID()}`,
          text: draft.text,
          images: [...(draft.images ?? [])],
          placement: 'followup',
          docked: true,
        },
      ]
      state.emit()
      return true
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
      // (Exception: an in-flight 'user' cancel kept the backend queue, so
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
        // of the given inputs, since docked rows are the oldest texts (FIFO).
        // Rows still awaiting their receipt stay parked for the verdict:
        // their backend copies may still run.
        const heldHere = (id: string): boolean => input.provisionalDockIds?.includes(id) === true
        const docked = state.pending.filter(item => item.docked === true && !heldHere(item.id))
        if (docked.length > 0) {
          state.pending = state.pending.filter(item => item.docked !== true || heldHere(item.id))
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
