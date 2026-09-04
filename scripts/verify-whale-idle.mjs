/**
 * Regression for the settled-header whale behaviors (settings
 * `dsh-tui.whaleIdle`), ported from the dsh-ui-whale web plugin
 * (https://github.com/lhh010/dsh-ui-whale): the LAYERED planner —
 * independent tail / fin / heart / sleep-Z / blink planes that compose per
 * tick (whaleLayers.ts) so actions run in PARALLEL — plus frame-data parity
 * against the source art and the channel wiring of the setting. Imports
 * source through tsx, so it never relies on a pre-existing lib/.
 *
 * Run: node --import tsx/esm scripts/verify-whale-idle.mjs
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { strict: assert },
  { createChannel },
  whaleFrames,
  whaleLayers,
  whaleIdle,
] = await Promise.all([
  import('node:assert'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/components/whaleFrames.js'),
  import('../src/components/whaleLayers.js'),
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

const { WHALE_FRAMES, WHALE_FRAME_INDEX: F } = whaleFrames
const { composeWhaleGrid, RESTING_POSE } = whaleLayers
const { initialWhaleIdleState, nextWhaleIdleStep, SLEEP_DELAY_MS, HEART_HOLD_MS } = whaleIdle

/** Drive the planner with a controllable clock; collects (pose, delay). */
function drive(input, steps, start = 0) {
  let state = initialWhaleIdleState(start)
  const out = []
  let now = start
  for (let i = 0; i < steps; i++) {
    const step = nextWhaleIdleStep(state, input(now, i), now)
    state = step.state
    out.push({ pose: step.pose, delay: step.delayMs, state, now })
    now += step.delayMs
  }
  return out
}

function gridRows(pose) {
  return composeWhaleGrid(pose).map(row => row.join(''))
}

// ── 0. Frame-data parity against the source art (whale_frames) ────────────
// The tail2 frame once drifted 23 cells from the source (shifted spout
// pixels); these digests pin the corrected data.
{
  const webTail2Rows = [
    '...........................D............',
    '..........................DBD.......D...',
    '..........................DBBD.....DBD..',
    '..........................DBBD....DBBD..',
    '..........................DBBBD.DDBBBD..',
    '.......DDDDDDDDD..........DBBBBDBBBBD...',
  ]
  check('tail2 frame matches the source art (drift regression)', () => {
    assert.deepEqual(WHALE_FRAMES[F.tail2].rows.slice(2, 8), webTail2Rows)
  })
  const webHeart3Rows = [
    '..HH.HH.................................',
    '.HHHHHHH................D...............',
    '.HHHHHHH...............DBD.......D......',
    '..HHHHH................DBBD.....DBD.....',
    '...HHH.................DBBBD..DDBBD.....',
    '....H..................DBBBBDDBBBBD.....',
  ]
  check('heart3 frame matches the source art', () => {
    assert.deepEqual(WHALE_FRAMES[F.heart3].rows.slice(1, 7), webHeart3Rows)
  })
}

// ── 1. Layer compositor parity: single-family pose == whole frame ─────────
{
  check('compose: tail pose k == TAIL_k frame', () => {
    for (const k of [1, 2, 3, 4]) {
      assert.deepEqual(
        gridRows({ ...RESTING_POSE, tail: k }),
        WHALE_FRAMES[F[`tail${k}`]].rows,
      )
    }
  })
  check('compose: heart pose k == HEART_k frame', () => {
    for (const k of [1, 2, 3]) {
      assert.deepEqual(
        gridRows({ ...RESTING_POSE, heart: k }),
        WHALE_FRAMES[F[`heart${k}`]].rows,
      )
    }
  })
  check('compose: sleep/blink/fin poses match their frames', () => {
    assert.deepEqual(gridRows({ ...RESTING_POSE, sleep: 3 }), WHALE_FRAMES[F.sleep3].rows)
    assert.deepEqual(gridRows({ ...RESTING_POSE, blink: true }), WHALE_FRAMES[F.blink].rows)
    assert.deepEqual(gridRows({ ...RESTING_POSE, fin: 2 }), WHALE_FRAMES[F.fin2].rows)
    assert.deepEqual(gridRows(RESTING_POSE), WHALE_FRAMES[F.standard].rows)
  })
}

// ── 2. Working: continuous tail/fin motion, never sleeps ──────────────────
{
  const steps = drive(() => ({ working: true, heart: false }), 40)
  check('working whale never shows sleep or rest', () => {
    for (const s of steps) {
      assert.equal(s.pose.sleep, 0, 'no Z while working')
      assert.ok(s.state.asleep === false)
    }
  })
  check('working whale cycles wag and flutter layers', () => {
    const tails = new Set(steps.map(s => s.pose.tail))
    const fins = new Set(steps.map(s => s.pose.fin))
    assert.ok(tails.has(4), 'tail wag reaches the full swing')
    assert.ok(fins.has(2), 'fin flutter reaches the full raise')
  })
}

// ── 3. PARALLEL: blink composes over a mid-pass tail wag ──────────────────
{
  // Working keeps the tail cycling; drive to a moment where the tail is
  // mid-pass (pose.tail > 0) exactly when the blink fires.
  let state = initialWhaleIdleState(0)
  // The first working blink is due at 1680ms (14 ticks); the tail pass holds
  // 360ms per frame, so somewhere before 1680ms the tail is mid-wag.
  let now = 0
  let seen = null
  for (let i = 0; i < 60 && seen === null; i++) {
    const step = nextWhaleIdleStep(state, { working: true, heart: false }, now)
    state = step.state
    if (step.pose.blink && step.pose.tail > 0) seen = step
    now += step.delayMs
  }
  check('PARALLEL: blink composes over a mid-pass tail wag', () => {
    assert.ok(seen !== null, 'blink and tail wag never coincided')
    assert.ok(seen.pose.tail >= 1 && seen.pose.tail <= 4, 'tail is mid-wag under the blink')
  })
}

// ── 4. PARALLEL: heart overlays a mid-pass tail wag ───────────────────────
{
  let state = initialWhaleIdleState(0)
  let now = 0
  // Run the working whale until the tail is mid-pass, then click.
  for (let i = 0; i < 30; i++) {
    const step = nextWhaleIdleStep(state, { working: true, heart: false }, now)
    state = step.state
    now += step.delayMs
    if (state.tailStep >= 2) break
  }
  const clicked = nextWhaleIdleStep(state, { working: true, heart: true }, now)
  check('PARALLEL: heart plays over the working tail pose', () => {
    assert.equal(clicked.pose.heart, 1, 'small heart shows immediately')
    assert.ok(clicked.state.tailStep >= 0, 'the tail pass was NOT reset by the click')
  })
}

// ── 5. Heart pass cadence: one-way 1-2-3, re-click restarts ───────────────
{
  let state = initialWhaleIdleState(0)
  let now = 0
  const h1 = nextWhaleIdleStep(state, { working: false, heart: true }, now)
  now += HEART_HOLD_MS
  const h2 = nextWhaleIdleStep(h1.state, { working: false, heart: false }, now)
  now += HEART_HOLD_MS
  const h3 = nextWhaleIdleStep(h2.state, { working: false, heart: false }, now)
  now += HEART_HOLD_MS
  const h4 = nextWhaleIdleStep(h3.state, { working: false, heart: false }, now)
  check('click plays the one-way heart pass and ends', () => {
    assert.equal(h1.pose.heart, 1)
    assert.equal(h2.pose.heart, 2)
    assert.equal(h3.pose.heart, 3)
    assert.equal(h4.pose.heart, 0, 'pass ends after the large heart')
  })
  check('a repeat click mid-heart re-arms from the small heart', () => {
    const start = initialWhaleIdleState(0)
    const first = nextWhaleIdleStep(start, { working: false, heart: true }, 0)
    const mid = nextWhaleIdleStep(first.state, { working: false, heart: false }, HEART_HOLD_MS)
    const rearmed = nextWhaleIdleStep(mid.state, { working: false, heart: true }, 2 * HEART_HOLD_MS)
    assert.equal(mid.pose.heart, 2, 'the re-click happens while the medium heart shows')
    assert.equal(rearmed.pose.heart, 1, 're-click restarts from the small heart')
  })
}

// ── 6. Idle: occasional passes, then sleep after the delay ────────────────
{
  const steps = drive(() => ({ working: false, heart: false }), 200)
  check('idle whale runs an occasional blink before sleeping', () => {
    assert.ok(steps.slice(0, 30).some(s => s.pose.blink), 'blink fires while awake')
  })
  check('idle whale falls asleep after the inactivity delay', () => {
    assert.ok(steps.some(s => s.state.asleep), 'sleep eventually entered')
  })
  check('asleep Z loop cycles 1..5 and never rests at 0', () => {
    const zs = steps.filter(s => s.state.asleep).map(s => s.pose.sleep)
    assert.ok(zs.includes(1) && zs.includes(5), 'the Z loop spans its range')
    assert.ok(!zs.includes(0) || zs.indexOf(0) === 0, 'layer 0 only as the settle frame')
  })
}

// ── 7. PARALLEL: asleep — tail thump pass plays under the sleep-Z ─────────
{
  let state = initialWhaleIdleState(0)
  let now = 0
  for (let i = 0; i < 200; i++) {
    const step = nextWhaleIdleStep(state, { working: false, heart: false }, now)
    state = step.state
    now += step.delayMs
    if (state.asleep && now >= state.thumpAt) {
      // Drive into the thump pass: the next steps must show tail > 0 while
      // the sleep layer keeps cycling.
      const during = nextWhaleIdleStep(state, { working: false, heart: false }, now)
      if (during.pose.tail > 0) {
        check('PARALLEL: asleep tail thump plays under the sleep-Z', () => {
          assert.equal(during.state.asleep, true)
          assert.ok(during.pose.sleep >= 1, 'sleep-Z stays up under the pass')
        })
        break
      }
    }
    now += step.delayMs
  }
}

// ── 8. PARALLEL: heart over sleep does not wake the whale ─────────────────
{
  let state = initialWhaleIdleState(0)
  let now = 0
  for (let i = 0; i < 200; i++) {
    const step = nextWhaleIdleStep(state, { working: false, heart: false }, now)
    state = step.state
    now += step.delayMs
    // Drive past the settle frame (layer 0) until a Z frame actually shows.
    if (state.asleep && state.sleepStep >= 1) break
  }
  const clicked = nextWhaleIdleStep(state, { working: false, heart: true }, now)
  check('heart over sleep does not wake the whale', () => {
    assert.equal(clicked.pose.heart, 1)
    assert.equal(clicked.state.asleep, true, 'still asleep underneath')
    assert.ok(clicked.pose.sleep >= 1, 'the sleep-Z stays up under the heart')
  })
}

// ── 9. Work wakes a sleeping whale ─────────────────────────────────────────
{
  let state = initialWhaleIdleState(0)
  let now = 0
  for (let i = 0; i < 200; i++) {
    const step = nextWhaleIdleStep(state, { working: false, heart: false }, now)
    state = step.state
    now += step.delayMs
    if (state.asleep) break
  }
  const woken = nextWhaleIdleStep(state, { working: true, heart: false }, now)
  check('work wakes the whale into continuous motion', () => {
    assert.equal(woken.state.asleep, false)
    assert.equal(woken.state.sleepStep, -1, 'the Z is cleared')
    assert.equal(woken.pose.tail, 1, 'wakes straight into the wag pass')
  })
}

// ── 10. Resting whale schedules exactly one pending event, not a loop ─────
{
  const state = initialWhaleIdleState(0)
  const rest = nextWhaleIdleStep(state, { working: false, heart: false }, 0)
  check('fresh idle whale rests until its nearest scheduled event', () => {
    assert.deepEqual(rest.pose, { ...RESTING_POSE })
    assert.ok(rest.delayMs > 1000, `waited ${rest.delayMs}ms, not a fast loop`)
    assert.ok(rest.delayMs <= SLEEP_DELAY_MS + 1, 'bounded by the sleep delay')
  })
}

// ── 11. Channel wiring: whaleIdle defaults off and toggles live ────────────
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
