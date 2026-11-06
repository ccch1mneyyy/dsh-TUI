/**
 * TikZ source → terminal-image raster: the engine produces a cropped SVG,
 * sharp renders it to RGBA sized in whole terminal cells.
 *
 * This is the TikZ sibling of `../math/renderer.ts`: it decides nothing about
 * whether an image is shown (the component falls back to the source), knows no
 * terminal protocol, and returns a TerminalImageSource plus its cell box.
 * The SVG cache lives in the engine; here we cache the themed raster, so a
 * theme or width change re-rasterizes without re-running TeX.
 */
import { createHash } from 'node:crypto'
import { loadSharp } from '../dsh-adapter/sharp.js'
import {
  TERMINAL_IMAGE_MAX_BYTES,
  TERMINAL_IMAGE_MAX_EDGE,
  type TerminalCellSize,
  type TerminalImageSource,
} from '../ink/terminal-image.js'
import { WeightedLru } from '../utils/weightedLru.js'
import {
  compileTikzSvg,
  clearTikzCompileCaches,
  type TikzCompileFailure,
  type TikzCompileResult,
} from './engine.js'
import { planTikzLayout, type TikzLayoutFailure, type TikzLayoutPlan } from './layout.js'
import { TIKZ_TEMPLATE_VERSION } from './source.js'

/** Transparent margins tried in turn, in device-independent pixels. */
const BLEED_STEPS = [2, 4, 8, 16] as const

export type TikzRasterFailure =
  | TikzCompileFailure
  | TikzLayoutFailure
  | 'backend-unavailable'
  | 'empty-raster'
  | 'clipped-raster'

export interface TikzRenderRequest {
  /** Figure body without fences. */
  readonly source: string
  /** Ink color as `#rrggbb` (the theme's text color). */
  readonly color: string
  readonly cellSize: TerminalCellSize
  /** Largest cell box the figure may occupy; it shrinks to fit, never grows. */
  readonly maxColumns: number
  readonly maxRows: number
}

export interface TikzRaster {
  /** Stable identity of this raster (source, color, geometry). */
  readonly key: string
  readonly source: TerminalImageSource
  readonly columns: number
  readonly rows: number
  /** Half-open pixel box of visible ink inside the canvas. */
  readonly inkBounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
}

export type TikzRenderResult =
  | { readonly ok: true; readonly raster: TikzRaster }
  | { readonly ok: false; readonly failure: TikzRasterFailure }

type Compiler = (source: string, signal?: AbortSignal) => Promise<TikzCompileResult>

let compilerOverride: Compiler | undefined

/**
 * Replace the TeX compile with a fixture for regression scripts. Not part of
 * the package surface; production never calls this.
 */
export function setTikzCompilerForTests(compiler: Compiler | undefined): void {
  compilerOverride = compiler
}

const rasters = new WeightedLru<TikzRenderResult>(
  64,
  64 * 1024 * 1024,
  value => value.ok ? value.raster.source.data.byteLength : 64,
)
const inflight = new Map<string, Promise<TikzRenderResult>>()

/** Cache counters, for tests and debug output. */
export const tikzRenderStats = { rasterHits: 0, rasterMisses: 0 }

/** Renders still running (tests wait for 0 before reading the screen). */
export function tikzRendersInFlight(): number {
  return inflight.size
}

/** The settled raster for a request if one is cached, without rendering. */
export function peekTikzRaster(request: TikzRenderRequest): TikzRaster | undefined {
  const cached = rasters.get(tikzRequestKey(request))
  return cached?.ok === true ? cached.raster : undefined
}

/** Cache key for one themed, laid-out raster. Exported for tests. */
export function tikzRequestKey(request: TikzRenderRequest): string {
  return createHash('sha256').update([
    TIKZ_TEMPLATE_VERSION,
    normalizeColor(request.color),
    request.cellSize.width,
    request.cellSize.height,
    request.maxColumns,
    request.maxRows,
    request.source,
  ].join('\u0000')).digest('hex')
}

/**
 * Compile and rasterize one figure. Results (including failures) are cached by
 * source, color and geometry; concurrent requests for the same key share one
 * render.
 */
export function renderTikzRaster(request: TikzRenderRequest, signal?: AbortSignal): Promise<TikzRenderResult> {
  if (signal?.aborted === true) return Promise.resolve({ ok: false, failure: 'aborted' })
  const key = tikzRequestKey(request)
  const cached = rasters.get(key)
  if (cached !== undefined) {
    tikzRenderStats.rasterHits += 1
    return Promise.resolve(cached)
  }
  const pending = inflight.get(key)
  if (pending !== undefined) return pending
  tikzRenderStats.rasterMisses += 1
  const run = (async (): Promise<TikzRenderResult> => {
    const compiled = compilerOverride === undefined
      ? await compileTikzSvg(request.source, signal)
      : await compilerOverride(request.source, signal)
    if (!compiled.ok) return { ok: false, failure: compiled.failure }
    return rasterize(compiled.svg.svg, compiled.svg.widthPt, compiled.svg.heightPt, request, key)
  })()
    .catch((): TikzRenderResult => ({ ok: false, failure: 'backend-unavailable' }))
    .then(result => {
      inflight.delete(key)
      if (!(result.ok === false && result.failure === 'aborted')) rasters.set(key, result)
      return result
    })
  inflight.set(key, run)
  return run
}

/** Drop every cached raster and compiled vector (tests; a future debug command). */
export function clearTikzRenderCaches(): void {
  rasters.clear()
  clearTikzCompileCaches()
  inflight.clear()
  tikzRenderStats.rasterHits = 0
  tikzRenderStats.rasterMisses = 0
}

async function rasterize(
  svg: string,
  widthPt: number,
  heightPt: number,
  request: TikzRenderRequest,
  key: string,
): Promise<TikzRenderResult> {
  const sharp = await loadSharp()
  if (sharp === undefined) return { ok: false, failure: 'backend-unavailable' }
  const color = normalizeColor(request.color)
  for (const bleed of BLEED_STEPS) {
    const plan = planTikzLayout({ widthPt, heightPt }, {
      cellSize: request.cellSize,
      maxColumns: request.maxColumns,
      maxRows: request.maxRows,
      bleed,
      maxEdge: TERMINAL_IMAGE_MAX_EDGE,
      maxBytes: TERMINAL_IMAGE_MAX_BYTES,
    })
    if (typeof plan === 'string') return { ok: false, failure: plan }
    let ink: { data: Buffer; info: { width: number; height: number } }
    try {
      ink = await sharp(Buffer.from(sizedSvg(svg, plan, color)))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
    } catch {
      return { ok: false, failure: 'backend-unavailable' }
    }
    const { width, height } = ink.info
    if (width > plan.canvasWidth || height > plan.canvasHeight) continue
    const canvas = new Uint8Array(plan.canvasWidth * plan.canvasHeight * 4)
    const offsetX = Math.floor((plan.canvasWidth - width) / 2)
    const offsetY = Math.floor((plan.canvasHeight - height) / 2)
    for (let y = 0; y < height; y++) {
      canvas.set(
        ink.data.subarray(y * width * 4, (y + 1) * width * 4),
        ((offsetY + y) * plan.canvasWidth + offsetX) * 4,
      )
    }
    const bounds = inkBoundsOf(canvas, plan.canvasWidth, plan.canvasHeight)
    if (bounds === undefined) return { ok: false, failure: 'empty-raster' }
    const touchesEdge = bounds.left === 0 || bounds.top === 0 ||
      bounds.right === plan.canvasWidth || bounds.bottom === plan.canvasHeight
    if (touchesEdge) continue
    return {
      ok: true,
      raster: {
        key,
        source: { data: canvas, width: plan.canvasWidth, height: plan.canvasHeight },
        columns: plan.columns,
        rows: plan.rows,
        inkBounds: bounds,
      },
    }
  }
  return { ok: false, failure: 'clipped-raster' }
}

/** Only a plain hex color may reach the SVG handed to the rasterizer. */
function normalizeColor(color: string): string {
  return /^#[0-9a-f]{6}$/iu.test(color) ? color.toLowerCase() : '#808080'
}

/** Rewrite the root `<svg>` size to device pixels and its default ink to `color`. */
function sizedSvg(svg: string, plan: TikzLayoutPlan, color: string): string {
  // dvisvgm starts the file with `<?xml ...?>`; the first '>' is the XML
  // declaration's, not the SVG root's. Rewriting from that point silently
  // left the raster at its intrinsic pt-as-px size (a tiny diagram centered
  // in a large cell box). Anchor on the actual <svg> tag instead.
  const start = svg.indexOf('<svg')
  if (start < 0) return svg
  const headEnd = svg.indexOf('>', start)
  if (headEnd < 0) return svg
  const head = svg
    .slice(start, headEnd)
    .replace(/\swidth\s*=\s*['"][^'"]*['"]/u, ` width="${plan.contentWidth.toFixed(3)}"`)
    .replace(/\sheight\s*=\s*['"][^'"]*['"]/u, ` height="${plan.contentHeight.toFixed(3)}"`)
  // dvisvgm --currentcolor turns its default black into currentColor. Older
  // dvisvgm builds that reject the flag emit literal #000/#000000 instead;
  // recolour those too so a dark terminal never renders an invisible figure.
  // A user-authored explicit black is themed as well — the same outcome the
  // currentColor path already gives it.
  return (svg.slice(0, start) + head + svg.slice(headEnd))
    .replace(/currentColor/gu, color)
    .replace(/(stroke|fill)=(['"])#(?:000|000000)\2/gu, `$1=$2${color}$2`)
}

/** Half-open box of pixels with any alpha, or undefined when fully transparent. */
function inkBoundsOf(data: Uint8Array, width: number, height: number): TikzRaster['inkBounds'] | undefined {
  let left = width
  let top = height
  let right = 0
  let bottom = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue
      if (x < left) left = x
      if (x >= right) right = x + 1
      if (y < top) top = y
      if (y >= bottom) bottom = y + 1
    }
  }
  return right === 0 ? undefined : { left, top, right, bottom }
}
