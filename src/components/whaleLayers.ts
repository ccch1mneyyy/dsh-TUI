/**
 * Layered whale sprite composition, ported from the dsh-ui-whale web plugin
 * (https://github.com/lhh010/dsh-ui-whale, src/client/sprite.ts): the frame
 * set splits into the still STANDARD body plus per-action diff regions — the
 * cells any frame of an action changes relative to STANDARD. A pose composes
 * by overlaying each action's diff cells onto the cleared body, so tail wags,
 * fin flutters, hearts, sleep-Z and blinks render INDEPENDENTLY and can run
 * in parallel (a click heart plays over a mid-wag tail; a blink composes over
 * any pose) — exactly the web pet's semantics, where the old whole-frame
 * planner could only arbitrate one action at a time.
 *
 * All pixel data comes from the same source art as the web plugin
 * (whale_frames, 25x40 grids, palette D outline · B body · L belly · W mouth ·
 * H heart · Z sleep-Z · `.` transparent), so composed poses are
 * pixel-identical to it; `scripts/verify-whale-idle.mjs` pins frame parity.
 */
import { WHALE_FRAMES, WHALE_FRAME_INDEX } from './whaleFrames.js'

/** One composed whale pose, in the web plugin's WhaleFrame shape. */
export interface WhaleLayerPose {
  /** 0 = resting tail; 1..4 = TAIL_1..4. */
  readonly tail: number
  /** 0 = resting fins; 1..2 = FIN_1..2. */
  readonly fin: number
  /** 0 = none; 1..6 = SPOUT_1..6. */
  readonly spout: number
  /** 0 = none; 1..3 = HEART_1..3. */
  readonly heart: number
  /** 0 = awake; 1..5 = SLEEP_1..5 (the Z loop). */
  readonly sleep: number
  /** Eyes closed. */
  readonly blink: boolean
}

/** The resting pose every animation returns to. */
export const RESTING_POSE: WhaleLayerPose = {
  tail: 0, fin: 0, spout: 0, heart: 0, sleep: 0, blink: false,
}

type Grid = string[][]

function gridOf(frameIndex: number): Grid {
  return WHALE_FRAMES[frameIndex].rows.map(row => row.split(''))
}

/** Cells where any frame of the family differs from STANDARD. */
function diffRegion(frameIndexes: readonly number[]): ReadonlySet<string> {
  const region = new Set<string>()
  const standard = WHALE_FRAMES[WHALE_FRAME_INDEX.standard].rows
  for (const index of frameIndexes) {
    WHALE_FRAMES[index].rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        if ((row[x] ?? '.') !== (standard[y]?.[x] ?? '.')) region.add(`${x},${y}`)
      }
    })
  }
  return region
}

const F = WHALE_FRAME_INDEX
const EYES_REGION = diffRegion([F.blink])
const TAIL_REGION = diffRegion([F.tail1, F.tail2, F.tail3, F.tail4])
const FIN_REGION = diffRegion([F.fin1, F.fin2])
const SPOUT_REGION = diffRegion([F.spout1, F.spout2, F.spout3, F.spout4, F.spout5, F.spout6])
const HEART_REGION = diffRegion([F.heart1, F.heart2, F.heart3])
const SLEEP_REGION = diffRegion([F.sleep1, F.sleep2, F.sleep3, F.sleep4, F.sleep5])

/**
 * The still body: STANDARD with every motion region cleared (transparent).
 * Layers paint their own pixels back — an idle region cell stays transparent,
 * exactly like the web plugin's filtered BODY layer.
 */
const BASE: Grid = (() => {
  const grid = gridOf(F.standard)
  for (const region of [EYES_REGION, TAIL_REGION, FIN_REGION, SPOUT_REGION, HEART_REGION, SLEEP_REGION]) {
    for (const key of region) {
      const [x, y] = key.split(',').map(Number)
      grid[y][x] = '.'
    }
  }
  return grid
})()

/** Paint the family frame's cells inside the family's motion region. */
function applyLayer(grid: Grid, frameIndex: number, region: ReadonlySet<string>): void {
  const rows = WHALE_FRAMES[frameIndex].rows
  for (const key of region) {
    const [x, y] = key.split(',').map(Number)
    grid[y][x] = rows[y]?.[x] ?? '.'
  }
}

function familyFrameIndex(poseValue: number, rest: number, frames: readonly number[]): number {
  return poseValue <= 0 ? rest : frames[poseValue - 1] ?? rest
}

/**
 * Compose one pose into the full 25x40 character grid: body + eyes + tail +
 * fins + spout + heart + sleep-Z, painted in the web plugin's layer order.
 * Single-family poses compose to exactly that family's whole frame.
 */
export function composeWhaleGrid(pose: WhaleLayerPose): Grid {
  const grid = BASE.map(row => [...row])
  applyLayer(grid, pose.blink ? F.blink : F.standard, EYES_REGION)
  applyLayer(grid, familyFrameIndex(pose.tail, F.standard, [F.tail1, F.tail2, F.tail3, F.tail4]), TAIL_REGION)
  applyLayer(grid, familyFrameIndex(pose.fin, F.standard, [F.fin1, F.fin2]), FIN_REGION)
  applyLayer(grid, familyFrameIndex(pose.spout, F.standard, [F.spout1, F.spout2, F.spout3, F.spout4, F.spout5, F.spout6]), SPOUT_REGION)
  applyLayer(grid, familyFrameIndex(pose.heart, F.standard, [F.heart1, F.heart2, F.heart3]), HEART_REGION)
  applyLayer(grid, familyFrameIndex(pose.sleep, F.standard, [F.sleep1, F.sleep2, F.sleep3, F.sleep4, F.sleep5]), SLEEP_REGION)
  return grid
}

/** Stable cache key for one pose (layer indices are small integers). */
export function poseKey(pose: WhaleLayerPose): string {
  return `${pose.tail}.${pose.fin}.${pose.spout}.${pose.heart}.${pose.sleep}.${pose.blink ? 1 : 0}`
}
