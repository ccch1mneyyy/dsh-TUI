/**
 * Headless verification of the streaming scroll-jump fix: a transient
 * virtualized-content SHRINK frame (tail unmount + stale heightCache
 * spacer) must not yank an explicitly scrolled position. Before the fix,
 * the follow/clamp wrote scrollTop = maxScroll (0 when the transient
 * measurement dropped below the viewport) → the view jumped to the top
 * while streaming; now the position is frozen for the shrink frame and
 * re-validated when content grows back.
 *
 * Scenario: 60-row content in a 24-row viewport (maxScroll 36). Scroll
 * away from the top, then re-render with 20 rows (shrink: maxScroll 0),
 * then back to 60 (grow). The shrink frame must keep the pre-frame
 * scrollTop (36 / 10), never 0.
 *
 * Run with plain node against the compiled lib: `node scripts/verify-scroll.mjs`
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render, Text, ScrollBox } from '../lib/types/ui.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

const rows = (count) =>
  Array.from({ length: count }, (_, i) =>
    React.createElement(Text, { key: i }, `row ${i}`))

async function run() {
  const { stdout, stderr, stdin } = makeStreams()
  let scrollHandle = null
  // Frame log: every painted frame records the committed scroll geometry.
  const frameLog = []
  const makeScroller = (count) =>
    React.createElement(ScrollBox, {
      ref: h => { scrollHandle = h },
      stickyScroll: false,
      width: 40,
      height: 24,
      flexDirection: 'column',
    }, rows(count))
  const instance = await render(makeScroller(60), {
    stdout,
    stderr,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame: () => {
      frameLog.push({
        scrollTop: scrollHandle?.getScrollTop() ?? -1,
        scrollHeight: scrollHandle?.getScrollHeight() ?? -1,
      })
    },
  })
  await sleep(400)
  if (!scrollHandle) {
    check('ScrollBox handle attached', false)
    process.exit(failed)
  }
  check('ScrollBox handle attached', true)

  // ---- bottom-scrolled: 60 rows, maxScroll 36, scroll to 36.
  scrollHandle.scrollTo(36)
  await sleep(400)
  const bottomScrolled = frameLog.at(-1)
  check('bottom scroll landed at maxScroll', bottomScrolled.scrollTop === 36 && bottomScrolled.scrollHeight === 60, JSON.stringify(bottomScrolled))

  // ---- shrink frame: 20 rows → content collapses to the viewport height
  // (24; the content wrapper flexGrows to at least the viewport), so
  // maxScroll = 0. Must NOT jump to 0.
  instance.rerender(makeScroller(20))
  await sleep(400)
  const shrinkFrame = frameLog.find(f => f.scrollHeight === 24)
  check('shrink frame keeps the scrolled position (no jump to top)', shrinkFrame !== undefined && shrinkFrame.scrollTop === 36, JSON.stringify(shrinkFrame ?? frameLog.at(-1)))

  // ---- grow back: 60 rows. Position re-validated at the bottom.
  instance.rerender(makeScroller(60))
  await sleep(400)
  const grownFrame = frameLog.at(-1)
  check('grow-back frame stays at the bottom', grownFrame.scrollTop === 36 && grownFrame.scrollHeight === 60, JSON.stringify(grownFrame))

  // ---- mid-scrolled: 60 rows, scroll to 10 (away from bottom), shrink, grow.
  instance.rerender(makeScroller(60))
  await sleep(400)
  scrollHandle.scrollTo(10)
  await sleep(400)
  instance.rerender(makeScroller(20))
  await sleep(400)
  const midShrink = frameLog.filter(f => f.scrollHeight === 24).at(-1)
  check('mid-scroll shrink frame keeps the position', midShrink !== undefined && midShrink.scrollTop === 10, JSON.stringify(midShrink ?? frameLog.at(-1)))

  // ---- the frame AFTER the shrink artifact must not pull the mid position
  // to the bottom: the positional at-bottom check must not trust a maxScroll
  // computed from the artifact frame (opentui #709: content-size changes
  // must not reset the manual-scroll state).
  instance.rerender(makeScroller(60))
  await sleep(400)
  const midGrown = frameLog.at(-1)
  check('post-shrink grow frame keeps the mid position', midGrown.scrollTop === 10 && midGrown.scrollHeight === 60, JSON.stringify(midGrown))

  instance.unmount()
  process.exit(failed)
}

run()
