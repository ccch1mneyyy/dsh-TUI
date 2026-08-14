/**
 * Headless verification of the wheel-to-bottom re-pin fix: scrolling UP
 * breaks sticky (scrollBy sets stickyScroll=false); wheeling back DOWN
 * onto the exact bottom must re-engage the follow even when no content
 * growth happens afterwards (stream idle) — otherwise the "N new messages"
 * pill stays visible while the view sits at the bottom.
 *
 * Scenario: 60-row content in a 24-row viewport (maxScroll 36), sticky on.
 * 1. scrollBy(-10)  → sticky broken, lands mid-list
 * 2. scrollBy(+999) → drains onto maxScroll; a no-growth re-render must
 *    restore isSticky()
 * 3. control: scrollBy(-10) then scrollBy(+5) (NOT reaching bottom) must
 *    keep isSticky() false
 *
 * Run with plain node against the compiled lib: `node scripts/verify-resticky.mjs`
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
  const makeScroller = (count) =>
    React.createElement(ScrollBox, {
      ref: h => { scrollHandle = h },
      stickyScroll: true,
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
  })
  await sleep(400)
  check('initial sticky follow pins to bottom', scrollHandle?.getScrollTop() === 36 && scrollHandle?.isSticky() === true,
    `scrollTop=${scrollHandle?.getScrollTop()} sticky=${scrollHandle?.isSticky()}`)

  // 1. scroll up: sticky breaks
  scrollHandle.scrollBy(-10)
  await sleep(400)
  check('scrollBy up breaks sticky', scrollHandle?.isSticky() === false, `sticky=${scrollHandle?.isSticky()}`)

  // React-side subscriber (mirrors Chat's useSyncExternalStore): the
  // renderer-side sticky restore must notify, or the UI snapshot stays stale.
  let notifyCount = 0
  const unsubscribe = scrollHandle.subscribe(() => { notifyCount++ })

  // 2. wheel down past the bottom, then a no-growth re-render
  scrollHandle.scrollBy(999)
  await sleep(400)
  const landed = scrollHandle?.getScrollTop()
  instance.rerender(makeScroller(60)) // same content: NO growth frame
  await sleep(400)
  check('wheel to bottom lands at maxScroll', landed === 36, `scrollTop=${landed}`)
  check('no-growth frame at bottom re-pins sticky', scrollHandle?.isSticky() === true, `sticky=${scrollHandle?.isSticky()}`)
  check('sticky restore notifies React subscribers', notifyCount > 0, `notifyCount=${notifyCount}`)
  unsubscribe()

  // 3. control: partial scroll down must NOT re-pin
  scrollHandle.scrollBy(-10)
  await sleep(400)
  scrollHandle.scrollBy(5)
  await sleep(400)
  instance.rerender(makeScroller(60))
  await sleep(400)
  const partialTop = scrollHandle?.getScrollTop()
  check('partial scroll down stays unsticky', scrollHandle?.isSticky() === false && partialTop < 36,
    `scrollTop=${partialTop} sticky=${scrollHandle?.isSticky()}`)

  instance.unmount()
  process.exit(failed)
}

run()
