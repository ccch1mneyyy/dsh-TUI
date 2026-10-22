/** Run npm run compile:src, then node --import tsx/esm scripts/verify-sixel-cursor-heal.tsx.
 * Actual renderer/worker/querier/parser output capture plus bounded lifecycle tests.
 * The terminal below injects cursor corruption; this is not native ConPTY acceptance.
 */
import '../lib/types/force-production-react.js'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { settled, sleep } from './lib/term-test.mjs'
import { AlternateScreen, Box, Image, Text, render } from '../lib/types/ui.js'
import instances from '../lib/types/ink/instances.js'
import { SixelCursorHeal } from '../lib/types/ink/sixel-cursor-heal.js'
import { TerminalQuerier } from '../lib/types/ink/terminal-querier.js'
import { parseMultipleKeypresses, INITIAL_STATE } from '../lib/types/ink/parse-keypress.js'

class Input extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
}
class Output extends Writable {
  isTTY = true
  columns = 50
  rows = 24
  data = ''
  row = 1
  col = 1
  samples: { row: number; col: number; frame: string; index: number }[] = []
  payloads = 0
  corrupt = false
  answer = true
  replyDelay = 0
  privateMode = 2
  constructor(readonly input: Input) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
    const data = String(chunk)
    this.data += data
    const reply = data === '\x1b[c' ? '\x1b[?62;4c'
      : data === '\x1b[?80$p' ? `\x1b[?80;${this.privateMode}$y`
        : data === '\x1b[16t' ? '\x1b[6;20;10t'
          : data === '\x1b[14t' ? '\x1b[4;480;500t' : ''
    if (reply) queueMicrotask(() => this.input.write(reply))
    // Independent terminal model: CUP sets text position; each sixel '-' is
    // a six-pixel band advance; WT leaves X at the originating text column.
    const tokens = /\x1bP[^\x1b]*\x1b\\|\x1b\[(\d+);(\d+)H|\x1b\[\?6n/gu
    for (const match of data.matchAll(tokens)) {
      if (match[0].startsWith('\x1bP')) {
        this.payloads++
        this.row += Math.floor([...match[0]].filter(byte => byte === '-').length * 6 / 20)
        if (this.corrupt) { this.row = Math.min(this.rows, this.row + 2); this.col = 17; this.corrupt = false }
      } else if (match[1]) {
        this.row = Number(match[1]); this.col = Number(match[2])
      } else {
        this.samples.push({ row: this.row, col: this.col, frame: data, index: match.index! })
        if (this.answer) {
          const report = `\x1b[?${this.row};${this.col};1R`
          if (this.replyDelay > 0) setTimeout(() => this.input.write(report), this.replyDelay)
          else queueMicrotask(() => this.input.write(report))
        }
      }
    }
    done()
  }
}
const env = { ...process.env }
process.env.WT_SESSION = 'sixel-fixture'
process.env.DSH_TUI_IMAGE_PROTOCOL = 'sixel'
delete process.env.TMUX
delete process.env.STY
delete process.env.DSH_TUI_ACCESSIBILITY
delete process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES
delete process.env.DSH_TUI_SIXEL_CURSOR_HEAL
const source = { width: 2, height: 3, data: new Uint8Array(24).fill(255) }
const tree = (height: number) => (
  <AlternateScreen><Box width={50} height={23} flexDirection="column">
    <Text>STATIC CONTENT</Text>
    <Image source={source} width={10} height={height} presentation="preview" alt="image"><Text>fallback</Text></Image>
  </Box></AlternateScreen>
)

for (const scenario of ['healthy', 'drift', 'delayed', 'disabled', 'unsupported', 'unsupported-terminal', 'timeout', 'resize', 'unmount'] as const) {
  const input = new Input()
  const output = new Output(input)
  if (scenario === 'unsupported-terminal') delete process.env.WT_SESSION
  else process.env.WT_SESSION = 'sixel-fixture'
  if (scenario === 'disabled') process.env.DSH_TUI_SIXEL_CURSOR_HEAL = '0'
  else delete process.env.DSH_TUI_SIXEL_CURSOR_HEAL
  if (scenario === 'unsupported') output.privateMode = 0
  if (scenario === 'delayed') output.replyDelay = 80
  output.corrupt = scenario === 'drift'
  output.answer = !['timeout', 'resize', 'unmount'].includes(scenario)
  const handle = await render(tree(3), { stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, patchConsole: false })
  const ink = instances.get(output as unknown as NodeJS.WriteStream)!
  let recoveries = 0
  const redraw = ink.forceRedraw.bind(ink)
  ink.forceRedraw = () => { recoveries++; redraw() }
  assert.ok(await settled(() => output.payloads > 0, { timeoutMs: 10_000 }), 'real sixel payload rendered')
  if (scenario === 'disabled' || scenario === 'unsupported' || scenario === 'unsupported-terminal') {
    assert.equal(output.samples.length, 0, `${scenario}: no new probe`)
  } else {
    assert.ok(await settled(() => output.samples.length > 0, { timeoutMs: 5000 }), 'pre-park query emitted')
    const sample = output.samples[0]!
    const payload = sample.frame.lastIndexOf('\x1bP', sample.index)
    const end = sample.frame.indexOf('\x1b\\', payload)
    const park = sample.frame.indexOf('\x1b[24;1H', sample.index)
    assert.ok(payload >= 0 && payload < end && end < sample.index && sample.index < park, 'strict payload → CPR → park order in the actual frame')
    if (scenario === 'healthy') {
      assert.equal(recoveries, 0)
      const count = output.samples.length
      handle.rerender(tree(6))
      assert.ok(await settled(() => output.samples.length > count, { timeoutMs: 5000 }), 'new image height probed')
      assert.equal(recoveries, 0, 'different image geometry never learns from a CPR sample')
    }
    if (scenario === 'drift') {
      assert.ok(await settled(() => recoveries === 1, { timeoutMs: 5000 }), 'corruption repaired once')
      assert.ok(await settled(() => output.samples.length >= 2, { timeoutMs: 5000 }), 'recovery frame checked')
      assert.ok(output.data.includes('\x1b[0m\x1b[2J\x1b[H'), 'recovery uses the physical Ctrl+L clear')
      assert.equal(recoveries, 1, 'healthy recovery frame stops the loop')
      assert.equal(output.row, 24, 'final cursor is parked correctly after recovery')
    }
    if (scenario === 'delayed') {
      handle.rerender(tree(6))
      await sleep(120) // 固定窗:探针 — reply remains bound to its earlier frame geometry.
      assert.equal(recoveries, 0, 'delayed CPR is compared to the emitting frame')
    }
    if (scenario === 'timeout') {
      await sleep(550) // 固定窗:探针 — production 500ms query timeout.
      const count = output.samples.length
      input.write('\x1b[?23;17;1R')
      handle.rerender(tree(6))
      await sleep(100) // 固定窗:探针 — delayed reply quarantine, no second probe.
      assert.equal(recoveries, 0)
      assert.equal(output.samples.length, count, 'timeout enters a 60s quiet period')
    }
    if (scenario === 'resize') {
      output.columns = 42
      output.emit('resize')
      input.write('\x1b[?23;17;1R')
      await sleep(100) // 固定窗:探针 — replies for old geometry must remain inert.
      assert.equal(recoveries, 0, 'resize cancels the outstanding geometry check')
      assert.equal(output.samples.length, 1, 'resize frame skips probing')
    }
  }
  if (scenario === 'unmount') {
    const exited = handle.waitUntilExit()
    handle.unmount()
    await exited
  } else await handle.detachForShutdown()
  const bytes = output.data.length
  input.write('\x1b[?23;17;1R')
  await Promise.resolve()
  assert.equal(output.data.length, bytes, 'late reply after teardown emits no recovery or probe')
  assert.equal(input.isRaw, false)
  input.destroy()
  console.log(`PASS actual renderer: ${scenario}`)
}

// Bind the real healer/query to a live renderer without graphics discovery's DA1
// sentinel: otherwise that sentinel can already reject the probe before exit.
for (const alreadyResolved of [false, true]) {
  const input = new Input(), output = new Output(input)
  output.answer = false
  const handle = await render(<AlternateScreen><Text>main-screen guard</Text></AlternateScreen>, {
    stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream,
    patchConsole: false, terminalImages: false,
  })
  const ink = instances.get(output as unknown as NodeJS.WriteStream)!
  const runtime = ink as unknown as { sixelCursorHeal: SixelCursorHeal; app: { querier: TerminalQuerier } }
  const querier = runtime.app.querier
  let recoveries = 0
  const redraw = ink.forceRedraw.bind(ink)
  ink.forceRedraw = () => { recoveries++; redraw() }
  output.write(runtime.sixelCursorHeal.prepare(querier, { row: 2, col: 2 }))
  assert.ok(querier.pendingResponseTypes.has('cursorPosition'), 'the transition test has a live CPR probe')
  const reply = () => {
    const [events] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[?23;17;1R')
    for (const event of events) if (event.kind === 'response') querier.onResponse(event.response)
  }
  if (alreadyResolved) reply()
  ink.setAltScreenActive(false)
  if (!alreadyResolved) reply()
  await Promise.resolve()
  assert.equal(recoveries, 0, `alt exit cancels ${alreadyResolved ? 'resolved callback' : 'pending query'}`)
  await handle.detachForShutdown()
  input.destroy()
  console.log(`PASS screen transition: ${alreadyResolved ? 'resolved callback' : 'pending query'}`)
}

// Exact timing/budget checks use the production controller with a controlled
// clock; the query queue and parser are real, not replicas of the policy.
{
  const input = new Input()
  const output = new Output(input)
  let now = 1000
  let repairs = 0
  const q = new TerminalQuerier(output as unknown as NodeJS.WriteStream)
  const heal = new SixelCursorHeal(() => { repairs++ }, () => {}, () => now)
  const report = (row: number) => {
    const [events] = parseMultipleKeypresses(INITIAL_STATE, `\x1b[?${row};1;7R`)
    for (const event of events) if (event.kind === 'response') q.onResponse(event.response)
  }
  for (let i = 0; i < 3; i++) {
    assert.equal(heal.prepare(q, { row: 2, col: 1 }), '\x1b[?6n')
    assert.equal(heal.prepare(q, { row: 2, col: 1 }), '', 'only one query in flight')
    report(3)
    await Promise.resolve()
    assert.equal(repairs, i + 1)
    now += 100
  }
  assert.equal(heal.prepare(q, { row: 2, col: 1 }), '', 'three failures mute probes')
  now += 59_899
  assert.equal(heal.prepare(q, { row: 2, col: 1 }), '')
  now += 2
  assert.equal(heal.prepare(q, { row: 2, col: 1 }), '\x1b[?6n', '60-second cooldown expires')
  report(2)
  await Promise.resolve()
  assert.equal(repairs, 3, 'page parameter and healthy answer do not repair')
  assert.equal(q.hasPending, false)
  heal.prepare(q, { row: 2, col: 1 })
  heal.dispose()
  assert.equal(q.hasPending, false, 'dispose removes pending query and timer')
  report(9)
  await Promise.resolve()
  assert.equal(repairs, 3)
  q.dispose()
  input.destroy()
  console.log('PASS bounded lifecycle: one in flight, three repairs/10s, 60s cooldown, cancellation')
}
process.env = env
console.log('PASS sixel cursor healing')
