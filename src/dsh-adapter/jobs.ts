/**
 * Background-job projection for the UI (`/jobs` panel, transcript cards,
 * status-line chip, completion toasts).
 *
 * The domain model sits on top of the harness job registry (`ctx.jobs`,
 * `@deepseek-ai/dsh-jobs`). The registry is an optional service the TUI
 * never hard-depends on: channel.ts reaches it through a local structural
 * type ({@link JobsRuntime}), so compositions without the jobs plugin load
 * the UI unchanged with the feature silently off.
 *
 * Two registry rules shape everything here:
 *
 * - `read()` is CONSUMING (one cursor per job) and a terminal read marks the
 *   job reported, which would eat the owning agent's `job_output` delta and
 *   suppress its completion notice. The UI therefore NEVER reads: the
 *   three-line output waterfall on a card is mirrored from the agent's own
 *   `job_output` tool results as they stream through the session event log
 *   ({@link BackgroundJobStore.onOutputSeen}), not polled.
 * - Jobs are process-local and owner-fenced. `list(agent)` returns exactly
 *   the jobs the current conversation owns (plus unowned ones); a job that
 *   disappears while live was teardown-cancelled (owner disposal / session
 *   swap) and is frozen as `killed` so no transcript card ticks forever.
 *
 * @module jobs
 */

/** Terminal / live lifecycle states, mirrored from the registry contract. */
export type BackgroundJobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/**
 * Structural mirror of the registry's `JobSnapshot` — only the fields the
 * UI reads. Declared locally so no `@deepseek-ai/dsh-jobs` dependency (peer
 * range churn) is introduced; the harness service satisfies this shape.
 */
export interface BackgroundJobSnapshot {
  /** Registry-issued id (`<kind>-N`, e.g. `pwsh-3`). */
  id: string
  /** Producer kind (`bash`, `pwsh`, `subagent`, `pty-send`, …). */
  kind: string
  /** One-line label — the command or delegation description. */
  label: string
  status: BackgroundJobStatus
  /** Kind-specific status detail, usually terminal ('exit code: 0'). */
  detail?: string
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** Epoch ms when the job settled; absent while running/stopping. */
  finishedAt?: number
}

/**
 * Duck-typed registry surface the channel consumes. `caller` is the owning
 * live agent (`Agent` in the harness) — typed as object here because the
 * UI only forwards the instance it already holds.
 */
export interface JobsRuntime {
  /** Caller-owned + unowned job snapshots in registration order. */
  list(caller?: object): BackgroundJobSnapshot[]
  /** Request cancellation by id; resolves to 'requested'/'already-finished'. */
  kill(id: string, caller?: object, reason?: string): unknown
  /** Fires after every commit changing one owner's visible set; re-read. */
  onJobsChanged?(listener: (owner: unknown) => void): () => void
  /** Fires on every settlement with the terminal snapshot + owner. */
  onJobDone?(listener: (snapshot: BackgroundJobSnapshot, owner: unknown) => void): () => void
}

/** One tracked job as the UI renders it. */
export interface BackgroundJobState {
  id: string
  kind: string
  label: string
  /** The full command that started the job, captured from the originating
   *  tool call's args (`command`/`text`); the registry label is the friendly
   *  description. Absent when the start ack never streamed through (replay
   *  without the tool card, subagent one-shot jobs, …). */
  command?: string
  status: BackgroundJobStatus
  detail?: string
  startedAt: number
  finishedAt?: number
  /** Last-seen output tail (mirrored `job_output` text), newest last. */
  outputLines: string[]
  /** Epoch ms of the last mirrored `job_output` read (receipt time). */
  lastOutputAt?: number
}

/** Store event hooks the channel injects (toast on settle, emit on change). */
export interface BackgroundJobEvents {
  /** A job the store knew live just settled (or vanished mid-flight). */
  onSettled?(job: BackgroundJobState): void
  /** The visible set changed; the channel syncs rows and emits. */
  onChanged?(): void
}

/** Total tracked jobs kept (running plus most recent terminal ones). */
export const JOBS_MAX_TRACKED = 40
/** Output tail lines retained per job (the card waterfall shows the last 3;
 *  the /jobs panel detail shows the whole retained tail). */
export const JOBS_MAX_OUTPUT_LINES = 30
/** A `job_output` result's trailing status suffix — never a waterfall line. */
const STATUS_SUFFIX_PATTERN = /^\s*\[status:\s/

function isTerminal(status: BackgroundJobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/**
 * Ordered store of the current conversation's background jobs. Fed by
 * {@link BackgroundJobStore.replace} with a fresh `list()` after every
 * `onJobsChanged` commit, and by {@link BackgroundJobStore.onOutputSeen}
 * with the tail of every `job_output` tool result. Emits no React state of
 * its own — the channel wires the events into its version bump, exactly
 * like the subagent projection.
 */
export class BackgroundJobStore {
  private readonly jobs = new Map<string, BackgroundJobState>()
  /** Commands captured from start acks that arrived before the registry
   *  registered the job (the tool/result stream and the registry commit can
   *  race); consumed on registration. */
  private readonly pendingCommands = new Map<string, string>()

  constructor(private readonly events: BackgroundJobEvents = {}) {}

  /**
   * Diff a fresh `list()` against the tracked set: register new jobs, fold
   * status/detail transitions, and fire `onSettled` for live→terminal moves.
   * Jobs that vanish while live were teardown-cancelled (session swap /
   * owner disposal) and are frozen as `killed` and KEPT as recent history —
   * their transcript rows freeze at a sensible terminal state instead of
   * ticking on, and the panel keeps them alongside other finished work
   * (the tracked bound below trims the oldest terminals).
   */
  replace(snapshots: readonly BackgroundJobSnapshot[]): void {
    const seen = new Set<string>()
    let changed = false
    for (const snap of snapshots) {
      seen.add(snap.id)
      const prev = this.jobs.get(snap.id)
      if (prev === undefined) {
        const command = this.pendingCommands.get(snap.id)
        if (command !== undefined) this.pendingCommands.delete(snap.id)
        this.jobs.set(snap.id, {
          id: snap.id,
          kind: snap.kind,
          label: snap.label,
          ...(command === undefined ? {} : { command }),
          status: snap.status,
          ...(snap.detail === undefined ? {} : { detail: snap.detail }),
          startedAt: snap.startedAt,
          ...(snap.finishedAt === undefined ? {} : { finishedAt: snap.finishedAt }),
          outputLines: [],
        })
        changed = true
        continue
      }
      if (
        prev.status === snap.status &&
        prev.detail === snap.detail &&
        prev.label === snap.label &&
        prev.finishedAt === snap.finishedAt
      ) continue
      const wasLive = !isTerminal(prev.status)
      prev.status = snap.status
      prev.label = snap.label
      if (snap.detail === undefined) delete prev.detail
      else prev.detail = snap.detail
      if (snap.finishedAt === undefined) delete prev.finishedAt
      else prev.finishedAt = snap.finishedAt
      changed = true
      if (wasLive && isTerminal(snap.status)) this.events.onSettled?.(prev)
    }
    for (const job of this.jobs.values()) {
      if (seen.has(job.id) || isTerminal(job.status)) continue
      job.status = 'killed'
      job.finishedAt = Date.now()
      this.events.onSettled?.(job)
      changed = true
    }
    if (this.jobs.size > JOBS_MAX_TRACKED) {
      // Drop the oldest terminal jobs first; live jobs always survive.
      for (const [id, job] of this.jobs) {
        if (this.jobs.size <= JOBS_MAX_TRACKED) break
        if (isTerminal(job.status)) {
          this.jobs.delete(id)
          changed = true
        }
      }
    }
    if (changed) this.events.onChanged?.()
  }

  /**
   * Record the full command that started a job, captured from its tool
   * call's args via the `started background job <id>` ack. May arrive
   * before the registry registers the job — the command is parked and
   * consumed by the next replace().
   */
  onStarted(id: string, command: string): void {
    const job = this.jobs.get(id)
    if (job === undefined) {
      this.pendingCommands.set(id, command)
      return
    }
    if (job.command !== command) {
      job.command = command
      this.events.onChanged?.()
    }
  }

  /**
   * Mirror the tail of a `job_output` tool result for one job. Appends
   * non-empty lines (excluding the tool's `[status: …]` suffix) and keeps
   * the bounded tail. This is the ONLY output feed — the registry's read is
   * consuming and reserved for the owning agent.
   * @param at - wall-clock receipt time of the read (defaults to now).
   */
  onOutputSeen(id: string, text: string, at = Date.now()): void {
    const job = this.jobs.get(id)
    if (job === undefined || text === '') return
    const lines = text
      .split(/\r?\n/)
      .map(line => line.replace(/\s+$/, ''))
      .filter(line => line !== '' && !STATUS_SUFFIX_PATTERN.test(line))
    if (lines.length === 0) return
    job.outputLines = [...job.outputLines, ...lines].slice(-JOBS_MAX_OUTPUT_LINES)
    job.lastOutputAt = at
    this.events.onChanged?.()
  }

  /** A fresh snapshot in registration order (newest tracked job last). */
  snapshot(): readonly BackgroundJobState[] {
    return [...this.jobs.values()]
  }

  get(id: string): BackgroundJobState | undefined {
    return this.jobs.get(id)
  }

  /** Jobs still alive (running or being stopped). */
  runningCount(): number {
    let count = 0
    for (const job of this.jobs.values()) {
      if (!isTerminal(job.status)) count += 1
    }
    return count
  }

  /** Drop everything (session swap / transcript wipe). */
  reset(): void {
    if (this.jobs.size === 0) return
    this.jobs.clear()
    this.events.onChanged?.()
  }
}

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
