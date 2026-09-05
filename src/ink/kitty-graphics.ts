import { randomInt } from 'node:crypto'
import type { DOMElement } from './dom.js'
import type {
  TerminalImagePlacement,
  TerminalImageSource,
} from './terminal-image.js'

const APC = '\u001b_G'
const ST = '\u001b\\'
const BASE64_CHUNK_CELLS = 4096
const ID_MIN = 0x40000000
const ID_MAX_EXCLUSIVE = 0x7fffffff
// Keep raster content behind terminal text and explicit panel backgrounds.
const IMAGE_Z_INDEX = -0x80000000

type PlacementState = {
  readonly imageId: number
  readonly placementId: number
  source: TerminalImageSource | undefined
  uploaded: boolean
  placed: boolean
  x: number
  y: number
  columns: number
  rows: number
}

export interface KittyGraphicsManagerOptions {
  /** Deterministic seed used by protocol tests; production chooses a random range. */
  readonly firstImageId?: number
}

/**
 * Reconcile renderer image requests with Kitty image/placement state.
 *
 * One DOM node owns one image id and one placement id. Pixel changes replace
 * that image, geometry changes replace the placement without flicker, and
 * removed nodes release both placement and image data.
 */
export class KittyGraphicsManager {
  private readonly states = new Map<DOMElement, PlacementState>()
  private nextImageId: number

  constructor(options: KittyGraphicsManagerOptions = {}) {
    this.nextImageId = normalizeFirstId(
      options.firstImageId ?? randomInt(ID_MIN, ID_MAX_EXCLUSIVE),
    )
  }

  reconcile(placements: readonly TerminalImagePlacement[]): string {
    const desired = new Set<DOMElement>()
    const output: string[] = []

    for (const placement of placements) {
      if (desired.has(placement.node)) continue
      desired.add(placement.node)
      let state = this.states.get(placement.node)
      if (state === undefined) {
        state = {
          imageId: this.allocateImageId(),
          placementId: 1,
          source: undefined,
          uploaded: false,
          placed: false,
          x: -1,
          y: -1,
          columns: 0,
          rows: 0,
        }
        this.states.set(placement.node, state)
      }

      if (
        state.source?.data !== placement.source.data ||
        state.source?.width !== placement.source.width ||
        state.source?.height !== placement.source.height
      ) {
        state.source = placement.source
        state.uploaded = false
        state.placed = false
      }

      if (!state.uploaded) {
        output.push(transmitKittyRgba(state.imageId, placement.source))
        state.uploaded = true
      }

      const moved =
        state.x !== placement.x ||
        state.y !== placement.y ||
        state.columns !== placement.columns ||
        state.rows !== placement.rows
      if (!state.placed || moved) {
        output.push(
          kittyPlacement(
            state.imageId,
            state.placementId,
            placement.x,
            placement.y,
            placement.columns,
            placement.rows,
          ),
        )
        state.x = placement.x
        state.y = placement.y
        state.columns = placement.columns
        state.rows = placement.rows
        state.placed = true
      }
    }

    for (const [node, state] of this.states) {
      if (desired.has(node)) continue
      output.push(deleteKittyImage(state.imageId))
      this.states.delete(node)
    }

    return output.join('')
  }

  /** A clear/screen swap invalidated terminal-side data; resend next frame. */
  invalidateAll(): void {
    for (const state of this.states.values()) {
      state.uploaded = false
      state.placed = false
    }
  }

  /** Forget terminal-side state after leaving the buffer that owned it. */
  reset(): void {
    this.states.clear()
  }

  /** Delete every image owned by this renderer and forget their ids. */
  deleteAll(): string {
    const output = [...this.states.values()]
      .map(state => deleteKittyImage(state.imageId))
      .join('')
    this.states.clear()
    return output
  }

  private allocateImageId(): number {
    const id = this.nextImageId
    this.nextImageId += 1
    if (this.nextImageId >= ID_MAX_EXCLUSIVE) this.nextImageId = ID_MIN
    return id
  }
}

/** Direct RGBA transmission split into protocol-compliant base64 chunks. */
export function transmitKittyRgba(
  imageId: number,
  source: TerminalImageSource,
): string {
  const encoded = Buffer.from(
    source.data.buffer,
    source.data.byteOffset,
    source.data.byteLength,
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
          ? `a=t,t=d,f=32,s=${source.width},v=${source.height},i=${imageId},q=2,m=${more}`
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
): string {
  return (
    `\u001b[${y + 1};${x + 1}H` +
    kittyCommand(
      `a=p,i=${imageId},p=${placementId},c=${columns},r=${rows},z=${IMAGE_Z_INDEX},C=1,q=2`,
    )
  )
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
