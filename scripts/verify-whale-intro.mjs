/**
 * Whale startup-intro regression: the three randomized opening sequences —
 * classic (blink + spout + tail wag), heart, sleep. Frame-table integrity,
 * sequence validity, the random pick API, and a LogoV2 render smoke that
 * proves each new palette color (pink heart, gray sleep-Z) actually paints
 * during its intro and disappears once the header settles.
 *
 * Run: node --import tsx/esm scripts/verify-whale-intro.mjs
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { render, ThemeProvider },
  { LogoV2 },
  whale,
  { settle, settled },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/LogoV2.js'),
  import('../src/components/whaleFrames.js'),
  import('./lib/term-test.mjs'),
])

let checks = 0
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

const { WHALE_FRAMES, WHALE_INTRO_IDS, OPENING_SEQUENCES, pickOpeningSequence } = whale

// ── 1. Frame-table integrity ─────────────────────────────────────────────
const EXPECTED_NAMES = [
  'standard', 'blink', 'fin1', 'fin2',
  'spout1', 'spout2', 'spout3', 'spout4', 'spout5', 'spout6',
  'tail1', 'tail2', 'tail3', 'tail4',
  'heart1', 'heart2', 'heart3',
  'sleep1', 'sleep2', 'sleep3', 'sleep4', 'sleep5',
]

check('whaleFrames holds all 22 source frames in art order', () => {
  assert.equal(WHALE_FRAMES.length, 22)
  assert.deepEqual(WHALE_FRAMES.map(f => f.name), EXPECTED_NAMES)
})

check('every frame is a 25x40 grid of palette chars', () => {
  const valid = /^[.DBLWHZ]+$/
  for (const frame of WHALE_FRAMES) {
    assert.equal(frame.rows.length, 25, `${frame.name}: row count`)
    for (const row of frame.rows) {
      assert.equal(row.length, 40, `${frame.name}: column count`)
      assert.match(row, valid, `${frame.name}: unexpected char`)
    }
  }
})

check('heart/sleep pixels exist only in their own frames', () => {
  for (const frame of WHALE_FRAMES) {
    const text = frame.rows.join('')
    if (frame.name.startsWith('heart')) {
      assert.ok(text.includes('H'), `${frame.name}: missing heart`)
      assert.ok(!text.includes('Z'), `${frame.name}: unexpected sleep-Z`)
    } else if (frame.name.startsWith('sleep')) {
      assert.ok(text.includes('Z'), `${frame.name}: missing sleep-Z`)
      assert.ok(!text.includes('H'), `${frame.name}: unexpected heart`)
    } else {
      assert.ok(!text.includes('H') && !text.includes('Z'), `${frame.name}: stray heart/Z`)
    }
  }
})

// ── 2. Sequence validity ─────────────────────────────────────────────────
// Motion frames each intro may use (beyond the standard bookends). The
// classic opener keeps the base behaviors bundled — blink (1), spout
// (4..9) and the full tail wag (10..13) — the way the header always
// played them; only heart and sleep get standalone intros.
const FAMILIES = {
  classic: new Set([1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
  heart: new Set([14, 15, 16]),
  sleep: new Set([17, 18, 19, 20, 21]),
}

check('three intro ids, one sequence each', () => {
  assert.deepEqual([...WHALE_INTRO_IDS], ['classic', 'heart', 'sleep'])
  assert.deepEqual(Object.keys(OPENING_SEQUENCES).sort(), [...WHALE_INTRO_IDS].sort())
})

check('every sequence: valid frames, positive dwell, standard bookends', () => {
  for (const id of WHALE_INTRO_IDS) {
    const seq = OPENING_SEQUENCES[id]
    assert.ok(seq.length >= 3, `${id}: too short`)
    assert.equal(seq[0].frame, 0, `${id}: must open on standard`)
    assert.equal(seq[seq.length - 1].frame, 0, `${id}: must close on standard`)
    let motion = 0
    for (const step of seq) {
      assert.ok(step.frame >= 0 && step.frame < WHALE_FRAMES.length, `${id}: frame out of range`)
      assert.ok(step.ms > 0, `${id}: dwell must be positive`)
      if (step.frame !== 0) motion += 1
    }
    assert.ok(motion > 0, `${id}: no motion`)
  }
})

check('each sequence animates only its own behavior', () => {
  for (const id of WHALE_INTRO_IDS) {
    const family = FAMILIES[id]
    for (const step of OPENING_SEQUENCES[id]) {
      if (step.frame === 0) continue
      assert.ok(family.has(step.frame), `${id}: frame ${step.frame} outside the ${id} family`)
    }
  }
})

check('classic keeps the base behaviors bundled (blink + spout + wag)', () => {
  const motion = new Set(OPENING_SEQUENCES.classic.map(s => s.frame).filter(f => f !== 0))
  assert.ok(motion.has(1), 'classic lost the blink')
  assert.ok([4, 5, 6, 7, 8, 9].some(f => motion.has(f)), 'classic lost the spout bloom')
  assert.ok([10, 11, 12, 13].some(f => motion.has(f)), 'classic lost the tail wag')
})

// ── 3. Random pick API ───────────────────────────────────────────────────
check('pickOpeningSequence covers all three ids across the unit interval', () => {
  for (let i = 0; i < WHALE_INTRO_IDS.length; i += 1) {
    const roll = (i + 0.5) / WHALE_INTRO_IDS.length
    const { id } = pickOpeningSequence(() => roll)
    assert.equal(id, WHALE_INTRO_IDS[i], `roll ${roll} -> ${id} (want ${WHALE_INTRO_IDS[i]})`)
  }
})

check('pickOpeningSequence clamps out-of-range rolls', () => {
  assert.equal(pickOpeningSequence(() => 1).id, 'sleep')
  assert.equal(pickOpeningSequence(() => -0.5).id, 'classic')
})

check('pickOpeningSequence rolls fresh on every call (no per-process cache)', () => {
  // Each logo mount (startup splash, every /deepseek replay) calls the
  // roll independently — consecutive calls must never hand back a cached
  // pick.
  const a = pickOpeningSequence(() => 0)
  const b = pickOpeningSequence(() => 0.999)
  assert.strictEqual(a.sequence, OPENING_SEQUENCES.classic)
  assert.strictEqual(b.sequence, OPENING_SEQUENCES.sleep)
  assert.notStrictEqual(a, b, 'callers must get independent result objects')
})

// ── 4. Render smoke: heart / sleep actually paint, then settle ───────────
const PINK = '\x1b[38;2;204;51;153m' // #cc3399 heart
const GRAY = '\x1b[38;2;128;128;128m' // #808080 sleep-Z

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

class FakeOutput extends Writable {
  constructor() {
    super()
    this.columns = 100
  }
  rows = 30
  isTTY = true
  writes = []
  _write(chunk, _encoding, callback) {
    this.writes.push(String(chunk))
    callback()
  }
}

async function renderLogo(intro) {
  const stdout = new FakeOutput()
  const instance = await render(
    React.createElement(
      ThemeProvider,
      { theme: 'dark' },
      React.createElement(LogoV2, { model: 'whale-intro-probe', cwd: '/whale/cwd', intro }),
    ),
    {
      stdout,
      stdin: new FakeStdin(),
      stderr: new FakeOutput(),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  return { stdout, instance }
}

{
  const { stdout, instance } = await renderLogo('heart')
  const sawPink = await settled(() => stdout.writes.join('').includes(PINK))
  check('heart intro paints the pink heart SGR', () => assert.ok(sawPink, 'pink heart never painted'))
  // heart total dwell = 2750ms; wait past it, the settled frame must be plain.
  await new Promise(resolve => setTimeout(resolve, 2750 + 900))
  const last = stdout.writes.slice(-3).join('')
  const all = stdout.writes.join('')
  check('heart intro settles back to the standard pose (no pink)', () => {
    assert.ok(!last.includes(PINK), 'pink leaked into the settled frame')
    assert.ok(all.includes('\x1b[38;2;20;38;96m'), 'whale outline never painted')
  })
  await instance.unmount()
}

{
  const { stdout, instance } = await renderLogo('sleep')
  const sawGray = await settled(() => stdout.writes.join('').includes(GRAY))
  check('sleep intro paints the gray Z SGR', () => assert.ok(sawGray, 'gray Z never painted'))
  // sleep total dwell = 3100ms; wait past it, the settled frame must be plain.
  await new Promise(resolve => setTimeout(resolve, 3100 + 900))
  const last = stdout.writes.slice(-3).join('')
  const all = stdout.writes.join('')
  check('sleep intro settles back to the standard pose (no Z)', () => {
    assert.ok(!last.includes(GRAY), 'gray leaked into the settled frame')
    assert.ok(all.includes('\x1b[38;2;20;38;96m'), 'whale outline never painted')
  })
  await instance.unmount()
}

console.log(`\nAll ${checks} whale-intro checks passed.`)
