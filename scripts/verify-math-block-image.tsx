/** Block math as a terminal image (`mathRendering: image`): a complete block
 * in a terminal with graphics and a measured cell size is laid out as an
 * image box of exactly the raster's cells, painted in the theme's text color;
 * every other case keeps the Unicode rendering — `auto`, a terminal without
 * graphics or without a cell size, a dimmed block, a still-streaming block,
 * and TeX the image backend rejects. Run with:
 * node --import tsx/esm scripts/verify-math-block-image.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import assert from 'node:assert/strict'
import React from 'react'
import { renderToScreen } from '../src/ink/render-to-screen.js'
import { cellAt } from '../src/ink/screen.js'
import { TerminalSizeContext } from '../src/ink/components/TerminalSizeContext.js'
import { TerminalImagesContext } from '../src/ink/hooks/use-terminal-images.js'
import type { TerminalCellSize } from '../src/ink/terminal-image.js'
import { MathBlock } from '../src/components/MathBlock.js'
import { renderMathRaster, type MathRenderRequest } from '../src/math/renderer.js'
import { getTheme } from '../src/theme.js'
import { LARGE_DISPLAY_EX_TO_CELL_HEIGHT } from '../src/math/layout.js'
import { stringWidth } from '../src/ink/stringWidth.js'
import { renderDisplayMath, renderInlineMath } from '../src/terminal-utils/math.js'
import { applyMathImageScale, applyMathRendering, normalizeMathImageScale, type MathImageScale } from '../src/tuiDisplayPrefs.js'

const WIDTH = 80
const CELL: TerminalCellSize = { width: 10, height: 20 }
const QUADRATIC = String.raw`x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}`

const blockToken = (text: string, pending = false) => ({
  type: 'mathBlock' as const,
  raw: `$$\n${text}\n$$`,
  text,
  ...(pending ? { pending: true } : {}),
})

function images(available: boolean, cellSize: TerminalCellSize | undefined) {
  return {
    subscribe: () => () => {},
    getSnapshot: () => available,
    getCellSize: () => cellSize,
    request: () => () => {},
  }
}

function screenLines(element: React.ReactElement, graphics = images(true, CELL)): string[] {
  const screen = renderToScreen(
    <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 40 }}>
      <TerminalImagesContext.Provider value={graphics}>{element}</TerminalImagesContext.Provider>
    </TerminalSizeContext.Provider>,
    WIDTH,
  )
  return Array.from({ length: screen.height }, (_, row) =>
    Array.from({ length: WIDTH }, (_, column) => cellAt(screen.screen, column, row)?.char ?? '').join('').trimEnd(),
  )
}

const block = (text: string, dimColor = false, pending = false) =>
  <MathBlock token={blockToken(text, pending)} dimColor={dimColor} forceWidth={WIDTH} />

// The request MathBlock derives: the theme's text color, the width left after
// its indent and slack, at most 16 rows. Rendering it here first puts the
// result in the cache, which the component reads synchronously on mount.
const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(getTheme('dark').text)
assert.ok(rgb !== null, 'the dark theme text color is rgb()')
const color = `#${rgb.slice(1, 4).map(channel => Number(channel).toString(16).padStart(2, '0')).join('')}`
const baseFor = (scale: MathImageScale): number | undefined =>
  scale === 'xlarge' ? 0.9 : scale === 'large' ? LARGE_DISPLAY_EX_TO_CELL_HEIGHT : undefined
const request = (tex: string, scale: MathImageScale = 'auto'): MathRenderRequest => {
  const base = baseFor(scale)
  return {
    tex, display: true, color, cellSize: CELL, maxColumns: WIDTH - 2 - 4, maxRows: 16,
    ...(base === undefined ? {} : { baseExToCellHeight: base }),
  }
}

const stacked = renderDisplayMath(QUADRATIC)!.map(line => `  ${line}`.trimEnd())
const linear = renderInlineMath(QUADRATIC)!

applyMathRendering('image')
const quadratic = await renderMathRaster(request(QUADRATIC))
assert.ok(quadratic.ok, `the quadratic formula rasterizes (got ${quadratic.ok ? '' : quadratic.failure})`)

// Image: a box of exactly the raster's cells. What a cell grid shows is the
// box's fallback — the stacked Unicode when it fits (so a partly visible box
// still shows the formula), drawn dim, unlike the plain Unicode path.
{
  const lines = screenLines(block(QUADRATIC))
  assert.equal(lines.length, quadratic.raster.rows, 'the block takes the raster rows')
  const display = renderDisplayMath(QUADRATIC)!
  const stackedFits = display.length <= quadratic.raster.rows &&
    display.every(line => stringWidth(line) <= quadratic.raster.columns)
  if (stackedFits) {
    // The box can now be a row or two taller than the stacked form; what
    // matters is that the stacked formula is what fills it.
    assert.deepEqual(lines.slice(0, stacked.length), stacked, 'the fallback is the full stacked formula when it fits the box')
  } else {
    // Display formulas are set larger now, so a width-clamped raster can be
    // too narrow for the stacked form; the box then wraps the one-line
    // fallback and still never shows the raw source.
    assert.ok(lines.some(line => line.trim() !== ''), 'a narrow box still shows the formula fallback')
    assert.ok(!lines.includes('$$'), 'and never the source')
  }
}
{
  // TeX the Unicode renderer cannot lay out: the Unicode path keeps the
  // source, the image path shows the formula as an image box.
  const arrow = String.raw`a \xrightarrow{f} b`
  const result = await renderMathRaster(request(arrow))
  assert.ok(result.ok, 'MathJax typesets what the Unicode renderer rejects')
  assert.deepEqual(screenLines(block(arrow), images(false, CELL)), ['$$', arrow, '$$'], 'without graphics: the source')
  const lines = screenLines(block(arrow))
  assert.equal(lines.length, result.raster.rows, 'with graphics: an image box of the raster rows')
  assert.ok(!lines.includes('$$'), 'not the source fallback')
}
{
  // A box too narrow for the stacked layout wraps the one-line form across
  // its rows instead of leaving rows blank.
  const narrow = { ...request(QUADRATIC), maxColumns: 12 }
  const result = await renderMathRaster(narrow)
  if (result.ok && result.raster.rows > 1) {
    const lines = screenLines(<MathBlock token={blockToken(QUADRATIC)} dimColor={false} forceWidth={12 + 2 + 4} />)
    assert.ok(lines.slice(0, result.raster.rows).every(line => line.trim() !== ''), 'every row of a narrow image box carries part of the formula')
  }
}

// Every other case keeps the Unicode rendering.
assert.deepEqual(screenLines(block(QUADRATIC), images(false, CELL)), stacked, 'no graphics: Unicode')
assert.deepEqual(screenLines(block(QUADRATIC), images(true, undefined)), stacked, 'no measured cell size: Unicode')
assert.deepEqual(screenLines(block(QUADRATIC, true)), stacked, 'a dimmed block cannot be an image')
assert.deepEqual(screenLines(block(QUADRATIC, false, true)), ['$$', QUADRATIC, '$$'], 'a streaming block keeps its source')
{
  const unknown = String.raw`x + \unknown{y}`
  const rejected = await renderMathRaster(request(unknown))
  assert.ok(!rejected.ok, 'the image backend rejects unknown commands')
  assert.deepEqual(screenLines(block(unknown)), ['$$', unknown, '$$'], 'a rejected formula falls back like the Unicode path')
}

{
  // Settings `mathImageScale`: a larger display scale is more cells, which is
  // literally more device pixels per stroke (the only sharpness lever a
  // terminal image has). Unknown values fall back to the text size.
  assert.equal(normalizeMathImageScale('bogus'), 'auto', 'an unknown scale falls back to the text size')
  applyMathImageScale('auto')
  const auto = await renderMathRaster(request(QUADRATIC, 'auto'))
  applyMathImageScale('large')
  const large = await renderMathRaster(request(QUADRATIC, 'large'))
  assert.ok(auto.ok && large.ok, 'both scales rasterize')
  assert.ok(large.raster.columns * large.raster.rows > auto.raster.columns * auto.raster.rows,
    'a larger scale gives the formula more cells')
  assert.equal(screenLines(block(QUADRATIC)).length, large.raster.rows, 'the block box follows the chosen scale')
  applyMathImageScale('auto')
  assert.equal(screenLines(block(QUADRATIC)).length, auto.raster.rows, 'and returns to the text size')
}

applyMathRendering('auto')
assert.deepEqual(screenLines(block(QUADRATIC)), stacked, '`auto` stays on Unicode until images are validated')
applyMathRendering('unicode')
assert.deepEqual(screenLines(block(QUADRATIC)), stacked, '`unicode` never uses images')

console.log('Math block images verified: image box from the cached raster, Unicode for auto/unicode, no graphics, no cell size, dimmed, streaming, and rejected TeX')
