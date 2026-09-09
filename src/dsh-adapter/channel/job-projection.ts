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
        jobs.kill(id, deps.agent(), 'dsh-tui /jobs panel')
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
        const snapshot = jobs.list(deps.agent())
        if (!current()) return
        store.replace(snapshot)
      } catch { /* optional service is disposing */ }
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
