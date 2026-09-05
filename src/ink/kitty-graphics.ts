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

type PreparedKittyRgba = {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

type ImageState = {
  readonly imageId: number
  readonly payload: PreparedKittyRgba
  uploaded: boolean
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
}

export interface KittyGraphicsManagerOptions {
  /** Deterministic seed used by protocol tests; production chooses a random range. */
  readonly firstImageId?: number
  /** Physical pixels per cell; defaults to a conventional 8×16 cell. */
  readonly cellSize?: TerminalCellSize
}

/**
 * Reconcile renderer image requests with Kitty image/placement state.
 *
 * Pixel content owns an image id while each DOM node owns a placement id.
 * Equal immutable RGBA content is uploaded once and can back several nodes;
 * geometry changes replace only that node's placement without flicker.
 */
export class KittyGraphicsManager {
  private readonly images = new Map<string, ImageState>()
  private readonly placements = new Map<DOMElement, PlacementState>()
  private readonly contentHashes = new WeakMap<Uint8Array, string>()
  private nextImageId: number
  private nextPlacementId = 1
  private cellSize: TerminalCellSize

  constructor(options: KittyGraphicsManagerOptions = {}) {
    this.nextImageId = normalizeFirstId(
      options.firstImageId ?? randomInt(ID_MIN, ID_MAX_EXCLUSIVE),
    )
    this.cellSize = normalizeTerminalCellSize(
      options.cellSize ?? DEFAULT_TERMINAL_CELL_SIZE,
    )
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
    const desiredNodes = new Set<DOMElement>()
    const desiredImages = new Set<ImageState>()
    const desired: Array<{
      readonly placement: TerminalImagePlacement
      readonly image: ImageState
    }> = []
    const output: string[] = []

    for (const placement of placements) {
      if (desiredNodes.has(placement.node)) continue
      desiredNodes.add(placement.node)
      const image = this.imageFor(placement)
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

      const moved =
        state.x !== placement.x ||
        state.y !== placement.y ||
        state.columns !== placement.columns ||
        state.rows !== placement.rows
      if (!state.placed || moved) {
        output.push(
          kittyPlacement(
            image.imageId,
            state.placementId,
            placement.x,
            placement.y,
            placement.columns,
            placement.rows,
            state.zIndex,
          ),
        )
        state.x = placement.x
        state.y = placement.y
        state.columns = placement.columns
        state.rows = placement.rows
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

    for (const obsolete of obsoletePlacements) {
      if (!desiredImages.has(obsolete.image)) continue
      output.push(
        deleteKittyPlacement(
          obsolete.image.imageId,
          obsolete.placementId,
        ),
      )
    }

    for (const [key, image] of this.images) {
      if (desiredImages.has(image)) continue
      output.push(deleteKittyImage(image.imageId))
      this.images.delete(key)
    }

    return output.join('')
  }

  /** A clear/screen swap invalidated terminal-side data; resend next frame. */
  invalidateAll(): void {
    for (const image of this.images.values()) image.uploaded = false
    for (const state of this.placements.values()) {
      state.placed = false
    }
  }

  /** Delete every image owned by this renderer and forget their ids. */
  deleteAll(): string {
    const output = [...this.images.values()]
      .map(image => deleteKittyImage(image.imageId))
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
    ].join(':')
    const existing = this.images.get(key)
    if (existing !== undefined) return existing

    const fitted = fitTerminalImageSource(
      placement.source,
      placement.columns,
      placement.rows,
      this.cellSize,
    )
    const image: ImageState = {
      imageId: this.allocateImageId(),
      payload: prepareKittyRgba(fitted),
      uploaded: false,
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
): string {
  return (
    `\u001b[${y + 1};${x + 1}H` +
    kittyCommand(
      `a=p,i=${imageId},p=${placementId},c=${columns},r=${rows},z=${zIndex},C=1,q=2`,
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
