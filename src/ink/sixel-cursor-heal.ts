import { cursorPosition, type TerminalQuerier } from './terminal-querier.js'

const REPLY_TIMEOUT_MS = 500
const RECOVERY_WINDOW_MS = 10_000
const COOLDOWN_MS = 60_000

/** One ordered pre-park probe, with bounded recovery and lifecycle cancellation. */
export class SixelCursorHeal {
  private pending: { cancel: () => void } | undefined
  private recoveredAt: number[] = []
  private quietUntil = 0
  private disposed = false

  constructor(
    private readonly recover: () => void,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns bytes to append immediately after the last sixel payload, before CUP. */
  prepare(querier: TerminalQuerier, expected: { row: number; col: number }): string {
    if (this.disposed || this.pending !== undefined || this.now() < this.quietUntil || querier.isSuspended) return ''
    const query = querier.prepare(cursorPosition(), REPLY_TIMEOUT_MS)
    if (query.request === '') return ''
    this.pending = query
    void query.response.then(reply => {
      if (this.pending !== query || this.disposed) return
      this.pending = undefined
      if (reply === undefined) {
        // Private CPR has no request id. Avoid attributing a very late reply
        // to the next frame after a timeout or a DA1 barrier rejected it.
        this.quietUntil = this.now() + COOLDOWN_MS
        this.log('sixel cursor probe unanswered; pausing probes for 60s')
        return
      }
      if (reply.row === expected.row && reply.col === expected.col) return
      const now = this.now()
      this.recoveredAt = this.recoveredAt.filter(time => now - time < RECOVERY_WINDOW_MS)
      this.recoveredAt.push(now)
      if (this.recoveredAt.length >= 3) this.quietUntil = now + COOLDOWN_MS
      this.log(`sixel cursor drift expected=${expected.row},${expected.col} actual=${reply.row},${reply.col}; recovery ${this.recoveredAt.length}/3`)
      this.recover()
    })
    return query.request
  }

  /** Resize/handoff invalidates geometry and quarantines already travelling replies. */
  reset(): void {
    const pending = this.pending
    this.pending = undefined
    pending?.cancel()
    this.quietUntil = Math.max(this.quietUntil, this.now() + REPLY_TIMEOUT_MS)
  }

  dispose(): void {
    this.disposed = true
    this.reset()
    this.recoveredAt = []
  }
}
