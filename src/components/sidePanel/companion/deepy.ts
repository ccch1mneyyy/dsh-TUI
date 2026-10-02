/**
 * Deepy 小鲸鱼素材包接入（assets/deepy/frames.json，非官方粉丝作品，
 * 见 assets/deepy/README.md）：20 个动画，每帧 42×30 像素字母格——
 * 与开屏鲸鱼同一套半块渲染管线（renderSpriteRows），显示为 42 列 ×
 * 15 行。
 *
 * 设计要点：
 * - 帧选择是纯函数 frameAt(animation, elapsedMs)：按帧表 dur 累加取模，
 *   不持定时器；mood 切换时 CompanionPanel 换动画并从 0 计 elapsed。
 * - 预渲染在首次使用时按动画惰性生成（RLE + erase-to-EOL 由
 *   renderSpriteRows 保证），缺素材（包未带 frames.json）时返回
 *   undefined，皮肤层回退到 WhaleSkin。
 *
 * 加载/校验/缓存抽成 loadSpriteKit（deepy 与鲸娘 assets/whaleGirl 共用，
 * 同 schema：22 动画，构建脚本 scripts/build-whale-girl-kit.mjs）。
 */
import { readFileSync } from 'node:fs'
import { renderSpriteRows } from '../../Whale.js'
import type { CompanionMood } from './mood.js'

type Rgb = readonly [number, number, number]

export interface DeepyFrame {
  readonly dur: number
  readonly rows: readonly string[]
}

export interface DeepyAnimation {
  readonly key: string
  readonly title: string
  readonly frames: readonly DeepyFrame[]
  /** 全部帧的 dur 总和（循环周期）。 */
  readonly totalMs: number
}

export interface DeepyKit {
  /** 素材包身份（'deepy' / 'whaleGirl'）：预渲染缓存按它分命名空间。 */
  readonly id: string
  readonly columns: number
  readonly rows: number
  readonly palette: Record<string, Rgb | undefined>
  readonly byKey: Readonly<Record<string, DeepyAnimation>>
}

export const DEEPY_CELLS = Object.freeze({ columns: 42, rows: 15 })

/**
 * Asset locations, tried in order. The depth differs by what is running:
 * - `src/components/sidePanel/companion/` (tsx harnesses) needs four levels;
 * - the COMPILED tree `lib/types/components/sidePanel/companion/` — what the
 *   installed package and every real session actually loads — sits one level
 *   deeper, so it needs five. Getting this wrong is silent: loadDeepyKit()
 *   falls back to the whale skin and the pet simply never shows the kit.
 */
const DEEPY_ASSET_CANDIDATES = [
  '../../../../assets/deepy/frames.json',
  '../../../assets/deepy/frames.json',
  '../../../../../assets/deepy/frames.json',
]

/** 鲸娘素材包（用户提供，见 assets/whaleGirl/README.md）：同一套层级
 *  教训——源码层 4 层 + 编译层 5 层。 */
const WHALE_GIRL_ASSET_CANDIDATES = [
  '../../../../assets/whaleGirl/frames.json',
  '../../../../../assets/whaleGirl/frames.json',
]

/** 校验即拒绝：尺寸不符 / 未知调色板字符 / 帧 dur 非正数，任一失败整份
 *  视为不可用（皮肤回退），不渲染半成品。id 是素材包身份（缓存用）。 */
function parseKit(raw: unknown, id: string): DeepyKit | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const data = raw as {
    size?: unknown
    palette?: unknown
    animations?: unknown
  }
  if (!Array.isArray(data.size) || data.size[0] !== 42 || data.size[1] !== 30) return undefined
  if (data.palette === null || typeof data.palette !== 'object') return undefined
  const palette: Record<string, Rgb | undefined> = { '.': undefined }
  for (const [key, value] of Object.entries(data.palette as Record<string, unknown>)) {
    if (key.length !== 1 || typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) return undefined
    palette[key] = [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
    ]
  }
  if (!Array.isArray(data.animations)) return undefined
  const byKey: Record<string, DeepyAnimation> = {}
  for (const animation of data.animations as { key?: unknown; title?: unknown; frames?: unknown }[]) {
    if (typeof animation.key !== 'string' || !Array.isArray(animation.frames)) return undefined
    const frames: DeepyFrame[] = []
    for (const frame of animation.frames as { dur?: unknown; rows?: unknown }[]) {
      if (typeof frame.dur !== 'number' || frame.dur <= 0 || !Array.isArray(frame.rows)) return undefined
      if (frame.rows.length !== 30) return undefined
      const rows = frame.rows as unknown[]
      for (const row of rows) {
        if (typeof row !== 'string' || row.length !== 42) return undefined
        for (const char of row) {
          if (!(char in palette)) return undefined
        }
      }
      frames.push({ dur: frame.dur, rows: rows as string[] })
    }
    byKey[animation.key] = {
      key: animation.key,
      title: typeof animation.title === 'string' ? animation.title : animation.key,
      frames,
      totalMs: frames.reduce((sum, frame) => sum + frame.dur, 0),
    }
  }
  return { id, columns: 42, rows: 30, palette, byKey }
}

/** kit 加载缓存：null = 尚未尝试；undefined = 已尝试但素材缺失/校验
 *  失败（皮肤回退）；DeepyKit = 已加载。测试可直接改写以模拟缺失。 */
export interface SpriteKitCache {
  kit: DeepyKit | undefined | null
}

export const deepyKitCache: SpriteKitCache = { kit: null }
export const whaleGirlKitCache: SpriteKitCache = { kit: null }

/** 按候选相对路径（相对本模块）依次尝试「读取 + parseKit 校验」，第一个
 *  通过校验的胜出并记入 cache；全部失败 → undefined。抽自 loadDeepyKit，
 *  deepy 与鲸娘共用。 */
export function loadSpriteKit(candidates: readonly string[], cache: SpriteKitCache, id: string): DeepyKit | undefined {
  if (cache.kit !== null) return cache.kit
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, import.meta.url)
      cache.kit = parseKit(JSON.parse(readFileSync(url, 'utf8')), id)
      if (cache.kit !== undefined) return cache.kit
    } catch {
      // 下一个候选路径
    }
  }
  cache.kit = undefined
  return undefined
}

/** 加载并缓存 deepy 素材包；素材缺失或校验失败返回 undefined（皮肤回退）。 */
export function loadDeepyKit(): DeepyKit | undefined {
  return loadSpriteKit(DEEPY_ASSET_CANDIDATES, deepyKitCache, 'deepy')
}

/** 鲸娘素材包（用户提供，assets/whaleGirl/frames.json：22 动画，与 deepy
 *  同 schema 的 42×30 字母格，构建见 scripts/build-whale-girl-kit.mjs）。 */
export function loadWhaleGirlKit(): DeepyKit | undefined {
  return loadSpriteKit(WHALE_GIRL_ASSET_CANDIDATES, whaleGirlKitCache, 'whaleGirl')
}

/** mood → deepy 动画（素材包 README 的状态对应表；显示语义经
 *  CompanionPanel 的平滑层后映射到这里）。 */
export const DEEPY_MOOD_ANIMATION: Readonly<Record<CompanionMood, string>> = {
  sleeping: 'sleeping',
  idle: 'idle',
  waiting: 'thinking',
  thinking: 'thinking',
  working: 'typing',
  responding: 'typing',
  attention: 'notification',
  celebrate: 'happy',
  error: 'error',
}

/** 并行上下文 → 动画（官方表：conducting=2+ 子代理、building=3+ 会话、
 *  music=1 子代理或 2 会话、compacting=上下文压缩）。 */
export const DEEPY_CONTEXT_ANIMATION: Readonly<Record<string, string>> = {
  music: 'music',
  conducting: 'conducting',
  building: 'building',
  compacting: 'compacting',
}

/** 互动/悬停/闪现 → 动画（官方表 reaction 档）：look=idle-look（东张西望，
 *  追踪面板内指针），notice=idle-spout（指针碰到宠物本体，开心喷水），
 *  waking=被吵醒（官方 trigger：睡眠中移动鼠标/来信号），carrying=顶箱子
 *  （gitBranch 变更闪现）。 */
export const DEEPY_INTERACTION_ANIMATION: Readonly<Record<string, string>> = {
  'poke-left': 'poke-left',
  'poke-right': 'poke-right',
  tickle: 'tickle',
  drag: 'drag',
  look: 'idle-look',
  notice: 'idle-spout',
  waking: 'waking',
  carrying: 'carrying',
}

/** 通知气泡反应 → 动画：error 色 → 出错啦；success → 任务完成；
 *  warning → 需要你确认；无色（默认档）→ idle-look。 */
export const DEEPY_NOTIFICATION_REACTION: Readonly<Record<string, string>> = {
  error: 'error',
  warning: 'notification',
  success: 'happy',
  default: 'idle-look',
}

/** idle 族的随机轮换池（官方表：空闲待机，后三个随机插播；idle-look 同时
 *  兼任悬停追踪档）。按 IDLE_ROTATE_MS 时间轮换，不跟信号边沿。 */
export const DEEPY_IDLE_ROTATION: readonly string[] = ['idle', 'idle-look', 'idle-spout', 'swim']

/** 显示语义（mood.ts 平滑层的输出）→ kit 动画键。注意 thinking/typing/
 *  notification/happy 是显示语义不是 CompanionMood——mood 表的键是
 *  waiting/thinking/working/responding/attention/celebrate，语义表必须单列。 */
export const DEEPY_SEMANTIC_ANIMATION: Readonly<Record<string, string>> = {
  thinking: 'thinking',
  typing: 'typing',
  notification: 'notification',
  error: 'error',
  happy: 'happy',
  sleeping: 'sleeping',
  idle: 'idle',
  ...DEEPY_CONTEXT_ANIMATION,
  ...DEEPY_INTERACTION_ANIMATION,
  ...DEEPY_NOTIFICATION_REACTION,
}

/** 语义 → kit 动画键的统一查找；DEEPY_IDLE_ROTATION 的成员本身就是
 *  kit 键，不需要映射。 */
export function deepyAnimationFor(semantic: string): string {
  return DEEPY_SEMANTIC_ANIMATION[semantic] ?? 'idle'
}

/** elapsed 时刻应显示第几帧（按 dur 累加取模，确定性、可单测）。 */
export function frameAt(animation: DeepyAnimation, elapsedMs: number): number {
  if (animation.frames.length === 0 || animation.totalMs <= 0) return 0
  let remainder = Math.max(0, elapsedMs) % animation.totalMs
  for (let index = 0; index < animation.frames.length; index += 1) {
    const frame = animation.frames[index]!
    if (remainder < frame.dur) return index
    remainder -= frame.dur
  }
  return animation.frames.length - 1
}

const renderedCache = new Map<string, readonly string[][]>()

/** 一个动画全部帧的预渲染 ANSI 行（15 行/帧），惰性生成并缓存。多套
 *  素材包（deepy / whaleGirl）共用本缓存：键必须带 kit.id，否则同名
 *  动画会串包（鲸娘读到 deepy 的行，调色板错乱）。 */
export function renderedDeepyAnimation(kit: DeepyKit, key: string): readonly string[][] | undefined {
  const animation = kit.byKey[key]
  if (animation === undefined) return undefined
  const cacheKey = kit.id + ':' + key
  let rendered = renderedCache.get(cacheKey)
  if (rendered === undefined) {
    rendered = Object.freeze(animation.frames.map(frame => renderSpriteRows(frame.rows, kit.palette)))
    renderedCache.set(cacheKey, rendered)
  }
  return rendered
}

/** 测试接缝：清掉加载与渲染缓存（deepy 与 whaleGirl 一起复位）。 */
export function resetDeepyCacheForTests(): void {
  deepyKitCache.kit = null
  whaleGirlKitCache.kit = null
  renderedCache.clear()
}
