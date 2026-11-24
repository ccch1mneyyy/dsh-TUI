/** Original-pixel crop/zoom, mouse controls, cancellation and original export.
 * Run: node --import tsx/esm scripts/verify-image-inspection.tsx
 * Uses generated images and headless streams; never launches a native viewer.
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '0'
delete process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES
delete process.env.DSH_TUI_IMAGE_PROTOCOL
delete process.env.TMUX
delete process.env.STY
delete process.env.DSH_TUI_ACCESSIBILITY

import assert from 'node:assert/strict'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mock } from 'node:test'
import { loadSharp } from '../src/dsh-adapter/sharp.js'
import { ImageInspectionSession, inspectionCells, inspectionRegion } from '../src/components/messages/imageInspection.js'
import { exportOriginalImage } from '../src/components/messages/originalImage.js'
import { fitTerminalImageSource } from '../src/ink/terminal-image.js'
import type { TranscriptImage } from '../src/dsh-adapter/transcript-images.js'
import type { TerminalImagePlacement } from '../src/ink/terminal-image.js'
import { settled, sleep } from './lib/term-test.mjs'

const sharp = await loadSharp()
assert.ok(sharp)
const width = 720
const height = 480
const pixels = new Uint8Array(width * height * 4)
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = (y * width + x) * 4
  pixels.set([x % 256, y % 256, (x + y) % 256, 255], i)
}
const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()
let reads = 0
const image: TranscriptImage = { id: 'inspection-fixture', width, height, name: 'original.png',
  // Source paths are display-only, and must never win over durable bytes.
  path: 'Z:/missing/changed-file.exe', mediaType: 'image/png',
  read: async () => { reads++; return png },
}
const session = new ImageInspectionSession(image)
assert.deepEqual(await session.metadata(), { width, height })
for (const zoom of [1, 2, 4, 8]) {
  const viewport = { width: 53, height: 37 }
  for (const center of [{ x: 201, y: 115 }, { x: -100, y: 1000 }]) {
    const crop = inspectionRegion(image, viewport, zoom, center)
    const actual = await session.render(viewport, zoom, center, new AbortController().signal)
    for (let y = 0; y < viewport.height; y++) for (let x = 0; x < viewport.width; x++) {
      const start = ((crop.top + Math.floor(y / zoom)) * width + crop.left + Math.floor(x / zoom)) * 4
      assert.deepEqual(actual.data.subarray((y * viewport.width + x) * 4, (y * viewport.width + x) * 4 + 4),
        pixels.subarray(start, start + 4), `exact original pixels at ${zoom}x, ${x},${y}`)
    }
  }
}
assert.equal(reads, 1, 'pan and zoom reuse one encoded original')
const cancelled = new AbortController()
cancelled.abort()
await assert.rejects(session.render({ width: 53, height: 37 }, 1, { x: 0, y: 0 }, cancelled.signal))
assert.equal(reads, 1)
session.dispose()
await assert.rejects(session.metadata())
let releaseRead!: () => void
let notifyRead!: () => void
const reading = new Promise<void>(resolve => { notifyRead = resolve })
const readBarrier = new Promise<void>(resolve => { releaseRead = resolve })
const abandoned = new ImageInspectionSession({ ...image, read: async () => { notifyRead(); await readBarrier; return png } })
const abandonedResult = assert.rejects(abandoned.render({ width: 53, height: 37 }, 1, { x: 0, y: 0 }, new AbortController().signal))
await reading
abandoned.dispose()
releaseRead()
await abandonedResult
const openController = new AbortController()
let finishOriginal!: () => void
const originalBarrier = new Promise<void>(resolve => { finishOriginal = resolve })
const cancelledOriginal = assert.rejects(exportOriginalImage({ ...image, read: async () => { await originalBarrier; return png } }, openController.signal))
openController.abort()
finishOriginal()
await cancelledOriginal
assert.throws(() => inspectionRegion(image, { width: 2048, height: 2048 }, 1, { x: 1, y: 1 }))
assert.throws(() => inspectionRegion(image, { width: 10, height: 10 }, 0, { x: 1, y: 1 }))
for (const cell of [{ width: 8, height: 16 }, { width: 25, height: 47 }, { width: 512, height: 512 }]) {
  const [columns, rows] = inspectionCells(400, 160, cell)
  assert.ok(columns * cell.width <= 2048 && rows * cell.height <= 2048)
  assert.ok(columns * cell.width * rows * cell.height * 4 <= 8 * 1024 * 1024)
  assert.ok(columns * rows <= 128 * 128)
}
const largeSource = { width: 1800, height: 1000, data: new Uint8Array(1800 * 1000 * 4) }
assert.equal(fitTerminalImageSource(largeSource, 180, 50, { width: 10, height: 20 }, 'preview'), largeSource,
  'Kitty retains exact 100% pixels above the old 4 MiB budget')

// EXIF orientation and smaller-than-viewport originals retain pixel geometry.
const oriented = await sharp(png).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer()
const orientationSession = new ImageInspectionSession({ ...image, read: async () => oriented })
assert.deepEqual(await orientationSession.metadata(), { width: height, height: width })
const orientedPixels = await sharp(oriented).autoOrient().ensureAlpha().raw().toBuffer()
const orientedView = await orientationSession.render({ width: 17, height: 13 }, 1, { x: 0, y: 0 }, new AbortController().signal)
assert.deepEqual(orientedView.data.slice(0, 17 * 4), new Uint8Array(orientedPixels.subarray(0, 17 * 4)))
orientationSession.dispose()
const tinyPng = await sharp({ create: { width: 2, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer()
const tinySession = new ImageInspectionSession({ ...image, read: async () => tinyPng })
const tiny = await tinySession.render({ width: 8, height: 5 }, 1, { x: 0, y: 0 }, new AbortController().signal)
assert.equal(tiny.data.filter((_, i) => i % 4 === 3 && tiny.data[i] === 255).length, 2, 'small original is padded, never enlarged at 100%')
tinySession.dispose()

const exported = await exportOriginalImage(image)
assert.deepEqual(await readFile(exported), png, 'original export is byte-for-byte identical')
assert.ok(exported.endsWith('.png') && !exported.includes('changed-file'), 'signature determines a safe image extension')
const afterExportReads = reads
assert.equal(await exportOriginalImage(image), exported)
assert.equal(reads, afterExportReads, 'reopening does not reread or rewrite the original')
await assert.rejects(exportOriginalImage({ ...image, read: async () => new Uint8Array([77, 90, 0]) }), /Unsupported/)
// A file-backed image (a `present` deliverable) opens where it lives: no temp
// copy under a content hash, and no reread just to open it.
const deliveredPath = '/artifacts/kaggle-stable05-verified.png'
const delivered: TranscriptImage = { ...image, path: deliveredPath, pathIsOriginal: true,
  read: async () => { throw new Error('opening the original must not read the bytes') } }
assert.equal(await exportOriginalImage(delivered), deliveredPath, 'a file-backed original opens in place')
assert.equal(await exportOriginalImage({ ...image, path: undefined, pathIsOriginal: true, read: async () => png }), exported,
  'a facade without a path still falls back to the export')
console.log('PASS exact original crop, 100-800% nearest zoom, pan bounds, orientation, byte-preserving export')

const launches: Array<{ command: unknown; args: unknown; options: unknown }> = []
/** Fake child for the mocked spawn: answer the Linux xdg-mime probes and close
 *  them, so the xdg-open launch that follows is observable. */
interface FakeChild extends EventEmitter {
  unref(): void
  stdout?: PassThrough
}
mock.method(childProcess, 'spawn', (command: unknown, args: unknown, options: unknown) => {
  launches.push({ command, args, options })
  const child: FakeChild = Object.assign(new EventEmitter(), { unref() {} })
  if (command === 'xdg-mime') {
    const query = Array.isArray(args) ? args[1] : undefined
    child.stdout = new PassThrough()
    setImmediate(() => {
      child.stdout?.emit('data', Buffer.from(query === 'filetype' ? 'image/png\n' : 'dsh-tui-test-handler.desktop\n', 'utf8'))
      child.emit('close', 0)
    })
  }
  return child
})
syncBuiltinESMExports()
const React = (await import('react')).default
const { Terminal } = await import('@xterm/headless')
const { render, AlternateScreen, Box, Text, useInput } = await import('../src/ui.js')
const { ImagePreviewOverlay } = await import('../src/components/ImagePreviewOverlay.js')
const { AssistantToolUseMessage } = await import('../src/components/messages/AssistantToolUseMessage.js')
const { default: instances } = await import('../src/ink/instances.js')
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
const terminal = new Terminal({ cols: 100, rows: 36, allowProposedApi: true, scrollback: 0 })
const input = new Input()
class Output extends Writable {
  isTTY = true
  columns = 100
  rows = 36
  data = ''
  cellWidth = 10
  cellHeight = 20
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
    const text = String(chunk)
    this.data += text
    const reply = text === '\x1b[c' ? '\x1b[?61;4;28c' : text === '\x1b[?80$p' ? '\x1b[?80;1$y'
      : text === '\x1b[16t' ? `\x1b[6;${this.cellHeight};${this.cellWidth}t` : ''
    if (reply) queueMicrotask(() => input.write(reply))
    terminal.write(text, done)
  }
}
const output = new Output()
const stderr = new Writable({ write(_chunk, _encoding, done) { done() } })
function InputLease(): React.ReactNode { useInput(() => {}); return null }
const tree = (show = true, selected = image) => <AlternateScreen><Box width={output.columns} height={output.rows - 1} flexDirection="column">
  <InputLease />
  <Box height={output.rows - 4} width={output.columns}><Text>CONVERSATION</Text>
    {show ? <ImagePreviewOverlay image={selected} onClose={() => {}} region={{ columns: output.columns, rows: output.rows - 4 }} /> : null}
  </Box><Text>PROMPT</Text>
</Box></AlternateScreen>
const app = await render(tree(), { stdin: input, stdout: output, stderr, exitOnCtrlC: false, patchConsole: false })
const text = () => Array.from({ length: output.rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n')
const host = () => instances.get(output) as unknown as { frontFrame: { images?: TerminalImagePlacement[] } }
const placement = () => host().frontFrame.images?.find(value => value.presentation === 'preview')
const click = async (label: string) => {
  let found: { x: number; y: number } | undefined
  for (let y = 0; y < output.rows; y++) {
    const line = terminal.buffer.active.getLine(y)?.translateToString(true) ?? ''
    const x = line.indexOf(label)
    if (x !== -1) { found = { x: x + label.length - label.trimStart().length, y }; break }
  }
  assert.ok(found, `control ${label} visible: ${text()}`)
  input.write(`\x1b[<0;${found.x + 1};${found.y + 1}M\x1b[<0;${found.x + 1};${found.y + 1}m`)
  await sleep(40) // 固定窗:pacing 鼠标 press→release 后的步间等待，调用方各自用 settled 断言结果
}
try {
  assert.ok(await settled(() => output.data.includes('\x1bP0;1;q'), { timeoutMs: 15000 }), 'fit preview paints through compiled worker')
  const readsBeforeActual = reads
  await click('100%')
  assert.ok(await settled(() => {
    const p = placement()
    return text().includes('· 100%') && !!p && p.source.width === p.columns * 10 && p.source.height === p.rows * 20
  }, { timeoutMs: 15000 }), `100% source has exactly one pixel per reported terminal pixel: ${text()}`)
  const beforeZoom = placement()?.source
  await click(' + ')
  assert.ok(await settled(() => text().includes('200%')), text())
  assert.ok(await settled(() => !!placement()?.source && placement()?.source !== beforeZoom, { timeoutMs: 15000 }))
  const beforePan = placement()!.source
  await click(' → ')
  assert.ok(await settled(() => !!placement()?.source && placement()?.source !== beforePan, { timeoutMs: 15000 }), 'pan replaces source pixels')
  const beforeDrag = placement()!
  const x = beforeDrag.x + 8
  const y = beforeDrag.y + 3
  input.write(`\x1b[<0;${x};${y}M`)
  for (let i = 1; i <= 12; i++) input.write(`\x1b[<32;${x + i};${y}M`)
  input.write(`\x1b[<0;${x + 12};${y}m`)
  assert.ok(await settled(() => !!placement()?.source && placement()?.source !== beforeDrag.source, { timeoutMs: 15000 }), 'drag pans without invoking a click')
  assert.equal(reads - readsBeforeActual, 1, 'all actual-pixel gestures share one encoded read')
  const viewerLaunches = (): typeof launches => launches.filter(entry => entry.command !== 'xdg-mime')
  assert.equal(viewerLaunches().length, 0, 'image/control clicks never launch the original viewer')
  await click('Open original:')
  assert.ok(await settled(() => viewerLaunches().length === 1))
  const launch = viewerLaunches()[0]!
  assert.ok(JSON.stringify(launch.args).includes(exported.replaceAll('\\', '\\\\')), 'link launches exported original, not the display-only path')
  assert.equal((launch.options as { windowsHide: boolean }).windowsHide, true)
  assert.ok(text().includes('PROMPT'), 'inspection keeps the prompt visible')
  await click('Fit')
  assert.ok(await settled(() => !text().includes('200%')), text())
  await click(' + ')
  await click(' + ')
  await click(' + ')
  assert.ok(await settled(() => text().includes('400%')), 'rapid repeated zoom clicks remain commands, not word selection')
  // A file-backed image (a `present` deliverable) opens its own path: the
  // preview must not copy it to a content-hash name in temp.
  const deliveredPath = '/artifacts/kaggle-stable05-verified.png'
  const delivered = { ...image, id: 'delivered-image', name: 'kaggle-stable05-verified.png', path: deliveredPath, pathIsOriginal: true, read: async () => png }
  app.rerender(tree(true, delivered))
  assert.ok(await settled(() => text().includes('Open original:') && text().includes('kaggle-stable05-verified.png')), text())
  await click('Open original:')
  assert.ok(await settled(() => viewerLaunches().length === 2), text())
  const deliveredLaunch = viewerLaunches()[1]!
  assert.ok(JSON.stringify(deliveredLaunch.args).includes(deliveredPath.replaceAll('\\', '\\\\')),
    'a file-backed image opens its own path, not a temp copy')
  // A new attachment may not inherit the prior image's zoom or pixels.
  const other = { ...image, id: 'other-image', name: 'other.png', read: async () => tinyPng }
  await click('100%')
  app.rerender(tree(true, other))
  assert.ok(await settled(() => text().includes('other.png') && !text().includes('200%')))
  output.columns = 42
  output.rows = 18
  output.cellWidth = 12
  output.cellHeight = 24
  terminal.resize(42, 18)
  output.emit('resize')
  app.rerender(tree(true, other))
  assert.ok(await settled(() => text().includes('100%') && text().includes('PROMPT')))
  await click('100%')
  assert.ok(await settled(() => {
    const p = placement()
    return !!p && p.graphicsReady === true && p.source.width === p.columns * 12 && p.source.height === p.rows * 24
  }, { timeoutMs: 15000 }), '100% follows refreshed terminal pixel metrics')
  const closeStart = output.data.length
  app.rerender(tree(false))
  assert.ok(await settled(() => !text().includes('Open original') && text().includes('PROMPT')))
  assert.ok(/\x1b\[\d+X/u.test(output.data.slice(closeStart)), 'closing clears actual graphics')
  // A `present` card paints one delivered image inline as a bounded
  // transcript placement; several become the contact strip asserted below.
  // The narrow-terminal case above left the fake screen at 42×18; the
  // thumbnail needs a wide card (the card hides it below 48 columns).
  output.columns = 100
  output.rows = 36
  output.cellWidth = 10
  output.cellHeight = 20
  terminal.resize(output.columns, output.rows)
  output.emit('resize')
  const deliveredThumb = join(tmpdir(), `dsh-tui-present-thumb-${process.pid}.png`)
  await writeFile(deliveredThumb, png)
  const presentCard = (paths: readonly string[], suppressed = false, handlers: {
    readonly onOpenFile?: (path: string) => void
    readonly onPreviewFile?: (path: string) => void
  } = {}) => {
    const files = paths.map(path => ({ path: basename(path), target: path, size: png.byteLength }))
    return <AlternateScreen><Box width={output.columns} height={output.rows - 1} flexDirection="column">
      <InputLease />
      <AssistantToolUseMessage
        tool={{
          callId: 'present-thumb',
          argsText: '',
          status: 'ok',
          startedAt: 0,
          durationMs: 5,
          name: 'present',
          callView: { card: 'files', files },
          resultView: { card: 'files', files },
          resultText: 'Presented',
        }}
        marginTopOnTurn={false}
        verbose={false}
        onOpenFile={handlers.onOpenFile}
        onPreviewFile={handlers.onPreviewFile}
        suppressImageGraphics={suppressed}
      />
      <Text>END-OF-CARD</Text>
    </Box></AlternateScreen>
  }
  const thumb = () => host().frontFrame.images?.find(value => value.presentation === 'transcript')
  const transcripts = (): readonly TerminalImagePlacement[] => (host().frontFrame.images ?? [])
    .filter(value => value.presentation === 'transcript')
  /** Row of the sentinel after the card: it moves iff the card's height does. */
  const endRow = (value: string): number => value.split('\n').findIndex(line => line.includes('END-OF-CARD'))
  app.rerender(presentCard([deliveredThumb]))
  assert.ok(await settled(() => !!thumb(), { timeoutMs: 15000 }), `delivered image paints inline: ${text()}`)
  const thumbBox = thumb()!
  assert.ok(thumbBox.columns >= 12 && thumbBox.columns <= 32 && thumbBox.rows >= 1 && thumbBox.rows <= 9,
    `thumbnail stays inside the card budget: ${thumbBox.columns}×${thumbBox.rows}`)
  assert.deepEqual([thumbBox.x, thumbBox.y], [3, 2],
    `thumbnail hangs under the file row at the body column: ${thumbBox.x},${thumbBox.y}`)
  // Opening the modal preview must free the graphics budget without reflowing
  // the card: the thumbnail keeps its rows but paints nothing.
  // Let xterm parse every queued frame write before reading cells: the
  // committed frame (and its placements) can land before the buffer is updated.
  const drained = (): Promise<void> => new Promise(resolve => output.write('', resolve))
  await drained()
  const paintedCard = text()
  const paintedEnd = endRow(paintedCard)
  assert.ok(paintedEnd >= 0, 'the card-end sentinel is on screen')
  app.rerender(presentCard([deliveredThumb], true))
  assert.ok(await settled(() => !thumb(), { timeoutMs: 15000 }), 'the modal preview suppresses the inline thumbnail')
  await drained()
  // Compare row structure, not cell contents: the painted frame marks the
  // image rows with background-bearing spaces, the suppressed one leaves them
  // empty — the card must not change height either way. The trailing sentinel
  // is the real height probe: a dropped placeholder moves it up (a blank tail
  // alone cannot tell "kept the rows" from "removed them").
  const rows = (value: string): string => value.split('\n').map(line => line.replace(/\s+$/u, '')).join('\n')
  assert.equal(endRow(text()), paintedEnd, 'suppression keeps the card height (the sentinel does not move)')
  assert.equal(rows(text()), rows(paintedCard), 'suppression keeps the card geometry')
  // The thumbnail routes like the file row it hangs under: the preview when
  // the caller provides one, otherwise the file-action fallback. A caller
  // that only passes `onOpenFile` must not get a dead click (or a fold).
  {
    const opened: string[] = []
    app.rerender(presentCard([deliveredThumb], false, { onOpenFile: path => opened.push(path) }))
    assert.ok(await settled(() => !!thumb(), { timeoutMs: 15000 }), 'the fallback thumbnail paints')
    const box = thumb()!
    const clickX = box.x + Math.floor(box.columns / 2) + 1
    const clickY = box.y + Math.floor(box.rows / 2) + 1
    const press = `\x1b[<0;${clickX};${clickY}M\x1b[<0;${clickX};${clickY}m`
    input.write(press)
    assert.ok(await settled(() => opened.length === 1, { timeoutMs: 5000 }),
      `a thumbnail without a preview handler falls back to the file menu: ${opened.length}`)
    assert.equal(opened[0], deliveredThumb, 'the fallback receives the delivered path')
    const previewed: string[] = []
    app.rerender(presentCard([deliveredThumb], false, {
      onOpenFile: path => opened.push(path),
      onPreviewFile: path => previewed.push(path),
    }))
    await drained()
    assert.ok(await settled(() => !!thumb(), { timeoutMs: 15000 }), 'the preview thumbnail repaints')
    // 固定窗:墙钟 Ink 的 500ms 多击窗口过后，第二次点击才会被派发为 click。
    await sleep(550)
    input.write(press)
    assert.ok(await settled(() => previewed.length === 1 && opened.length === 1, { timeoutMs: 5000 }),
      `a preview handler takes precedence over the fallback: previewed=${previewed.length} opened=${opened.length}`)
  }
  // Several images become the contact strip: uniform 10×5 tiles in delivery
  // order, one gap apart, under the rows — never one big thumbnail per file.
  const secondThumb = `${deliveredThumb}.copy.png`
  await writeFile(secondThumb, png)
  const tiles = (): readonly TerminalImagePlacement[] => transcripts().slice().sort((a, b) => a.x - b.x)
  app.rerender(presentCard([deliveredThumb, secondThumb]))
  assert.ok(await settled(() => tiles().length === 2, { timeoutMs: 15000 }),
    `delivery strip paints one tile per image: ${tiles().length}`)
  assert.deepEqual(tiles().map(value => [value.columns, value.rows]), [[10, 5], [10, 5]],
    'strip tiles share the transcript grid cell box')
  assert.deepEqual(tiles().map(value => [value.x, value.y]), [[3, 4], [14, 4]],
    `strip tiles sit side by side under the rows: ${JSON.stringify(tiles().map(value => [value.x, value.y]))}`)
  // Beyond the sheet's cap the card counts the rest instead of growing. A
  // missing file paints nothing, so the count must not be earned by blank
  // tiles; the same nine with real bytes paint exactly eight.
  const manyMissing = Array.from({ length: 9 }, (_, index) => `${deliveredThumb}.missing.${index}.png`)
  app.rerender(presentCard(manyMissing))
  assert.ok(await settled(() => text().includes('1 more image'), { timeoutMs: 15000 }), text())
  assert.equal(tiles().length, 0, 'missing images paint no tile')
  const manyReal = Array.from({ length: 9 }, (_, index) => `${deliveredThumb}.real.${index}.png`)
  await Promise.all(manyReal.map(path => writeFile(path, png)))
  app.rerender(presentCard(manyReal))
  assert.ok(await settled(() => tiles().length === 8, { timeoutMs: 20000 }),
    `the strip paints at most eight tiles: ${tiles().length}`)
  await drained()
  assert.ok(text().includes('1 more image'), 'the ninth image is only counted')
  // A card that lists the same file twice paints one thumbnail, on the first
  // row (the previous frame carried the strip's eight tiles, so this waits for
  // the card to switch back to the single-image layout).
  app.rerender(presentCard([deliveredThumb, deliveredThumb]))
  assert.ok(await settled(() => transcripts().length === 1, { timeoutMs: 15000 }),
    `a duplicated delivery paints one thumbnail: ${transcripts().length}`)
  assert.deepEqual([transcripts()[0]!.x, transcripts()[0]!.y], [3, 2],
    'the duplicated file thumbs under its first row only')
  // A COLD renderer with no other image consumer: the multi-image sheet is
  // what must start the graphics probe. If it gates on capability before
  // requesting it, the tiles never mount and the sheet stays invisible.
  await app.unmount()
  {
    const coldTerminal = new Terminal({ cols: 100, rows: 36, allowProposedApi: true, scrollback: 0 })
    const coldInput = new Input()
    class ColdOutput extends Writable {
      isTTY = true
      columns = 100
      rows = 36
      cellWidth = 10
      cellHeight = 20
      data = ''
      _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
        const value = String(chunk)
        this.data += value
        const reply = value === '\x1b[c' ? '\x1b[?61;4;28c' : value === '\x1b[?80$p' ? '\x1b[?80;1$y'
          : value === '\x1b[16t' ? `\x1b[6;${this.cellHeight};${this.cellWidth}t` : ''
        if (reply) queueMicrotask(() => coldInput.write(reply))
        coldTerminal.write(value, done)
      }
    }
    const coldStdout = new ColdOutput()
    const coldApp = await render(presentCard([deliveredThumb, secondThumb]),
      { stdin: coldInput, stdout: coldStdout as never, stderr, exitOnCtrlC: false, patchConsole: false })
    const coldTiles = (): readonly TerminalImagePlacement[] =>
      ((instances.get(coldStdout) as { frontFrame?: { images?: TerminalImagePlacement[] } } | undefined)
        ?.frontFrame?.images ?? []).filter(value => value.presentation === 'transcript')
    assert.ok(await settled(() => coldTiles().length === 2, { timeoutMs: 15000 }),
      `a cold strip starts its own graphics probe: ${coldTiles().length}`)
    await coldApp.unmount()
    coldTerminal.dispose()
  }
  await unlink(secondThumb)
  await unlink(deliveredThumb)
  await Promise.all(manyReal.map(path => unlink(path)))
  console.log('PASS real Sixel overlay fit/100%/zoom/pan/drag/resize, original link and cleanup; delivery thumbnail and strip')
} finally {
  output.isTTY = false
  await app.unmount()
  terminal.dispose()
  mock.restoreAll()
  syncBuiltinESMExports()
  await unlink(exported)
}
