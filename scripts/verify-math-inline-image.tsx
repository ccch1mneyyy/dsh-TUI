/** Inline math as terminal images (`mathRendering: image`).
 *
 * layoutInlineMedia (pure): with no formulas it reproduces the <Text> wrap
 * line for line; a formula's placeholder run is never split and moves to
 * the next row whole; a run wider than the row fails the layout (the caller
 * keeps Unicode); bold and links crossing a formula stay balanced in every
 * piece; wrap continuations are told apart from source newlines.
 *
 * Markdown: in image mode without graphics a paragraph with inline math is
 * cell-for-cell identical to the Unicode rendering at 80/40/20 columns (CJK
 * and a wrapped link included); with Kitty or Sixel graphics and a cell
 * size it switches to rows of text pieces and one-row image slots, keeping
 * every formula whole, and falls back when a formula cannot fit one row;
 * while streaming it stays on the Unicode path. Run with:
 * node --import tsx/esm scripts/verify-math-inline-image.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import xterm from '@xterm/headless'
import { AlternateScreen, Box, render, useInput } from '../src/ui.js'
import { Markdown } from '../src/components/Markdown.js'
import { StreamingMarkdown } from '../src/components/StreamingMarkdown.js'
import { TerminalImagesContext } from '../src/ink/hooks/use-terminal-images.js'
import { ThemeProvider } from '../src/components/design-system/ThemeProvider.js'
import { setMathPreviewOpener, type MathPreviewRequest } from '../src/components/mathPreview.js'
import instances from '../src/ink/instances.js'
import type { TerminalImagePlacement } from '../src/ink/terminal-image.js'
import wrapText from '../src/ink/wrap-text.js'
import { inlineMediaPlaceholder as slot, layoutInlineMedia } from '../src/math/inline-layout.js'
import { applyMathRendering } from '../src/tuiDisplayPrefs.js'
import { mathRendersInFlight } from '../src/math/renderer.js'
import { settle } from './lib/term-test.mjs'

// ── layoutInlineMedia ──────────────────────────────────────────────────

{
  const prose = 'The quick brown fox jumps over the lazy dog. 敏捷的棕色狐狸跳过了懒狗。'
  for (const width of [80, 40, 20, 7]) {
    const rows = layoutInlineMedia(prose, width, [])!
    assert.deepEqual(
      rows.map(row => row.pieces.map(piece => (piece.kind === 'text' ? stripAnsi(piece.text) : '')).join('')),
      stripAnsi(wrapText(prose, width, 'wrap')).split('\n'),
      `without formulas the rows are the <Text> wrap at ${width} columns`,
    )
  }
}
{
  const text = `ab ${slot(0, 5)} cd`
  const rows = layoutInlineMedia(text, 6, [5])!
  assert.ok(rows.some(row => row.pieces.some(piece => piece.kind === 'media' && piece.columns === 5)), 'the formula keeps its full width')
  assert.equal(rows.flatMap(row => row.pieces).filter(piece => piece.kind === 'media').length, 1, 'and is never split')
  assert.equal(layoutInlineMedia(`x ${slot(0, 9)} y`, 8, [9]), undefined, 'a formula wider than the row fails the layout')
  assert.equal(layoutInlineMedia(`${slot(0, 2)} ${slot(0, 2)}`, 20, [2]), undefined, 'a formula slot appearing twice fails the layout')
}
{
  const bold = (text: string) => `\x1b[1m${text}\x1b[22m`
  const text = `plain ${bold(`bold ${slot(0, 4)} still bold`)} end`
  const rows = layoutInlineMedia(text, 12, [4])!
  const pieces = rows.flatMap(row => row.pieces).filter(piece => piece.kind === 'text')
  const after = pieces.find(piece => stripAnsi(piece.text).includes('still'))!
  assert.ok(after.text.startsWith('\x1b[1m'), 'bold re-opens in the piece after the formula')
  for (const piece of pieces) {
    const opens = piece.text.split('\x1b[1m').length - 1
    const closes = piece.text.split('\x1b[22m').length - 1
    assert.equal(opens, closes, `piece ${JSON.stringify(stripAnsi(piece.text))} leaves no style open`)
  }
  const link = (text: string) => `\x1b]8;;https://example.com\x07${text}\x1b]8;;\x07`
  const linked = layoutInlineMedia(`see ${link(`the docs ${slot(0, 3)} here`)} ok`, 10, [3])!
  for (const piece of linked.flatMap(row => row.pieces)) {
    if (piece.kind !== 'text' || !piece.text.includes('\x1b]8;;https')) continue
    assert.ok(piece.text.endsWith('\x1b]8;;\x07') || piece.text.includes('\x1b]8;;\x07'), 'a link crossing a formula is closed in each piece')
  }
}
{
  const rows = layoutInlineMedia(`one two three four\nfive ${slot(0, 2)}`, 9, [2])!
  assert.deepEqual(rows.map(row => row.continuation), [false, true, true, false], 'wraps continue their row; source newlines do not')
  assert.equal(rows[0]!.width, stripAnsi(wrapText('one two three four', 9, 'wrap').split('\n')[0]!).length, 'a row reports its content width')
}

// ── Markdown ───────────────────────────────────────────────────────────

const CELL = { width: 10, height: 20 }
function images(available: boolean, protocol: 'kitty' | 'sixel' = 'kitty') {
  return {
    subscribe: () => () => {},
    getSnapshot: () => available,
    getCellSize: () => CELL,
    getProtocol: () => (available ? protocol : undefined),
    request: () => () => {},
  }
}

async function screenOf(element: React.ReactElement, columns: number, graphics = images(false), rows = 24): Promise<string[]> {
  const term = new xterm.Terminal({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  class Out extends Writable {
    columns = columns
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  const app = await render(
    <TerminalImagesContext.Provider value={graphics}>
      <Box width={columns} flexDirection="column">{element}</Box>
    </TerminalImagesContext.Provider>,
    { stdout: new Out() as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(resolve => setTimeout(resolve, 600)) // 固定窗:墙钟 (raster settle)
  const read = () => Array.from({ length: rows }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true).trimEnd() ?? '')
  // The first formula loads MathJax and sharp, which can outlast that window on
  // a busy machine: also wait for every in-flight render, then for the screen
  // to hold still across two reads, so the image-slot relayout has painted.
  await settle(() => mathRendersInFlight() === 0)
  let previous: string | undefined
  await settle(() => {
    const current = read().join('\n')
    const still = current === previous
    previous = current
    return still
  }, { stepMs: 100 })
  const screen = read()
  await app.unmount()
  term.dispose()
  while (screen.length > 0 && screen[screen.length - 1] === '') screen.pop()
  return screen
}

const DOCUMENT = [
  String.raw`对 $ax^2+bx+c=0$（$a \neq 0$）配方，**得到 $x_1, x_2$ 两个根**，见 [说明 $\Delta$ 文档](https://example.com/a-long-link)，判别式 $\Delta = b^2-4ac$ 决定实根个数。`,
  '',
  '$$',
  String.raw`x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}`,
  '$$',
  '',
  String.raw`Then $\alpha+\beta$ holds.`,
].join('\n')

for (const width of [80, 40, 20]) {
  applyMathRendering('auto')
  const unicode = await screenOf(<Markdown>{DOCUMENT}</Markdown>, width)
  applyMathRendering('image')
  const noGraphics = await screenOf(<Markdown>{DOCUMENT}</Markdown>, width)
  assert.deepEqual(noGraphics, unicode, `image mode without graphics is the Unicode rendering at ${width} columns`)
}

applyMathRendering('image')
{
  // Tall enough that the larger display-formula images do not scroll the
  // document: paragraph spacing is what the blank-line count compares.
  const unicode = await screenOf(<Markdown>{DOCUMENT}</Markdown>, 60, images(false), 48)
  const imaged = await screenOf(<Markdown>{DOCUMENT}</Markdown>, 60, images(true), 48)
  assert.notDeepEqual(imaged, unicode, 'with Kitty graphics the paragraphs switch to image slots')
  // Headless terminals paint each slot's fallback: the Unicode formula cut
  // to the slot, so every formula is still present and none spans two rows.
  for (const fragment of ['ax²', 'x₁', 'α+β']) {
    assert.ok(imaged.some(line => line.includes(fragment)), `slot for ${fragment} is present`)
  }
  // A taller image box may add blank rows of its own, but the document's
  // paragraph spacing must never be swallowed by the image path.
  assert.ok(imaged.filter(line => line === '').length >= unicode.filter(line => line === '').length,
    'the image path does not swallow paragraph spacing')
}
{
  // While streaming, paragraphs stay on the Unicode path.
  applyMathRendering('auto')
  const unicode = await screenOf(<Markdown>{DOCUMENT}</Markdown>, 60)
  applyMathRendering('image')
  const streaming = await screenOf(<StreamingMarkdown>{DOCUMENT}</StreamingMarkdown>, 60, images(true))
  const inlineRows = (screen: string[]) => screen.filter(line => line.includes('配方') || line.includes('holds'))
  assert.deepEqual(inlineRows(streaming), inlineRows(unicode), 'streaming text keeps inline math as Unicode')
}

{
  // A Sixel terminal (Windows Terminal 1.22+, xterm, foot, WezTerm…) lays out
  // the same one-row slots as Kitty: the protocol gate admits both, and the
  // slot carries the transcript presentation Sixel encoding requires.
  const kitty = await screenOf(<Markdown>{DOCUMENT}</Markdown>, 60, images(true, 'kitty'))
  const sixel = await screenOf(<Markdown>{DOCUMENT}</Markdown>, 60, images(true, 'sixel'))
  assert.deepEqual(sixel, kitty, 'a Sixel terminal lays out the same inline image slots as Kitty')
  for (const fragment of ['ax²', 'x₁', 'α+β']) {
    assert.ok(sixel.some(line => line.includes(fragment)), `Sixel slot for ${fragment} is present`)
  }
}

// ── Real Sixel host: a fake Windows Terminal ───────────────────────────
// The fixture above proves the protocol gate; this proves the whole path end
// to end: DA1 "?61;4;…c" selects Sixel (Windows Terminal's default conformance
// level honours background select 1, so a raster with no backing really is
// transparent) and both slots reach the frame as unbacked transcript
// placements instead of painting a colour slab around the formula.
{
  applyMathRendering('image')
  class Input extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  class Output extends Writable {
    isTTY = true
    columns = 60
    rows = 20
    data = ''
    _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
      const text = String(chunk)
      this.data += text
      const reply = text === '\x1b[c' ? '\x1b[?61;4;28c'
        : text === '\x1b[?80$p' ? '\x1b[?80;1$y'
          : text === '\x1b[16t' ? '\x1b[6;20;10t'
            : text === '\x1b[14t' ? '\x1b[4;400;600t'
              : /^\x1b\]11;\?/.test(text) ? '\x1b]11;rgb:ffff/ffff/ffff\x1b\\' : ''
      if (reply) queueMicrotask(() => input.write(reply))
      done()
    }
  }
  const input = new Input()
  const output = new Output()
  const stderr = new Writable({ write(_chunk: unknown, _encoding: BufferEncoding, done: () => void): void { done() } })
  function InputLease(): null {
    useInput(() => {})
    return null
  }
  const MATH = 'Inline $E=mc^2$ formula.\n\n$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$'
  // Publish the opener before the first paint: the math components decide
  // whether to wrap their slot in a click target at render time.
  const opened: MathPreviewRequest[] = []
  setMathPreviewOpener(request => { opened.push(request) })
  const app = await render(
    <AlternateScreen>
      <ThemeProvider theme="light">
        <Box width={60} flexDirection="column">
          <InputLease />
          <Markdown>{MATH}</Markdown>
        </Box>
      </ThemeProvider>
    </AlternateScreen>,
    {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      terminalImages: true,
    },
  )
  const host = instances.get(output as unknown as NodeJS.WriteStream) as unknown as {
    frontFrame: { images?: readonly TerminalImagePlacement[] }
  }
  const placements = (): readonly TerminalImagePlacement[] => host.frontFrame.images ?? []
  // Wait for both slots: the block raster can settle a frame after the inline
  // one, and a bare inline wait turns the block assertion into a race.
  const settled = (): boolean =>
    placements().some(value => value.presentation === 'transcript' && value.rows === 1) &&
    placements().some(value => value.presentation === 'transcript' && value.rows > 1)
  const deadline = Date.now() + 10_000
  while (!settled() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const seen = JSON.stringify(placements().map(value => [value.presentation, value.rows, value.background]))
  const inline = placements().find(value => value.presentation === 'transcript' && value.rows === 1)
  const block = placements().find(value => value.presentation === 'transcript' && value.rows > 1)
  assert.ok(inline, 'inline formula reaches the frame as a one-row transcript image: ' + seen)
  assert.ok(block, 'block formula reaches the frame as a transcript image: ' + seen)
  // Sixel has no alpha, so any backing colour paints a slab around the
  // formula: both slots must composite transparently instead and let the
  // terminal's own background (or wallpaper) show through.
  assert.equal(inline.background, undefined, 'the inline slot paints no background slab')
  assert.equal(block.background, undefined, 'the block slot paints no background slab')
  assert.equal(inline.transparent, true, 'formulas float transparent, so Sixel emits them without a backing')
  assert.equal(block.transparent, true, 'block formulas carry the same flag')
  assert.ok(!output.data.includes('a=t'), 'no Kitty upload on a Sixel terminal')

  // Clicking a formula image hands its TeX and its live raster to the preview
  // host, which is what opens the zoom card in the app.
  input.write(`\x1b[<0;${inline.x + 1};${inline.y + 1}M\x1b[<0;${inline.x + 1};${inline.y + 1}m`)
  const clickDeadline = Date.now() + 5_000
  while (opened.length === 0 && Date.now() < clickDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  setMathPreviewOpener(undefined)
  assert.equal(opened.length, 1, 'clicking the inline slot opens exactly one preview')
  assert.equal(opened[0]!.tex, 'E=mc^2', 'the preview carries the clicked formula source')
  assert.equal(opened[0]!.request.maxRows, 1, 'and the request that produced the one-row slot')
  assert.ok(opened[0]!.source.width > 0, 'with the live raster as the fallback pixels')
  await app.unmount()
}

applyMathRendering('auto')
console.log('Inline math images verified: layout parity, whole formulas, balanced styles, continuations, no-graphics parity at 80/40/20, Kitty and Sixel slots, streaming stays Unicode, and a fake Windows Terminal gets unbacked transcript placements')
