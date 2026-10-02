/**
 * Companion mood regression (pure functions, no terminal):
 * locks src/components/sidePanel/companion/mood.ts at the 2026-10 contract
 * (derive/display split + smoothing layer):
 *  - deriveCompanionMood priority: attention (approval/question) > error
 *    (failed jobs unread / failed subagents — the deepy kit's error slot,
 *    previously folded into attention) > working > celebrate > sleeping >
 *    idle;
 *  - attention/error both block sleep even when lastInputAt is far past
 *    sleepAfterMs;
 *  - celebration.until expiring falls back to idle or sleeping;
 *  - working subdivision: activity.phase wins, a missing activity (or a
 *    done/idle phase) falls back to spinnerMode
 *    (requesting->waiting, thinking->thinking, responding->responding,
 *    tool-use/tool-input->working);
 *  - sleepAfterMs=0 never sleeps;
 *  - the returned bubble: phrase first, else label+detail, never on
 *    idle/sleeping.
 * The smoothing layer (settle/dwell/preempt gates) and the context layer
 * (music/conducting/building/compacting) are locked in
 * scripts/verify-companion-panel.tsx (unit section) together with the
 * notification tracker.
 * Run: node --import tsx/esm scripts/verify-companion-mood.mjs
 */
import assert from 'node:assert/strict'
import {
  deriveCompanionMood,
  initialCompanionDisplayState,
} from '../src/components/sidePanel/companion/mood.ts'

let total = 0
function pass(name) {
  console.log('PASS: ' + name)
  total += 1
}

const NOW = 1_000_000
const SLEEP = 60_000
const NO_ATTENTION = { approvalPending: false, questionPending: false }
const NO_FAILURES = { failedJobsUnread: 0, failedSubagents: 0 }

function inputs(overrides = {}) {
  return {
    working: false,
    spinnerMode: 'thinking',
    activity: undefined,
    attention: NO_ATTENTION,
    failures: NO_FAILURES,
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
const moodOf = (given, now = NOW) => deriveCompanionMood(given, now).mood

// --- attention triggers (approval/question) ------------------------------
for (const [name, attention] of [
  ['approvalPending', { approvalPending: true, questionPending: false }],
  ['questionPending', { approvalPending: false, questionPending: true }],
]) {
  assert.equal(moodOf(inputs({ attention })), 'attention')
  pass('attention trigger: ' + name)
}

// --- failure triggers -> error (kit's 工具失败 slot) ----------------------
for (const [name, failures] of [
  ['failedJobsUnread', { failedJobsUnread: 2, failedSubagents: 0 }],
  ['failedSubagents', { failedJobsUnread: 0, failedSubagents: 1 }],
]) {
  assert.equal(moodOf(inputs({ failures })), 'error')
  pass('failure trigger: ' + name + ' -> error')
}
assert.equal(moodOf(inputs({
  attention: { approvalPending: true, questionPending: true },
  failures: { failedJobsUnread: 3, failedSubagents: 1 },
})), 'attention')
pass('priority: attention beats error')

// attention > error > working > celebrate > sleeping > idle.
assert.equal(moodOf(inputs({
  celebration: { kind: 'star', until: NOW + 10_000 },
  working: true,
  spinnerMode: 'tool-use',
  lastInputAt: NOW - 10 * SLEEP,
})), 'working')
pass('priority: working beats celebrate and sleeping')
assert.equal(moodOf(inputs({
  failures: { failedJobsUnread: 1, failedSubagents: 0 },
  working: true,
  lastInputAt: NOW - 10 * SLEEP,
})), 'error')
pass('priority: error beats working and sleeping')
assert.equal(moodOf(inputs({
  celebration: { kind: 'turn-done', until: NOW + 1 },
  working: true,
  spinnerMode: 'tool-use',
  lastInputAt: NOW - 10 * SLEEP,
})), 'working')
pass('priority: working beats celebrate (next turn cancels the party)')
assert.equal(moodOf(inputs({
  celebration: { kind: 'turn-done', until: NOW + 1 },
})), 'celebrate')
pass('priority: celebrate when the turn is over')

assert.equal(moodOf(inputs({
  working: true,
  spinnerMode: 'requesting',
  lastInputAt: NOW - 10 * SLEEP,
})), 'waiting')
pass('priority: working beats sleeping')

assert.equal(moodOf(inputs({ lastInputAt: NOW - SLEEP })), 'sleeping')
pass('priority: sleeping after sleepAfterMs of quiet')

assert.equal(moodOf(inputs()), 'idle')
pass('priority: idle is the floor')

// --- attention/error prevent sleep ---------------------------------------
assert.equal(moodOf(inputs({
  attention: { approvalPending: true, questionPending: false },
  lastInputAt: NOW - 10 * SLEEP,
})), 'attention')
pass('attention blocks sleep — lastInputAt far past sleepAfterMs')
assert.equal(moodOf(inputs({
  failures: { failedJobsUnread: 4, failedSubagents: 0 },
  lastInputAt: NOW - 10 * SLEEP,
})), 'error')
pass('error blocks sleep too')

// --- celebration expiry falls back ---------------------------------------
{
  const celebration = { kind: 'star', until: NOW + 1_000 }
  assert.equal(moodOf(inputs({ celebration }), NOW), 'celebrate')
  assert.equal(moodOf(inputs({ celebration }), NOW + 1_000), 'idle')
  assert.equal(moodOf(inputs({ celebration, lastInputAt: NOW - 5 * SLEEP }), NOW + 1_000), 'sleeping')
  pass('celebration.until expiry falls back to idle (or sleeping)')
}

// --- working subdivision: activity.phase wins ----------------------------
for (const [phase, expected] of [
  ['waiting', 'waiting'],
  ['thinking', 'thinking'],
  ['tool', 'working'],
]) {
  assert.equal(moodOf(inputs({ working: true, spinnerMode: 'responding', activity: activity(phase) })), expected)
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
  assert.equal(moodOf(inputs({ working: true, spinnerMode: mode })), expected)
  pass('no activity: spinnerMode=' + mode + ' -> ' + expected)
  assert.equal(moodOf(inputs({ working: true, spinnerMode: mode, activity: activity('done') })), expected)
  assert.equal(moodOf(inputs({ working: true, spinnerMode: mode, activity: activity('idle') })), expected)
  pass('phase done/idle: spinnerMode=' + mode + ' still -> ' + expected)
}

// --- sleepAfterMs=0 never sleeps -----------------------------------------
assert.equal(moodOf(inputs({ sleepAfterMs: 0, lastInputAt: NOW - 100 * SLEEP })), 'idle')
pass('sleepAfterMs=0 never sleeps')

// --- bubble derivation ----------------------------------------------------
{
  const step = deriveCompanionMood(inputs({
    working: true, spinnerMode: 'tool-use',
    activity: activity('tool', { phrase: '⏵ 正在读取 package.json', label: '读取', detail: 'package.json' }),
  }), NOW)
  assert.equal(step.mood, 'working')
  assert.equal(step.bubble, '⏵ 正在读取 package.json', 'phrase wins over label+detail')
  pass('bubble: phrase takes priority')
}
{
  const step = deriveCompanionMood(inputs({
    working: true, spinnerMode: 'tool-use',
    activity: activity('tool', { phrase: '', label: '读取', detail: 'package.json' }),
  }), NOW)
  assert.equal(step.bubble, '读取 package.json', 'empty phrase falls back to label+detail')
  pass('bubble: label + detail fallback')
}
{
  for (const mood of ['idle', 'sleeping']) {
    const step = deriveCompanionMood(inputs({
      activity: activity('tool', { phrase: '⏵ x' }),
      lastInputAt: mood === 'sleeping' ? NOW - 10 * SLEEP : NOW,
    }), NOW)
    assert.equal(step.mood, mood)
    assert.equal(step.bubble, undefined, mood + ' has no bubble even with activity present')
  }
  pass('bubble: idle/sleeping never carry one')
}
{
  assert.equal(initialCompanionDisplayState.semantic, 'idle')
  assert.equal(initialCompanionDisplayState.since, 0)
  pass('initial display state is idle@0')
}

console.log('OK: companion mood ' + total + ' checks passed.')
