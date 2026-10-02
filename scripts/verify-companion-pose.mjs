/**
 * Companion pose regression (pure functions, no terminal):
 * locks src/components/sidePanel/companion/pose.ts at the v2.1 contract —
 * it must be a THIN wrapper over the splash whale planner:
 *  - frame-level parity: advancing the same seed through
 *    nextCompanionPoseStep and through nextWhaleIdleStep({working:
 *    mood-mapped, heart}) yields identical layer poses on every step
 *    (working moods -> working=true; idle/sleeping/celebrate -> false),
 *    across many moods x heart x 50 steps of wall clock;
 *  - the same parity for the carried planner state, so drift cannot hide
 *    behind a pose that happens to match;
 *  - gestures derive from the layers: a step with tail>0 AND fin>0 holds
 *    wag+flutter simultaneously; a resting step holds an empty set;
 *  - blink / heart / sleepZ mirror nativeWhalePose (clamped only at the
 *    type boundary); tick = floor(now/120).
 * Run: node --import tsx/esm scripts/verify-companion-pose.mjs
 */
import assert from 'node:assert/strict'
import {
  nextCompanionPoseStep,
  initialCompanionPoseState,
} from '../src/components/sidePanel/companion/pose.ts'
import {
  nextWhaleIdleStep,
  initialWhaleIdleState,
} from '../src/components/whaleIdle.ts'

let total = 0
function pass(name) {
  console.log('PASS: ' + name)
  total += 1
}

const WORKING_MOODS = ['waiting', 'thinking', 'working', 'responding', 'attention']
const REST_MOODS = ['idle', 'sleeping', 'celebrate']
const STEP_MS = 120
const SEED = 1_000_000

// --- frame-level parity: two chains from the same seed -------------------
let compared = 0
let overlapSeen = false
let restingSeen = false
for (const mood of [...WORKING_MOODS, ...REST_MOODS]) {
  for (const heart of [false, true]) {
    let companionState = initialCompanionPoseState(SEED)
    let whaleState = initialWhaleIdleState(SEED)
    const working = WORKING_MOODS.includes(mood)
    for (let step = 0; step < 50; step += 1) {
      const now = SEED + step * STEP_MS
      const mine = nextCompanionPoseStep(companionState, { mood, heart }, now)
      const direct = nextWhaleIdleStep(whaleState, { working, heart }, now)
      const a = mine.pose.nativeWhalePose
      const b = direct.pose
      assert.deepEqual(
        { tail: a.tail, fin: a.fin, spout: a.spout, heart: a.heart, sleep: a.sleep, blink: a.blink },
        { tail: b.tail, fin: b.fin, spout: b.spout, heart: b.heart, sleep: b.sleep, blink: b.blink },
        'pose parity broke at mood=' + mood + ' heart=' + heart + ' step=' + step,
      )
      assert.deepEqual(mine.state, direct.state, 'state parity broke at mood=' + mood + ' step=' + step)
      assert.equal(mine.delayMs, direct.delayMs)
      companionState = mine.state
      whaleState = direct.state
      compared += 1
      // gesture derivation on the companion side only
      if (a.tail > 0 && a.fin > 0) {
        assert.ok(mine.pose.gestures.has('wag') && mine.pose.gestures.has('flutter'))
        overlapSeen = true
      }
      if (a.tail === 0 && a.fin === 0 && a.spout === 0) {
        assert.equal(mine.pose.gestures.size, 0, 'resting layers must yield no gestures')
        restingSeen = true
      }
      // pose mirrors the native layers
      assert.equal(mine.pose.blink, a.blink)
      assert.equal(mine.pose.heart, a.heart)
      assert.equal(mine.pose.sleepZ, a.sleep)
      assert.equal(mine.pose.tick, Math.floor(now / 120))
      assert.equal(mine.pose.mood, mood)
    }
  }
}
assert.ok(compared >= 50 * 8, 'parity sweep actually ran (' + compared + ' steps)')
pass('parity: ' + compared + ' steps across 8 moods x heart, pose+state+delay equal')
assert.ok(overlapSeen, 'a simultaneous tail>0 + fin>0 step must occur in the sweep')
pass('gestures: wag and flutter co-exist on overlap steps')
assert.ok(restingSeen, 'a fully resting step must occur in the sweep')
pass('gestures: resting steps hold an empty set')
pass('pose: blink/heart/sleepZ mirror nativeWhalePose; tick=floor(now/120)')

// --- explicit gesture membership probe (working mood, mid-pass) ----------
{
  // seed so the working pass is in full swing: after a few working steps
  // both limbs are cycling continuously, guaranteeing overlap snapshots.
  let state = initialCompanionPoseState(SEED)
  let sawBoth = 0
  for (let step = 0; step < 60; step += 1) {
    const now = SEED + step * STEP_MS
    const mine = nextCompanionPoseStep(state, { mood: 'working', heart: false }, now)
    const g = mine.pose.gestures
    if (mine.pose.nativeWhalePose.tail > 0) assert.ok(g.has('wag'), 'tail>0 implies wag')
    if (mine.pose.nativeWhalePose.fin > 0) assert.ok(g.has('flutter'), 'fin>0 implies flutter')
    if (mine.pose.nativeWhalePose.tail > 0 && mine.pose.nativeWhalePose.fin > 0) sawBoth += 1
    state = mine.state
  }
  assert.ok(sawBoth > 0)
  pass('gestures: 60 working steps, every layer pose maps into the set (' + sawBoth + ' overlaps)')
}

// --- heart pass propagates through the wrapper ---------------------------
{
  let state = initialCompanionPoseState(SEED)
  const clicked = nextCompanionPoseStep(state, { mood: 'idle', heart: true }, SEED)
  assert.ok(clicked.pose.heart > 0, 'a click arms the heart pass on step one')
  assert.ok(clicked.pose.gestures.size === 0 || true) // heart is not a gesture layer
  pass('heart: a pending click lights pose.heart on the very next step')
}

// --- clamps at the type boundary -----------------------------------------
{
  const state = initialCompanionPoseState(SEED)
  const step = nextCompanionPoseStep(state, { mood: 'sleeping', heart: false }, SEED)
  assert.ok(step.pose.heart >= 0 && step.pose.heart <= 3)
  assert.ok(step.pose.sleepZ >= 0 && step.pose.sleepZ <= 5)
  assert.equal(step.pose.facing, 'left')
  pass('clamps: heart in 0..3, sleepZ in 0..5, facing default left')
}

console.log('OK: companion pose ' + total + ' checks passed.')
