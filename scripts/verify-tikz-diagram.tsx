/** TikZ diagrams: the fixed wrapper, the pt→cell layout, the image box, and
 * every fallback — fenced blocks, display-math tikz-cd, streaming snapshots,
 * settings/graphics/dim guards, and TeX rejection. The TeX run is replaced by
 * a fixture SVG, so this gate needs neither TeX Live nor a display. A real
 * engine can be exercised with DSH_TUI_TIKZ_REAL=1 when TeX is installed.
 * Run with:
 *   node --import tsx/esm scripts/verify-tikz-diagram.tsx
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
import { Markdown } from '../src/components/Markdown.js'
import { TikzDiagram } from '../src/components/TikzDiagram.js'
import { themeInkHex } from '../src/components/MathBlock.js'
import { getTheme } from '../src/theme.js'
import { applyTikzRendering, normalizeTikzRendering } from '../src/tuiDisplayPrefs.js'
import {
  buildTikzDocument,
  hasCompleteTikzFigure,
  isClosedCodeFence,
  isTikzLang,
  isTikzSource,
  TIKZ_SOURCE_LIMIT,
} from '../src/tikz/source.js'
import { planTikzLayout } from '../src/tikz/layout.js'
import {
  clearTikzRenderCaches,
  peekTikzRaster,
  renderTikzRaster,
  setTikzCompilerForTests,
  tikzRenderStats,
  type TikzRaster,
  type TikzRenderRequest,
} from '../src/tikz/renderer.js'

const WIDTH = 80
const CELL: TerminalCellSize = { width: 10, height: 20 }
const MAX_COLUMNS = WIDTH - 2 - 4
const MAX_ROWS = 24

// The XML declaration matters: the regression this fixture guards against is
// that the first '>' is the declaration's, so the root width/height must be
// rewritten from the <svg> tag, not from the start of the file.
const SVG = String.raw`<?xml version='1.0' encoding='UTF-8'?>
<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' width='40pt' height='20pt' viewBox='0 0 40 20'>
<path d='M2 2L38 2L38 18L2 18Z' stroke='currentColor' fill='none' stroke-width='.8'/>
</svg>`

const FIGURE = String.raw`\begin{tikzpicture}
\draw[thick] (0,0) circle (1);
\end{tikzpicture}`

const TIKZCD = String.raw`\begin{tikzcd}
A \arrow[r, "f"] \arrow[d, "g"'] & B \arrow[d, "h"] \\
C \arrow[r, "k"'] & D
\end{tikzcd}`

const themeColor = themeInkHex(getTheme('dark').text)
assert.ok(themeColor !== undefined, 'the dark theme text color is a hex color')
const ink = themeColor as string

function request(source: string): TikzRenderRequest {
  return { source, color: ink, cellSize: CELL, maxColumns: MAX_COLUMNS, maxRows: MAX_ROWS }
}

function images(available: boolean, cellSize: TerminalCellSize | undefined) {
  return {
    subscribe: () => () => {},
    getSnapshot: () => available,
    getCellSize: () => cellSize,
    request: () => () => {},
  }
}

function lines(element: React.ReactElement, graphics = images(true, CELL)): string[] {
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

function markdown(text: string): React.ReactElement {
  return <Markdown>{text}</Markdown>
}

let compilerCalls = 0
let compilerFailure = false
setTikzCompilerForTests(async () => {
  compilerCalls += 1
  return compilerFailure
    ? { ok: false, failure: 'compile-error' }
    : { ok: true, key: 'fixture', svg: { svg: SVG, widthPt: 40, heightPt: 20 } }
})

// ── Source policy ──────────────────────────────────────────────────────────
assert.equal(isTikzLang('tikz'), true)
assert.equal(isTikzLang('TikZ title'), true)
assert.equal(isTikzLang('tikzcd'), true)
assert.equal(isTikzLang('latex'), false)
assert.equal(isTikzLang(undefined), false)
assert.equal(isTikzSource(FIGURE), true)
assert.equal(isTikzSource(TIKZCD), true)
assert.equal(isTikzSource('\\draw (0,0) -- (1,1);'), false)
assert.equal(isClosedCodeFence('```tikz\n' + FIGURE + '\n```'), true)
assert.equal(isClosedCodeFence('```tikz\n' + FIGURE + '\n'), false)
assert.equal(hasCompleteTikzFigure(FIGURE), true, 'a balanced figure is complete')
assert.equal(hasCompleteTikzFigure('\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);'), false, 'an open figure is not complete')
assert.equal(hasCompleteTikzFigure('\\begin{tikzcd}\nA & B \\\\\n\\end{tikzcd}'), true, 'tikz-cd is complete')
assert.equal(hasCompleteTikzFigure('\\begin{axis}\\addplot {x};'), false, 'an open axis is not complete')

{
  const built = buildTikzDocument(String.raw`\usetikzlibrary{arrows.meta,positioning}
\begin{tikzpicture}[right=of a]
\node (a) {A};
\end{tikzpicture}`)
  assert.ok(built.ok, 'a fragment with a library preamble is accepted')
  assert.match(built.document.document, /\\usepackage\{tikz\}/u)
  assert.match(built.document.document, /\\usetikzlibrary\{[^}]*arrows\.meta/u)
  assert.match(built.document.document, /\\begin\{document\}/u)
  const beginDocument = built.document.document.indexOf('\\begin{document}')
  assert.ok(built.document.document.indexOf('\\usetikzlibrary{arrows.meta') > beginDocument,
    'libraries load inside the document body so a preloaded format still sees them')
  assert.ok(!built.document.document.slice(0, beginDocument).includes('\\usetikzlibrary'),
    'the preamble carries no library command')
  assert.equal(built.document.usesTikzCd, false)
}
{
  const built = buildTikzDocument(TIKZCD)
  assert.ok(built.ok, 'tikz-cd is accepted')
  assert.match(built.document.document, /\\usepackage\{tikz-cd\}/u)
  assert.equal(built.document.usesTikzCd, true)
}
{
  const built = buildTikzDocument(String.raw`\begin{tikzpicture}\begin{axis}\addplot {x^2};\end{axis}\end{tikzpicture}`)
  assert.ok(built.ok, 'pgfplots is accepted')
  assert.match(built.document.document, /\\usepackage\{pgfplots\}/u)
  assert.equal(built.document.usesPgfplots, true)
}
{
  const built = buildTikzDocument(String.raw`\begin{document}
\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}
\end{document}`)
  assert.ok(built.ok, 'a bare document wrapper is reduced to its body')
  assert.doesNotMatch(built.document.document, /\\begin\{document\}\s*\\begin\{document\}/u)
}
for (const [source, failure] of [
  ['', 'empty'],
  ['\\documentclass{article}\\begin{document}x\\end{document}', 'unsupported-document'],
  ['\\begin{tikzpicture}\\input{/etc/passwd}\\end{tikzpicture}', 'unsafe'],
  ['\\begin{tikzpicture}\\node at (0,0) {\\usepackage{evil}};\\end{tikzpicture}', 'unsafe'],
  ['\\begin{tikzpicture}\\end{tikzpicture}' + 'x'.repeat(TIKZ_SOURCE_LIMIT), 'input-too-long'],
  ['just prose', 'no-figure'],
] as const) {
  const built = buildTikzDocument(source)
  assert.equal(built.ok, false, `${failure} is rejected`)
  if (!built.ok) assert.equal(built.failure, failure, `failure is ${failure}`)
}
{
  const built = buildTikzDocument(String.raw`\usepackage{amsmath}\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}`)
  assert.ok(built.ok, 'an allowed package is hoisted')
  assert.match(built.document.document, /\\usepackage\{amsmath\}/u, 'the package reaches the preamble')
}

// ── Layout ────────────────────────────────────────────────────────────────
{
  const plan = planTikzLayout({ widthPt: 40, heightPt: 20 }, {
    cellSize: CELL, maxColumns: MAX_COLUMNS, maxRows: MAX_ROWS, bleed: 2, maxEdge: 1024, maxBytes: 4 * 1024 * 1024,
  })
  if (typeof plan === 'string') throw new Error(`layout failed: ${plan}`)
  assert.equal(plan.columns, 9, 'a 40 pt figure is nine columns wide at the base scale')
  assert.equal(plan.rows, 3, 'a 20 pt figure is three rows tall')
  assert.equal(plan.deviceScale, 2, 'the raster is rendered at twice the cell resolution when it fits')
  assert.equal(plan.contentWidth, 160)
  assert.equal(plan.contentHeight, 80)
}
assert.equal(planTikzLayout({ widthPt: 0, heightPt: 20 }, {
  cellSize: CELL, maxColumns: 10, maxRows: 10, bleed: 2, maxEdge: 1024, maxBytes: 4 * 1024 * 1024,
}), 'invalid-dimensions')
assert.equal(planTikzLayout({ widthPt: 50_000, heightPt: 50_000 }, {
  cellSize: CELL, maxColumns: 10, maxRows: 10, bleed: 2, maxEdge: 1024, maxBytes: 4 * 1024 * 1024,
}), 'too-small')

// ── Raster and component ──────────────────────────────────────────────────
const raster = await renderTikzRaster(request(FIGURE))
assert.ok(raster.ok, 'the fixture figure rasterizes')
const expected = raster.raster
assert.equal(expected.columns, 9)
assert.equal(expected.rows, 3)
assert.equal(expected.source.width, 180)
assert.equal(expected.source.height, 120)
assert.ok(expected.inkBounds.right - expected.inkBounds.left > 120,
  'the drawing fills the scaled canvas instead of staying at intrinsic pt size')
assert.ok(expected.inkBounds.bottom - expected.inkBounds.top > 50,
  'the drawing fills the scaled canvas vertically too')
assert.ok(peekTikzRaster(request(FIGURE)) !== undefined, 'the settled raster is cached for a remount')
assert.equal(compilerCalls, 1, 'one fixture compile')
const before = tikzRenderStats.rasterHits
const again = await renderTikzRaster(request(FIGURE))
assert.equal(again.ok, true)
if (again.ok && raster.ok) assert.equal(again.raster.key, raster.raster.key)
assert.ok(tikzRenderStats.rasterHits > before, 'the second render is a cache hit')
assert.equal(compilerCalls, 1, 'a cache hit does not recompile')

{
  const fence = '```tikz\n' + FIGURE + '\n```'
  const rendered = lines(markdown(fence))
  assert.equal(rendered.length, expected.rows, 'a settled fence takes the raster rows')
  assert.ok(!rendered.some(line => line.includes('```tikz')), 'the fence line is gone')
}
{
  const rendered = lines(markdown('```tikz\n' + FIGURE + '\n```'), images(false, CELL))
  assert.ok(rendered.some(line => line.includes('\\begin{tikzpicture}')), 'without graphics the source stays')
}
{
  applyTikzRendering('source')
  const rendered = lines(markdown('```tikz\n' + FIGURE + '\n```'))
  assert.ok(rendered.some(line => line.includes('\\begin{tikzpicture}')), 'the source switch keeps the code')
  assert.equal(normalizeTikzRendering('bogus'), 'auto', 'an unknown switch value falls back to auto')
  applyTikzRendering('auto')
}
{
  const rendered = lines(<Markdown dimColor>{'```tikz\n' + FIGURE + '\n```'}</Markdown>)
  assert.ok(rendered.some(line => line.includes('\\begin{tikzpicture}')), 'a dimmed thinking block stays source')
}
{
  const incomplete = String.raw`\begin{tikzpicture}
\draw (0,0) -- (1,1);`
  const rendered = lines(<TikzDiagram source={incomplete} raw={'```tikz\n' + incomplete + '\n'} dimColor={false} closed={false} highlight={null} />)
  assert.ok(rendered.some(line => line.includes('\\begin{tikzpicture}')), 'an unfinished figure stays source')
}
{
  // A balanced figure starts rendering before its closing fence arrives; the
  // fixture cache makes that observable on the first screen.
  const rendered = lines(<TikzDiagram source={FIGURE} raw={'```tikz\n' + FIGURE + '\n'} dimColor={false} closed={false} highlight={null} />)
  assert.equal(rendered.length, expected.rows, 'a balanced streaming figure uses the cached raster')
}
{
  // A real streaming fence: marked keeps the unclosed fence as one code token,
  // and the balanced environment is enough to start the render.
  const rendered = lines(markdown('```tikz\n' + FIGURE + '\n'))
  assert.equal(rendered.length, expected.rows, 'an unclosed fence with a balanced figure renders from cache')
}
{
  const math = '$$\n' + TIKZCD + '\n$$'
  const rasterCd = await renderTikzRaster(request(TIKZCD))
  assert.ok(rasterCd.ok, 'tikz-cd rasterizes')
  const rendered = lines(markdown(math))
  assert.equal(rendered.length, rasterCd.raster.rows, 'display-math tikz-cd takes the raster rows')
}
{
  const bare = TIKZCD
  const rasterCd = await renderTikzRaster(request(TIKZCD))
  assert.ok(rasterCd.ok)
  const rendered = lines(markdown(bare))
  assert.equal(rendered.length, rasterCd.raster.rows, 'a bare tikzcd environment takes the raster rows')
}
{
  // Display math still streaming: the closer is absent, but the tikzcd
  // environment is balanced, so the image may appear before the token seals.
  const rasterCd = await renderTikzRaster(request(TIKZCD))
  assert.ok(rasterCd.ok)
  const rendered = lines(markdown('$$\n' + TIKZCD + '\n'))
  assert.equal(rendered.length, rasterCd.raster.rows, 'a still-streaming display-math tikzcd uses the cached raster')
}
{
  compilerFailure = true
  clearTikzRenderCaches()
  const failed = await renderTikzRaster(request(FIGURE))
  assert.equal(failed.ok, false, 'the fixture compiler can reject')
  const rendered = lines(markdown('```tikz\n' + FIGURE + '\n```'))
  assert.ok(rendered.some(line => line.includes('\\begin{tikzpicture}')), 'a rejected figure falls back to source')
  compilerFailure = false
  clearTikzRenderCaches()
}

// ── Optional real engine ──────────────────────────────────────────────────
if (process.env.DSH_TUI_TIKZ_REAL === '1') {
  setTikzCompilerForTests(undefined)
  clearTikzRenderCaches()
  const started = performance.now()
  const real = await renderTikzRaster(request(FIGURE))
  const elapsed = Math.round(performance.now() - started)
  assert.ok(real.ok, `a real TeX render works (got ${real.ok ? 'ok' : real.failure})`)
  if (real.ok) {
    assert.ok(real.raster.columns > 0 && real.raster.rows > 0)
    assert.ok(real.raster.inkBounds.right - real.raster.inkBounds.left > real.raster.source.width * 0.5,
      'the real dvisvgm SVG fills the scaled canvas (the XML declaration must not hide the root)')
    const rendered = lines(markdown('```tikz\n' + FIGURE + '\n```'))
    assert.equal(rendered.length, real.raster.rows, 'Markdown uses the real raster')
    console.log(`real TeX render: ${real.raster.columns}x${real.raster.rows} cells in ${elapsed} ms`)
  }
  if (process.env.DSH_TUI_TIKZ_REAL_CD === '1') {
    const cdStarted = performance.now()
    const cd = await renderTikzRaster(request(TIKZCD))
    console.log(`real tikz-cd render: ${cd.ok ? `${cd.raster.columns}x${cd.raster.rows} cells` : `failed (${cd.failure})`} in ${Math.round(performance.now() - cdStarted)} ms`)
    assert.ok(cd.ok, `a real tikz-cd render works (got ${cd.ok ? 'ok' : cd.failure})`)
  }
}

setTikzCompilerForTests(undefined)
clearTikzRenderCaches()
console.log('TikZ diagrams verified: wrapper policy, pt→cell layout, image box, tikzcd display math, streaming snapshots, settings/graphics/dim and TeX-failure fallbacks')
