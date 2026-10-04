/** Backend-neutral background-job formatting shared by the job stores, the
 *  transcript card, the `/jobs` panel and the status-line chip. */
import type { BackgroundJobState } from '../adapter/ports/channel-view.js'

/** `3s` under a minute, `3m12s` under an hour, `1h02m` beyond — transcript-card compact. */
export function formatJobDuration(job: Pick<BackgroundJobState, 'startedAt' | 'finishedAt'>, now = Date.now()): string {
  const end = job.finishedAt ?? now
  const seconds = Math.max(0, Math.floor((end - job.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}
