/**
 * Perf probe: what does one React commit cost in the ported-Ink layout, and
 * what does the ActivityLine 60fps clock do to the commit rate?
 *
 * Part A — commit cost vs mounted rows (rerender of the bottom input line).
 * Part B — steady-state frame rate with an ActivityLine ticking at 60ms
 *          (the TUI's perpetual working/idle status line) at small vs large
 *          row counts.
 *
 * Run: node scripts/perf-probe-enter.mjs
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render, Box, Text, ThemeProvider } from '../lib/types/ui.js'
import { ActivityLine } from '../lib/types/components/ActivityLine.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

function transcriptRows(n) {
  return Array.from({ length: n }, (_, i) =>
    React.createElement(Text, { key: `r${i}`, wrap: 'truncate' }, `row ${i} — some transcript content line ${i}`),
  )
}

async function partA(n, updates = 40) {
  const { stdout, stderr, stdin } = makeStreams()
  const rows = transcriptRows(n)
  const tree = (i) =>
    React.createElement(Box, { flexDirection: 'column' },
      ...rows,
      React.createElement(Text, { key: 'input' }, `❯ typed input ${i}`))
  const instance = await render(tree(0), { exitOnCtrlC: false, stdout, stderr, stdin })
  await sleep(100)
  // warm-up commit
  await instance.rerender(tree(1))
  await sleep(50)
  const t0 = performance.now()
  for (let i = 0; i < updates; i++) {
    await instance.rerender(tree(i + 2))
  }
  const dt = performance.now() - t0
  instance.unmount()
  console.log(`A rows=${n}  avg commit ${(dt / updates).toFixed(2)}ms (${updates} updates)`)
}

async function partB(n, windowMs = 2500) {
  const { stdout, stderr, stdin } = makeStreams()
  const rows = transcriptRows(n)
  const tree = React.createElement(
    ThemeProvider,
    null,
    React.createElement(Box, { flexDirection: 'column' },
      ...rows,
      React.createElement(ActivityLine, {
        key: 'activity',
        activity: { phase: 'thinking', line: '正在思考…', frames: [] },
        activityFrames: undefined,
      }),
    ),
  )
  const instance = await render(tree, { exitOnCtrlC: false, stdout, stderr, stdin })
  await sleep(300) // settle + clock warm
  stdout.frames.length = 0
  const t0 = performance.now()
  await sleep(windowMs)
  const dt = performance.now() - t0
  const frames = stdout.frames.length
  instance.unmount()
  console.log(`B rows=${n}  frames=${frames} in ${(dt / 1000).toFixed(1)}s → ${(frames / (dt / 1000)).toFixed(1)} commits/s`)
}

await partA(10)
await partA(30)
await partA(100)
await partA(300)
await partB(10)
await partB(30)
await partB(300)
await partC()
process.exit(0)

/**
 * Part C — idle clock pause: with a done-phase ActivityLine the 60ms clock
 * must not drive periodic commits; the only frames are one-time setup/teardown
 * sequences, so a settled window counts ~0 frames (live phase would count
 * many). Reproduces the "idle status line stops ticking" claim.
 */
async function partC(windowMs = 1500) {
  const { stdout, stderr, stdin } = makeStreams()
  const tree = React.createElement(
    ThemeProvider,
    null,
    React.createElement(Box, { flexDirection: 'column' },
      React.createElement(ActivityLine, {
        key: 'activity',
        activity: { phase: 'done', line: '完成', frames: [] },
        activityFrames: undefined,
      }),
    ),
  )
  const instance = await render(tree, { exitOnCtrlC: false, stdout, stderr, stdin })
  await sleep(300) // settle: initial content + one-time terminal mode frames
  stdout.frames.length = 0
  await sleep(windowMs)
  const frames = stdout.frames.length
  instance.unmount()
  console.log(`C done-phase: frames=${frames} in ${(windowMs / 1000).toFixed(1)}s (期望≈0，live 相位同一窗口应有 ~16+)`)
}
