/**
 * Settled-header whale behaviors, ported from the dsh-ui-whale web plugin's
 * animation driver (https://github.com/lhh010/dsh-ui-whale, src/client/
 * animation.ts): occasional fin flutters and tail thumps while idle,
 * continuous motion while the agent works, a sleep-Z loop after sustained
 * inactivity, and a heart pass on click. Unlike the web plugin — which
 * composites independent tail/fin/heart/sleep sprite layers — the TUI
 * renders whole frames, so this planner arbitrates ONE action at a time
 * and drives it event-driven: each step names the frame to show now and
 * how long to wait before the next step, so a resting whale holds ZERO
 * timers (the idle-wakeup contract; see scripts/verify-idle-wakeups.tsx).
 *
 * All timing decisions live here as pure functions over (state, input,
 * now) so the behavior is unit-testable without timers; the component
 * only feeds timestamps and clicks.
 */

import { WHALE_FRAME_INDEX } from './whaleFrames.js'

/** One tail-wag pass: 1-2-3-4-3-2-1, the source plugin's forward-and-back rule. */
const WAG_PASS: readonly number[] = [
  WHALE_FRAME_INDEX.tail1, WHALE_FRAME_INDEX.tail2,
  WHALE_FRAME_INDEX.tail3, WHALE_FRAME_INDEX.tail4,
  WHALE_FRAME_INDEX.tail3, WHALE_FRAME_INDEX.tail2, WHALE_FRAME_INDEX.tail1,
]

/** One fin-flutter pass: 1-2-1. */
const FLUTTER_PASS: readonly number[] = [
  WHALE_FRAME_INDEX.fin1, WHALE_FRAME_INDEX.fin2, WHALE_FRAME_INDEX.fin1,
]

/** One blink: a single frame. */
const BLINK_PASS: readonly number[] = [WHALE_FRAME_INDEX.blink]

/** Heart pass (click): ONE-WAY 1-2-3, then the pass ends — the source
 * plugin's no-reverse special case. Shared with LogoV2 so the rendered peak
 * and the planner never diverge. */
export const HEART_PASS: readonly number[] = [
  WHALE_FRAME_INDEX.heart1, WHALE_FRAME_INDEX.heart2, WHALE_FRAME_INDEX.heart3,
]

/** Sleep-Z loop frames: 1-2-3-4-5, wrapping back to 1 (never to rest). */
const SLEEP_LOOP: readonly number[] = [
  WHALE_FRAME_INDEX.sleep1, WHALE_FRAME_INDEX.sleep2,
  WHALE_FRAME_INDEX.sleep3, WHALE_FRAME_INDEX.sleep4, WHALE_FRAME_INDEX.sleep5,
]

/** Per-frame hold times, in ms (mirrors the source plugin's tick cadences). */
export const HEART_HOLD_MS = 350
const WAG_HOLD_WORKING_MS = 200
const FLUTTER_HOLD_WORKING_MS = 180
const BLINK_HOLD_MS = 250
const IDLE_WAG_HOLD_MS = 500
const IDLE_FLUTTER_HOLD_MS = 450
const SLEEP_SETTLE_MS = 400
const SLEEP_HOLD_MS = 400

/** Continuous inactivity before the whale falls asleep (source parity: 10s). */
export const SLEEP_DELAY_MS = 10_000

/** Rest between idle passes (source parity: 60/90/42 ticks × 120ms). */
const IDLE_FLUTTER_GAP_MS = 7_200
const IDLE_THUMP_GAP_MS = 10_800
const IDLE_BLINK_GAP_MS = 5_000

/**
 * Planner state. `queue`/`queueIndex` name the frame to show on the NEXT
 * step call; the sleep loop keeps its own position. Each occasional-pass
 * clock (blinkAt/flutterAt/thumpAt) seeds ONE fire per awake window and is
 * cleared when it fires (see the idle branch) — so a window is: blink once,
 * flutter once, thump once, then sleep. `sleepAt` is the sleep deadline,
 * measured as 10s of quiet after the LAST motion: every working step and
 * every occasional pass pushes it past its own end + SLEEP_DELAY_MS.
 */
export interface WhaleIdleState {
  readonly asleep: boolean
  readonly queue: readonly number[]
  readonly queueIndex: number
  readonly queueHoldMs: number
  /** Working-pass alternation: wag / flutter, blink every third pass. */
  readonly workPhase: number
  readonly flutterAt: number
  readonly thumpAt: number
  readonly blinkAt: number
  readonly sleepAt: number
  /** Position in SLEEP_LOOP; -1 = not yet started (settle frame first). */
  readonly sleepIndex: number
}

/** The per-step inputs: agent activity + a pending click-heart request. */
export interface WhaleIdleInput {
  readonly working: boolean
  readonly heart: boolean
}

/** One planner decision: the state to keep, the frame to paint, the wait. */
export interface WhaleIdleStep {
  readonly state: WhaleIdleState
  readonly frameIndex: number
  readonly delayMs: number
}

/** The resting initial state; `now` seeds the idle event schedule. */
export function initialWhaleIdleState(now: number): WhaleIdleState {
  return {
    asleep: false,
    queue: [],
    queueIndex: 0,
    queueHoldMs: 0,
    workPhase: 0,
    flutterAt: now + IDLE_FLUTTER_GAP_MS,
    thumpAt: now + IDLE_THUMP_GAP_MS,
    blinkAt: now + IDLE_BLINK_GAP_MS,
    sleepAt: now + SLEEP_DELAY_MS,
    sleepIndex: -1,
  }
}

/** Start a pass: the first frame shows now, the rest follow per call. */
function startPass(
  prev: WhaleIdleState,
  queue: readonly number[],
  holdMs: number,
  overrides: Partial<WhaleIdleState> = {},
): WhaleIdleStep {
  const state = { ...prev, queue, queueIndex: 1, queueHoldMs: holdMs, ...overrides }
  return { state, frameIndex: queue[0] ?? WHALE_FRAME_INDEX.standard, delayMs: holdMs }
}

/** Advance the current pass; when it ends the next call picks a new action. */
function continuePass(prev: WhaleIdleState): WhaleIdleStep {
  const frameIndex = prev.queue[prev.queueIndex] ?? WHALE_FRAME_INDEX.standard
  return { state: { ...prev, queueIndex: prev.queueIndex + 1 }, frameIndex, delayMs: prev.queueHoldMs }
}

/**
 * Compute the next animation step.
 * @param prev - the state carried from the previous step.
 * @param input - working (agent turn active) and heart (click requested).
 * @param now - current wall-clock ms (test seam: inject fixed clocks).
 */
export function nextWhaleIdleStep(
  prev: WhaleIdleState,
  input: WhaleIdleInput,
  now: number,
): WhaleIdleStep {
  // A click (re)arms the heart pass from the small heart — it plays over
  // any other action (even asleep) without changing the sleep state.
  if (input.heart) return startPass(prev, HEART_PASS, HEART_HOLD_MS)

  // Continue an in-flight pass (including the heart's own frames).
  if (prev.queueIndex < prev.queue.length) return continuePass(prev)

  // Working: continuous motion, and work is activity — the sleep deadline
  // and idle schedule keep sliding forward while the turn runs.
  if (input.working) {
    const awake: WhaleIdleState = prev.asleep
      ? { ...prev, asleep: false, sleepIndex: -1 }
      : prev
    const active: WhaleIdleState = {
      ...awake,
      sleepAt: now + SLEEP_DELAY_MS,
      flutterAt: now + IDLE_FLUTTER_GAP_MS,
      thumpAt: now + IDLE_THUMP_GAP_MS,
      blinkAt: now + IDLE_BLINK_GAP_MS,
    }
    const phase = active.workPhase % 3
    const nextPhase = active.workPhase + 1
    if (phase === 2) return startPass(active, BLINK_PASS, BLINK_HOLD_MS, { workPhase: nextPhase })
    if (phase === 0) return startPass(active, WAG_PASS, WAG_HOLD_WORKING_MS, { workPhase: nextPhase })
    return startPass(active, FLUTTER_PASS, FLUTTER_HOLD_WORKING_MS, { workPhase: nextPhase })
  }

  // Asleep: the settle frame (standard) played once on entry, then the
  // Z loop cycles 1-2-3-4-5-1-…; only work (or a heart overlay) interrupts.
  if (prev.asleep) {
    const index = prev.sleepIndex < 0 ? 0 : prev.sleepIndex
    const frameIndex = SLEEP_LOOP[index] ?? WHALE_FRAME_INDEX.sleep1
    return {
      state: { ...prev, sleepIndex: index >= SLEEP_LOOP.length - 1 ? 0 : index + 1 },
      frameIndex,
      delayMs: SLEEP_HOLD_MS,
    }
  }

  // Awake and idle: sleep when the inactivity deadline is the nearest due
  // event (it always is, once each occasional pass has fired its one shot),
  // else fire whichever occasional pass came due, else rest on the standard
  // pose until the nearest event. Sleep never preempts a pass: every pass
  // pushes the sleep deadline past its own end + SLEEP_DELAY_MS, and the
  // blink (shortest gap) always fires first and buys room for flutter and
  // thump inside the window.
  const dues: ReadonlyArray<{ at: number; kind: 'sleep' | 'blink' | 'flutter' | 'thump' }> = [
    { at: prev.sleepAt, kind: 'sleep' },
    { at: prev.blinkAt, kind: 'blink' },
    { at: prev.flutterAt, kind: 'flutter' },
    { at: prev.thumpAt, kind: 'thump' },
  ]
  const nearest = dues.reduce((a, b) => (b.at < a.at ? b : a))
  if (nearest.at > now) {
    return { state: prev, frameIndex: WHALE_FRAME_INDEX.standard, delayMs: nearest.at - now }
  }
  if (nearest.kind === 'sleep') {
    return {
      state: { ...prev, asleep: true, sleepIndex: -1 },
      frameIndex: WHALE_FRAME_INDEX.standard,
      delayMs: SLEEP_SETTLE_MS,
    }
  }
  // Each occasional pass fires once per awake window (clock → ∞, no
  // re-arm) and counts as activity: the sleep deadline moves to the end of
  // the pass plus 10s of quiet, so sleep only comes after every pass got
  // its turn — the idle thump included.
  if (nearest.kind === 'blink') {
    return startPass(prev, BLINK_PASS, BLINK_HOLD_MS, {
      blinkAt: Number.POSITIVE_INFINITY,
      sleepAt: now + BLINK_PASS.length * BLINK_HOLD_MS + SLEEP_DELAY_MS,
    })
  }
  if (nearest.kind === 'flutter') {
    return startPass(prev, FLUTTER_PASS, IDLE_FLUTTER_HOLD_MS, {
      flutterAt: Number.POSITIVE_INFINITY,
      sleepAt: now + FLUTTER_PASS.length * IDLE_FLUTTER_HOLD_MS + SLEEP_DELAY_MS,
    })
  }
  return startPass(prev, WAG_PASS, IDLE_WAG_HOLD_MS, {
    thumpAt: Number.POSITIVE_INFINITY,
    sleepAt: now + WAG_PASS.length * IDLE_WAG_HOLD_MS + SLEEP_DELAY_MS,
  })
}
