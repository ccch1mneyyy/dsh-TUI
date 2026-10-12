import type { Agent } from '@deepseek-ai/dsh-agent'
import { markChannelReadDirty } from '../../adapter/channel/read-view.js'
import { t } from '../../i18n.js'
import { BackgroundJobStore, formatJobDuration, type BackgroundJobState, type JobsRuntime } from '../jobs.js'
import type { ChannelOwner } from './owner.js'
import { toolCommandOf } from './projection-helpers.js'
import type { ChannelState, ChatRow, JobControl } from './types.js'

/**
 * Current-binding background-job projection. The registry can publish every
 * owner's changes, so callbacks must prove their attachment and Channel owner
 * are still current before they read a service or mutate projected rows.
 */
export function createJobProjection(
  getState: () => Pick<ChannelState, 'backgroundJobs' | 'rows' | 'emit'>,
  deps: {
    owner: Pick<ChannelOwner, 'current' | 'own'>
    notify(text: string, options?: { color?: 'success' | 'error' | 'warning'; timeoutMs?: number }): unknown
    rowIds: { value: number }
    agent(): Agent
    steer(text: string): void
    /** The bound session's durable log, for seeding the hold ledger when a
     *  binding takes over a session that already has a call in flight. */
    history?(): readonly unknown[]
  },
) {
  const jobRowsByJobId = new Map<string, ChatRow>()
  /**
   * Settlements a waiting caller collected itself (kernel `awaited`), held for
   * the roster fold in flight: their result is already on screen, so the
   * completion toast skips them.
   */
  const collectedSettles = new Set<string>()
  /** Open `command`-carrying tool calls of the bound session (callId → command). */
  const openCommandCalls = new Map<string, string>()
  /**
   * Cards held back because the calls that could own the job are still in
   * flight (jobId → callIds). A shell tool registers its foreground command as
   * a job like any other and hands the id to nobody, so a card now would
   * duplicate the call's own card for as long as the command runs. The card
   * appears when every such call has returned — the moment the id, if any,
   * reaches the model — and never for a foreground command, whose record the
   * registry drops before its call returns.
   */
  const heldJobs = new Map<string, Set<string>>()
  let jobsRuntime: JobsRuntime | undefined
  /** The live attachment's conditional roster re-read (see `reanchor`). */
  let reanchorActive: (() => void) | undefined
  let detachActive: (() => void) | undefined
  let attachmentToken: symbol | undefined
  let attachmentCurrent = (): boolean => false

  const syncRows = (): void => {
    if (!attachmentCurrent()) return
    const state = getState()
    const jobs = store.snapshot()
    state.backgroundJobs = jobs
    for (const job of jobs) {
      if (!jobRowsByJobId.has(job.id)) {
        // A card waits while a call that could own the job is in flight: that
        // call's own card already carries this work (see `heldJobs`).
        if (heldJobs.has(job.id)) continue
        const owners = openCallsOwning(job.label)
        if (owners.size > 0) {
          heldJobs.set(job.id, owners)
          continue
        }
      }
      materializeRow(state, job)
    }
  }

  /** Create or refresh one job's transcript card. */
  const materializeRow = (state: Pick<ChannelState, 'rows'>, job: BackgroundJobState): void => {
    let row = jobRowsByJobId.get(job.id)
    if (!row) {
      row = { id: deps.rowIds.value++, kind: 'job', text: job.label, job: undefined }
      jobRowsByJobId.set(job.id, row)
      state.rows.push(row)
    }
    row.job = {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      ...(job.detail === undefined ? {} : { detail: job.detail }),
      ...(job.progress === undefined ? {} : { progress: job.progress }),
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      outputLines: job.outputLines,
    }
    row.text = job.label
    markChannelReadDirty(row)
    markChannelReadDirty(state.rows)
  }

  /**
   * Take one job's card out of the transcript. Only an explicit departure
   * (the registry's `removed`) does this: a record the store itself evicts at
   * its tracked bound keeps its card as frozen history, exactly as it did
   * before cards could leave at all.
   */
  const dropRow = (jobId: string): void => {
    const row = jobRowsByJobId.get(jobId)
    if (row === undefined) return
    jobRowsByJobId.delete(jobId)
    const rows = getState().rows
    const at = rows.indexOf(row)
    if (at === -1) return
    rows.splice(at, 1)
    markChannelReadDirty(rows)
  }

  const store = new BackgroundJobStore({
    onSettled(job) {
      // A settlement a waiting caller collected (kernel `awaited`) already has
      // its result in the transcript — the shell tool's own foreground wait —
      // so there is nothing left to announce. The harness's completion
      // notices skip the same settlements.
      if (collectedSettles.delete(job.id)) return
      deps.notify(
        t(job.status === 'completed' ? 'jobs-toast-completed' : job.status === 'failed' ? 'jobs-toast-failed' : 'jobs-toast-killed', {
          id: job.id,
          label: job.label,
          duration: formatJobDuration(job),
          detail: job.detail ?? '',
        }),
        { color: job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : 'warning', timeoutMs: 6000 },
      )
    },
    onChanged() {
      if (!attachmentCurrent()) return
      syncRows()
      if (attachmentCurrent()) getState().emit()
    },
  })

  const control: JobControl = {
    kill(id) {
      const jobs = jobsRuntime
      if (!jobs?.kill) return false
      const job = store.get(id)
      try {
        // The kernel fence compares job.owner.id === caller, so the caller
        // MUST be the session id string — the Agent object matches nothing
        // and every owned-job kill would throw "another session".
        jobs.kill(id, sessionCaller(), 'dsh-tui /jobs panel')
      } catch {
        return false
      }
      if (job !== undefined && (job.status === 'running' || job.status === 'stopping')) {
        deps.steer(t('jobs-steer-killed', { id, label: job.label }))
      }
      return true
    },
  }

  /**
   * Caller identity for the kernel fence: the owning session id string
   * (`Agent.id`). The registry compares `job.owner.id === caller`, so the
   * Agent object the channel holds is only good for extracting the id.
   */
  const sessionCaller = (): string | undefined => {
    const agent = deps.agent() as { id?: string } | undefined
    return agent?.id
  }

  /** Every open call whose command this job's label repeats. The label a shell
   *  tool registers is the command it was handed, so a match is the same string
   *  the model passed — not a resemblance. */
  const openCallsOwning = (label: string): Set<string> => {
    const owners = new Set<string>()
    for (const [callId, command] of openCommandCalls) {
      if (command === label) owners.add(callId)
    }
    return owners
  }

  /**
   * End one hold and render its card now: having no row yet is what makes a
   * job a hold candidate, so a released job must land its row in this same
   * turn or the next fold would take the hold right back.
   */
  const releaseHold = (jobId: string): boolean => {
    if (!heldJobs.delete(jobId)) return false
    if (!attachmentCurrent()) return false
    const job = store.get(jobId)
    if (job === undefined) return false
    materializeRow(getState(), job)
    return true
  }

  /**
   * Fold one raw durable event into the in-flight call ledger of the bound
   * session: a `tool/call` carrying a `command` opens an entry, its
   * `tool/result` closes it.
   * @returns the callId this event closed, when it closed one.
   */
  const observeCall = (event: unknown): string | undefined => {
    const type = (event as { type?: unknown }).type
    if (type === 'tool/call') {
      const data = (event as { data?: { callId?: unknown; arguments?: unknown } }).data
      if (typeof data?.callId !== 'string') return undefined
      const command = toolCommandOf(typeof data.arguments === 'string' ? data.arguments : undefined)
      if (command !== undefined) openCommandCalls.set(data.callId, command)
      return undefined
    }
    if (type !== 'tool/result') return undefined
    const callId = (event as { data?: { message?: { source?: { callId?: unknown } } } })
      .data?.message?.source?.callId
    if (typeof callId !== 'string' || !openCommandCalls.delete(callId)) return undefined
    return callId
  }

  /**
   * Rebuild the ledger from the bound session's log. A call the log shows
   * without its result was already in flight when this binding took the
   * session over (a parked/background session the user switched back to), and
   * the card it registered has to stay held across the swap.
   */
  const seedOpenCalls = (): void => {
    openCommandCalls.clear()
    for (const event of deps.history?.() ?? []) observeCall(event)
  }

  /**
   * Raw durable events of the bound session, ahead of the projector's fold:
   * the ledger above times the card hold, and a result releases it.
   */
  const onSessionEvent = (event: unknown): void => {
    const closed = observeCall(event)
    if (closed === undefined) return
    // This call is over. A card it was holding waits for the others it could
    // belong to; a job the call collected and removed on its way out is already
    // gone from the store and owes nothing.
    let released = false
    for (const [jobId, held] of heldJobs) {
      if (!held.delete(closed)) continue
      if (held.size > 0) continue
      if (releaseHold(jobId)) released = true
    }
    if (!released) return
    syncRows()
    getState().emit()
  }

  /**
   * Each service attachment has one idempotent disposer, dual-owned by the
   * Channel and (when injected) the service context. Reattachment revokes the
   * prior token before the replacement may synchronously publish.
   */
  const attach = (jobs: JobsRuntime | undefined, ownService?: (dispose: () => void) => void): void => {
    if (jobs === undefined) return
    detachActive?.()
    jobsRuntime = jobs
    const token = Symbol('jobs-attachment')
    let detached = false
    let detach: () => void
    const current = (): boolean => !detached && attachmentToken === token && detachActive === detach && jobsRuntime === jobs && deps.owner.current()
    // The caller the roster was last read with. `reanchor` compares against it
    // so a bind that did NOT change the session stays a no-op — mounting binds
    // the channel's own agent immediately after the service attaches, and
    // re-reading there would be a second, redundant list().
    let lastCaller: string | undefined
    let callerKnown = false
    const refresh = (): void => {
      // Check before list(): retained callbacks must not touch a revoked or
      // replaced service, nor invoke any store/row work after owner disposal.
      if (!current()) return
      try {
        const caller = sessionCaller()
        lastCaller = caller
        callerKnown = true
        const snapshot = jobs.list(caller)
        if (!current()) return
        store.replace(snapshot)
      } catch { /* optional service is disposing */ }
    }
    /** Re-read only when the bound session actually changed. */
    const reanchorThis = (): void => {
      if (callerKnown && sessionCaller() === lastCaller) return
      dropRows()
      // The new session may already have a call in flight (a parked session the
      // user switched back to), whose job the roster about to be read lists:
      // seed the ledger before that read decides any card.
      seedOpenCalls()
      store.reset()
      refresh()
    }
    /** One kernel `output` event: pull the ring increment past our cursor. */
    const pullOutput = (id: string): void => {
      if (!current()) return
      if (jobs.readAt === undefined) return
      const cursor = store.kernelCursorOf(id)
      if (cursor === undefined) return
      try {
        const read = jobs.readAt(id, cursor, sessionCaller())
        if (!current()) return
        store.onKernelOutput(id, read)
      } catch { /* job gone or fenced mid-pull; roster refresh follows */ }
    }
    // Publish the attachment identity before subscription: registries are
    // allowed to synchronously deliver their current snapshot from on*().
    // Every registration below is transactional because a second on*() can
    // throw after the first one successfully subscribed.
    const disposers: Array<(() => void) | undefined> = []
    let releaseOwner: (() => void) | undefined
    detach = (): void => {
      if (detached) return
      detached = true
      if (detachActive === detach) {
        detachActive = undefined
        attachmentToken = undefined
        attachmentCurrent = () => false
      }
      if (jobsRuntime === jobs) jobsRuntime = undefined
      if (reanchorActive === reanchorThis) reanchorActive = undefined
      for (const dispose of disposers.splice(0)) dispose?.()
      // A service-context detach happens before channel teardown on remount;
      // release its Channel owner entry now rather than retaining one cleanup
      // per remount until the entire channel exits.
      const release = releaseOwner
      releaseOwner = undefined
      release?.()
    }
    detachActive = detach
    attachmentToken = token
    attachmentCurrent = current
    reanchorActive = reanchorThis
    try {
      const bus = jobs.events
      if (bus !== undefined && typeof bus.subscribe === 'function') {
        // Kernel bus: lifecycle commits re-read the roster; output events
        // pull non-consuming readAt increments with the store's own cursor.
        // Subscribe to EVERY owner on purpose: this filter is captured at
        // attach, but the channel still rebinds afterwards (dsh-tui opens a
        // fresh session at boot and only then resumes the user's), and a filter
        // frozen to the boot session starves the panel for good — the kernel
        // drops every foreign-owner event, refresh() never runs again and the
        // roster stays at the empty list read during attach. Nothing extra is
        // exposed by widening it: the roster read is list(caller) and the ring
        // pull is readAt(id, cursor, caller), both fenced with the caller AT
        // CALL TIME, so another session's jobs fall out (and a foreign ring
        // read throws into the contained catch).
        disposers.push(bus.subscribe({ owners: 'all' }, event => {
          if (!current()) return
          try {
            if (event.type === 'output') pullOutput(event.id)
            else if (event.type === 'removed') {
              // The registry dropped the record — a caller collected the
              // terminal state through its own wait and never handed the id to
              // the model (the shell tool's foreground command), or the owner
              // was disposed. The card goes with it instead of lingering as
              // frozen history; a held card was never rendered at all.
              heldJobs.delete(event.job.id)
              dropRow(event.job.id)
              store.drop(event.job.id)
            } else {
              // `settled` reports whether it released a waiter: that caller's
              // own wait collected the outcome, so the settlement is announced
              // nowhere. The mark is good for exactly the fold below.
              const collected = event.type === 'settled' && event.awaited === true
              if (collected) collectedSettles.add(event.job.id)
              // A settlement nobody collected is model-facing on its own (the
              // harness sends its completion notice), so a held card may stop
              // waiting for its call — the waiting CALLER's settlements are
              // exactly the ones that must stay hidden until the record drops.
              else if (event.type === 'settled' && event.awaited === false) releaseHold(event.job.id)
              refresh()
              if (collected) collectedSettles.delete(event.job.id)
            }
          } catch { /* contained per-event; the next event re-syncs */ }
        }))
      }
      if (typeof jobs.onJobsChanged === 'function') disposers.push(jobs.onJobsChanged(refresh))
      if (typeof jobs.onJobDone === 'function') disposers.push(jobs.onJobDone(refresh))
      releaseOwner = deps.owner.own(detach)
      ownService?.(detach)
      refresh()
    } catch (error) {
      detach()
      throw error
    }
  }

  const dropRows = (): void => {
    jobRowsByJobId.clear()
    collectedSettles.clear()
    heldJobs.clear()
    openCommandCalls.clear()
  }
  const reset = (): void => { dropRows(); store.reset() }

  /**
   * Re-anchor after the live agent changed. `reset()` runs while the OLD
   * binding is still installed (resetSessionProjection precedes bindAgent), so
   * it can only clear; the re-read has to happen here, once the new agent is
   * bound, or the next session's jobs would only appear on its first event.
   */
  const reanchor = (): void => { reanchorActive?.() }

  return { store, control, attach, dropRows, reset, reanchor, onSessionEvent }
}
