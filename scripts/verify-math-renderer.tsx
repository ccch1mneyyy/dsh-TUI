/** Math image renderer regression (MathJax → SVG → sharp → RGBA): the pure
 * cell layout (base scale, shrink-only, whole-cell canvas, limits), real
 * rasters (transparent canvas, ink clear of every edge, ink color, cell box),
 * typed failures (bad TeX, excluded `html` commands, empty, too long, too
 * narrow), per-formula TeX isolation (macros, labels), the vector/raster caches, and the lazy-load contract: MathJax is
 * reachable only through a dynamic import inside src/math. Run with:
 * node --import tsx/esm scripts/verify-math-renderer.tsx
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planFormulaLayout } from '../src/math/layout.js'
import { clearMathRenderCaches, mathRenderStats, renderMathRaster } from '../src/math/renderer.js'

const cell = { width: 10, height: 20 }
const limits = { cellSize: cell, bleed: 2, maxEdge: 1024, maxBytes: 4 * 1024 * 1024 }

// ── Layout (pure) ──────────────────────────────────────────────────────

const base = planFormulaLayout({ widthEx: 10, heightEx: 2 }, { ...limits, maxColumns: 80, maxRows: 10 })
assert.ok(typeof base !== 'string')
assert.equal(base.pixelsPerEx, 10 * base.deviceScale, 'a formula that fits uses the base scale (half a cell height per ex)')
assert.equal(base.canvasWidth, base.columns * cell.width * base.deviceScale, 'the canvas is a whole number of cells')
assert.equal(base.canvasHeight, base.rows * cell.height * base.deviceScale)
assert.deepEqual([base.columns, base.rows], [11, 2])

const shrunk = planFormulaLayout({ widthEx: 40, heightEx: 2 }, { ...limits, maxColumns: 30, maxRows: 10 })
assert.ok(typeof shrunk !== 'string')
assert.ok(shrunk.pixelsPerEx / shrunk.deviceScale < 10, 'an overwide formula shrinks')
assert.ok(shrunk.columns <= 30, 'and stays inside the columns it may use')
const aspect = (plan: typeof shrunk) => plan.contentWidth / plan.contentHeight
assert.ok(Math.abs(aspect(shrunk) - 20) < 1e-9, 'uniformly — the aspect ratio is kept')

const tiny = planFormulaLayout({ widthEx: 1, heightEx: 1 }, { ...limits, maxColumns: 80, maxRows: 10 })
assert.ok(typeof tiny !== 'string' && tiny.pixelsPerEx / tiny.deviceScale === 10, 'a short formula is never enlarged')
assert.equal(planFormulaLayout({ widthEx: 200, heightEx: 2 }, { ...limits, maxColumns: 20, maxRows: 10 }), 'too-small')
assert.equal(planFormulaLayout({ widthEx: 0, heightEx: 2 }, { ...limits, maxColumns: 20, maxRows: 10 }), 'invalid-dimensions')
assert.equal(
  planFormulaLayout({ widthEx: 100, heightEx: 2 }, { ...limits, maxColumns: 200, maxRows: 10, maxEdge: 256 }),
  'raster-limit',
  'a canvas past the edge budget even at 1x is rejected',
)
const oneX = planFormulaLayout({ widthEx: 40, heightEx: 2 }, { ...limits, maxColumns: 80, maxRows: 10, maxEdge: 600 })
assert.ok(typeof oneX !== 'string' && oneX.deviceScale === 1, 'a canvas that only fits at 1x drops the 2x density')

// ── Real rasters ───────────────────────────────────────────────────────

const color = '#cdd6f4'
const request = (tex: string, display = true, overrides: Partial<Parameters<typeof renderMathRaster>[0]> = {}) =>
  renderMathRaster({ tex, display, color, cellSize: cell, maxColumns: 80, maxRows: 12, ...overrides })

const FORMULAS = [
  String.raw`x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}`,
  String.raw`\sum_{i=1}^{n} i^2 = \frac{n(n+1)(2n+1)}{6}`,
  String.raw`\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}`,
  String.raw`\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}`,
  String.raw`f(x) = \begin{cases} x^2 & x \ge 0 \\ -x & x < 0 \end{cases}`,
  String.raw`\boxed{E = mc^2}`,
  String.raw`\left( \frac{a}{b} \right)^{\!2}`,
]
for (const tex of FORMULAS) {
  const result = await request(tex)
  assert.ok(result.ok, `${tex} rasterizes (got ${result.ok ? '' : result.failure})`)
  const { source, columns, rows, inkBounds } = result.raster
  assert.ok(Number.isInteger(columns) && Number.isInteger(rows) && columns >= 1 && rows >= 1)
  const scale = source.width / (columns * cell.width)
  assert.ok(scale === 1 || scale === 2, `${tex}: device scale is 1 or 2`)
  assert.equal(source.height, rows * cell.height * scale, `${tex}: whole-cell canvas`)
  assert.equal(source.data.byteLength, source.width * source.height * 4, `${tex}: RGBA`)
  assert.equal(source.data[3], 0, `${tex}: transparent background`)
  assert.ok(
    inkBounds.left > 0 && inkBounds.top > 0 && inkBounds.right < source.width && inkBounds.bottom < source.height,
    `${tex}: ink clear of every canvas edge`,
  )
}

// Ink color: the most opaque pixel carries the requested color.
{
  const result = await request(String.raw`\blacksquare`, false)
  assert.ok(result.ok)
  const { data } = result.raster.source
  let best = 0
  for (let index = 3; index < data.length; index += 4) if (data[index]! > data[best + 3]!) best = index - 3
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16)
  for (let at = 0; at < 3; at++) {
    assert.ok(Math.abs(data[best + at]! - channel(color, at)) <= 8, 'ink uses the requested color')
  }
}

// CJK inside \text either renders visible ink or fails with a type — never blank.
{
  const result = await request(String.raw`\text{速度} = \frac{s}{t}`)
  if (result.ok) assert.ok(result.raster.inkBounds.right > result.raster.inkBounds.left)
  else assert.ok(['tex-error', 'empty-raster', 'clipped-raster', 'backend-unavailable'].includes(result.failure))
}

// ── Typed failures ─────────────────────────────────────────────────────

const failure = async (promise: ReturnType<typeof renderMathRaster>) => {
  const result = await promise
  return result.ok ? 'ok' : result.failure
}
assert.equal(await failure(request(String.raw`x + \unknown{y}`)), 'tex-error', 'unknown commands fail instead of rendering red text')
assert.equal(await failure(request(String.raw`\frac{1}{`)), 'tex-error', 'malformed TeX fails')
assert.equal(await failure(request(String.raw`\href{https://example.com}{x}`)), 'tex-error', 'the html extension is not loaded')
assert.equal(await failure(request(String.raw`\style{color:red}{x}`)), 'tex-error')
// Each formula stands alone: TeX state (macros, labels) never leaks into the
// next one, so a cached result never depends on what was rendered before it.
assert.equal(await failure(request(String.raw`\newcommand{\foo}{x}\foo`)), 'ok')
assert.equal(await failure(request(String.raw`\foo`)), 'tex-error', 'a macro defined by one formula is gone in the next')
assert.equal(await failure(request(String.raw`\begin{equation}a\label{eq:t}\end{equation}`)), 'ok')
assert.equal(await failure(request(String.raw`\begin{equation}b\label{eq:t}\end{equation}`)), 'ok', 'labels do not collide across formulas')
assert.equal(await failure(request('   ')), 'empty')
assert.equal(await failure(request(`x+${'y'.repeat(5000)}`)), 'input-too-long')
assert.equal(
  await failure(request(String.raw`a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z`, true, { maxColumns: 6 })),
  'too-small',
  'a formula that would shrink past legibility keeps its Unicode rendering',
)

// ── Caches ─────────────────────────────────────────────────────────────

clearMathRenderCaches()
await request(FORMULAS[0]!)
assert.deepEqual({ ...mathRenderStats }, { vectorHits: 0, vectorMisses: 1, rasterHits: 0, rasterMisses: 1 })
await request(FORMULAS[0]!)
assert.equal(mathRenderStats.rasterHits, 1, 'the same request is a raster cache hit')
await request(FORMULAS[0]!, true, { maxColumns: 60 })
assert.deepEqual(
  [mathRenderStats.vectorHits, mathRenderStats.rasterMisses],
  [1, 2],
  'a new width re-rasterizes from the cached SVG without re-typesetting',
)
const [first, second] = await Promise.all([request('a^2', false), request('a^2', false)])
assert.equal(first, second, 'concurrent identical requests share one render')
await request(String.raw`\unknown{z}`)
const failedMisses = mathRenderStats.vectorMisses
await request(String.raw`\unknown{z}`)
assert.equal(mathRenderStats.vectorMisses, failedMisses, 'failures are cached, not retried')

// ── Lazy-load contract ─────────────────────────────────────────────────

const root = fileURLToPath(new URL('../', import.meta.url))
const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name)
  return entry.isDirectory() ? sources(path) : /\.(tsx?|mts)$/.test(entry.name) ? [path] : []
})
for (const file of sources(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8')
  // POSIX separators, so the whitelist reads identically on Windows (where
  // relative() returns backslashes) and on CI.
  const name = relative(root, file).split(sep).join('/')
  for (const line of text.split('\n')) {
    if (!line.includes('@dsh-tui-vendor/mathjax-tex-svg')) continue
    const allowed = name === 'src/math/renderer.ts' &&
      (/^import type /.test(line.trim()) || /import\('@dsh-tui-vendor\/mathjax-tex-svg'\)/.test(line))
    assert.ok(allowed, `${name}: MathJax may only be reached through the dynamic import in src/math/renderer.ts`)
  }
  if (name !== 'src/math/renderer.ts' && /from '(\.\.?\/)+(math\/)?renderer\.js'/.test(text) && name.startsWith('src/math/')) {
    assert.fail(`${name}: unexpected static dependency on the renderer`)
  }
}

console.log('Math renderer verified: cell layout, real rasters (transparency, edge-clear ink, color, cell box), typed failures, caches, lazy-load contract')
