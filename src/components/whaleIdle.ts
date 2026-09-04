/**
 * Settled-header whale behaviors, ported from the dsh-ui-whale web plugin's
 * animation driver (https://github.com/lhh010/dsh-ui-whale, src/client/
 * animation.ts): independent tail / fin / heart / sleep-Z / blink layers —
 * a click heart plays OVER a mid-wag tail or the sleep-Z loop instead of
 * replacing it (the old whole-frame planner arbitrated one action at a time).
 *
 * Web-faithful layer semantics: continuous tail/fin cycling while the agent
 * works, occasional passes while idle AND while asleep (the web pet never
 * freezes mid-sleep), a sticky sleep entered after SLEEP_DELAY_MS of
 * inactivity that only work clears, and a one-way 1-2-3 heart pass that
 * never wakes the whale.
 *
 * Event-driven: while resting, the ONLY pending timer is the next due layer
 * transition, and with the setting off the component holds no timer at all
 * (the idle-wakeup contract keeps holding). Pure functions over (state,
 * input, now) — unit-testable without timers.
 */
import type { WhaleLayerPose } from './whaleLayers.js'

const TICK_MS = 120 // the web plugin's animation tick

// Web-faithful cadences: animation.ts WAG_HOLD / FIN_HOLD / BLINK_GAP /
// SLEEP_HOLD / HEART_HOLD, in ticks, converted to ms.
const WAG_HOLD_WORKING_MS = 3 * TICK_MS
const WAG_HOLD_IDLE_MS = 6 * TICK_MS
const FIN_HOLD_WORKING_MS = 2 * TICK_MS
const FIN_HOLD_IDLE_MS = 5 * TICK_MS
const BLINK_HOLD_MS = 1 * TICK_MS
const BLINK_GAP_WORKING_MS = 14 * TICK_MS
const BLINK_GAP_IDLE_MS = 42 * TICK_MS
const IDLE_THUMP_GAP_MS = 90 * TICK_MS
const IDLE_FLUTTER_GAP_MS = 60 * TICK_MS
const SLEEP_HOLD_MS = 3 * TICK_MS
/** How long each heart size is held (web HEART_HOLD = 3 ticks). */
export const HEART_HOLD_MS = 3 * TICK_MS
/** Continuous inactivity before the whale falls asleep (web parity: 10s). */
export const SLEEP_DELAY_MS = 10_000

// Pose sequences — layer indices, straight from the web plugin:
// WAG_SEQUENCE 0-1-2-3-4-3-2-1-0 (forward-and-back), FIN_SEQUENCE 0-1-2-1-0,
// HEART one-way 0-1-2-3-0 (grows, then the pass ends).
const WAG_SEQUENCE: readonly number[] = [1, 2, 3, 4, 3, 2, 1]
const FIN_SEQUENCE: readonly number[] = [1, 2, 1]
const HEART_SEQUENCE: readonly number[] = [1, 2, 3]
const SLEEP_LAST = 5

/** Step/hold/countdown for one limb, in wall-clock deadlines. */
interface LimbStep {
  readonly step: number
  readonly holdUntil: number
  readonly passAt: number
}

/**
 * Planner state — one independent plane per layer. Steps index their pose
 * sequence (-1 = resting); holds are deadlines; the *At fields schedule the
 * occasional passes and the sleep entry. The heart is its own one-shot plane
 * so it overlays whatever the body planes are doing.
 */
export interface WhaleIdleState {
  readonly tailStep: number
  readonly tailHoldUntil: number
  readonly thumpAt: number
  readonly finStep: number
  readonly finHoldUntil: number
  readonly flutterAt: number
  readonly blinkAt: number
  readonly blinkUntil: number
  readonly heartStep: number
  readonly heartHoldUntil: number
  readonly asleep: boolean
  readonly sleepStep: number
  readonly sleepHoldUntil: number
  readonly sleepAt: number
}

/** The per-step inputs: agent activity + a pending click-heart request. */
export interface WhaleIdleInput {
  readonly working: boolean
  readonly heart: boolean
}

/** One planner decision: the state to keep, the pose to paint, the wait. */
export interface WhaleIdleStep {
  readonly state: WhaleIdleState
  readonly pose: WhaleLayerPose
  readonly delayMs: number
}

/** The resting initial state; `now` seeds the idle event schedule. */
export function initialWhaleIdleState(now: number): WhaleIdleState {
  return {
    tailStep: -1,
    tailHoldUntil: 0,
    thumpAt: now + IDLE_THUMP_GAP_MS,
    finStep: -1,
    finHoldUntil: 0,
    flutterAt: now + IDLE_FLUTTER_GAP_MS,
    blinkAt: now + BLINK_GAP_IDLE_MS,
    blinkUntil: 0,
    heartStep: -1,
    heartHoldUntil: 0,
    asleep: false,
    sleepStep: -1,
    sleepHoldUntil: 0,
    sleepAt: now + SLEEP_DELAY_MS,
  }
}

/**
 * Advance one limb plane. Working cycles the pass continuously; idle and
 * asleep play one occasional pass per gap and rest at the resting pose
 * between passes (web advanceLimb: the sleeping whale never freezes —
 * the tail keeps thumping and the fins keep fluttering on their cadence).
 */
function advanceLimb(
  step: number,
  holdUntil: number,
  passAt: number,
  sequence: readonly number[],
  holdWorkingMs: number,
  holdIdleMs: number,
  passGapMs: number,
  continuous: boolean,
  now: number,
): LimbStep {
  const holdMs = continuous ? holdWorkingMs : holdIdleMs
  if (continuous) {
    if (step < 0) return { step: 0, holdUntil: now + holdMs, passAt: now + passGapMs }
    if (now >= holdUntil) return { step: (step + 1) % sequence.length, holdUntil: now + holdMs, passAt: now + passGapMs }
    return { step, holdUntil, passAt }
  }
  if (step >= 0) {
    if (now >= holdUntil) {
      if (step >= sequence.length - 1) return { step: -1, holdUntil: 0, passAt: now + passGapMs }
      return { step: step + 1, holdUntil: now + holdMs, passAt }
    }
    return { step, holdUntil, passAt }
  }
  if (now >= passAt) return { step: 0, holdUntil: now + holdMs, passAt }
  return { step: -1, holdUntil: 0, passAt }
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
  // Heart plane — a click (re)arms the one-way pass from the small heart,
  // even mid-pass; it overlays everything and never wakes the whale.
  let heartStep = prev.heartStep
  let heartHoldUntil = prev.heartHoldUntil
  if (input.heart) {
    heartStep = 0
    heartHoldUntil = now + HEART_HOLD_MS
  } else if (heartStep >= 0 && now >= heartHoldUntil) {
    heartStep = heartStep >= HEART_SEQUENCE.length - 1 ? -1 : heartStep + 1
    if (heartStep >= 0) heartHoldUntil = now + HEART_HOLD_MS
  }

  // Sleep plane — sticky while idle: only work clears it; a click does not.
  let asleep = prev.asleep
  let sleepStep = prev.sleepStep
  let sleepHoldUntil = prev.sleepHoldUntil
  let sleepAt = prev.sleepAt
  if (input.working) {
    if (asleep || sleepStep >= 0) {
      asleep = false
      sleepStep = -1
    }
    sleepAt = now + SLEEP_DELAY_MS
  } else if (!asleep && now >= sleepAt) {
    // Entry: the resting pose (layer 0) plays once as the whale settles.
    asleep = true
    sleepStep = 0
    sleepHoldUntil = now + SLEEP_HOLD_MS
  } else if (asleep && now >= sleepHoldUntil) {
    // Z loop: 1..5, wrapping back to 1 (never to the resting pose).
    sleepStep = sleepStep >= SLEEP_LAST ? 1 : sleepStep + 1
    sleepHoldUntil = now + SLEEP_HOLD_MS
  }

  // Body planes — tail and fin run independently of each other and of the
  // heart/sleep overlays.
  const continuous = input.working
  const tail = advanceLimb(
    prev.tailStep, prev.tailHoldUntil, prev.thumpAt,
    WAG_SEQUENCE, WAG_HOLD_WORKING_MS, WAG_HOLD_IDLE_MS, IDLE_THUMP_GAP_MS, continuous, now,
  )
  const fin = advanceLimb(
    prev.finStep, prev.finHoldUntil, prev.flutterAt,
    FIN_SEQUENCE, FIN_HOLD_WORKING_MS, FIN_HOLD_IDLE_MS, IDLE_FLUTTER_GAP_MS, continuous, now,
  )

  // Blink plane — its own cadence, composing over any body pose.
  let blinkAt = prev.blinkAt
  let blinkUntil = prev.blinkUntil
  if (now >= blinkAt) {
    blinkUntil = now + BLINK_HOLD_MS
    blinkAt = now + (input.working ? BLINK_GAP_WORKING_MS : BLINK_GAP_IDLE_MS)
  }
  const blinking = now < blinkUntil

  const pose: WhaleLayerPose = {
    tail: tail.step < 0 ? 0 : WAG_SEQUENCE[tail.step] ?? 0,
    fin: fin.step < 0 ? 0 : FIN_SEQUENCE[fin.step] ?? 0,
    spout: 0,
    heart: heartStep < 0 ? 0 : HEART_SEQUENCE[heartStep] ?? 0,
    sleep: asleep ? Math.max(0, sleepStep) : 0,
    blink: blinking,
  }

  // Next due transition across every active plane; the sleep deadline is
  // always pending while awake, so a resting whale waits for exactly one
  // event (the idle-wakeup contract).
  const dues: number[] = []
  dues.push(tail.step >= 0 ? tail.holdUntil : tail.passAt)
  dues.push(fin.step >= 0 ? fin.holdUntil : fin.passAt)
  if (heartStep >= 0) dues.push(heartHoldUntil)
  dues.push(asleep ? sleepHoldUntil : sleepAt)
  dues.push(blinkAt)
  if (blinking) dues.push(blinkUntil)
  const next = dues.reduce((a, b) => (b < a && b > now ? b : a), Number.POSITIVE_INFINITY)
  const delayMs = Math.max(16, next - now)

  return { state: {
    tailStep: tail.step,
    tailHoldUntil: tail.holdUntil,
    thumpAt: tail.passAt,
    finStep: fin.step,
    finHoldUntil: fin.holdUntil,
    flutterAt: fin.passAt,
    blinkAt,
    blinkUntil,
    heartStep,
    heartHoldUntil,
    asleep,
    sleepStep,
    sleepHoldUntil,
    sleepAt,
  }, pose, delayMs }
}
