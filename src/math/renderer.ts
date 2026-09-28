/**
 * LaTeX → terminal-image raster: MathJax typesets TeX to SVG, sharp renders
 * the SVG to RGBA sized in whole terminal cells.
 *
 * The typeset-image backend behind `mathRendering: image` (#1051). Nothing
 * here decides whether an image is shown — callers fall back to the Unicode
 * renderer on any failure — and nothing here knows a terminal protocol: the
 * result is a TerminalImageSource plus its cell box. Every failure is a
 * typed result; nothing throws to the caller.
 *
 * MathJax (a ~1.8 MB bundle) loads on the first formula that asks for an
 * image, never at startup. SVG and raster results are cached separately, so
 * a theme or width change re-rasterizes without re-typesetting, and failures
 * are cached too so a bad formula is not retried every frame.
 */
import type { TexToSvg } from '@dsh-tui-vendor/mathjax-tex-svg'
import { loadSharp } from '../dsh-adapter/sharp.js'
import {
  TERMINAL_IMAGE_MAX_BYTES,
  TERMINAL_IMAGE_MAX_EDGE,
  type TerminalCellSize,
  type TerminalImageSource,
} from '../ink/terminal-image.js'
import { planFormulaLayout, type FormulaLayoutPlan } from './layout.js'

/** Same budget as the Unicode renderer: longer input is a paste, not math. */
export const MATH_SOURCE_LIMIT = 4096
/**
 * Transparent margins tried in turn, in CSS pixels. Glyph overhang (italic
 * tails, radicals, big fences) can exceed the box MathJax reports; a raster
 * whose ink still touches the canvas edge at the largest margin is rejected
 * rather than shown clipped.
 */
const BLEED_STEPS = [1, 2, 4, 8, 16, 32] as const

export type MathFailureCode =
  | 'empty'
  | 'input-too-long'
  | 'tex-error'
  | 'invalid-dimensions'
  | 'too-small'
  | 'raster-limit'
  | 'empty-raster'
  | 'clipped-raster'
  | 'backend-unavailable'

export interface MathRenderRequest {
  /** TeX without delimiters. */
  readonly tex: string
  readonly display: boolean
  /** Ink color as `#rrggbb` (the theme's text color). */
  readonly color: string
  readonly cellSize: TerminalCellSize
  /** Largest cell box the formula may occupy; it shrinks to fit, never grows. */
  readonly maxColumns: number
  readonly maxRows: number
}

export interface MathRaster {
  /** Stable identity of this raster (formula, color, geometry). */
  readonly key: string
  readonly source: TerminalImageSource
  readonly columns: number
  readonly rows: number
  /** Half-open pixel box of visible ink inside the canvas. */
  readonly inkBounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
}

export type MathRenderResult =
  | { readonly ok: true; readonly raster: MathRaster }
  | { readonly ok: false; readonly failure: MathFailureCode }

type Vector = {
  readonly svg: string
  readonly widthEx: number
  readonly heightEx: number
  /** Baseline offset MathJax reports; kept for inline baseline alignment. */
  readonly verticalAlignEx: number
}
type VectorResult = Vector | { readonly failure: MathFailureCode }

/** LRU bounded by entry count and by the summed weight of its values. */
class WeightedLru<V> {
  private readonly map = new Map<string, V>()
  private weight = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly weigh: (value: V) => number,
  ) {}

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    const previous = this.map.get(key)
    if (previous !== undefined) {
      this.weight -= this.weigh(previous)
      this.map.delete(key)
    }
    this.map.set(key, value)
    this.weight += this.weigh(value)
    while (this.map.size > this.maxEntries || this.weight > this.maxWeight) {
      const oldest = this.map.keys().next()
      if (oldest.done === true) break
      this.weight -= this.weigh(this.map.get(oldest.value)!)
      this.map.delete(oldest.value)
    }
  }

  clear(): void {
    this.map.clear()
    this.weight = 0
  }

  get size(): number {
    return this.map.size
  }
}

const vectors = new WeightedLru<VectorResult>(256, 8 * 1024 * 1024, value => 'svg' in value ? value.svg.length * 2 : 64)
const rasters = new WeightedLru<MathRenderResult>(
  128,
  64 * 1024 * 1024,
  value => value.ok ? value.raster.source.data.byteLength : 64,
)
const inflight = new Map<string, Promise<MathRenderResult>>()

/** Cache counters, for tests and debug output. */
export const mathRenderStats = { vectorHits: 0, vectorMisses: 0, rasterHits: 0, rasterMisses: 0 }

let converter: Promise<TexToSvg | undefined> | undefined

function loadConverter(): Promise<TexToSvg | undefined> {
  converter ??= import('@dsh-tui-vendor/mathjax-tex-svg')
    .then(module => module.createTexToSvg())
    .catch(() => undefined)
  return converter
}

async function typeset(tex: string, display: boolean): Promise<VectorResult> {
  const key = `${display ? 'D' : 'T'}\u0000${tex}`
  const cached = vectors.get(key)
  if (cached !== undefined) {
    mathRenderStats.vectorHits += 1
    return cached
  }
  mathRenderStats.vectorMisses += 1
  const engine = await loadConverter()
  if (engine === undefined) return { failure: 'backend-unavailable' }
  let result: VectorResult
  try {
    const { svg, widthEx, heightEx, verticalAlignEx } = engine.convert(tex, display)
    result = { svg, widthEx, heightEx, verticalAlignEx }
  } catch {
    result = { failure: 'tex-error' }
  }
  vectors.set(key, result)
  return result
}

/** Only a plain hex color may reach the SVG handed to the rasterizer. */
function normalizeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#808080'
}

/** Rewrite the root `<svg>` size to device pixels and its ink to `color`. */
function sizedSvg(svg: string, plan: FormulaLayoutPlan, color: string): string {
  const headEnd = svg.indexOf('>')
  const head = svg
    .slice(0, headEnd)
    .replace(/\swidth="[^"]*"/, ` width="${plan.contentWidth.toFixed(3)}"`)
    .replace(/\sheight="[^"]*"/, ` height="${plan.contentHeight.toFixed(3)}"`)
    .replace(/\sstyle="[^"]*"/, '')
  return (head + svg.slice(headEnd)).replaceAll('currentColor', color)
}

/** Half-open box of pixels with any alpha, or undefined when fully transparent. */
function inkBoundsOf(data: Uint8Array, width: number, height: number): MathRaster['inkBounds'] | undefined {
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

async function rasterize(vector: Vector, request: MathRenderRequest, color: string, key: string): Promise<MathRenderResult> {
  const sharp = await loadSharp()
  if (sharp === undefined) return { ok: false, failure: 'backend-unavailable' }
  for (const bleed of BLEED_STEPS) {
    const plan = planFormulaLayout(vector, {
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
      ink = await sharp(Buffer.from(sizedSvg(vector.svg, plan, color)))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
    } catch {
      return { ok: false, failure: 'backend-unavailable' }
    }
    const { width, height } = ink.info
    if (width > plan.canvasWidth || height > plan.canvasHeight) continue
    // Center the ink box in the whole-cell canvas; the rest stays transparent.
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

type PreparedRequest =
  | { readonly key: string; readonly tex: string; readonly color: string }
  | { readonly failure: MathFailureCode }

/** Normalize a request and derive its cache key (formula, color, geometry). */
function prepare(request: MathRenderRequest): PreparedRequest {
  const tex = request.tex.trim()
  if (tex === '') return { failure: 'empty' }
  if (tex.length > MATH_SOURCE_LIMIT) return { failure: 'input-too-long' }
  const color = normalizeColor(request.color)
  const key = [
    request.display ? 'D' : 'T',
    color,
    request.cellSize.width,
    request.cellSize.height,
    request.maxColumns,
    request.maxRows,
    tex,
  ].join('\u0000')
  return { key, tex, color }
}

/**
 * The settled result for this request if one is cached, without rendering.
 * Lets a remounted view (scrolled back into the viewport) paint its image on
 * the first frame instead of flashing the Unicode fallback.
 */
export function peekMathRaster(request: MathRenderRequest): MathRenderResult | undefined {
  const prepared = prepare(request)
  if ('failure' in prepared) return { ok: false, failure: prepared.failure }
  return rasters.get(prepared.key)
}

/**
 * Typeset and rasterize one formula. Results (including failures) are cached
 * by formula, color and geometry; concurrent requests for the same key share
 * one render.
 */
export function renderMathRaster(request: MathRenderRequest): Promise<MathRenderResult> {
  const prepared = prepare(request)
  if ('failure' in prepared) return Promise.resolve({ ok: false, failure: prepared.failure })
  const { key, tex, color } = prepared
  const cached = rasters.get(key)
  if (cached !== undefined) {
    mathRenderStats.rasterHits += 1
    return Promise.resolve(cached)
  }
  const pending = inflight.get(key)
  if (pending !== undefined) return pending
  mathRenderStats.rasterMisses += 1
  const render = (async (): Promise<MathRenderResult> => {
    const vector = await typeset(tex, request.display)
    if ('failure' in vector) return { ok: false, failure: vector.failure }
    return rasterize(vector, request, color, key)
  })()
    .catch((): MathRenderResult => ({ ok: false, failure: 'backend-unavailable' }))
    .then(result => {
      inflight.delete(key)
      rasters.set(key, result)
      return result
    })
  inflight.set(key, render)
  return render
}

/** Drop every cached vector and raster (tests; a future debug command). */
export function clearMathRenderCaches(): void {
  vectors.clear()
  rasters.clear()
  mathRenderStats.vectorHits = 0
  mathRenderStats.vectorMisses = 0
  mathRenderStats.rasterHits = 0
  mathRenderStats.rasterMisses = 0
}
