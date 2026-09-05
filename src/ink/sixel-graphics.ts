import { Worker } from 'node:worker_threads'
import type { DOMElement } from './dom.js'
import type { SixelEncodeRequest, SixelRaster, SixelWorkerRequest, SixelWorkerResponse } from './sixel-codec.js'
import {
  DEFAULT_TERMINAL_CELL_SIZE, normalizeTerminalCellSize, TERMINAL_IMAGE_MAX_EDGE,
  SIXEL_MAX_ENCODED_BYTES, SIXEL_THUMBNAIL_FRAME_BYTES, SIXEL_CACHE_BYTES, SIXEL_CACHE_ENTRIES,
  type TerminalCellSize, type TerminalImagePlacement,
} from './terminal-image.js'
import { cellAt, clearRegion, type Screen } from './screen.js'
import type { Diff } from './frame.js'
import { stringWidth } from './stringWidth.js'

type Rect = { x: number; y: number; columns: number; rows: number }
type Variant = {
  key: string
  assetKey: string
  request: SixelEncodeRequest
  rect: Rect
  placement: TerminalImagePlacement
  ready: boolean
}
type Displayed = Rect & { key: string; raster: SixelRaster }
type Encoder = (request: SixelEncodeRequest) => Promise<SixelRaster>

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.columns && a.x + a.columns > b.x &&
    a.y < b.y + b.rows && a.y + a.rows > b.y
}

/** Viewport-owned pixels. Encoding is shared; placement/erasure is per DOM node. */
export class SixelGraphicsManager {
  private cell: TerminalCellSize = DEFAULT_TERMINAL_CELL_SIZE
  private readonly ids = new WeakMap<Uint8Array, number>()
  private nextId = 1
  private readonly cache = new Map<string, SixelRaster | null>()
  private cachedBytes = 0
  private readyBytes = 0
  private active: Variant | undefined
  private pending: Variant[] = []
  private readonly frame = new Map<DOMElement, Variant>()
  private desired = new Set<string>()
  private displayed = new Map<DOMElement, Displayed>()
  private nextDisplay = new Map<DOMElement, Displayed>()
  private readonly repaint = new Set<DOMElement>()
  private worker: Worker | undefined
  private workerKeys = new Set<string>()
  private workerReject: ((reason: Error) => void) | undefined
  private disposed = false
  private dirty = false
  private columns = 0
  private rows = 0
  private displayModeSet = false

  constructor(private readonly onReady: () => void, private readonly encoder?: Encoder) {}

  get hasImage(): boolean { return this.displayed.size > 0 || this.nextDisplay.size > 0 }

  setDisplayMode(enabled: boolean): void {
    this.displayModeSet = enabled
    this.invalidateAll()
  }

  setCellSize(cell: TerminalCellSize): boolean {
    const next = normalizeTerminalCellSize(cell)
    if (next.width === this.cell.width && next.height === this.cell.height) return false
    this.cell = next
    this.invalidateAll()
    return true
  }

  beginFrame(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.frame.clear()
    this.readyBytes = 0
  }

  readonly prepare = (placement: TerminalImagePlacement): boolean => {
    if (this.disposed || (placement.presentation !== 'preview' && placement.presentation !== 'transcript')) return false
    const variant = this.variant(placement)
    if (!variant) return false
    const raster = this.cache.get(variant.key)
    const budget = placement.presentation === 'preview' ? SIXEL_MAX_ENCODED_BYTES : SIXEL_THUMBNAIL_FRAME_BYTES
    variant.ready = !!raster && this.readyBytes + raster.data.length <= budget
    if (variant.ready) {
      this.readyBytes += raster!.data.length
      this.cache.delete(variant.key)
      this.cache.set(variant.key, raster!)
    }
    this.frame.set(placement.node, variant)
    return variant.ready
  }

  private variant(placement: TerminalImagePlacement): Variant | undefined {
    let id = this.ids.get(placement.source.data)
    if (id === undefined) { id = this.nextId++; this.ids.set(placement.source.data, id) }
    const pixelWidth = placement.columns * this.cell.width
    const pixelHeight = placement.rows * this.cell.height
    const scale = Math.min(1, TERMINAL_IMAGE_MAX_EDGE / Math.max(pixelWidth, pixelHeight))
    const width = Math.max(1, Math.floor(pixelWidth * scale))
    const height = Math.max(1, Math.floor(pixelHeight * scale))
    const canvasColumns = Math.ceil(width / this.cell.width)
    const canvasRows = Math.ceil(height / this.cell.height)
    const originX = placement.x + Math.floor((placement.columns - canvasColumns) / 2)
    const originY = placement.y + Math.floor((placement.rows - canvasRows) / 2)
    const clip = placement.clip ?? placement
    const x = Math.max(0, originX, clip.x)
    const y = Math.max(0, originY, clip.y)
    const right = Math.min(this.columns, originX + canvasColumns, clip.x + clip.columns)
    const bottom = Math.min(this.rows - 1, originY + canvasRows, clip.y + clip.rows)
    if (right <= x || bottom <= y) return undefined
    const left = (x - originX) * this.cell.width
    const top = (y - originY) * this.cell.height
    const cropWidth = Math.min((right - x) * this.cell.width, width - left)
    const cropHeight = Math.min((bottom - y) * this.cell.height, height - top,
      Math.floor((this.rows - y) * this.cell.height / 6) * 6)
    if (cropWidth <= 0 || cropHeight <= 0) return undefined
    const background = placement.background ?? '#000000'
    const assetKey = `${id}:${placement.source.width}:${placement.source.height}:${width}:${height}:${background}`
    const key = `${assetKey}:${left}:${top}:${cropWidth}:${cropHeight}`
    return {
      assetKey, key, placement, ready: false,
      rect: { x, y, columns: Math.ceil(cropWidth / this.cell.width), rows: Math.ceil(cropHeight / this.cell.height) },
      request: { source: placement.source, width, height, background,
        crop: { left, top, width: cropWidth, height: cropHeight } },
    }
  }

  /** Reconcile ALL old rectangles before diffing, with only one baseline copy. */
  reconcile(screen: Screen, previous: Screen, placements?: readonly TerminalImagePlacement[]): { erase: string; baseline: Screen } {
    const actual = placements ? new Map(placements.map(p => [p.node, p])) : undefined
    const visible: Variant[] = []
    this.desired = new Set()
    this.nextDisplay.clear()
    this.repaint.clear()
    for (const [node, variant] of this.frame) {
      const placement = actual?.get(node)
      if ((actual && !placement) || placement?.occluded) continue
      visible.push(variant)
      this.desired.add(variant.key)
      const raster = this.cache.get(variant.key)
      if (variant.ready && raster && placement?.graphicsReady !== false && this.isUncovered(variant.rect, screen)) {
        this.nextDisplay.set(node, { ...variant.rect, key: variant.key, raster })
      }
    }
    const unique = new Map<string, Variant>()
    for (const variant of visible) {
      if (!this.cache.has(variant.key) && this.active?.key !== variant.key) unique.set(variant.key, variant)
    }
    this.pending = [...unique.values()].sort((a, b) =>
      Number(b.placement.presentation === 'preview') - Number(a.placement.presentation === 'preview'))
    this.drain()

    const erased: Displayed[] = []
    for (const [node, old] of this.displayed) {
      const next = this.nextDisplay.get(node)
      if (!next || this.dirty || old.key !== next.key || old.x !== next.x || old.y !== next.y) erased.push(old)
    }
    for (const [node, next] of this.nextDisplay) {
      const old = this.displayed.get(node)
      if (!old || this.dirty || old.key !== next.key || old.x !== next.x || old.y !== next.y ||
          erased.some(rect => overlaps(rect, next))) this.repaint.add(node)
    }
    if (erased.length === 0) return { erase: '', baseline: previous }
    const cells = previous.cells.slice()
    const baseline: Screen = { ...previous, cells, cells64: new BigInt64Array(cells.buffer), noSelect: previous.noSelect.slice() }
    let erase = ''
    for (const rect of erased) {
      clearRegion(baseline, rect.x, rect.y, rect.columns, rect.rows)
      erase += this.erase(rect)
    }
    return { erase: erase + '\x1b[H', baseline }
  }

  /** Unchanged images have zero transport cost, including unrelated text ticks. */
  paint(diff: Diff): string {
    let damage: Rect[] | null | undefined
    let draw = ''
    for (const [node, next] of this.nextDisplay) {
      if (!this.dirty && !this.repaint.has(node)) {
        if (damage === undefined) damage = this.textDamage(diff)
        if (damage !== null && !damage.some(rect => overlaps(rect, next))) continue
      }
      draw += `\x1b[${next.y + 1};${next.x + 1}H${next.raster.data}`
    }
    this.displayed = new Map(this.nextDisplay)
    this.dirty = false
    if (draw === '') return ''
    return this.displayModeSet ? `\x1b[?80l${draw}\x1b[?80h` : draw
  }

  invalidateAll(): void { this.dirty = true }

  clear(): string {
    const output = [...this.displayed.values()].map(rect => this.erase(rect)).join('')
    this.displayed.clear()
    this.nextDisplay.clear()
    this.frame.clear()
    this.desired.clear()
    this.pending = []
    return output === '' ? '' : output + '\x1b[H'
  }

  dispose(): string {
    const output = this.clear()
    this.disposed = true
    this.cache.clear()
    this.cachedBytes = 0
    this.workerReject?.(new Error('Sixel worker disposed'))
    this.workerReject = undefined
    void this.worker?.terminate()
    this.worker = undefined
    this.workerKeys.clear()
    return output
  }

  private erase(rect: Rect): string {
    const columns = Math.min(rect.columns, this.columns - rect.x)
    const rows = Math.min(rect.rows, this.rows - rect.y)
    if (columns <= 0 || rows <= 0) return ''
    let data = '\x1b[0m'
    for (let y = rect.y; y < rect.y + rows; y++) data += `\x1b[${y + 1};${rect.x + 1}H\x1b[${columns}X`
    return data
  }

  private isUncovered(rect: Rect, screen: Screen): boolean {
    for (let y = rect.y; y < rect.y + rect.rows; y++) {
      for (let x = rect.x; x < rect.x + rect.columns; x++) {
        const cell = cellAt(screen, x, y)
        if (cell && (cell.char !== ' ' || cell.styleId !== screen.emptyStyleId)) return false
      }
    }
    return true
  }

  private textDamage(diff: Diff): Rect[] | null {
    const regions: Rect[] = []
    let x = 0
    let y = 0
    for (const patch of diff) {
      if (patch.type === 'clear' || patch.type === 'clearTerminal') return null
      if (patch.type === 'cursorMove') { x += patch.x; y += patch.y }
      else if (patch.type === 'cursorTo') x = patch.col
      else if (patch.type === 'carriageReturn') x = 0
      else if (patch.type === 'stdout') {
        if (patch.content.includes('\x1b')) return null
        for (const line of patch.content.split(/(?<=\n)/u)) {
          const width = stringWidth(line.replace(/[\r\n]/gu, ''))
          if (width) regions.push({ x, y, columns: width, rows: 1 })
          x += width
          if (x > this.columns) return null
          if (line.includes('\r')) x = 0
          if (line.endsWith('\n')) { y++; x = 0 }
        }
      }
    }
    return regions
  }

  private drain(): void {
    if (this.active || this.disposed) return
    const job = this.pending.shift()
    if (!job) return
    if (!this.desired.has(job.key) || this.cache.has(job.key)) { this.drain(); return }
    this.active = job
    void (this.encoder ? this.encoder(job.request) : this.encodeInWorker(job))
      .then(raster => this.complete(job, raster), () => this.complete(job, null))
      .finally(() => { this.active = undefined; this.drain() })
  }

  private complete(job: Variant, raster: SixelRaster | null): void {
    if (this.disposed) return
    this.cachedBytes -= this.cache.get(job.key)?.data.length ?? 0
    this.cache.delete(job.key)
    this.cache.set(job.key, raster)
    this.cachedBytes += raster?.data.length ?? 0
    while (this.cache.size > SIXEL_CACHE_ENTRIES || this.cachedBytes > SIXEL_CACHE_BYTES) {
      const key = this.cache.keys().next().value!
      this.cachedBytes -= this.cache.get(key)?.data.length ?? 0
      this.cache.delete(key)
    }
    if (this.desired.has(job.key)) this.onReady()
  }

  private encodeInWorker(job: Variant): Promise<SixelRaster> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        this.workerKeys.clear()
        this.worker = new Worker(new URL('./sixel-worker.js', import.meta.url), {
          stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 256 },
        })
        const worker = this.worker
        const forget = (): void => {
          if (this.worker === worker) { this.worker = undefined; this.workerKeys.clear() }
        }
        worker.on('error', forget)
        worker.once('exit', forget)
        worker.stdout?.resume()
        worker.stderr?.resume()
      }
      const worker = this.worker
      worker.ref()
      let retried = false
      const finish = (error?: Error, raster?: SixelRaster): void => {
        clearTimeout(timeout)
        worker.removeListener('message', onMessage)
        worker.removeListener('error', onError)
        worker.removeListener('exit', onExit)
        this.workerReject = undefined
        if (error) {
          if (this.worker === worker) { this.worker = undefined; this.workerKeys.clear() }
          void worker.terminate()
          reject(error)
        } else { worker.unref(); resolve(raster!) }
      }
      const send = (includeSource: boolean): void => {
        const { source, ...request } = job.request
        const message: SixelWorkerRequest = { assetKey: job.assetKey, request }
        if (includeSource) {
          // Copy only these pixels, never detach a shared Buffer or clone its pool.
          const data = new Uint8Array(source.data)
          worker.postMessage({ ...message, request: { ...request, source: { ...source, data } } }, [data.buffer])
        } else worker.postMessage(message)
      }
      const onMessage = (message: SixelWorkerResponse): void => {
        if (message.missing && !retried) {
          retried = true
          try { send(true) } catch { finish(new Error('Sixel worker unavailable')) }
          return
        }
        const r = message.raster
        const expected = job.request.crop ?? job.request
        if (!r || r.width !== expected.width || r.height !== expected.height ||
            typeof r.data !== 'string' || r.data.length > SIXEL_MAX_ENCODED_BYTES) {
          finish(new Error('Sixel encoding failed'))
        } else {
          this.workerKeys = new Set(message.preparedKeys ?? [])
          finish(undefined, r)
        }
      }
      const onError = (error: Error): void => finish(error)
      const onExit = (): void => finish(new Error('Sixel worker exited'))
      const timeout = setTimeout(() => finish(new Error('Sixel encoding timed out')), 30_000)
      this.workerReject = onError
      worker.once('message', onMessage)
      worker.once('error', onError)
      worker.once('exit', onExit)
      try { send(!this.workerKeys.has(job.assetKey)) } catch { finish(new Error('Sixel worker unavailable')) }
    })
  }
}
