/**
 * Kernel-switch handoff events — S05 MVE (deploy-transition design §S05
 * "MVE：先解决『点了像消失』").
 *
 * The old process OWNS the visible transition between the teardown and the
 * replacement's first frame: a flushed, stable status line with a clear
 * tense (switching to X / starting X), and — when the replacement fails —
 * a classified, colored outcome instead of a bare exit-code dump. Success
 * stays quiet: the new kernel's own UI is the success signal (the design
 * forbids pretending a first-frame ACK exists before M1).
 *
 * Event kinds and their contract:
 *  - starting      shown at the finishExit boundary (after terminal
 *                  cleanup, via the flushed notice write): target kernel
 *                  + "the current session is preserved".
 *  - stage-start   shown by the old parent right BEFORE spawning the
 *                  replacement (console is free; written with a drain-
 *                  awaited flush, never a fire-and-forget write).
 *  - succeeded     replacement exited cleanly after owning the terminal —
 *                  restart-log event only, no terminal noise.
 *  - failed        the replacement never came up (spawn error, or death
 *                  inside the 4s survival window): yellow, actionable,
 *                  with the safe-mode remediation hint. The old session is
 *                  preserved — say so.
 *  - crashed       the replacement ran and exited nonzero later: red, with
 *                  the exit code.
 *
 * Coloring is caller-gated (TTY only) so headless regressions and piped
 * output see clean text; the formatter itself is pure and unit-tested.
 *
 * NOT in the MVE: a supervisor owning stdout/stdin across processes, or a
 * first-frame ACK — those are the M1 atomic-screen-handoff work.
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
 * Classify a replacement's end. The 4s survival window stays a DIAGNOSIS
 * marker (design: never promoted to a success fact): a death inside it
 * means the TUI never came up (failed); a clean exit after it means the
 * user owned and closed a working session (succeeded); a later nonzero
 * exit is a session-level crash, not a handoff failure.
 *
 * firstFrameAcked upgrades the fact behind those heuristics (S05 完整版):
 * when the handoff ACK pipe reports the replacement's first frame flushed,
 * every death is post-boot (crashed/succeeded — the user saw a UI); when it
 * reports the replacement died WITHOUT ever flushing a frame, the failure
 * is a boot failure whenever it happens — the 4s timer was only ever a
 * proxy for exactly this observation. Undefined keeps the M0 timer
 * semantics for callers without the protocol (plain /restart, /update,
 * older replacements that predate the ACK pipe).
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
 * Forced-level chalk instance: auto-detection would follow the CREATING
 * process's pipes (a headless regression or a piped run would silently drop
 * the distinction this module exists to provide). The caller decides via
 * the color option; TTY gating belongs to the call sites.
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

/** restart.log event tag for a kind (shared attempt vocabulary, §S05). */
export function handoffEventTag(kind: HandoffEventKind): string {
  return 'handoff/' + kind
}

/**
 * Format one event's visible text. Pure: no stream I/O, no clock, no env.
 * Passing color: false yields plain text (headless/piped consumers and the
 * regression oracle). The succeeded kind formats to an empty string — the
 * new UI is the success signal, the event only reaches restart.log. The
 * first-frame kind is likewise terminal-quiet: the flushed frame ITSELF
 * replaces the transition surface (design: "随后 transition 消失").
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
 * Write a stage line and WAIT for the stream to acknowledge the bytes (the
 * design's flushed contract — no fixed sleeps): the promise resolves on
 * the write callback, which the underlying handle fires once the data left
 * the process. setImmediate covers sinks that never invoke the callback;
 * the caller only needs ordering (the spawn happens strictly after this
 * resolves).
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
