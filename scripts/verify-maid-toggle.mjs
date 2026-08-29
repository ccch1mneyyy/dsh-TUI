/**
 * Component and channel regression for the maid persona easter egg.
 * Imports source through tsx, so it never relies on a pre-existing lib/ tree.
 *
 * Run: node --import tsx/esm scripts/verify-maid-toggle.mjs
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { render, ThemeProvider },
  { LogoHeader },
  { createChannel },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('../src/dsh-adapter/channel.js'),
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

function makeChannel(events = []) {
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
    session: { id: 's1', seq: 0, events },
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
  }
  return createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
  })
}

/** A `command/run` event shaped like the commands registry logs it. */
const maidRun = (args = '') =>
  ({ type: 'command/run', seq: 0, time: 0, data: { commandId: 'c', name: 'maid', args, source: { kind: 'user' } } })
const otherRun = (name = 'tips') =>
  ({ type: 'command/run', seq: 0, time: 0, data: { commandId: 'c', name, args: '', source: { kind: 'user' } } })

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

class FakeOutput extends Writable {
  constructor(columns) {
    super()
    this.columns = columns
  }
  rows = 30
  isTTY = true
  writes = []
  _write(chunk, _encoding, callback) {
    this.writes.push(String(chunk))
    callback()
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stripAnsi = text => text
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')
const MAID_PINK = '\x1b[38;2;220;197;198m'
const WHALE_OUTLINE = '\x1b[38;2;20;38;96m'

async function renderHeader({ columns, maid }) {
  const stdout = new FakeOutput(columns)
  const stderr = new FakeOutput(columns)
  const instance = await render(
    React.createElement(
      ThemeProvider,
      { theme: 'dark' },
      React.createElement(LogoHeader, { model: 'maid-model-probe', cwd: '/maid/cwd', maid }),
    ),
    {
      stdout,
      stderr,
      stdin: new FakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(180)
  const raw = stdout.writes.join('')
  await instance.unmount()
  return { raw, plain: stripAnsi(raw) }
}

// Channel fold semantics: toggle, explicit off, resume recovery, guard.
check('channel defaults maidActive to off', () => assert.equal(makeChannel().maidActive, false))
check('fold: bare /maid toggles on', () => assert.equal(makeChannel([maidRun('')]).maidActive, true))
check('fold: second bare /maid toggles back off', () => assert.equal(makeChannel([maidRun(''), maidRun('')]).maidActive, false))
check('fold: `/maid off` deactivates from active', () => assert.equal(makeChannel([maidRun(''), maidRun(' off ')]).maidActive, false))
check('fold: `/maid off` from inactive stays off', () => assert.equal(makeChannel([maidRun('off')]).maidActive, false))
// `on` is force-enable, not a flip: a future external plugin adding an
// `on` subcommand must not bounce an already-active session back to whale.
check('fold: `/maid on` from inactive activates', () => assert.equal(makeChannel([maidRun('on')]).maidActive, true))
check('fold: `/maid on` while active stays active (force, not flip)', () =>
  assert.equal(makeChannel([maidRun(''), maidRun(' on ')]).maidActive, true))
check('fold: args-bearing /maid (e.g. `/maid hello`) still toggles', () =>
  assert.equal(makeChannel([maidRun(''), maidRun('hello')]).maidActive, false))
check('fold: other commands never touch the fold', () =>
  assert.equal(makeChannel([maidRun(''), otherRun(), otherRun('goal')]).maidActive, true))

// The fold refresh lives in the channel's agent subscriptions, which the
// makeChannel fake ctx does not drive; the fold checks above cover the
// semantics and the header checks below cover the render, so close with the
// public state shape.
check('public state exposes maidActive alongside whale', () => {
  const live = makeChannel()
  assert.equal(typeof live.maidActive, 'boolean')
  assert.equal(typeof live.whale, 'boolean')
})

// Real LogoHeader -> LogoV2 rendering with each mascot.
const whaleHeader = await renderHeader({ columns: 100, maid: false })
check('maid=false keeps the whale (outline marker, no maid pink)', () => {
  assert.ok(whaleHeader.raw.includes(WHALE_OUTLINE), 'whale palette marker missing')
  assert.ok(!whaleHeader.raw.includes(MAID_PINK), 'maid palette leaked into whale mode')
})

const maidHeader = await renderHeader({ columns: 100, maid: true })
check('maid=true renders the whale girl (maid palette present)', () => {
  assert.ok(maidHeader.raw.includes(MAID_PINK), 'maid palette marker missing')
  assert.ok(maidHeader.plain.includes('maid-model-probe'), 'header details missing')
})
// Row-count parity lives in the sprite-rows check below (maid rows ==
// whale rows, whale baseline 13); this one pins the text logo next to the
// sprite — the layout element the row-count check cannot see.
check('maid render keeps the text logo beside the art', () => {
  assert.ok(maidHeader.plain.includes('dsh-TUI'), 'text logo missing')
})
{
  const { WHALE_FRAMES } = await import('../src/components/whaleFrames.js')
  const { renderSpriteRows } = await import('../src/components/Whale.js')
  // Whale palette mirrors Whale.tsx's private PALETTE (D/B/L/W — not exported).
  const WHALE_PALETTE = { D: [20, 38, 96], B: [78, 111, 255], L: [190, 225, 255], W: [255, 255, 255] }
  const { WHALE_MAID_FRAMES, MAID_PALETTE } = await import('../src/components/whaleMaidFrames.js')
  const whaleRows = renderSpriteRows(WHALE_FRAMES[0], WHALE_PALETTE).length
  const maidRows = renderSpriteRows(WHALE_MAID_FRAMES[0], MAID_PALETTE).length
  check('maid sprite renders exactly as many rows as whale (no layout growth)', () => {
    assert.equal(maidRows, whaleRows, `maid ${maidRows} rows vs whale ${whaleRows}`)
    assert.equal(whaleRows, 13, `whale baseline drifted: ${whaleRows}`)
  })
}

const maidNarrow = await renderHeader({ columns: 63, maid: true })
check('narrow terminal hides the maid art too (WHALE_MIN_COLUMNS shared)', () => {
  assert.ok(!maidNarrow.raw.includes(MAID_PINK), 'maid art should hide below 64 columns')
  assert.ok(maidNarrow.plain.includes('maid-model-probe'), 'header details missing')
})

// SGR residue guard (the WT report): renderSpriteRows run-length-encodes
// styles, and SGR is stateful — a single-sided cell written as a bare fg()
// inherits the previous cell's bg() under its transparent half, painting
// stale colors through the hair lines (25 ghost cells on Windows Terminal's
// pure-black default background before the fix). Walk a state machine over
// the emitted bytes and assert every half-block paints exactly the colors
// the sprite grid asks for.
{
  const { WHALE_MAID_FRAMES, MAID_PALETTE } = await import('../src/components/whaleMaidFrames.js')
  const { renderSpriteRows } = await import('../src/components/Whale.tsx')
  const frame = WHALE_MAID_FRAMES[0]
  const rows = renderSpriteRows(frame, MAID_PALETTE)
  const ghosts = []
  rows.forEach((ansiRow, tr) => {
    let fgCur = null
    let bgCur = null
    let col = 0
    for (const token of ansiRow.match(/\x1b\[[0-9;]*m|[^\x1b]/g) ?? []) {
      if (token.charCodeAt(0) === 27) {
        if (token === '\x1b[0m') { fgCur = null; bgCur = null }
        else {
          const parts = token.slice(2, -1).split(';').map(Number)
          if (parts[0] === 38 && parts[1] === 2) fgCur = parts.slice(2)
          if (parts[0] === 48 && parts[1] === 2) bgCur = parts.slice(2)
        }
      } else if (token === '▀' || token === '▄' || token === ' ') {
        const up = MAID_PALETTE[frame.rows[tr * 2]?.[col]] ?? null
        const lo = MAID_PALETTE[frame.rows[tr * 2 + 1]?.[col]] ?? null
        const painted = token === '▀' ? [fgCur, bgCur] : token === '▄' ? [bgCur, fgCur] : [null, null]
        for (const [want, got] of [[up, painted[0]], [lo, painted[1]]]) {
          if (String(want) !== String(got)) ghosts.push(`row${tr} col${col} ${token} want=${want} got=${got}`)
        }
        col++
      }
    }
  })
  check('no SGR residue: every half-block paints exactly the sprite colors', () => {
    assert.deepEqual(ghosts, [], `ghost cells:\n${ghosts.slice(0, 5).join('\n')}`)
  })
}

console.log(`\nAll ${checks} maid-toggle checks passed.`)
