/**
 * Companion mood regression (pure functions, no terminal):
 * locks src/components/sidePanel/companion/mood.ts at the contract the
 * design doc v2.1 fixed:
 *  - the priority lattice attention > celebrate > working > sleeping >
 *    idle, with each of the three attention triggers lighting on its own;
 *  - attention outranks sleep even when lastInputAt is far past
 *    sleepAfterMs (attention must keep the pet awake);
 *  - celebration.until expiring falls back to idle or sleeping;
 *  - working subdivision: activity.phase wins, a missing activity (or a
 *    done/idle phase) falls back to spinnerMode
 *    (requesting->waiting, thinking->thinking, responding->responding,
 *    tool-use/tool-input->working);
 *  - sleepAfterMs=0 never sleeps;
 *  - stepCompanionMood keeps since while the mood holds, stamps now on a
 *    change, and derives the bubble: phrase first, else label+detail,
 *    never on idle/sleeping.
 * Run: node --import tsx/esm scripts/verify-companion-mood.mjs
 */
import assert from 'node:assert/strict'
import {
  resolveCompanionMood,
  stepCompanionMood,
  initialCompanionMoodState,
} from '../src/components/sidePanel/companion/mood.ts'

let total = 0
function pass(name) {
  console.log('PASS: ' + name)
  total += 1
}

const NOW = 1_000_000
const SLEEP = 60_000
const NONE = { approvalPending: false, questionPending: false, failedJobsUnread: 0 }

function inputs(overrides = {}) {
  return {
    working: false,
    spinnerMode: 'thinking',
    activity: undefined,
    attention: NONE,
    lastInputAt: NOW,
    celebration: undefined,
    sleepAfterMs: SLEEP,
    ...overrides,
  }
}
const activity = (phase, extra = {}) => ({
  phase, line: '', live: false, toolCount: 0, phaseStartedAt: 0, turnStartedAt: 0, updatedAt: 0, lang: 'zh',
  ...extra,
})

// --- priority lattice: each attention trigger lights on its own ----------
for (const [name, attention] of [
  ['approvalPending', { approvalPending: true, questionPending: false, failedJobsUnread: 0 }],
  ['questionPending', { approvalPending: false, questionPending: true, failedJobsUnread: 0 }],
  ['failedJobsUnread', { approvalPending: false, questionPending: false, failedJobsUnread: 2 }],
]) {
  assert.equal(resolveCompanionMood(inputs({ attention }), NOW), 'attention')
  pass('attention trigger: ' + name)
}

// attention > celebrate > working > sleeping > idle, one input at a time.
assert.equal(resolveCompanionMood(inputs({
  attention: { approvalPending: true, questionPending: true, failedJobsUnread: 3 },
  celebration: { kind: 'star', until: NOW + 10_000 },
  working: true,
  lastInputAt: NOW - 10 * SLEEP,
}), NOW), 'attention')
pass('priority: attention beats celebrate/working/sleeping')

assert.equal(resolveCompanionMood(inputs({
  celebration: { kind: 'turn-done', until: NOW + 1 },
  working: true,
  lastInputAt: NOW - 10 * SLEEP,
}), NOW), 'celebrate')
pass('priority: celebrate beats working and sleeping')

assert.equal(resolveCompanionMood(inputs({
  working: true,
  spinnerMode: 'requesting',
  lastInputAt: NOW - 10 * SLEEP,
}), NOW), 'waiting')
pass('priority: working beats sleeping')

assert.equal(resolveCompanionMood(inputs({ lastInputAt: NOW - SLEEP }), NOW), 'sleeping')
pass('priority: sleeping after sleepAfterMs of quiet')

assert.equal(resolveCompanionMood(inputs(), NOW), 'idle')
pass('priority: idle is the floor')

// --- attention prevents sleep --------------------------------------------
assert.equal(resolveCompanionMood(inputs({
  attention: { approvalPending: true, questionPending: false, failedJobsUnread: 0 },
  lastInputAt: NOW - 10 * SLEEP,
}), NOW + 123), 'attention')
pass('attention blocks sleep — lastInputAt far past sleepAfterMs')

// --- celebration expiry falls back ---------------------------------------
{
  const celebration = { kind: 'star' , until: NOW + 1_000 }
  assert.equal(resolveCompanionMood(inputs({ celebration }), NOW), 'celebrate')
  assert.equal(resolveCompanionMood(inputs({ celebration }), NOW + 1_000), 'idle')
  assert.equal(resolveCompanionMood(inputs({ celebration, lastInputAt: NOW - 5 * SLEEP }), NOW + 1_000), 'sleeping')
  pass('celebration.until expiry falls back to idle (or sleeping)')
}

// --- working subdivision: activity.phase wins ----------------------------
for (const [phase, expected] of [
  ['waiting', 'waiting'],
  ['thinking', 'thinking'],
  ['tool', 'working'],
]) {
  assert.equal(resolveCompanionMood(inputs({ working: true, spinnerMode: 'responding', activity: activity(phase) }), NOW), expected)
  pass('activity.phase=' + phase + ' -> ' + expected + ' (spinnerMode ignored)')
}

// --- missing activity / done / idle fall back to spinnerMode -------------
for (const [mode, expected] of [
  ['requesting', 'waiting'],
  ['thinking', 'thinking'],
  ['responding', 'responding'],
  ['tool-use', 'working'],
  ['tool-input', 'working'],
]) {
  assert.equal(resolveCompanionMood(inputs({ working: true, spinnerMode: mode }), NOW), expected)
  pass('no activity: spinnerMode=' + mode + ' -> ' + expected)
  assert.equal(resolveCompanionMood(inputs({ working: true, spinnerMode: mode, activity: activity('done') }), NOW), expected)
  assert.equal(resolveCompanionMood(inputs({ working: true, spinnerMode: mode, activity: activity('idle') }), NOW), expected)
  pass('phase done/idle: spinnerMode=' + mode + ' still -> ' + expected)
}

// --- sleepAfterMs=0 never sleeps -----------------------------------------
assert.equal(resolveCompanionMood(inputs({ sleepAfterMs: 0, lastInputAt: NOW - 100 * SLEEP }), NOW), 'idle')
pass('sleepAfterMs=0 never sleeps')

// --- stepCompanionMood: since + bubble -----------------------------------
{
  const prev = { mood: 'idle' , since: 123 }
  const held = stepCompanionMood(prev, inputs(), NOW + 5)
  assert.equal(held.mood, 'idle')
  assert.equal(held.since, 123, 'same mood keeps since')
  assert.equal(held.bubble, undefined, 'idle has no bubble')
  pass('step: mood unchanged keeps since')
}
{
  const prev = { mood: 'idle', since: 123 }
  const moved = stepCompanionMood(prev, inputs({ working: true, spinnerMode: 'requesting' }), NOW)
  assert.equal(moved.mood, 'waiting')
  assert.equal(moved.since, NOW, 'mood change stamps since=now')
  pass('step: mood change stamps since=now')
}
{
  const step = stepCompanionMood({ mood: 'working', since: 0 }, inputs({
    working: true, spinnerMode: 'tool-use',
    activity: activity('tool', { phrase: '⏵ 正在读取 package.json', label: '读取', detail: 'package.json' }),
  }), NOW)
  assert.equal(step.bubble, '⏵ 正在读取 package.json', 'phrase wins over label+detail')
  pass('bubble: phrase takes priority')
}
{
  const step = stepCompanionMood({ mood: 'working', since: 0 }, inputs({
    working: true, spinnerMode: 'tool-use',
    activity: activity('tool', { phrase: '', label: '读取', detail: 'package.json' }),
  }), NOW)
  assert.equal(step.bubble, '读取 package.json', 'empty phrase falls back to label+detail')
  pass('bubble: label + detail fallback')
}
{
  for (const mood of ['idle', 'sleeping']) {
    const prior = { mood, since: 0 }
    const step = stepCompanionMood(prior, inputs({
      activity: activity('tool', { phrase: '⏵ x' }),
      lastInputAt: mood === 'sleeping' ? NOW - 10 * SLEEP : NOW,
    }), NOW)
    assert.equal(step.mood, mood)
    assert.equal(step.bubble, undefined, mood + ' has no bubble even with activity present')
  }
  pass('bubble: idle/sleeping never carry one')
}
{
  assert.equal(initialCompanionMoodState.mood, 'idle')
  assert.equal(initialCompanionMoodState.since, 0)
  pass('initial state is idle@0')
}

console.log('OK: companion mood ' + total + ' checks passed.')
