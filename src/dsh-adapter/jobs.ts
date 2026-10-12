import type { BackgroundJobOutputChannel, BackgroundJobOutputLine, BackgroundJobStatus, BackgroundJobState, JobTimelineEvent } from '../adapter/ports/channel-view.js'
export type { BackgroundJobOutputChannel, BackgroundJobOutputLine, BackgroundJobStatus, BackgroundJobState, JobTimelineEvent } from '../adapter/ports/channel-view.js'


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
  /** Live producer progress line (`3/10`, phase name); cleared at settle. */
  progress?: string
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** Epoch ms when the job settled; absent while running/stopping. */
  finishedAt?: number
  /** Output-ring facts when the snapshot came from the real registry:
   *  `total`/`earliest` are absolute byte coordinates; `spillPaths` name
   *  producer-retained files holding the complete stream. */
  output?: { total: number; earliest: number; spillPaths?: readonly string[] }
}

/** Kernel `output` event: no payload — observers pull `readAt` themselves. */
export interface KernelJobOutputEvent {
  type: 'output'
  id: string
  owner?: string
  total: number
}

/** Kernel lifecycle event carrying the committed job projection. */
export interface KernelJobLifecycleEvent {
  type: 'registered' | 'progress' | 'stopping' | 'settled' | 'removed'
  job: BackgroundJobSnapshot
  /** Settlement extras (`settled` only): who ended it, whether a waiter
   *  had already collected it (the UI skips duplicate toasts then). */
  cause?: 'producer' | 'kill' | 'teardown'
  awaited?: boolean
}

export type KernelJobEvent = KernelJobOutputEvent | KernelJobLifecycleEvent

/** One kernel output-ring chunk at an absolute byte offset. */
export interface KernelJobChunk {
  at: number
  text: string
  channel?: BackgroundJobOutputChannel
  gapBefore?: true
}

/** Non-consuming ring read result; `next` is the resume offset. */
export interface KernelJobOutputRead {
  chunks: readonly KernelJobChunk[]
  next: number
  lossy?: boolean
}

/**
 * Duck-typed registry surface the channel consumes. `caller` is the owning
 * session id string (`Agent.id`): the kernel fence compares
 * `job.owner.id === caller`, so passing the Agent OBJECT matches nothing —
 * the id string is the only value that opens owned jobs.
 */
export interface JobsRuntime {
  /** Caller-owned + unowned job snapshots in registration order. */
  list(caller?: string): BackgroundJobSnapshot[]
  /** Request cancellation by id; resolves to 'requested'/'already-finished'. */
  kill(id: string, caller?: string, reason?: string): unknown
  /**
   * Kernel event bus (the real `JobRegistry.events` surface). Present on
   * modern kernels: lifecycle events re-read the roster, `output` events
   * pull `readAt` increments with the UI's own byte cursor. Absent on older
   * kernels and test doubles — the mirror falls back to `onJobsChanged` +
   * `job_output` tails.
   */
  events?: {
    subscribe(
      filter: { owner?: string; owners?: 'all' | 'scope' },
      listener: (event: KernelJobEvent) => void,
    ): () => void
  }
  /** Non-consuming ring read at an absolute byte offset (kernel `readAt`). */
  readAt?(id: string, from: number, caller?: string): KernelJobOutputRead
  /** Legacy push hooks; absent on the real registry, kept for old doubles. */
  onJobsChanged?(listener: (owner: unknown) => void): () => void
  onJobDone?(listener: (snapshot: BackgroundJobSnapshot, owner: unknown) => void): () => void
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
/** Timeline events retained per job: the /jobs detail renders the latest
 *  slice; older observations are dropped, never re-derived. */
export const JOBS_MAX_TIMELINE = 40
/** A `job_output` result's trailing status suffix — never a waterfall line. */
const STATUS_SUFFIX_PATTERN = /^\s*\[status:\s/

function isTerminal(status: BackgroundJobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/**
 * Ordered store of the current conversation's background jobs. Roster: fed by
 * {@link BackgroundJobStore.replace} with a fresh `list()` after every
 * lifecycle commit (kernel `events` bus when reachable, `onJobsChanged`
 * legacy hooks otherwise), and trimmed by {@link BackgroundJobStore.drop} for
 * the records the registry announces as `removed` (work the model never saw
 * an id for, such as a shell tool's foreground command). Output: two tiers —
 * kernel `output` events pull
 * non-consuming `readAt` increments through {@link BackgroundJobStore.onKernelOutput}
 * (live, channel-labelled, gap-aware), and `job_output` tool-result tails
 * land in {@link BackgroundJobStore.onOutputSeen} as the fallback mirror.
 * Emits no React state of its own — the channel wires the events into its
 * version bump, exactly like the subagent projection.
 */
interface KernelReadState {
  /** Next byte offset to readAt (kernel `next`; starts at `earliest`). */
  cursor: number
  /** Unconsumed tail of the last chunk that did not end in a newline. */
  partial: string
}

/** Append one bounded timeline observation. Timeline events live directly
 *  on the job state so a snapshot reader sees them without a second lookup;
 *  the ring drops the oldest entries, and the detail renders the latest
 *  slice without implying a complete history. */
function recordTimeline(job: BackgroundJobState, event: JobTimelineEvent): void {
  const timeline = [...(job.timeline ?? []), event]
  job.timeline = timeline.length > JOBS_MAX_TIMELINE ? timeline.slice(timeline.length - JOBS_MAX_TIMELINE) : timeline
}

export class BackgroundJobStore {
  private readonly jobs = new Map<string, BackgroundJobState>()
  /** Kernel-ring read state per job id (own cursor — never the model's). */
  private readonly kernelReads = new Map<string, KernelReadState>()
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
          ...(snap.progress === undefined ? {} : { progress: snap.progress }),
          ...(snap.progress === undefined || snap.progress === '' ? {} : { lastProgress: snap.progress, lastProgressAt: Date.now() }),
          startedAt: snap.startedAt,
          ...(snap.finishedAt === undefined ? {} : { finishedAt: snap.finishedAt }),
          outputLines: [],
          // First sight already terminal (a roster refresh mid-flight missed
          // the live phase): the timeline starts at the settle fact.
          timeline: [{ kind: isTerminal(snap.status) ? 'settled' : 'started', at: snap.startedAt, ...(snap.detail === undefined ? {} : { text: snap.detail }) }],
          ...(snap.output === undefined ? {} : {
            outputTotalBytes: snap.output.total,
            ...(snap.output.spillPaths === undefined || snap.output.spillPaths.length === 0 ? {} : { spillPaths: [...snap.output.spillPaths] }),
          }),
        })
        if (snap.output !== undefined) this.seedKernelRead(snap.id, snap.output.earliest)
        changed = true
        continue
      }
      if (
        prev.status === snap.status &&
        prev.detail === snap.detail &&
        prev.label === snap.label &&
        prev.progress === snap.progress &&
        prev.finishedAt === snap.finishedAt
      ) continue
      const wasLive = !isTerminal(prev.status)
      // Captured before the write below: the lifecycle-event gate compares
      // against the previous status, which the assignment overwrites.
      const prevStatus = prev.status
      prev.status = snap.status
      prev.label = snap.label
      if (snap.detail === undefined) delete prev.detail
      else prev.detail = snap.detail
      if (snap.progress === undefined) delete prev.progress
      else prev.progress = snap.progress
      // The live progress line dies at settle, but the last thing the producer
      // said survives for the focused detail, with its observation time (the
      // source is the producer kind the row already names).
      if (snap.progress !== undefined && snap.progress !== '') {
        prev.lastProgress = snap.progress
        prev.lastProgressAt = Date.now()
        recordTimeline(prev, { kind: 'progress', at: prev.lastProgressAt, text: snap.progress })
      }
      if (snap.finishedAt === undefined) delete prev.finishedAt
      else prev.finishedAt = snap.finishedAt
      // Lifecycle observations land in the timeline ring: stopping, and the
      // terminal transition with its detail (exit code, kill cause).
      if (prevStatus !== snap.status) {
        recordTimeline(prev, {
          kind: snap.status === 'stopping' ? 'stopping' : isTerminal(snap.status) ? 'settled' : 'started',
          at: snap.finishedAt ?? Date.now(),
          ...(snap.detail === undefined ? {} : { text: snap.detail }),
        })
      }
      if (snap.output !== undefined) {
        prev.outputTotalBytes = snap.output.total
        if (snap.output.spillPaths !== undefined && snap.output.spillPaths.length > 0) prev.spillPaths = [...snap.output.spillPaths]
        this.seedKernelRead(snap.id, snap.output.earliest)
      }
      changed = true
      if (wasLive && isTerminal(snap.status)) this.events.onSettled?.(prev)
    }
    for (const job of this.jobs.values()) {
      if (seen.has(job.id) || isTerminal(job.status)) continue
      job.status = 'killed'
      job.finishedAt = Date.now()
      recordTimeline(job, { kind: 'settled', at: job.finishedAt })
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
      .map(text => ({ text }))
    if (lines.length === 0) return
    job.outputLines = [...job.outputLines, ...lines].slice(-JOBS_MAX_OUTPUT_LINES)
    job.lastOutputAt = at
    recordTimeline(job, { kind: 'output', at, bytes: text.length })
    this.events.onChanged?.()
  }

  /**
   * Seed the kernel-ring cursor for one job at its retained head. Called from
   * replace() whenever a snapshot carries ring facts — before any output
   * pull — so the first readAt starts at `earliest`, never at 0 (bytes
   * before `earliest` are already evicted).
   */
  private seedKernelRead(id: string, earliest: number): void {
    const read = this.kernelReads.get(id)
    if (read === undefined) this.kernelReads.set(id, { cursor: earliest, partial: '' })
    else if (read.cursor < earliest) {
      // Ring evicted past our cursor: resync and mark the discontinuity.
      read.cursor = earliest
      read.partial = ''
      const job = this.jobs.get(id)
      if (job !== undefined) {
        job.outputDropped = true
        job.gapCount = (job.gapCount ?? 0) + 1
        recordTimeline(job, { kind: 'gap', at: Date.now() })
      }
    }
  }

  /**
   * Pull one non-consuming increment from the kernel ring after an `output`
   * event. Chunks split into lines; a chunk without a trailing newline parks
   * its tail until the next pull (producers append streaming bytes, so line
   * boundaries routinely straddle chunks). `gapBefore`/`lossy` mark bytes
   * lost before the retained tail — surfaced as the dropped banner.
   */
  onKernelOutput(id: string, read: KernelJobOutputRead, at = Date.now()): void {
    const job = this.jobs.get(id)
    if (job === undefined) return
    const state = this.kernelReads.get(id) ?? { cursor: 0, partial: '' }
    this.kernelReads.set(id, state)
    const startCursor = state.cursor
    const appended: BackgroundJobOutputLine[] = []
    let gapPending = read.lossy === true
    let gapSeen = read.lossy === true
    for (const chunk of read.chunks) {
      if (chunk.gapBefore === true) { gapPending = true; gapSeen = true }
      let text = state.partial + chunk.text
      state.partial = ''
      // A \r not followed by \n is a same-line rewrite (progress spinners);
      // keep the tail after the last one so the panel shows the newest form.
      const lines = text.split(/\r?\n/)
      if (!text.endsWith('\n')) {
        state.partial = lines.pop() ?? ''
      } else {
        lines.pop()
      }
      for (const raw of lines) {
        const trimmed = raw.replace(/\s+$/, '')
        if (trimmed === '') continue
        appended.push({ text: trimmed, ...(chunk.channel === undefined ? {} : { channel: chunk.channel }), ...(gapPending ? { gapBefore: true } : {}) })
        gapPending = false
      }
      if (state.partial !== '') {
        // Re-split parked tail the same way so an embedded \r refreshes it.
        const parts = state.partial.split(/\r(?!\n)/)
        state.partial = parts[parts.length - 1]
      }
    }
    state.cursor = read.next
    if (gapSeen) {
      job.outputDropped = true
      job.gapCount = (job.gapCount ?? 0) + 1
      recordTimeline(job, { kind: 'gap', at })
    }
    if (appended.length > 0) {
      job.outputLines = [...job.outputLines, ...appended].slice(-JOBS_MAX_OUTPUT_LINES)
      job.lastOutputAt = at
      // One observation per drain: the bytes this pull advanced and the
      // dominant channel label, when the chunks carried one.
      const channel = appended.find(line => line.channel !== undefined)?.channel
      recordTimeline(job, { kind: 'output', at, bytes: read.next - startCursor, ...(channel === undefined ? {} : { channel }) })
      this.events.onChanged?.()
    } else if (job.outputTotalBytes !== read.next) {
      this.events.onChanged?.()
    }
    job.outputTotalBytes = Math.max(job.outputTotalBytes ?? 0, read.next)
  }

  /** Kernel read state accessor for tests and cursor diagnostics. */
  kernelCursorOf(id: string): number | undefined {
    return this.kernelReads.get(id)?.cursor
  }

  /** A fresh snapshot in registration order (newest tracked job last). */
  snapshot(): readonly BackgroundJobState[] {
    return [...this.jobs.values()]
  }

  get(id: string): BackgroundJobState | undefined {
    return this.jobs.get(id)
  }

  /**
   * Drop one job's record after the registry announced `removed` — a caller
   * collected the terminal state through its own wait and never handed the id
   * to the model (the shell tool's foreground command). The record left the
   * registry's visible set, so it leaves ours too; `reset()` is the bulk form.
   */
  drop(id: string): void {
    if (!this.jobs.delete(id)) return
    this.kernelReads.delete(id)
    this.pendingCommands.delete(id)
    this.events.onChanged?.()
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
    this.kernelReads.clear()
    this.events.onChanged?.()
  }
}

// The formatter is backend-neutral (src/channel/job-format.ts); re-exported
// here for the existing importers.
export { formatJobDuration } from '../channel/job-format.js'
