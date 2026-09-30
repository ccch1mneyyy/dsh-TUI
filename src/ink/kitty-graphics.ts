import { createHash, randomInt } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import type { DOMElement } from './dom.js'
import {
  DEFAULT_TERMINAL_CELL_SIZE,
  fitTerminalImageSource,
  normalizeTerminalCellSize,
  type TerminalCellSize,
  type TerminalImagePlacement,
  type TerminalImageSource,
} from './terminal-image.js'

const APC = '\u001b_G'
const ST = '\u001b\\'
const BASE64_CHUNK_CELLS = 4096
const ID_MIN = 0x40000000
const ID_MAX_EXCLUSIVE = 0x7fffffff
const PLACEMENT_ID_MAX_EXCLUSIVE = 0x40000000
// Keep raster content behind terminal text and explicit panel backgrounds.
const IMAGE_Z_INDEX = -0x80000000
/**
 * Retention for uploaded images that no node places this frame. Leaving the
 * viewport deletes only the placement (`d=i`), so scrolling back re-places
 * the terminal-side data with one `a=p` instead of re-fitting, re-compressing
 * and re-sending the whole raster — the protocol's intended use, and what
 * mature terminal UIs do. Dormant images are evicted least-recently-used past
 * either bound. The byte bound counts decoded RGBA (what the terminal keeps)
 * and stays a small fraction of default terminal image quotas. A terminal
 * configured with a smaller quota may still evict a dormant image, so
 * placements report failures (`q=1`): an ENOENT reply marks the image for
 * re-upload (see handleResponse).
 */
const DORMANT_MAX_IMAGES = 128
const RETAINED_MAX_BYTES = 64 * 1024 * 1024
/**
 * An ENOENT this soon after re-uploading the same image means the terminal
 * cannot keep it at all (e.g. the image exceeds its whole quota and the
 * upload was refused): stop re-uploading instead of looping.
 */
const REUPLOAD_FAILURE_WINDOW_MS = 5000

type PreparedKittyRgba = {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

type ImageState = {
  /** Replaced on every re-upload, so replies to older placements miss it. */
  imageId: number
  readonly payload: PreparedKittyRgba
  /** Decoded RGBA bytes the terminal stores for this image. */
  readonly retainedBytes: number
  /** Cell geometry the raster was fitted for; other geometries never reuse it. */
  readonly cellSize: TerminalCellSize
  uploaded: boolean
  /** Last reconcile pass that placed this image (LRU order for eviction). */
  lastUsed: number
  /** When an ENOENT last triggered a re-upload (0 = never). */
  reuploadedAt: number
  /** The terminal refused this image right after a re-upload; stop retrying. */
  abandoned: boolean
}

type PlacementState = {
  readonly placementId: number
  readonly zIndex: number
  image: ImageState
  placed: boolean
  x: number
  y: number
  columns: number
  rows: number
  /** Serialized source rectangle of the last placement ('' = whole image). */
  crop: string
}

/** Pixel rectangle of the uploaded raster to show (Kitty `x,y,w,h`). */
export type KittySourceRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface KittyGraphicsManagerOptions {
  /** Deterministic seed used by protocol tests; production chooses a random range. */
  readonly firstImageId?: number
  /** Physical pixels per cell; defaults to a conventional 8×16 cell. */
  readonly cellSize?: TerminalCellSize
  /** Clock for the re-upload failure window; protocol tests pin it. */
  readonly now?: () => number
}

/**
 * Reconcile renderer image requests with Kitty image/placement state.
 *
 * Pixel content owns an image id while each DOM node owns a placement id.
 * Equal immutable RGBA content is uploaded once and can back several nodes;
 * geometry changes replace only that node's placement without flicker. An
 * image no node places stays uploaded (dormant) within the retention budget,
 * so content that scrolls back into view is re-placed, not re-sent.
 */
export class KittyGraphicsManager {
  private readonly images = new Map<string, ImageState>()
  private readonly placements = new Map<DOMElement, PlacementState>()
  /**
   * Ids given up by a re-upload. The ENOENT that triggered it may be stale
   * (the id was re-sent in between), so the terminal can still hold data
   * under the old id; it is deleted on the next frame (or at exit).
   */
  private readonly retiredImageIds: number[] = []
  private readonly contentHashes = new WeakMap<Uint8Array, string>()
  private nextImageId: number
  private nextPlacementId = 1
  private cellSize: TerminalCellSize
  private pass = 0
  private readonly now: () => number

  constructor(options: KittyGraphicsManagerOptions = {}) {
    this.nextImageId = normalizeFirstId(
      options.firstImageId ?? randomInt(ID_MIN, ID_MAX_EXCLUSIVE),
    )
    this.cellSize = normalizeTerminalCellSize(
      options.cellSize ?? DEFAULT_TERMINAL_CELL_SIZE,
    )
    this.now = options.now ?? Date.now
  }

  /** Update the physical cell ratio used by future image variants. */
  setCellSize(cellSize: TerminalCellSize): boolean {
    const normalized = normalizeTerminalCellSize(cellSize)
    if (
      normalized.width === this.cellSize.width &&
      normalized.height === this.cellSize.height
    ) {
      return false
    }
    this.cellSize = normalized
    return true
  }

  reconcile(placements: readonly TerminalImagePlacement[]): string {
    this.pass += 1
    const desiredNodes = new Set<DOMElement>()
    const desiredImages = new Set<ImageState>()
    const desired: Array<{
      readonly placement: TerminalImagePlacement
      readonly image: ImageState
    }> = []
    const output: string[] = this.retiredImageIds.splice(0).map(deleteKittyImage)

    for (const placement of placements) {
      if (desiredNodes.has(placement.node)) continue
      desiredNodes.add(placement.node)
      const image = this.imageFor(placement)
      image.lastUsed = this.pass
      desiredImages.add(image)
      desired.push({ placement, image })
    }

    const obsoletePlacements: Array<{
      readonly image: ImageState
      readonly placementId: number
    }> = []

    for (const { placement, image } of desired) {
      let state = this.placements.get(placement.node)
      if (state === undefined) {
        const placementId = this.allocatePlacementId()
        state = {
          image,
          placementId,
          zIndex: IMAGE_Z_INDEX + placementId - 1,
          placed: false,
          x: -1,
          y: -1,
          columns: 0,
          rows: 0,
          crop: '',
        }
        this.placements.set(placement.node, state)
      }

      if (state.image !== image) {
        obsoletePlacements.push({
          image: state.image,
          placementId: state.placementId,
        })
        state.image = image
        state.placed = false
      }

      if (!image.uploaded) {
        output.push(transmitPreparedKittyRgba(image.imageId, image.payload))
        image.uploaded = true
      }

      const visible = visiblePlacement(placement, image.payload)
      const crop = visible.source === undefined
        ? ''
        : `${visible.source.x},${visible.source.y},${visible.source.width},${visible.source.height}`
      const moved =
        state.x !== visible.x ||
        state.y !== visible.y ||
        state.columns !== visible.columns ||
        state.rows !== visible.rows ||
        state.crop !== crop
      if (!state.placed || moved) {
        output.push(
          kittyPlacement(
            image.imageId,
            state.placementId,
            visible.x,
            visible.y,
            visible.columns,
            visible.rows,
            state.zIndex,
            visible.source,
          ),
        )
        state.x = visible.x
        state.y = visible.y
        state.columns = visible.columns
        state.rows = visible.rows
        state.crop = crop
        state.placed = true
      }
    }

    for (const [node, state] of this.placements) {
      if (desiredNodes.has(node)) continue
      obsoletePlacements.push({
        image: state.image,
        placementId: state.placementId,
      })
      this.placements.delete(node)
    }

    // Deleting an image's data also removes its placements, so an evicted
    // image needs no separate placement delete.
    const evicted = this.evictDormant(desiredImages)
    for (const obsolete of obsoletePlacements) {
      if (evicted.has(obsolete.image)) continue
      output.push(
        deleteKittyPlacement(
          obsolete.image.imageId,
          obsolete.placementId,
        ),
      )
    }
    for (const image of evicted) output.push(deleteKittyImage(image.imageId))

    return output.join('')
  }

  /**
   * Forget images no node placed this pass once they are unusable (fitted for
   * another cell geometry) or past the retention budget, oldest first.
   */
  private evictDormant(desiredImages: ReadonlySet<ImageState>): Set<ImageState> {
    const evicted = new Set<ImageState>()
    const dormant: Array<[string, ImageState]> = []
    let retainedBytes = 0
    for (const entry of this.images) {
      const image = entry[1]
      if (desiredImages.has(image)) {
        retainedBytes += image.retainedBytes
      } else if (
        image.cellSize.width !== this.cellSize.width ||
        image.cellSize.height !== this.cellSize.height
      ) {
        evicted.add(image)
      } else {
        retainedBytes += image.retainedBytes
        dormant.push(entry)
      }
    }
    dormant.sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    let index = 0
    while (
      index < dormant.length &&
      (dormant.length - index > DORMANT_MAX_IMAGES || retainedBytes > RETAINED_MAX_BYTES)
    ) {
      const image = dormant[index]![1]
      evicted.add(image)
      retainedBytes -= image.retainedBytes
      index += 1
    }
    for (const [key, image] of this.images) {
      if (evicted.has(image)) this.images.delete(key)
    }
    return evicted
  }

  /**
   * Handle a Kitty graphics reply the renderer did not ask for. ENOENT for
   * one of our images means the terminal evicted its data (its own quota is
   * smaller than our retention budget): upload it again and re-place every
   * node showing it on the next frame. A second ENOENT within
   * REUPLOAD_FAILURE_WINDOW_MS of that re-upload means the terminal refuses
   * the image outright, so it is left as is (never an upload loop); a new
   * content or size variant is a new image and tries again. The re-upload
   * takes a fresh image id: every placement of the old id may still answer
   * ENOENT, and those late replies must not count as the re-upload failing.
   * Returns whether a repaint is needed.
   */
  handleResponse(imageId: number, status: string): boolean {
    if (!status.startsWith('ENOENT')) return false
    let image: ImageState | undefined
    for (const candidate of this.images.values()) {
      if (candidate.imageId === imageId) image = candidate
    }
    if (image === undefined || !image.uploaded || image.abandoned) return false
    const now = this.now()
    if (image.reuploadedAt !== 0 && now - image.reuploadedAt < REUPLOAD_FAILURE_WINDOW_MS) {
      image.abandoned = true
      return false
    }
    image.reuploadedAt = now
    this.retiredImageIds.push(image.imageId)
    image.imageId = this.allocateImageId()
    image.uploaded = false
    for (const state of this.placements.values()) {
      if (state.image === image) state.placed = false
    }
    return true
  }

  /**
   * A clear/screen swap invalidated terminal-side data; resend next frame.
   * The terminal state an abandoned image was judged against is gone too, so
   * it gets a fresh ENOENT budget; one clear still buys at most one retry.
   */
  invalidateAll(): void {
    for (const image of this.images.values()) {
      image.uploaded = false
      image.abandoned = false
      image.reuploadedAt = 0
    }
    for (const state of this.placements.values()) {
      state.placed = false
    }
  }

  /** Delete every image owned by this renderer and forget their ids. */
  deleteAll(): string {
    const output = [...this.retiredImageIds.splice(0), ...[...this.images.values()].map(image => image.imageId)]
      .map(deleteKittyImage)
      .join('')
    this.images.clear()
    this.placements.clear()
    return output
  }

  private imageFor(placement: TerminalImagePlacement): ImageState {
    const digest = this.contentHash(placement.source.data)
    const key = [
      digest,
      placement.source.width,
      placement.source.height,
      placement.columns,
      placement.rows,
      this.cellSize.width,
      this.cellSize.height,
      placement.presentation,
    ].join(':')
    const existing = this.images.get(key)
    if (existing !== undefined) return existing

    const fitted = fitTerminalImageSource(
      placement.source,
      placement.columns,
      placement.rows,
      this.cellSize,
      placement.presentation,
    )
    const image: ImageState = {
      imageId: this.allocateImageId(),
      payload: prepareKittyRgba(fitted),
      retainedBytes: fitted.width * fitted.height * 4,
      cellSize: this.cellSize,
      uploaded: false,
      lastUsed: this.pass,
      reuploadedAt: 0,
      abandoned: false,
    }
    this.images.set(key, image)
    return image
  }

  private contentHash(data: Uint8Array): string {
    const existing = this.contentHashes.get(data)
    if (existing !== undefined) return existing
    const digest = createHash('sha256').update(data).digest('base64url')
    this.contentHashes.set(data, digest)
    return digest
  }

  private allocateImageId(): number {
    const id = this.nextImageId
    this.nextImageId += 1
    if (this.nextImageId >= ID_MAX_EXCLUSIVE) this.nextImageId = ID_MIN
    return id
  }

  private allocatePlacementId(): number {
    const id = this.nextPlacementId
    this.nextPlacementId += 1
    if (this.nextPlacementId >= PLACEMENT_ID_MAX_EXCLUSIVE) {
      this.nextPlacementId = 1
    }
    return id
  }
}

/**
 * The cells a placement actually occupies and, when it is clipped, the part
 * of the uploaded raster behind them. The raster has the full cell box's
 * exact physical aspect (see fitTerminalImageSource), so a cell edge maps to
 * a pixel edge proportionally; the start rounds down and the end up, so a
 * partially covered pixel row is shown rather than dropped.
 */
function visiblePlacement(
  placement: TerminalImagePlacement,
  payload: PreparedKittyRgba,
): { x: number; y: number; columns: number; rows: number; source?: KittySourceRect } {
  const clip = placement.clip
  if (
    clip === undefined ||
    (clip.x === placement.x && clip.y === placement.y &&
      clip.columns === placement.columns && clip.rows === placement.rows)
  ) {
    return { x: placement.x, y: placement.y, columns: placement.columns, rows: placement.rows }
  }
  const left = clip.x - placement.x
  const top = clip.y - placement.y
  const sourceX = Math.floor((payload.width * left) / placement.columns)
  const sourceY = Math.floor((payload.height * top) / placement.rows)
  const sourceRight = Math.min(payload.width, Math.ceil((payload.width * (left + clip.columns)) / placement.columns))
  const sourceBottom = Math.min(payload.height, Math.ceil((payload.height * (top + clip.rows)) / placement.rows))
  return {
    x: clip.x,
    y: clip.y,
    columns: clip.columns,
    rows: clip.rows,
    source: {
      x: sourceX,
      y: sourceY,
      width: Math.max(1, sourceRight - sourceX),
      height: Math.max(1, sourceBottom - sourceY),
    },
  }
}

/** Zlib-compressed direct RGBA split into protocol-compliant base64 chunks. */
export function transmitKittyRgba(
  imageId: number,
  source: TerminalImageSource,
): string {
  return transmitPreparedKittyRgba(imageId, prepareKittyRgba(source))
}

function prepareKittyRgba(source: TerminalImageSource): PreparedKittyRgba {
  return {
    data: deflateSync(source.data, { level: 1 }),
    width: source.width,
    height: source.height,
  }
}

function transmitPreparedKittyRgba(
  imageId: number,
  payload: PreparedKittyRgba,
): string {
  const encoded = Buffer.from(
    payload.data.buffer,
    payload.data.byteOffset,
    payload.data.byteLength,
  ).toString('base64')
  const chunks: string[] = []
  for (let offset = 0; offset < encoded.length; offset += BASE64_CHUNK_CELLS) {
    chunks.push(encoded.slice(offset, offset + BASE64_CHUNK_CELLS))
  }
  if (chunks.length === 0) chunks.push('')
  return chunks
    .map((chunk, index) => {
      const more = index + 1 < chunks.length ? 1 : 0
      const control =
        index === 0
          ? `a=t,t=d,f=32,s=${payload.width},v=${payload.height},i=${imageId},o=z,q=2,m=${more}`
          : `m=${more},q=2`
      return kittyCommand(control, chunk)
    })
    .join('')
}

export function kittyPlacement(
  imageId: number,
  placementId: number,
  x: number,
  y: number,
  columns: number,
  rows: number,
  zIndex = IMAGE_Z_INDEX,
  source?: KittySourceRect,
): string {
  const crop = source === undefined
    ? ''
    : `,x=${source.x},y=${source.y},w=${source.width},h=${source.height}`
  return (
    `\u001b[${y + 1};${x + 1}H` +
    kittyCommand(
      `a=p,i=${imageId},p=${placementId},c=${columns},r=${rows}${crop},z=${zIndex},C=1,q=1`,
    )
  )
}

export function deleteKittyPlacement(
  imageId: number,
  placementId: number,
): string {
  return kittyCommand(`a=d,d=i,i=${imageId},p=${placementId},q=2`)
}

export function deleteKittyImage(imageId: number): string {
  return kittyCommand(`a=d,d=I,i=${imageId},q=2`)
}

export function kittyCommand(control: string, payload = ''): string {
  return `${APC}${control};${payload}${ST}`
}

function normalizeFirstId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value >= 0xffffffff) {
    return ID_MIN
  }
  return value
}
