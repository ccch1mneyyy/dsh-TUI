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
 * and a wrapped link included); with Kitty graphics and a cell size it
 * switches to rows of text pieces and one-row image slots, keeping every
 * formula whole, and falls back when a formula cannot fit one row; while
 * streaming it stays on the Unicode path. Run with:
 * node --import tsx/esm scripts/verify-math-inline-image.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import xterm from '@xterm/headless'
import { render, Box } from '../src/ui.js'
import { Markdown } from '../src/components/Markdown.js'
import { StreamingMarkdown } from '../src/components/StreamingMarkdown.js'
import { TerminalImagesContext } from '../src/ink/hooks/use-terminal-images.js'
import wrapText from '../src/ink/wrap-text.js'
import { inlineMediaPlaceholder as slot, layoutInlineMedia } from '../src/math/inline-layout.js'
import { applyMathRendering } from '../src/tuiDisplayPrefs.js'

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
function images(available: boolean) {
  return {
    subscribe: () => () => {},
    getSnapshot: () => available,
    getCellSize: () => CELL,
    getProtocol: () => (available ? 'kitty' as const : undefined),
    request: () => () => {},
  }
}

async function screenOf(element: React.ReactElement, columns: number, graphics = images(false)): Promise<string[]> {
  const rows = 24
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
  const screen = Array.from({ length: rows }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true).trimEnd() ?? '')
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
  const unicode = await screenOf(<Markdown>{DOCUMENT}</Markdown>, 60)
  const imaged = await screenOf(<Markdown>{DOCUMENT}</Markdown>, 60, images(true))
  assert.notDeepEqual(imaged, unicode, 'with Kitty graphics the paragraphs switch to image slots')
  // Headless terminals paint each slot's fallback: the Unicode formula cut
  // to the slot, so every formula is still present and none spans two rows.
  for (const fragment of ['ax²', 'x₁', 'α+β']) {
    assert.ok(imaged.some(line => line.includes(fragment)), `slot for ${fragment} is present`)
  }
  assert.equal(imaged.filter(line => line === '').length, unicode.filter(line => line === '').length, 'the blank lines between blocks are unchanged')
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

applyMathRendering('auto')
console.log('Inline math images verified: layout parity, whole formulas, balanced styles, continuations, no-graphics parity at 80/40/20, Kitty slots, streaming stays Unicode')
