/**
 * Welcome-header art modes.
 *
 * The header splash draws one of three shapes, and every shipped design is a
 * row in `WELCOME_ART_MODES` rather than a branch in `LogoV2`. Rows reference
 * shared *elements*, not copies: the four classic-wordmark poses all name the
 * same `classic` wordmark, and the R1U / R3 studies share one whale PNG
 * (`whale-glitch.png`) — only their wordmark differs.
 *
 *  - `cell`  — the 40×25 pixel-whale sprite beside a block-font wordmark
 *              (`bigfont.ts` / `wordmark.ts`), optionally frozen on one whale
 *              frame and optionally carrying the floating sleep-Z overlay.
 *  - `image` — a transparent PNG whale beside a transparent PNG wordmark,
 *              drawn through the terminal graphics protocol with the same
 *              PNGs' half-block cell art as the fallback (`welcomeImage.ts`).
 *  - `scene` — one native transparent pixel scene spanning the header block.
 *
 * The ids are the values of the `dsh-tui.welcomeArt` setting. `codename`
 * keeps each row traceable to the art study it came from
 * (`design/whale-adaptations`, `design/whale-wordmarks`).
 */
import type { WelcomeArtId } from '../tuiDisplayPrefs.js'
import type { WordmarkStyle } from './wordmark.js'

/** Whale PNG elements (`assets/welcome/whale-<id>.png`). */
export type WhaleImageId = 'isobath' | 'dots' | 'crystal' | 'glitch' | 'original'

/** Wordmark PNG elements (`assets/welcome/mark-<id>.png`). */
export type WordmarkImageId = 'isobath' | 'dots' | 'crystal' | 'glitch' | 'heavy' | 'relief'

/** Native transparent scene identifier. */
export type SceneImageId = 'rainbow'

export type { WelcomeArtId }

interface WelcomeArtBase {
  readonly id: WelcomeArtId
  /** Art-study codename (`16`, `06A+`, `R5U`, `R1U`, `R3`, `07`). */
  readonly codename?: string
  /** Label shown in `/settings` (English UI). */
  readonly label: string
  /** Chinese label for the localized `/settings` row. */
  readonly labelZh: string
  readonly hint: string
  readonly hintZh: string
}

/** Sprite-based header: block-font wordmark beside the cell-art whale. */
export interface CellWelcomeArt extends WelcomeArtBase {
  readonly art: 'cell'
  readonly wordmark: WordmarkStyle
  /**
   * Pin the settled whale to one sprite frame (`WHALE_FRAME_INDEX`). Absent
   * keeps the standard resting frame and the welcome-phase idle behaviors;
   * a pinned pose is a still, so it also suppresses those behaviors.
   */
  readonly whaleFrame?: number
}

/** PNG header: transparent whale PNG beside a transparent wordmark PNG. */
export interface ImageWelcomeArt extends WelcomeArtBase {
  readonly art: 'image'
  readonly whale: WhaleImageId
  readonly wordmark: WordmarkImageId
  /**
   * Block-font wordmark drawn when the PNG pair does not fit — a terminal
   * narrower than `IMAGE_MIN_COLUMNS`, or the whale hidden by
   * `dsh-tui.whale=false`. Defaults to `deepsleep`.
   */
  readonly cellFallback?: WordmarkStyle
}

/** Native square-pixel scene; theme controls the foreground ink only. */
export interface SceneWelcomeArt extends WelcomeArtBase {
  readonly art: 'scene'
  readonly scene: SceneImageId
}

export type WelcomeArtMode = CellWelcomeArt | ImageWelcomeArt | SceneWelcomeArt

/**
 * Columns the PNG header needs: the 40-column whale box, the 2-column gap,
 * and the 48-column wordmark. Below this the pair is not drawn at its
 * designed size, so `image` modes fall back to a block-font wordmark.
 */
export const IMAGE_MIN_COLUMNS = 92

/** Cell wordmark drawn for a mode whose PNG pair does not fit. */
export function cellFallbackOf(mode: WelcomeArtMode): WordmarkStyle {
  return mode.art === 'image' ? (mode.cellFallback ?? 'deepsleep') : 'deepsleep'
}

/**
 * The art study's own names for the poses frozen in the `cell` rows — the
 * whale frames come straight from `WHALE_FRAME_INDEX`:
 * `spout3` is the widest point of the water-column bloom, `heart3` the fully
 * grown heart, and `sleep5` the Z trail at its highest.
 */
const POSE_SPOUT = 6
const POSE_HEART = 16
const POSE_SLEEP = 21

/**
 * Every mode, in `/settings` order. The default is `classic`; other artwork is opt-in through the existing settings panel.
 */
export const WELCOME_ART_MODES: readonly WelcomeArtMode[] = [
  {
    id: 'classic',
    art: 'cell', wordmark: 'classic',
    label: 'Classic header', labelZh: '原版 · 标准姿态',
    hint: 'The shipped block-font DEEPSEEK / HARNESS wordmark beside the resting whale.',
    hintZh: '原有的 DEEPSEEK / HARNESS 块字字标，配鲸鱼标准静止姿态。',
  },
  {
    id: 'spout',
    art: 'cell', wordmark: 'classic', whaleFrame: POSE_SPOUT,
    label: 'Classic header · water spout', labelZh: '喷水',
    hint: 'The same classic wordmark with the whale frozen at the spout bloom.',
    hintZh: '同一套经典字标，鲸鱼定格在水柱展开最宽的一帧。',
  },
  {
    id: 'heart',
    art: 'cell', wordmark: 'classic', whaleFrame: POSE_HEART,
    label: 'Classic header · heart', labelZh: '爱心',
    hint: 'The same classic wordmark with the whale frozen at the grown heart.',
    hintZh: '同一套经典字标，鲸鱼定格在爱心长到最大的一帧。',
  },
  {
    id: 'sleep',
    art: 'cell', wordmark: 'classic', whaleFrame: POSE_SLEEP,
    label: 'Classic header · dozing', labelZh: '睡觉',
    hint: 'The same classic wordmark with the whale frozen at the highest sleep-Z.',
    hintZh: '同一套经典字标，鲸鱼定格在 Z 飘得最高的一帧。',
  },
  {
    id: 'deepsleep',
    art: 'cell', wordmark: 'deepsleep',
    label: 'DEEP SLEEP wordmark', labelZh: '睡眠字形 DEEP SLEEP',
    hint: 'DEEPS + narrow LEEP + HARNESS on one column, with the floating sleep-Z.',
    hintZh: 'DEEPS + 窄体 LEEP + 等宽 HARNESS，上方飘 Z。',
  },
  {
    id: 'rainbow',
    art: 'scene', scene: 'rainbow',
    codename: '彩虹鲸鱼 × DSH',
    label: 'Rainbow whale × DSH', labelZh: '彩虹鲸鱼 × DSH',
    hint: 'Native square pixels: whale, rainbow and outlined DSH on the terminal background.',
    hintZh: '原生像素鲸鱼、彩虹与空心 DSH，透明区域使用终端底色。',
  },
  {
    id: 'isobath',
    art: 'image', whale: 'isobath', wordmark: 'isobath',
    codename: '16',
    label: '16 · ISOBATH', labelZh: '16 · 等深',
    hint: 'Contour-line DSH wordmark with the isobath whale.',
    hintZh: '线条版 DSH 字标 + 等深轮廓鲸鱼。',
  },
  {
    id: 'dots',
    art: 'image', whale: 'dots', wordmark: 'dots',
    codename: '06A+',
    label: '06A+ · Dot matrix', labelZh: '06A+ · 加密点阵',
    hint: 'DEEPSEEK / HARNESS in a blue dot matrix with the same dot-drawn whale.',
    hintZh: '蓝色圆点阵的 DEEPSEEK / HARNESS，配同款点阵鲸鱼。',
  },
  {
    id: 'crystal',
    art: 'image', whale: 'crystal', wordmark: 'crystal',
    codename: 'R5U',
    label: 'R5U · Crystal facets', labelZh: 'R5U · 晶体切面',
    hint: 'Faceted DSH wordmark and whale at a matched visual scale.',
    hintZh: '切面 DSH 字标，鲸鱼切面已放大到相近视觉尺度。',
  },
  {
    id: 'glitch',
    art: 'image', whale: 'glitch', wordmark: 'glitch',
    codename: 'R1U',
    label: 'R1U · Signal glitch', labelZh: 'R1U · 信号故障',
    hint: 'Glitched DSH wordmark and whale with scanlines and white flecks.',
    hintZh: '错位 + 扫描线 + 白色闪片的 DSH 字标与鲸鱼。',
  },
  {
    id: 'heavy',
    art: 'image', whale: 'glitch', wordmark: 'heavy',
    codename: 'R3',
    label: 'R3 · Heavy glitch', labelZh: 'R3 · 强烈故障',
    hint: 'Full DEEPSEEK / HARNESS title in the heaviest glitch treatment, on the R1U whale.',
    hintZh: '完整标题的最强故障版；鲸鱼与 R1U 共用同一张 PNG。',
  },
  {
    id: 'relief',
    art: 'image', whale: 'original', wordmark: 'relief',
    codename: '07',
    label: '07 · Pixel relief DSH', labelZh: '07 · 浮雕像素 DSH',
    hint: 'Pixel-grid DSH in relief, drawn at the whale art’s own grid; keeps the original whale.',
    hintZh: '与鲸鱼同一套格点绘制的浮雕 DSH；鲸鱼沿用原版。',
  },
]

/** Every mode id, in `/settings` order (schema/picker source of truth). */
export const WELCOME_ART_IDS: readonly WelcomeArtId[] =
  WELCOME_ART_MODES.map(mode => mode.id)

/** The mode the header ships with (see `WELCOME_ART_MODES`). */
export const DEFAULT_WELCOME_ART: WelcomeArtId = 'classic'

/** Narrow a possibly-foreign settings value to a known mode id. */
export function isWelcomeArtId(value: unknown): value is WelcomeArtId {
  return typeof value === 'string' && (WELCOME_ART_IDS as readonly string[]).includes(value)
}

/** Resolve an id to its registry row, falling back to the shipped default. */
export function welcomeArtMode(id: WelcomeArtId): WelcomeArtMode {
  return WELCOME_ART_MODES.find(mode => mode.id === id)
    ?? WELCOME_ART_MODES.find(mode => mode.id === DEFAULT_WELCOME_ART)!
}
