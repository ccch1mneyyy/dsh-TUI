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
  readonly columns: number
  readonly rows: number
  readonly palette: Record<string, Rgb | undefined>
  readonly byKey: Readonly<Record<string, DeepyAnimation>>
}

export const DEEPY_CELLS = Object.freeze({ columns: 42, rows: 15 })

const ASSET_CANDIDATES = [
  '../../../../assets/deepy/frames.json',
  '../../../assets/deepy/frames.json',
]

/** 校验即拒绝：尺寸不符 / 未知调色板字符 / 帧 dur 非正数，任一失败整份
 *  视为不可用（皮肤回退），不渲染半成品。 */
function parseKit(raw: unknown): DeepyKit | undefined {
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
  return { columns: 42, rows: 30, palette, byKey }
}

let cached: DeepyKit | undefined | null = null

/** 加载并缓存；素材缺失或校验失败返回 undefined（皮肤回退）。 */
export function loadDeepyKit(): DeepyKit | undefined {
  if (cached !== null) return cached
  for (const candidate of ASSET_CANDIDATES) {
    try {
      const url = new URL(candidate, import.meta.url)
      cached = parseKit(JSON.parse(readFileSync(url, 'utf8')))
      if (cached !== undefined) return cached
    } catch {
      // 下一个候选路径
    }
  }
  cached = undefined
  return undefined
}

/** mood → deepy 动画（素材包 README 的状态对应表）。 */
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

/** 一个动画全部帧的预渲染 ANSI 行（15 行/帧），惰性生成并缓存。 */
export function renderedDeepyAnimation(kit: DeepyKit, key: string): readonly string[][] | undefined {
  const animation = kit.byKey[key]
  if (animation === undefined) return undefined
  let rendered = renderedCache.get(key)
  if (rendered === undefined) {
    rendered = Object.freeze(animation.frames.map(frame => renderSpriteRows(frame.rows, kit.palette)))
    renderedCache.set(key, rendered)
  }
  return rendered
}

/** 测试接缝：清掉加载与渲染缓存。 */
export function resetDeepyCacheForTests(): void {
  cached = null
  renderedCache.clear()
}
