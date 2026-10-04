/**
 * What the user sees while a kernel switch restarts the TUI.
 *
 * Between the old process's teardown and the replacement's first frame the
 * old process prints a short status line, so the switch does not look like
 * the TUI just vanished. If the replacement fails, it prints a classified,
 * colored outcome instead of a bare exit code. Success prints nothing: the
 * new kernel's UI is the signal.
 *
 * Event kinds:
 *  - starting      written by finishExit with the terminal cleanup: target
 *                  kernel, and that the current session is kept.
 *  - stage-start   written by the old process right before the spawn,
 *                  waiting for the write callback.
 *  - first-frame   the replacement reported its first flushed frame
 *                  (restart.log only).
 *  - succeeded     the replacement exited cleanly (restart.log only).
 *  - failed        the replacement never came up: yellow, with the
 *                  safe-mode hint; the old session is kept.
 *  - crashed       the replacement ran and later exited nonzero: red, with
 *                  the exit code.
 *
 * Callers decide on color (TTY only), so headless tests and piped output get
 * plain text.
 */
import { Chalk } from 'chalk'
import { t } from './i18n.js'

export type HandoffEventKind = 'starting' | 'stage-start' | 'first-frame' | 'succeeded' | 'failed' | 'crashed'

/** One-line reason vocabulary for failed events (classified, not raw stacks). */
export type HandoffFailureReason = 'spawn-error' | 'boot-failure'

/** What the old process concludes about the replacement's outcome. */
export type ReplacementOutcome =
  | { kind: 'succeeded' }
  | { kind: 'failed'; reason: HandoffFailureReason }
  | { kind: 'crashed'; code: number | null }

/**
 * Classify how a replacement ended. Without a handoff pipe the only signal is
 * time: a death within 4s means the TUI never came up (failed), a clean exit
 * means the user ran and closed a working session (succeeded), and a later
 * nonzero exit is a crash of that session.
 *
 * With the pipe (firstFrameAcked defined) the first flushed frame decides
 * instead: after it every death is post-boot (crashed or succeeded); without
 * it the switch failed however long the process lived.
 */
export function classifyReplacementOutcome(input: {
  spawnError?: unknown
  closed: boolean
  code: number | null
  signal: NodeJS.Signals | null
  elapsedMs: number
  firstFrameAcked?: boolean
}): ReplacementOutcome {
  if (input.spawnError !== undefined || !input.closed) return { kind: 'failed', reason: 'spawn-error' }
  if (input.firstFrameAcked === false) return { kind: 'failed', reason: 'boot-failure' }
  if (input.code === 0) return { kind: 'succeeded' }
  if (input.code === null && input.signal === null) return { kind: 'succeeded' }
  if (input.firstFrameAcked === true) {
    // Post-frame deaths are session-level, not handoff failures.
    return { kind: 'crashed', code: input.code === null && input.signal !== null ? null : input.code }
  }
  if (input.elapsedMs < 4000) return { kind: 'failed', reason: 'boot-failure' }
  // A signal death (code null, signal set) after the window is a crash —
  // the copy renders "signal" instead of a fake code.
  return { kind: 'crashed', code: input.code === null && input.signal !== null ? null : input.code }
}

/**
 * Fixed color level: chalk's auto-detection would look at this process's
 * own pipes. Callers pass color: true only for a TTY.
 */
const COLOR = new Chalk({ level: 2 })

/** Per-kind color: progress is calm, failure is recoverable, crash is red. */
const KIND_COLOR: Record<HandoffEventKind, (text: string) => string> = {
  starting: COLOR.cyan,
  'stage-start': COLOR.cyan,
  'first-frame': COLOR.cyan,
  succeeded: COLOR.green,
  failed: COLOR.yellow,
  crashed: COLOR.red,
}

/** restart.log event tag for a kind. */
export function handoffEventTag(kind: HandoffEventKind): string {
  return 'handoff/' + kind
}

/**
 * Format one event's visible text. Pure: no I/O, clock or env. succeeded and
 * first-frame format to '' because they only go to restart.log.
 */
export function formatHandoffNotice(
  kind: HandoffEventKind,
  options: {
    name: string
    reason?: HandoffFailureReason
    code?: number | null
    safeHint?: boolean
    color?: boolean
  },
): string {
  const paint = options.color === true ? KIND_COLOR[kind] : (text: string) => text
  if (kind === 'succeeded' || kind === 'first-frame') return ''
  if (kind === 'starting') {
    return paint('⟳ ' + t('kernel-handoff-starting', { name: options.name }))
      + '\n  ' + t('kernel-handoff-session-kept')
  }
  if (kind === 'stage-start') {
    return paint('⟳ ' + t('kernel-handoff-stage-start', { name: options.name }))
  }
  if (kind === 'failed') {
    const reasonKey = options.reason === 'spawn-error' ? 'kernel-handoff-failed-reason-spawn' : 'kernel-handoff-failed-reason-boot'
    const lines = [paint(t('kernel-handoff-failed', { reason: t(reasonKey) }))]
    if (options.safeHint === true) lines.push(t('kernel-handoff-safe-hint'))
    return lines.join('\n')
  }
  const code = options.code === undefined ? 'signal' : options.code === null ? 'signal' : String(options.code)
  const lines = [paint(t('kernel-handoff-crashed', { code }))]
  if (options.safeHint === true) lines.push(t('kernel-handoff-safe-hint'))
  return lines.join('\n')
}

/**
 * Write a stage line and resolve once the stream's write callback fires, so
 * the line is out before the caller spawns the replacement. A write that
 * returns true also resolves on the next setImmediate, for sinks that never
 * call back.
 */
export function writeHandoffStage(stream: Pick<NodeJS.WriteStream, 'write'>, text: string): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const done = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    try {
      const returned = stream.write(text, () => done())
      if (returned === false) return // wait for the drain callback
      setImmediate(done)
    } catch {
      done()
    }
  })
}
