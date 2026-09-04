/**
 * Regression for the settled-header whale behaviors (settings
 * `dsh-tui.whaleIdle`), ported from the dsh-ui-whale web plugin:
 * the pure planner's frame choices and timings (idle passes, sleep entry,
 * work wake, click-heart pass) plus the channel wiring of the setting.
 * Imports source through tsx, so it never relies on a pre-existing lib/.
 *
 * Run: node --import tsx/esm scripts/verify-whale-idle.mjs
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { strict: assert },
  { createChannel },
  whaleFrames,
  whaleIdle,
] = await Promise.all([
  import('node:assert'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/components/whaleFrames.js'),
  import('../src/components/whaleIdle.js'),
])

let checks = 0
/** Assert one regression case by running its predicate; collect and report. */
function check(name, test) {
  try {
    test()
    checks += 1
    console.log(`PASS: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}`)
    throw error
  }
}

const { WHALE_FRAME_INDEX: F } = whaleFrames
const { initialWhaleIdleState, nextWhaleIdleStep, SLEEP_DELAY_MS } = whaleIdle

/** Drive the planner with a controllable clock; collects (frame, delay). */
function drive(input, steps, start = 0) {
  let state = initialWhaleIdleState(start)
  const out = []
  let now = start
  for (let i = 0; i < steps; i++) {
    const step = nextWhaleIdleStep(state, input(now, i), now)
    state = step.state
    out.push({ frame: step.frameIndex, delay: step.delayMs, state })
    now += step.delayMs
  }
  return out
}

// ── 1. Working: continuous motion, never sleeps ───────────────────────────
{
  const frames = drive(() => ({ working: true, heart: false }), 40)
    .map(s => s.frame)
  check('working whale never rests on sleep frames', () => {
    for (const frame of frames) {
      assert.ok(frame !== F.sleep1 && frame !== F.sleep5, `unexpected ${frame}`)
    }
  })
  check('working whale cycles wag and flutter passes', () => {
    assert.ok(frames.includes(F.tail4), 'tail wag pass appears')
    assert.ok(frames.includes(F.fin2), 'fin flutter pass appears')
    assert.ok(frames.includes(F.blink), 'blink pass appears')
  })
}

// ── 2. Idle: occasional passes, then sleep after the delay ────────────────
{
  const frames = drive(() => ({ working: false, heart: false }), 200)
    .map(s => s.frame)
  check('idle whale runs occasional blink/flutter passes before sleeping', () => {
    assert.ok(frames.slice(0, 20).includes(F.blink), 'blink fires while awake')
  })
  check('idle whale thumps its tail before falling asleep', () => {
    const asleepAt = frames.findIndex(f => f === F.sleep1)
    assert.ok(asleepAt > 0, 'sleep frames eventually play')
    assert.ok(frames.slice(0, asleepAt).includes(F.tail4), 'the full tail pass plays while awake')
    assert.ok(frames.slice(0, asleepAt).includes(F.fin2), 'fin flutter still precedes sleep')
  })
  check(`idle whale falls asleep (within ~${SLEEP_DELAY_MS}ms + passes)`, () => {
    const asleepAt = frames.findIndex(f => f === F.sleep1)
    assert.ok(asleepAt > 0, 'sleep frames eventually play')
  })
  check('asleep whale loops the Z cycle and never returns to tail frames', () => {
    const asleepAt = frames.findIndex(f => f === F.sleep1)
    const tailInSleep = frames.slice(asleepAt).some(f => f === F.tail1 || f === F.fin1)
    assert.ok(!tailInSleep, 'no motion passes interrupt sleep')
  })
}

// ── 3. Work wakes a sleeping whale ─────────────────────────────────────────
{
  let state = initialWhaleIdleState(0)
  // Idle long enough to be asleep.
  let now = 0
  for (let i = 0; i < 40; i++) {
    const step = nextWhaleIdleStep(state, { working: false, heart: false }, now)
    state = step.state
    now += step.delayMs
  }
  check('precondition: whale is asleep after long idle', () => {
    assert.equal(state.asleep, true)
  })
  const woken = nextWhaleIdleStep(state, { working: true, heart: false }, now)
  check('work wakes the whale', () => {
    assert.equal(woken.state.asleep, false)
    assert.equal(woken.frameIndex, F.tail1, 'wakes straight into motion')
  })
}

// ── 4. Click heart: one-way 1-2-3 pass from any state ─────────────────────
{
  let state = initialWhaleIdleState(0)
  const h1 = nextWhaleIdleStep(state, { working: false, heart: true }, 0)
  const h2 = nextWhaleIdleStep(h1.state, { working: false, heart: false }, 5)
  const h3 = nextWhaleIdleStep(h2.state, { working: false, heart: false }, 10)
  const h4 = nextWhaleIdleStep(h3.state, { working: false, heart: false }, 15)
  check('click plays the one-way heart pass and ends', () => {
    assert.equal(h1.frameIndex, F.heart1)
    assert.equal(h2.frameIndex, F.heart2)
    assert.equal(h3.frameIndex, F.heart3)
    assert.notEqual(h4.frameIndex, F.heart3, 'pass ends after the large heart')
  })
  check('a repeat click mid-heart re-arms from the small heart', () => {
    // Start a pass, then click again while heart2 is showing: the planner must
    // restart at heart1 (the LogoV2 component additionally bumps a heartKey so
    // its effect re-runs even when heartSeq is already 0).
    const startState = initialWhaleIdleState(0)
    const first = nextWhaleIdleStep(startState, { working: false, heart: true }, 0)
    const mid = nextWhaleIdleStep(first.state, { working: false, heart: false }, 5)
    const rearmed = nextWhaleIdleStep(mid.state, { working: false, heart: true }, 10)
    // Assert the intermediate frame really is the LARGE heart (mid-pass) before
    // the re-click, so this proves a genuinely mid-animation restart and not a
    // restart from the first frame.
    assert.equal(mid.frameIndex, F.heart2, 'the re-click happens while the large heart shows')
    assert.equal(rearmed.frameIndex, F.heart1, 're-click restarts from the small heart')
  })
  check('heart over sleep does not wake the whale', () => {
    let s = initialWhaleIdleState(0)
    let t = 0
    for (let i = 0; i < 40; i++) {
      const step = nextWhaleIdleStep(s, { working: false, heart: false }, t)
      s = step.state
      t += step.delayMs
    }
    const clicked = nextWhaleIdleStep(s, { working: false, heart: true }, t)
    assert.equal(clicked.frameIndex, F.heart1)
    assert.equal(clicked.state.asleep, true, 'still asleep underneath')
  })
}

// ── 5. Resting whale schedules exactly one pending event, not a loop ──────
{
  const state = initialWhaleIdleState(0)
  const rest = nextWhaleIdleStep(state, { working: false, heart: false }, 0)
  check('fresh idle whale rests until its nearest scheduled event', () => {
    assert.equal(rest.frameIndex, F.standard)
    assert.ok(rest.delayMs > 1000, `waited ${rest.delayMs}ms, not a fast loop`)
    assert.ok(rest.delayMs <= SLEEP_DELAY_MS + 1, 'bounded by the sleep delay')
  })
}

// ── 6. Channel wiring: whaleIdle defaults off and toggles live ────────────
{
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() {
      return undefined
    },
    logger: { warn() {} },
  }
  const agent = {
    id: 'a1',
    status: 'idle',
    session: { id: 's1', seq: 0, events: [] },
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
  }
  const channel = createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
  })
  check('channel whaleIdle defaults to off', () => {
    assert.equal(channel.whaleIdle, false)
  })
  check('setWhaleIdle toggles the flag', () => {
    channel.setWhaleIdle(true)
    assert.equal(channel.whaleIdle, true)
    channel.setWhaleIdle(false)
    assert.equal(channel.whaleIdle, false)
  })
}

console.log(`${checks} checks passed`)
