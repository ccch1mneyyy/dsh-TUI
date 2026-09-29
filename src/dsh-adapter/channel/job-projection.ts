import type { Agent } from '@deepseek-ai/dsh-agent'
import { markChannelReadDirty } from '../../adapter/channel/read-view.js'
import { t } from '../../i18n.js'
import { BackgroundJobStore, formatJobDuration, type JobsRuntime } from '../jobs.js'
import type { ChannelOwner } from './owner.js'
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
  },
) {
  const jobRowsByJobId = new Map<string, ChatRow>()
  let jobsRuntime: JobsRuntime | undefined
  let detachActive: (() => void) | undefined
  let attachmentToken: symbol | undefined
  let attachmentCurrent = (): boolean => false

  const syncRows = (): void => {
    if (!attachmentCurrent()) return
    const state = getState()
    state.backgroundJobs = store.snapshot()
    for (const job of state.backgroundJobs) {
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
  }

  const store = new BackgroundJobStore({
    onSettled(job) {
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
    const refresh = (): void => {
      // Check before list(): retained callbacks must not touch a revoked or
      // replaced service, nor invoke any store/row work after owner disposal.
      if (!current()) return
      try {
        const snapshot = jobs.list(sessionCaller())
        if (!current()) return
        store.replace(snapshot)
      } catch { /* optional service is disposing */ }
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
    try {
      const bus = jobs.events
      if (bus !== undefined && typeof bus.subscribe === 'function') {
        // Kernel bus: lifecycle commits re-read the roster; output events
        // pull non-consuming readAt increments with the store's own cursor.
        const owner = sessionCaller()
        disposers.push(bus.subscribe(owner === undefined ? { owners: 'all' } : { owner }, event => {
          if (!current()) return
          try {
            if (event.type === 'output') pullOutput(event.id)
            else refresh()
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

  const dropRows = (): void => { jobRowsByJobId.clear() }
  const reset = (): void => { dropRows(); store.reset() }

  return { store, control, attach, dropRows, reset }
}
