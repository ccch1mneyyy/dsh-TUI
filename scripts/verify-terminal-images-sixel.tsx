/** Run pnpm compile:src first, then node --import tsx/esm this file.
 * Uses built modules so Worker entry resolution matches the published package.
 * Headless text/byte assertions are not native terminal visual acceptance.
 */
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import React from 'react'
import { decode } from 'sixel'
import xterm from '@xterm/headless'
import { AlternateScreen, Box, Image, Text, render } from '../lib/types/ui.js'
import { ImagePreviewOverlay } from '../lib/types/components/ImagePreviewOverlay.js'
import { loadSharp } from '../lib/types/dsh-adapter/sharp.js'
import instances from '../lib/types/ink/instances.js'
import { createNode } from '../lib/types/ink/dom.js'
import { encodeSixel } from '../lib/types/ink/sixel-codec.js'
import { SixelGraphicsManager } from '../lib/types/ink/sixel-graphics.js'
import { selectTerminalImageProtocol } from '../lib/types/ink/terminal-image-protocol.js'
import { CharPool, HyperlinkPool, StylePool, createScreen, setCellAt } from '../lib/types/ink/screen.js'
import type { TerminalImagePlacement, TerminalImageSource } from '../lib/types/ink/terminal-image.js'
import type { SixelEncodeRequest, SixelRaster } from '../lib/types/ink/sixel-codec.js'

async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check() && Date.now() < deadline) await delay(20)
  assert.ok(check(), message)
}
const { Terminal } = xterm
if (!await loadSharp()) { console.log('SKIP Sixel images: optional sharp unavailable'); process.exit(0) }
function decodeRaster(data: string) {
  const body = /^\x1bP0;1;q([\s\S]*)\x1b\\$/u.exec(data)?.[1]
  assert.ok(body, 'complete DCS introducer and terminator')
  return decode(body)
}

const source: TerminalImageSource = {
  width: 2, height: 2,
  data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 2, 3, 0]),
}
const raster = await encodeSixel({ source, width: 2, height: 2, background: '#ffffff' })
assert.match(raster.data, /^\x1bP0;1;q/u)
assert.ok(raster.data.endsWith('\x1b\\'))
const decoded = decodeRaster(raster.data)
assert.equal(decoded.width, 2)
assert.equal(decoded.height, 2)
const pixels = new Uint8Array(decoded.data32.buffer)
assert.deepEqual([...pixels], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])
assert.equal(source.data[15], 0, 'encoding must not mutate the shared RGBA')
for (const [width, height] of [[0, 1], [1025, 1], [1, Infinity], [1.5, 2]]) {
  await assert.rejects(encodeSixel({ source, width, height, background: '#000000' }))
}
await assert.rejects(encodeSixel({ source: { ...source, data: new Uint8Array(1) }, width: 2, height: 2, background: '#000000' }))
const tail = decodeRaster((await encodeSixel({ source, width: 13, height: 7, background: '#123456' })).data)
assert.equal(tail.width, 13)
assert.equal(tail.height, 7, 'last six-pixel band must not extend raster dimensions')
for (const background of ['ansi:blackBright', 'ansi256(238)', 'rgb(20,30,40)']) {
  assert.equal(decodeRaster((await encodeSixel({ source, width: 2, height: 2, background })).data).width, 2)
}
assert.equal(selectTerminalImageProtocol('OK', [61, 4], undefined), 'kitty')
assert.equal(selectTerminalImageProtocol(undefined, [61, 4, 28], undefined), 'sixel')
assert.equal(selectTerminalImageProtocol(undefined, [4], undefined), 'none', 'device class is not a capability')
assert.equal(selectTerminalImageProtocol(undefined, [61], undefined), 'none')
assert.equal(selectTerminalImageProtocol('OK', [61, 4], 'none'), 'none')
assert.equal(selectTerminalImageProtocol('OK', [61, 4], 'sixel'), 'sixel')
assert.equal(selectTerminalImageProtocol(undefined, undefined, 'invalid'), 'none')

const styles = new StylePool()
const chars = new CharPool()
const links = new HyperlinkPool()
const screen = () => createScreen(40, 16, styles, chars, links)
const node = createNode('ink-image')
const placement: TerminalImagePlacement = { node, source, x: 2, y: 3, columns: 8, rows: 4, presentation: 'preview', background: '#ffffff' }
const jobs: Array<{ request: SixelEncodeRequest; resolve: (value: SixelRaster) => void }> = []
let notifications = 0
const manager = new SixelGraphicsManager(() => notifications++, request => new Promise(resolve => jobs.push({ request, resolve })))
manager.setCellSize({ width: 10, height: 20 })
manager.beginFrame(40, 16)
assert.equal(manager.prepare({ ...placement, presentation: undefined }), false, 'unmarked plugin images retain fallback')
assert.equal(manager.prepare(placement), false, 'pending pixels keep text fallback')
manager.reconcile(screen(), screen())
assert.equal(jobs.length, 1)
assert.deepEqual([jobs[0].request.width, jobs[0].request.height], [80, 80])
const readyRaster = { width: 80, height: 80, data: raster.data }
jobs[0].resolve(readyRaster)
await until(() => notifications === 1, 'async completion should request a repaint')
manager.beginFrame(40, 16)
assert.equal(manager.prepare(placement), true)
assert.equal(manager.reconcile(screen(), screen()).erase, '')
assert.match(manager.paint([]), /^\x1b\[4;3H/u)
manager.beginFrame(40, 16)
manager.prepare(placement)
manager.reconcile(screen(), screen())
assert.equal(manager.paint([{ type: 'cursorMove', x: 0, y: 12 }, { type: 'stdout', content: 'spinner' }]), '', 'unrelated text must not retransmit image')
assert.notEqual(manager.paint([{ type: 'cursorMove', x: 3, y: 4 }, { type: 'stdout', content: ' ' }]), '', 'a text write touching pixels must repair the image')
manager.setDisplayMode(true)
const borrowedMode = manager.paint([])
assert.ok(borrowedMode.startsWith('\x1b[?80l'))
assert.ok(borrowedMode.endsWith('\x1b[?80h'), 'restore borrowed terminal display mode')
manager.setDisplayMode(false)
manager.beginFrame(40, 16)
const removed = manager.reconcile(screen(), screen())
assert.match(removed.erase, /\x1b\[8X/u, 'blank-to-blank removal still emits an erase')
assert.equal(manager.paint([]), '')
manager.beginFrame(40, 16)
manager.prepare(placement)
const covered = screen()
setCellAt(covered, 3, 4, { char: 'X', width: 0, styleId: styles.none })
manager.reconcile(covered, screen())
assert.equal(manager.paint([]), '', 'image must not overpaint a text overlay')

manager.beginFrame(40, 16)
manager.prepare({ ...placement, columns: 9 })
manager.reconcile(screen(), screen())
await until(() => jobs.length === 2, 'new geometry queues work')
manager.beginFrame(40, 16)
manager.prepare({ ...placement, columns: 10 })
manager.reconcile(screen(), screen())
manager.beginFrame(40, 16)
manager.prepare({ ...placement, columns: 11 })
manager.reconcile(screen(), screen())
jobs[1].resolve({ ...readyRaster, width: 90 })
await until(() => jobs.length === 3, 'only latest pending geometry is processed')
assert.equal(jobs[2].request.width, 110)
const beforeClose = notifications
manager.clear()
jobs[2].resolve({ ...readyRaster, width: 110 })
await delay(20)
assert.equal(notifications, beforeClose, 'closed preview must not be resurrected by an old job')
manager.dispose()

let failedReady = 0
const failed = new SixelGraphicsManager(() => failedReady++, async () => { throw new Error('fixture failure') })
failed.beginFrame(40, 16)
assert.equal(failed.prepare(placement), false)
failed.reconcile(screen(), screen())
await until(() => failedReady === 1, 'failure resolves the pending job')
failed.beginFrame(40, 16)
assert.equal(failed.prepare(placement), false, 'failed encoding retains fallback without retrying every frame')
failed.dispose()

const coalesced: Array<{ request: SixelEncodeRequest; resolve: (value: SixelRaster) => void }> = []
const latest = new SixelGraphicsManager(() => {}, request => new Promise(resolve => coalesced.push({ request, resolve })))
latest.beginFrame(40, 16)
latest.prepare(placement)
latest.reconcile(screen(), screen())
latest.beginFrame(40, 16)
latest.prepare({ ...placement, columns: 9 })
latest.reconcile(screen(), screen())
latest.beginFrame(40, 16)
latest.prepare(placement)
latest.reconcile(screen(), screen())
coalesced[0].resolve(readyRaster)
await delay(20)
assert.equal(coalesced.length, 1, 'returning to the active request withdraws obsolete pending work')
latest.dispose()

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
  rows = 18
  data = ''
  constructor(readonly input: Input, readonly capabilities: string) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
    const text = String(chunk)
    this.data += text
    const reply = text === '\x1b[c' ? this.capabilities
      : text === '\x1b[?80$p' ? '\x1b[?80;1$y'
      : text === '\x1b[16t' ? '\x1b[6;20;10t'
        : text === '\x1b[14t' ? '\x1b[4;360;500t' : ''
    if (reply) queueMicrotask(() => this.input.write(reply))
    done()
  }
}
const oldEnv = { ...process.env }
delete process.env.TMUX
delete process.env.STY
delete process.env.CLAUDE_CODE_ACCESSIBILITY
delete process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES
delete process.env.DSH_TUI_IMAGE_PROTOCOL
const imageTree = (show: boolean, counter = 0, preview = true, covered = false) => (
  <AlternateScreen>
    <Box width={50} height={17} flexDirection="column">
      <Text>PREVIEW HEADER</Text>
      <Box height={7}>
        {show ? <Image source={source} width={8} height={4} alt="test" presentation={preview ? 'preview' : undefined}><Text>FALLBACK</Text></Image> : null}
      </Box>
      <Text>AFTER {counter}</Text>
      {covered ? <Box position="absolute" top={1} left={0} width={8} height={4} opaque><Text>{'        \n        \n        \n        '}</Text></Box> : null}
    </Box>
  </AlternateScreen>
)
const stdin = new Input()
const stdout = new Output(stdin, '\x1b[?61;4;28c')
const stderr = new Writable({ write(_chunk, _encoding, done) { done() } })
const app = await render(imageTree(true), { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false })
try {
  await until(() => stdout.data.includes('\x1bP0;1;q'), 'DA1 capability must enable a real compiled-worker image')
  assert.ok(stdout.data.includes('FALLBACK'), 'fallback is visible during preparation')
  assert.ok(!stdout.data.includes('a=t,t=d,f=32'), 'Sixel terminal receives no Kitty uploads')
  assert.ok(stdout.data.includes('\x1b[?80l'))
  assert.ok(stdout.data.includes('\x1b[?80h'), 'integration restores the original display mode')
  const firstEnd = stdout.data.length
  app.rerender(imageTree(true, 1))
  await until(() => stdout.data.length > firstEnd, 'unrelated counter renders')
  await delay(50)
  assert.ok(!stdout.data.slice(firstEnd).includes('\x1bP0;1;q'), 'spinner/text-only changes do not resend pixels')
  const coverStart = stdout.data.length
  app.rerender(imageTree(true, 1, true, true))
  await until(() => stdout.data.slice(coverStart).includes('\x1b[8X'), 'a blank overlay erases pixels beneath it')
  assert.ok(!stdout.data.slice(coverStart).includes('\x1bP0;1;q'), 'blank overlays must not be pierced by Sixel')
  const uncoverStart = stdout.data.length
  app.rerender(imageTree(true, 1))
  await until(() => stdout.data.slice(uncoverStart).includes('\x1bP0;1;q'), 'uncovering restores cached pixels')
  const closeStart = stdout.data.length
  app.rerender(imageTree(false))
  await until(() => stdout.data.slice(closeStart).includes('\x1b[8X'), 'closing a preview must erase actual pixels')
  const terminal = new Terminal({ cols: 50, rows: 18, allowProposedApi: true })
  await new Promise<void>(resolve => terminal.write(stdout.data, resolve))
  const lines = Array.from({ length: 18 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? [])
  assert.ok(lines.some(line => line.includes('PREVIEW HEADER')))
  assert.ok(lines.some(line => line.includes('AFTER')))
  assert.ok(!lines.some(line => line.includes('FALLBACK')), 'closing restores underlying text')
  assert.equal(terminal.buffer.active.cursorY, 17, 'cursor stays parked at the input row')
  terminal.dispose()
  for (let i = 0; i < 10; i++) {
    const start = stdout.data.length
    app.rerender(imageTree(true))
    await until(() => stdout.data.slice(start).includes('\x1bP0;1;q'), 'cached reopen paints')
    app.rerender(imageTree(false))
    await until(() => stdout.data.slice(start).includes('\x1b[8X'), 'repeated close erases')
  }
  const thumbnailStart = stdout.data.length
  app.rerender(imageTree(true, 0, false))
  await delay(100)
  assert.ok(!stdout.data.slice(thumbnailStart).includes('\x1bP0;1;q'))
  stdout.columns = 35
  stdout.rows = 15
  stdout.emit('resize')
  const resizeStart = stdout.data.length
  app.rerender(imageTree(true))
  await until(() => stdout.data.slice(resizeStart).includes('\x1bP0;1;q'), 'resize repositions and repaints')
  const ink = instances.get(stdout)
  assert.ok(ink)
  const handoffStart = stdout.data.length
  ink.enterAlternateScreen()
  assert.ok(stdout.data.slice(handoffStart).includes('\x1b[8X'), 'editor handoff erases displayed pixels before transfer')
  await delay(50)
  assert.ok(!stdout.data.slice(handoffStart).includes('\x1bP0;1;q'), 'no drawing while the editor owns the terminal')
  ink.exitAlternateScreen()
  await until(() => stdout.data.slice(handoffStart).includes('\x1bP0;1;q'), 'handoff restoration redraws the cached image')
} finally {
  stdout.isTTY = false
  app.unmount()
}
const sharp = await loadSharp()
assert.ok(sharp)
const png = await sharp(source.data, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer()
const previewImage = { id: 'sixel-overlay-fixture', width: 2, height: 2, name: 'test.png', mediaType: 'image/png', read: async () => png }
const overlayInput = new Input()
const overlayOutput = new Output(overlayInput, '\x1b[?61;4;28c')
const overlayTree = (show: boolean) => <AlternateScreen><Box width={50} height={17} flexDirection="column"><Text>CONVERSATION</Text>{show ? <ImagePreviewOverlay image={previewImage} onClose={() => {}} region={{ columns: 50, rows: 17 }} /> : null}</Box></AlternateScreen>
const overlayApp = await render(overlayTree(true), { stdin: overlayInput, stdout: overlayOutput, stderr, exitOnCtrlC: false, patchConsole: false })
try {
  await until(() => overlayOutput.data.includes('\x1bP0;1;q'), 'the real preview card must display Sixel with its inherited theme background')
  const start = overlayOutput.data.length
  overlayApp.rerender(overlayTree(false))
  await until(() => /\x1b\[\d+X/u.test(overlayOutput.data.slice(start)), 'the real card close erases Sixel')
} finally {
  overlayOutput.isTTY = false
  overlayApp.unmount()
}
for (const [name, env, caps] of [
  ['unsupported', {}, '\x1b[?61c'],
  ['disabled', { DSH_TUI_DISABLE_TERMINAL_IMAGES: '1' }, '\x1b[?61;4c'],
  ['accessibility', { CLAUDE_CODE_ACCESSIBILITY: '1' }, '\x1b[?61;4c'],
  ['multiplexer', { TMUX: 'test' }, '\x1b[?61;4c'],
] as const) {
  Object.assign(process.env, env)
  const input = new Input()
  const output = new Output(input, caps)
  const instance = await render(imageTree(true), { stdin: input, stdout: output, stderr, exitOnCtrlC: false, patchConsole: false })
  await delay(100)
  assert.ok(output.data.includes('FALLBACK'), name)
  assert.ok(!output.data.includes('\x1bP0;1;q'), name)
  output.isTTY = false
  instance.unmount()
  for (const key of Object.keys(env)) delete process.env[key]
}
for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
Object.assign(process.env, oldEnv)
console.log('Sixel codec, async lifecycle, fallback, erase and preview regression passed')
