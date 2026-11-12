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
 * then back to 60 (grow). A MID-SCROLL shrink frame must keep the
 * pre-frame scrollTop (10), never 0.
 *
 * Exception (#421/#422 contract): scrolling to the EXACT bottom re-pins
 * sticky (the wheel-tremor restore in render-node-to-output). A sticky
 * view on a shrink frame clamps to the shrunken maxScroll instead of
 * freezing — the freeze would park scrollTop past the whole collapsed
 * content and paint blank; clamping shows the (real) bottom rows.
 * "Nothing renderable exists below maxScroll" — so the bottom-scrolled
 * shrink frame now expects scrollTop 0 (= collapsed maxScroll).
 *
 * Run with plain node against the compiled lib: `node scripts/verify-scroll.mjs`
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render, Text, Box, ScrollBox } from '../lib/types/ui.js'
import { settle, settled, sleep } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

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

let firstRowElement = null
const rows = (count) =>
  Array.from({ length: count }, (_, i) =>
    i === 0
      ? React.createElement(Box, { key: i, ref: el => { firstRowElement = el }, height: 1 }, React.createElement(Text, null, `row ${i}`))
      : React.createElement(Text, { key: i }, `row ${i}`))

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
        pending: scrollHandle?.getPendingDelta() ?? 0,
      })
    },
  })
  // The extra frame clause is ordering: scrollTo below needs the first
  // full-height layout committed, which the fixed sleep used to cover.
  check('ScrollBox handle attached', await settled(() => scrollHandle !== null && frameLog.at(-1)?.scrollHeight === 60))
  if (!scrollHandle) process.exit(failed)

  // ---- bottom-scrolled: 60 rows, maxScroll 36, scroll to 36.
  scrollHandle.scrollTo(36)
  check('bottom scroll landed at maxScroll', await settled(() => frameLog.at(-1)?.scrollTop === 36 && frameLog.at(-1)?.scrollHeight === 60), JSON.stringify(frameLog.at(-1)))

  // ---- shrink frame: 20 rows → content collapses to the viewport height
  // (24; the content wrapper flexGrows to at least the viewport), so
  // maxScroll = 0. scrollTo(36) landed on the exact bottom, which re-pins
  // sticky; a sticky shrink frame clamps to the collapsed maxScroll (#421:
  // freezing past the content paints blank — see the docstring exception).
  instance.rerender(makeScroller(20))
  check('shrink frame clamps the re-pinned sticky view to the collapsed bottom', await settled(() => {
    const f = frameLog.find(f => f.scrollHeight === 24)
    return f !== undefined && f.scrollTop === 0
  }), JSON.stringify(frameLog.find(f => f.scrollHeight === 24) ?? frameLog.at(-1)))

  // ---- grow back: 60 rows. Position re-validated at the bottom.
  instance.rerender(makeScroller(60))
  check('grow-back frame stays at the bottom', await settled(() => frameLog.at(-1)?.scrollTop === 36 && frameLog.at(-1)?.scrollHeight === 60), JSON.stringify(frameLog.at(-1)))

  // ---- mid-scrolled: 60 rows, scroll to 10 (away from bottom), shrink, grow.
  instance.rerender(makeScroller(60))
  await settle(() => frameLog.at(-1)?.scrollHeight === 60)
  scrollHandle.scrollTo(10)
  await settle(() => frameLog.at(-1)?.scrollTop === 10)
  instance.rerender(makeScroller(20))
  check('mid-scroll shrink frame keeps the position', await settled(() => {
    const f = frameLog.filter(f => f.scrollHeight === 24).at(-1)
    return f !== undefined && f.scrollTop === 10
  }), JSON.stringify(frameLog.filter(f => f.scrollHeight === 24).at(-1) ?? frameLog.at(-1)))

  // ---- the frame AFTER the shrink artifact must not pull the mid position
  // to the bottom: the positional at-bottom check must not trust a maxScroll
  // computed from the artifact frame (opentui #709: content-size changes
  // must not reset the manual-scroll state).
  instance.rerender(makeScroller(60))
  check('post-shrink grow frame keeps the mid position', await settled(() => frameLog.at(-1)?.scrollTop === 10 && frameLog.at(-1)?.scrollHeight === 60), JSON.stringify(frameLog.at(-1)))

  // A negative anchor offset is a public path to negative cur without wheel
  // input. On the same shrink frame the #421 freeze must preserve positive
  // positions, but must never paint/persist a position above the top (#1786).
  scrollHandle.scrollToElement(firstRowElement, -3)
  const beforeNegativeShrink = frameLog.length
  instance.rerender(makeScroller(20))
  check('shrink frame clamps negative anchor positions to zero', await settled(() => {
    const frame = frameLog.slice(beforeNegativeShrink).find(frame => frame.scrollHeight === 24)
    return frame !== undefined && frame.scrollTop === 0
  }), JSON.stringify(frameLog.slice(beforeNegativeShrink)))
  instance.rerender(makeScroller(60))
  await settle(() => frameLog.at(-1)?.scrollHeight === 60)
  scrollHandle.scrollTo(10)
  await settle(() => frameLog.at(-1)?.scrollTop === 10)

  // A real content removal at the SAME width is not an indefinitely
  // recovering virtual window. Its next stable-height paint must clamp the
  // old position, so the bottom remains reachable and follow can resume.
  instance.rerender(makeScroller(20))
  check('real shrink keeps the position for its first frame', await settled(() =>
    frameLog.at(-1)?.scrollHeight === 24 && frameLog.at(-1)?.scrollTop === 10))
  instance.rerender(makeScroller(21))
  check('stable real shrink clamps to the new bottom', await settled(() =>
    frameLog.at(-1)?.scrollHeight === 24 && frameLog.at(-1)?.scrollTop === 0 && scrollHandle.isSticky()))
  instance.rerender(makeScroller(60))
  check('growth after a real shrink follows the reachable bottom', await settled(() =>
    frameLog.at(-1)?.scrollHeight === 60 && frameLog.at(-1)?.scrollTop === 36))

  // No animated parent or streaming updates: after this one content update,
  // only imperative scroll events may publish the settled geometry (#1207).
  instance.rerender(makeScroller(500))
  check('drain fixture has full content height', await settled(() =>
    frameLog.at(-1)?.scrollHeight === 500))
  const observed = []
  const unsubscribe = scrollHandle.subscribe(() => observed.push({
    top: scrollHandle.getScrollTop(),
    pending: scrollHandle.getPendingDelta(),
    sticky: scrollHandle.isSticky(),
  }))
  const landed = top => frameLog.at(-1)?.scrollTop === top &&
    frameLog.at(-1)?.pending === 0 && observed.at(-1)?.top === top &&
    observed.at(-1)?.pending === 0

  // A pending downward notch at the top must still accept its cancelling
  // upward notch; the top overscroll gate applies only without positive debt.
  scrollHandle.scrollTo(0)
  await settle(() => landed(0))
  // Upward wheel input must still cancel a pending anchor seek even when
  // its old committed position is already at the top (#1786).
  const beforeAnchorCancel = frameLog.length
  scrollHandle.scrollToElement(firstRowElement, 20)
  scrollHandle.scrollBy(-3)
  check('upward input at top cancels an in-flight anchor seek', await settled(() =>
    frameLog.length > beforeAnchorCancel && landed(0)),
    JSON.stringify(frameLog.slice(beforeAnchorCancel)))
  scrollHandle.scrollTo(0)
  await settle(() => landed(0))
  observed.length = 0
  scrollHandle.scrollBy(3)
  scrollHandle.scrollBy(-3)
  check('opposing inputs at the top cancel pending downward debt',
    scrollHandle.getPendingDelta() === 0)
  check('cancelled top input stays at the top', await settled(() =>
    observed.length > 0 && landed(0)))

  scrollHandle.scrollTo(300)
  check('manual drain starts from a published position', await settled(() => landed(300)))
  observed.length = 0
  const naturalFrames = frameLog.length
  scrollHandle.scrollBy(-120)
  check('natural drain publishes its final manual position', await settled(() => landed(180)), JSON.stringify(observed))
  check('multi-frame drain does not notify per intermediate frame',
    frameLog.slice(naturalFrames).filter(frame => frame.pending !== 0).length > 1 &&
    observed.length <= 2, `notifications=${observed.length}`)
  const idleNotifications = observed.length
  await sleep(250) // 固定窗:探针 已排空后没有周期性补偿通知
  check('idle scroll state emits no periodic notifications', observed.length === idleNotifications)

  scrollHandle.scrollBy(-1000)
  check('top clamp publishes the consumed remainder', await settled(() =>
    landed(0) && observed.at(-1)?.sticky === false), JSON.stringify(observed.at(-1)))
  scrollHandle.scrollBy(1000)
  check('bottom clamp publishes the re-pinned final position', await settled(() =>
    landed(476) && observed.at(-1)?.sticky === true), JSON.stringify(observed.at(-1)))

  scrollHandle.scrollTo(200)
  check('opposing input starts from a published position', await settled(() => landed(200)))
  observed.length = 0
  const cancelFrames = frameLog.length
  scrollHandle.scrollBy(-80)
  scrollHandle.scrollBy(80)
  check('opposing inputs publish zero pending scroll', await settled(() =>
    observed.length > 0 && landed(200)))
  await sleep(250) // 固定窗:探针 抵消后的延迟帧不得滚动或形成通知循环
  check('opposing inputs stay still without a notification loop',
    frameLog.slice(cancelFrames).every(frame => frame.scrollTop === 200 && frame.pending === 0) &&
    observed.length <= 2, `notifications=${observed.length}`)
  unsubscribe()
  const unsubscribedNotifications = observed.length
  scrollHandle.scrollBy(60)
  check('scrolling still drains after unsubscribe', await settled(() =>
    frameLog.at(-1)?.scrollTop === 260 && frameLog.at(-1)?.pending === 0))
  check('unsubscribed observer receives no scroll updates', observed.length === unsubscribedNotifications)

  instance.unmount()
  process.exit(failed)
}

run()
