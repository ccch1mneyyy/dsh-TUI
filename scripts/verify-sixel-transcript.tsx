/** pnpm compile:src first; node --import tsx/esm scripts/verify-sixel-transcript.tsx.
 * Uses xterm's parser plus a pixel plane for Sixel/ECH/ED. This checks emitted
 * positions and residue, not native Windows Terminal rendering performance.
 */
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import React from 'react'
import xterm from '@xterm/headless'
import { decode } from 'sixel'
import { AlternateScreen, Box, Image, ScrollBox, Text, render } from '../lib/types/ui.js'
import type { ScrollBoxHandle } from '../lib/types/ui.js'
import { SixelEncoderCache } from '../lib/types/ink/sixel-codec.js'
import { SixelGraphicsManager } from '../lib/types/ink/sixel-graphics.js'
import { createNode } from '../lib/types/ink/dom.js'
import { CharPool, HyperlinkPool, StylePool, createScreen } from '../lib/types/ink/screen.js'
import instances from '../lib/types/ink/instances.js'
import { loadSharp } from '../lib/types/dsh-adapter/sharp.js'
import { TranscriptImages, loadTranscriptImageFull, clearTranscriptImageCacheForTests } from '../lib/types/components/messages/TranscriptImages.js'
import type { TerminalImagePlacement, TerminalImageSource } from '../lib/types/ink/terminal-image.js'

const { Terminal } = xterm
const sharp = await loadSharp()
if (!sharp) { console.log('SKIP Sixel transcript: optional sharp unavailable'); process.exit(0) }
const oldEnv = { ...process.env }
for (const key of ['TMUX', 'STY', 'CLAUDE_CODE_ACCESSIBILITY', 'DSH_TUI_DISABLE_TERMINAL_IMAGES', 'DSH_TUI_IMAGE_PROTOCOL']) delete process.env[key]

async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!check() && Date.now() < deadline) await delay(20)
  assert.ok(check(), message)
}

function decodeDcs(data: string) {
  const body = /^\x1bP0;1;q([\s\S]*)\x1b\\$/u.exec(data)?.[1]
  assert.ok(body)
  return decode(body)
}

const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]
function stripes(shift: number): TerminalImageSource {
  const data = new Uint8Array(80 * 80 * 4)
  for (let y = 0; y < 80; y++) {
    const rgb = palette[(Math.floor(y / 20) + shift) % 4]
    for (let x = 0; x < 80; x++) data.set([...rgb, 255], (y * 80 + x) * 4)
  }
  return { data, width: 80, height: 80 }
}
const a = stripes(0)
const b = stripes(1)
const c = stripes(2)
const png = await sharp(a.data, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer()

// Shared pending reads survive one consumer leaving, but stop at the last one.
clearTranscriptImageCacheForTests()
let sharedReads = 0
let sharedSignal: AbortSignal | undefined
let finishRead: ((data: Uint8Array) => void) | undefined
const sharedImage = { id: 'shared', width: 80, height: 80, read(signal?: AbortSignal) {
  sharedReads++
  sharedSignal = signal
  return new Promise<Uint8Array>(resolve => { finishRead = resolve })
} }
const firstConsumer = new AbortController()
const secondConsumer = new AbortController()
const firstRead = loadTranscriptImageFull(sharedImage, firstConsumer.signal)
const firstRejection = assert.rejects(firstRead)
const secondRead = loadTranscriptImageFull(sharedImage, secondConsumer.signal)
await until(() => sharedReads === 1, 'shared attachment read starts once')
firstConsumer.abort()
await firstRejection
assert.equal(sharedSignal?.aborted, false, 'another mounted consumer still owns the shared read')
finishRead!(png)
assert.equal((await secondRead).width, 80)

clearTranscriptImageCacheForTests()
let startedReads = 0
const controllers = Array.from({ length: 8 }, () => new AbortController())
const pendingReads = controllers.map((controller, index) => loadTranscriptImageFull({
  id: 'cancel-' + index, width: 80, height: 80,
  read(signal?: AbortSignal) {
    startedReads++
    assert.ok(signal)
    return new Promise<Uint8Array>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  },
}, controller.signal))
const cancelledReads = Promise.allSettled(pendingReads)
await until(() => startedReads === 2, 'at most two attachment reads/native decodes run concurrently')
for (const controller of controllers) controller.abort()
assert.ok((await cancelledReads).every(result => result.status === 'rejected'))
await delay(20)
assert.equal(startedReads, 2, 'queued reads removed on unmount must never start')
clearTranscriptImageCacheForTests()
const codec = new SixelEncoderCache()
const full = await codec.render({ assetKey: 'a', request: { source: a, width: 80, height: 80, background: '#000000' } })
assert.equal(full.quantized, true)
const fullPixels = decodeDcs(full.raster!.data).data32
for (const top of [1, 5, 20, 41]) for (const left of [0, 3]) {
  const width = left === 0 ? 80 : 13
  const result = await codec.render({ assetKey: 'a', request: {
    width: 80, height: 80, background: '#000000', crop: { left, top, width, height: 7 },
  } })
  assert.equal(result.quantized, false, 'cropping must reuse worker quantization without a source transfer')
  const cropped = decodeDcs(result.raster!.data)
  assert.deepEqual([cropped.width, cropped.height], [width, 7])
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < width; x++) assert.equal(cropped.data32[y * width + x], fullPixels[(top + y) * 80 + x + left])
  }
}
assert.equal((await codec.render({ assetKey: 'missing', request: { width: 80, height: 80, background: '#000000' } })).missing, true)
await assert.rejects(codec.render({ assetKey: 'a', request: { width: 80, height: 80, background: '#000000', crop: { left: 79, top: 0, width: 2, height: 1 } } }))

// All visible jobs survive; repeated content shares work; a modal wins priority.
const styles = new StylePool()
const chars = new CharPool()
const links = new HyperlinkPool()
const blank = () => createScreen(40, 16, styles, chars, links)
const jobs: Array<{ request: import('../lib/types/ink/sixel-codec.js').SixelEncodeRequest; resolve: (r: import('../lib/types/ink/sixel-codec.js').SixelRaster) => void }> = []
let notices = 0
const manager = new SixelGraphicsManager(() => notices++, request => new Promise(resolve => jobs.push({ request, resolve })))
manager.setCellSize({ width: 10, height: 20 })
const placement = (source: TerminalImageSource, x: number, presentation: 'transcript' | 'preview' = 'transcript'): TerminalImagePlacement => ({
  node: createNode('ink-image'), source, x, y: 1, columns: 8, rows: 4, presentation,
})
const one = placement(a, 0)
const repeated = placement(a, 10)
const modal = placement(b, 20, 'preview')
manager.beginFrame(40, 16)
for (const p of [one, repeated, modal]) manager.prepare(p)
manager.reconcile(blank(), blank())
assert.equal(jobs.length, 1)
assert.equal(jobs[0].request.source, b, 'modal has priority over queued thumbnails')
jobs[0].resolve({ width: 80, height: 80, data: full.raster!.data })
await until(() => jobs.length === 2, 'other visible content is not cancelled')
assert.equal(jobs[1].request.source, a)
jobs[1].resolve({ width: 80, height: 80, data: full.raster!.data })
await until(() => notices === 2, 'both visible jobs complete')
assert.equal(jobs.length, 2, 'same content at two positions encodes once')
manager.beginFrame(40, 16)
for (const p of [one, repeated, modal]) assert.equal(manager.prepare(p), true)
manager.reconcile(blank(), blank())
assert.equal((manager.paint([]).match(/\x1bP0;1;q/gu) ?? []).length, 3, 'one placement per visible DOM image')
manager.beginFrame(40, 16)
manager.prepare(repeated)
const removal = manager.reconcile(blank(), blank())
assert.ok(removal.erase.includes('\x1b[8X'))
assert.equal(manager.paint([]), '', 'removing neighbours does not repaint an untouched image')
manager.dispose()

// Cache eviction is byte-based, not just entry-based.
let budgetNotices = 0
const payload = 'x'.repeat(1024 * 1024)
const budget = new SixelGraphicsManager(() => budgetNotices++, async request => ({ width: request.crop!.width, height: request.crop!.height, data: payload }))
const sources = Array.from({ length: 20 }, () => ({ ...a, data: new Uint8Array(a.data) }))
for (let i = 0; i < sources.length; i++) {
  budget.beginFrame(40, 16)
  budget.prepare(placement(sources[i], 0))
  budget.reconcile(blank(), blank())
  await until(() => budgetNotices === i + 1, 'budget fixture completes')
}
budget.beginFrame(40, 16)
assert.equal(budget.prepare(placement(sources[0], 0)), false, 'old encoded data is evicted by byte budget')
assert.equal(budget.prepare(placement(sources.at(-1)!, 10)), true, 'recent encoded data remains cached')
assert.equal(budget.prepare(placement(sources.at(-2)!, 20)), false, 'thumbnail frame byte budget rejects excess graphics but keeps fallback')
budget.dispose()

class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
class Output extends Writable {
  isTTY = true
  columns = 40
  rows = 16
  chunks: string[] = []
  constructor(readonly input: Input) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
    const text = String(chunk)
    this.chunks.push(text)
    const response = text === '\x1b[c' ? '\x1b[?61;4;28c'
      : text === '\x1b[16t' ? '\x1b[6;20;10t'
        : text === '\x1b[14t' ? '\x1b[4;320;400t'
          : text === '\x1b[?80$p' ? '\x1b[?80;2$y' : ''
    if (response) queueMicrotask(() => this.input.write(response))
    done()
  }
}

const input = new Input()
const output = new Output(input)
const stderr = new Writable({ write(_chunk, _encoding, done) { done() } })
const terminal = new Terminal({ cols: 40, rows: 16, allowProposedApi: true })
const pixelWidth = 400
const pixelHeight = 320
const pixels = new Uint32Array(pixelWidth * pixelHeight)
let draws = 0
const drawLog: Array<{ x: number; y: number; width: number; height: number; first: number }> = []
let consumed = 0
function erasePixels(left: number, top: number, width: number, height: number): void {
  for (let y = Math.max(0, top); y < Math.min(pixelHeight, top + height); y++) {
    pixels.fill(0, y * pixelWidth + Math.max(0, left), y * pixelWidth + Math.min(pixelWidth, left + width))
  }
}
terminal.parser.registerDcsHandler({ final: 'q' }, body => {
  const image = decode(body)
  const x = terminal.buffer.active.cursorX * 10
  const y = terminal.buffer.active.cursorY * 20
  drawLog.push({ x, y, width: image.width, height: image.height, first: image.data32[0] })
  assert.ok(x + image.width <= pixelWidth && y + image.height <= pixelHeight, 'DCS must stay inside viewport')
  for (let row = 0; row < image.height; row++) {
    for (let col = 0; col < image.width; col++) pixels[(y + row) * pixelWidth + x + col] = image.data32[row * image.width + col]
  }
  draws++
  return true
})
terminal.parser.registerCsiHandler({ final: 'X' }, params => {
  erasePixels(terminal.buffer.active.cursorX * 10, terminal.buffer.active.cursorY * 20, Number(params[0] || 1) * 10, 20)
  return false
})
terminal.parser.registerCsiHandler({ final: 'J' }, params => {
  if (params[0] === 2) pixels.fill(0)
  return false
})
terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => {
  if (params.includes(1049)) pixels.fill(0)
  return false
})
for (const final of ['S', 'T', 'L', 'M']) terminal.parser.registerCsiHandler({ final }, () => {
  assert.ok(!pixels.some(p => p !== 0), 'hardware scrolling must not move live Sixel pixels independently')
  return false
})

let scroller: ScrollBoxHandle | null = null
const images = [a, b, c, a]
const tree = (counter = 0, cover = false, show = true) => <AlternateScreen>
  <Box width={40} height={16} flexDirection="column">
    <Text>HEADER</Text>
    <ScrollBox ref={value => { scroller = value }} width={40} height={10} flexShrink={0} stickyScroll={false} flexDirection="column">
      {images.map((source, i) => <Box key={i} flexDirection="column" flexShrink={0}>
        <Text>message {i}</Text>
        <Box paddingLeft={2} height={4} flexShrink={0}>
          {show ? <Image source={source} width={8} height={4} presentation="transcript" alt="picture"><Text>LOADING</Text></Image> : null}
        </Box>
      </Box>)}
      <Text>{'tail\n'.repeat(10)}</Text>
    </ScrollBox>
    <Text>PROMPT {counter}</Text>
    {cover ? <Box position="absolute" top={1} left={0} width={40} height={10} opaque><Text>{(' '.repeat(40) + '\n').repeat(10)}</Text></Box> : null}
  </Box>
</AlternateScreen>
const app = await render(tree(), { stdin: input, stdout: output, stderr, exitOnCtrlC: false, patchConsole: false })
const ink = instances.get(output) as unknown as { frontFrame: { images: readonly TerminalImagePlacement[] } }
assert.ok(ink)
async function flush(): Promise<void> {
  const bytes = output.chunks.slice(consumed).join('')
  consumed = output.chunks.length
  if (bytes) await new Promise<void>(resolve => terminal.write(bytes, resolve))
}
async function checkFrame(label: string, covered = false): Promise<void> {
  // scrollTo changes the handle immediately; allow its scheduled frame to
  // expose the NEW visible jobs before testing their readiness.
  await delay(40)
  await until(() => ink.frontFrame.images.filter(p => p.presentation === 'transcript').every(p => p.graphicsReady), label + ': visible jobs settle')
  await delay(40)
  await flush()
  const expected = new Uint32Array(pixels.length)
  for (const p of ink.frontFrame.images) {
    if (covered || !p.graphicsReady || p.occluded) continue
    const clip = p.clip ?? p
    assert.ok(clip.y >= 1 && clip.y + clip.rows <= 11, 'image clip stays inside transcript, away from header/input')
    const source = new Uint32Array(p.source.data.buffer, p.source.data.byteOffset, p.source.data.byteLength / 4)
    for (let y = 0; y < clip.rows * 20; y++) {
      const sy = (clip.y - p.y) * 20 + y
      for (let x = 0; x < clip.columns * 10; x++) {
        const sx = (clip.x - p.x) * 10 + x
        expected[(clip.y * 20 + y) * pixelWidth + clip.x * 10 + x] = source[sy * p.source.width + sx]
      }
    }
  }
  const mismatch = pixels.findIndex((pixel, index) => pixel !== expected[index])
  assert.equal(mismatch, -1, JSON.stringify({ label, x: mismatch % pixelWidth, y: Math.floor(mismatch / pixelWidth),
    actual: pixels[mismatch], expected: expected[mismatch],
    placements: ink.frontFrame.images.map(p => ({ x: p.x, y: p.y, clip: p.clip, ready: p.graphicsReady, occluded: p.occluded })),
    draws: drawLog.slice(-8),
  }))
  assert.equal(terminal.buffer.active.cursorY, 15, label + ': input cursor stays parked')
}
try {
  await until(() => !!scroller && ink.frontFrame.images.length >= 2, 'multiple initial images laid out')
  await checkFrame('initial')
  assert.ok(draws >= 2)
  const beforeText = draws
  app.rerender(tree(1))
  await delay(100)
  await checkFrame('text-only change')
  assert.equal(draws, beforeText, 'ordinary streaming text must not retransmit thumbnails')
  for (const offset of [1, 2, 4, 5, 7, 9, 11, 14, 16, 12, 5, 0]) {
    scroller!.scrollTo(offset)
    await until(() => scroller!.getScrollTop() === offset, 'scroll position settles')
    await checkFrame('scroll ' + offset)
  }
  for (let i = 0; i < 40; i++) scroller!.scrollTo((i * 7) % 17)
  scroller!.scrollTo(3)
  await until(() => scroller!.getScrollTop() === 3, 'rapid scrolling finishes at latest position')
  await checkFrame('rapid scroll')
  app.rerender(tree(2, true))
  await delay(80)
  await checkFrame('blank overlay', true)
  app.rerender(tree(2))
  await checkFrame('uncover')
  app.rerender(tree(3, false, false))
  await until(() => ink.frontFrame.images.length === 0, 'images unmount')
  await checkFrame('remove all')
  assert.ok(output.chunks.every(chunk => chunk.length <= 4 * 1024 * 1024 + 64 * 1024), 'per-frame transport budget')
  assert.equal(a.data.byteLength, 80 * 80 * 4, 'worker transfer must not detach shared source data')
} finally {
  output.isTTY = false
  app.unmount()
  terminal.dispose()
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
  Object.assign(process.env, oldEnv)
}

// Exercise the real transcript component and its lazy terminal capability hook.
for (const fullscreen of [true, false]) {
  clearTranscriptImageCacheForTests()
  const input = new Input()
  const output = new Output(input)
  let reads = 0
  let galleryScroll: ScrollBoxHandle | null = null
  const image = { id: 'gallery-' + fullscreen, width: 80, height: 80, name: 'stripes.png', read: async () => { reads++; return png } }
  const gallery = (suppressed = false) => {
    const content = <Box width={40} height={16} flexDirection="column"><Text>HEADER</Text>
      <ScrollBox ref={value => { galleryScroll = value }} width={40} height={10} flexShrink={0} stickyScroll={false} flexDirection="column">
        <TranscriptImages images={[image]} suppressGraphics={suppressed} />
        <Text>{'tail\n'.repeat(10)}</Text>
      </ScrollBox><Text>PROMPT</Text></Box>
    return fullscreen ? <AlternateScreen>{content}</AlternateScreen> : content
  }
  const app = await render(gallery(), { stdin: input, stdout: output, stderr, exitOnCtrlC: false, patchConsole: false })
  try {
    if (fullscreen) {
      await until(() => output.chunks.some(chunk => chunk.includes('\x1bP0;1;q')), 'real transcript draws without opening a modal').catch(error => {
        const host = instances.get(output) as unknown as { sixelGraphicsSupported: boolean; terminalImageRequests: number; frontFrame: { images: TerminalImagePlacement[] } }
        console.error(JSON.stringify({ reads, supported: host.sixelGraphicsSupported, requests: host.terminalImageRequests,
          placements: host.frontFrame.images.map(p => ({ x: p.x, y: p.y, columns: p.columns, rows: p.rows, clip: p.clip, ready: p.graphicsReady, occluded: p.occluded })),
          tail: output.chunks.join('').slice(-1500),
        }))
        throw error
      })
      assert.equal(reads, 1)
      const start = output.chunks.length
      galleryScroll!.scrollTo(4)
      await until(() => output.chunks.slice(start).some(chunk => chunk.includes('\x1bP0;1;q')), 'real gallery clips after scrolling')
      await delay(80)
      const payloads = [...output.chunks.slice(start).join('').matchAll(/\x1bP0;1;q([\s\S]*?)\x1b\\/gu)]
      assert.equal(decode(payloads.at(-1)![1]).data32[0], 0xff00ff00, 'cropped gallery begins in the green stripe, not old red pixels')
      const hide = output.chunks.length
      app.rerender(gallery(true))
      await until(() => output.chunks.slice(hide).some(chunk => /\x1b\[\d+X/u.test(chunk)), 'modal suppression clears thumbnail pixels')
      assert.ok(!output.chunks.slice(hide).some(chunk => chunk.includes('\x1bP0;1;q')))
      app.rerender(gallery())
      await until(() => output.chunks.slice(hide).some(chunk => chunk.includes('\x1bP0;1;q')), 'closing modal restores thumbnails')
      assert.equal(reads, 1, 'restoring thumbnails uses the shared decode cache')
    } else {
      await delay(100)
      assert.equal(reads, 0, 'non-fullscreen inline mode stays lazy and text-only')
      assert.ok(!output.chunks.some(chunk => chunk.includes('\x1bP0;1;q')))
    }
  } finally { output.isTTY = false; app.unmount() }
}
console.log('Sixel transcript: exact crop/pixel-plane, scrolling, multi-image queue, cache and no-ghost regressions passed')
