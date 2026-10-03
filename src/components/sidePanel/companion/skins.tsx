/**
 * Companion 皮肤接口与注册表（设计分文档 §3 + v2.1）：皮肤拿到的是
 * CompanionPose（多层语义 + nativeWhalePose）与渲染上下文；皮肤只实现
 * 自己理解的语义子集，未支持的姿态退化而不是报错。
 *
 * 用户的 deepy 是默认皮肤（DEEPY_MOOD_ANIMATION 逐心情整段动画）；
 * WhaleGirlSkin 用用户提供的鲸娘素材包（assets/whaleGirl，映射表与 deepy
 * 同源，仅 smile-hearts / thumbs-up 两键独有）；WhaleSkin 复用开屏分层
 * 规划器的 nativeWhalePose（与 splash 帧级一致）。
 * 插件皮肤（纯数据帧表，分文档 §6）留到 Phase 7，注册表先把接缝定好：
 * 皮肤 = id + cells + render(pose, ctx)，自定义皮肤走同一接口进入。
 */
import React from 'react'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Box, Text, Image, useTerminalImages, useTerminalImageProtocol, useTerminalImageCellSize } from '../../../ui.js'
import { WhaleArt, renderSpriteRows } from '../../Whale.js'
import type { I18nKey } from '../../../i18n.js'
import type { TerminalImageSource } from '../../../ink/terminal-image.js'
import type { DOMElement } from '../../../ink/dom.js'
import { loadSharp } from '../../../dsh-adapter/sharp.js'
import {
  DEEPY_CELLS,
  DEEPY_MOOD_ANIMATION,
  DEEPY_SEMANTIC_ANIMATION,
  frameAt,
  loadDeepyKit,
  loadWhaleGirlKit,
  renderedDeepyAnimation,
} from './deepy.js'
import type { CompanionMood } from './mood.js'
import type { CompanionPose } from './pose.js'

export interface CompanionSkinRenderInput {
  readonly pose: CompanionPose
  /** 当前心情进入的时刻（动画从 0 计 elapsed 的起点）。 */
  readonly moodSince: number
  readonly now: number
  /** 可用宽度（皮肤永不超宽：宽度不足由 Panel 决定用不用 small）。 */
  readonly width: number
  /** 当前应播的动画键——CompanionPanel 的平滑层+互动层裁决结果，取
   *  deepy 规范键词汇表（即素材包 20 键：'typing' / 'poke-left' /
   *  'tickle' / 'idle-look' / 'notification' …），任何皮肤都能对互动
   *  做反应；互动覆盖期间 moodSince = 覆盖开始时刻（elapsed 从头播）。
   *  旧调用方（缺省）皮肤退回 pose.mood 分层，属皮肤接口「未支持即
   *  退化」契约。 */
  readonly animationSemantic?: string
}

export interface CompanionSkin {
  readonly id: string
  readonly titleKey?: I18nKey
  readonly title?: string
  /** 固定占位（列×行），永不随帧变化（§16.6 列宽不变硬约束）。 */
  readonly cells: { readonly columns: number; readonly rows: number }
  readonly graphics: 'none' | 'optional' | 'required'
  /** 本皮肤对 animationSemantic（deepy 规范键）的声明式落点表：规范键
   *  → 自家动画键；未列出的键同名直通（自家 kit 键集相同即可）。皮肤
   *  解析不出落点（semanticMap 缺 + 自家 kit 也没有同名键）→ 退回 mood
   *  层（pose.mood/pose.heart），不报错。像素鲸这类无帧表皮肤不声明，
   *  维持原样忽略。 */
  readonly semanticMap?: Readonly<Record<string, string>>
  render(input: CompanionSkinRenderInput): React.ReactNode
}

/** deepy 小鲸鱼（默认）：语义/心情 → 动画，elapsed → frameAt 确定性选帧。 */
export const DeepySkin: CompanionSkin = {
  id: 'deepy',
  title: 'Deepy',
  cells: DEEPY_CELLS,
  graphics: 'none',
  render(input) {
    const { pose, moodSince, now, animationSemantic } = input
    const kit = loadDeepyKit()
    if (kit === undefined) return WhaleSkin.render({ pose, moodSince, now, width: DEEPY_CELLS.columns, animationSemantic })
    // animationSemantic 已是 deepy 规范键；无效（皮肤词汇表外）才回 mood 层。
    const animationKey = animationSemantic !== undefined && kit.byKey[animationSemantic] !== undefined
      ? animationSemantic
      : DEEPY_MOOD_ANIMATION[pose.mood] ?? 'idle'
    const rendered = renderedDeepyAnimation(kit, animationKey)
    const animation = kit.byKey[animationKey]
    if (rendered === undefined || animation === undefined) return null
    const frameIndex = frameAt(animation, now - moodSince)
    const rows = rendered[frameIndex] ?? rendered[0] ?? []
    return (
      <Box flexDirection="column" flexShrink={0} width={DEEPY_CELLS.columns}>
        {rows.map((row, index) => (
          <Text key={index} wrap="truncate-end">{row}</Text>
        ))}
      </Box>
    )
  },
}

/** 图像轨的盒宽契约（2026-10 拖动空气墙修复）：cells.columns = 8×16 像
 * 件下图像的实际列宽（31）——面板 clamp/点击半区/§16.6 列宽预算全都吃这
 * 个常量，盒贴边即图贴边。其他像元比下图宽漂移（宽 = 15 × cellRatio ×
 * 帧比），钳在本常量内（contain 收行不裁剪），残隙 ≤2 格（常见像元比带
 * 1.75–2.13 内精确或差 1–2 格；字母轨 42 宽帧串的本体 ~21–25 格也装得下，
 * 两侧透明衬垫溢出盒外不可见）。字母轨的 8–11 格固有边距需另产裁边素材
 * 才能治，本轮留档不做。 */
const WHALE_GIRL_CELLS = Object.freeze({ columns: 31, rows: 15 })

/** 图像轨单元格盒列数：15 行预算 × 像元比 × 帧宽高比，钳在 cells.columns
 * （超出时调用方按 contain 收行）。导出供回归锁「cells 常量 == 常见像元比
 * 下的实际图宽」（空气墙契约：盒宽=图宽）。 */
export function whaleGirlImageBoxColumns(
  cell: { readonly width: number; readonly height: number },
  frameRatio: number,
): number {
  const cellRatio = cell.height / cell.width
  return Math.max(1, Math.min(WHALE_GIRL_CELLS.columns, Math.round(cellRatio * WHALE_GIRL_CELLS.rows * frameRatio)))
}

/** 鲸娘心情表：deepy 表同名直通，只有 celebrate 换成鲸娘独有的
 *  thumbs-up（happy/庆祝，success 通知反应同源）。 */
const WHALE_GIRL_MOOD_ANIMATION: Readonly<Record<CompanionMood, string>> = {
  ...DEEPY_MOOD_ANIMATION,
  celebrate: 'thumbs-up',
}

/** 鲸娘语义表：deepy 的语义/上下文/互动/通知反应表 key 同名直通，仅
 *  notice（悬停本体）→ smile-hearts、happy（庆祝）→ thumbs-up 两处覆盖。
 *  回归用它做全语义覆盖检查；运行时 CompanionPanel 把裁决出的
 *  animationSemantic 交给每个皮肤的 render（WhaleGirlSkin.semanticMap
 *  即本表），互动/通知反应因此同样能到非 deepy 皮肤。 */
export const WHALE_GIRL_SEMANTIC_ANIMATION: Readonly<Record<string, string>> = {
  ...DEEPY_SEMANTIC_ANIMATION,
  notice: 'smile-hearts',
  happy: 'thumbs-up',
}

/** pose → 鲸娘动画键（纯函数，回归直接测）：亲昵互动（爱心 pass，
 *  CompanionPanel 在点击宠物 / Enter 戳一戳时 arm）优先于心情。 */
export function whaleGirlAnimationKey(mood: CompanionMood, heart: number): string {
  if (heart > 0) return 'smile-hearts'
  return WHALE_GIRL_MOOD_ANIMATION[mood] ?? 'idle'
}

/** 鲸娘（用户提供的表情包，assets/whaleGirl/frames.json）：渲染路径照
 *  DeepySkin（kit → 动画 → frameAt 选帧 → 半块行）。动画键优先级：
 *  animationSemantic（互动/通知反应层，经 semanticMap 落点）> 爱心 pass
 *  > 心情层（whaleGirlAnimationKey 原契约不变）；缺 kit / 缺帧回退
 *  DeepySkin.render（再缺则由它落到 WhaleSkin）。 */
/** 鲸娘对 deepy 规范键的落点：只声明两处覆盖（悬停碰本体 deepy 会喷水，
 *  鲸娘换成 smile-hearts；庆祝 happy → 独有 thumbs-up），其余 18 键与
  deepy 同名直通（鲸娘 kit 键集同源）。semantic 空间的完整覆盖表见
  WHALE_GIRL_SEMANTIC_ANIMATION（回归用）。 */
const WHALE_GIRL_KEY_ANIMATION: Readonly<Record<string, string>> = {
  'idle-spout': 'smile-hearts',
  'happy': 'thumbs-up',
}

/** 鲸娘动画键裁决（字母格与图像两条路径同一语义）：semanticMap 落点
 *  > 爱心 pass > 心情层（whaleGirlAnimationKey 原契约不变）；落点在
 *  「本路径的素材包」里不存在时退心情层，不报错。 */
function resolveWhaleGirlAnimationKey(
  pose: CompanionPose,
  animationSemantic: string | undefined,
  hasKey: (key: string) => boolean,
): string {
  const semanticKey = animationSemantic !== undefined
    ? WHALE_GIRL_KEY_ANIMATION[animationSemantic] ?? animationSemantic
    : undefined
  if (semanticKey !== undefined && hasKey(semanticKey)) return semanticKey
  return whaleGirlAnimationKey(pose.mood, pose.heart)
}

/** 字母轨开窗（2026-10 空气墙修复配套）：42 格帧串的全部美术落在
 * [5,35] 共 31 列（实测 267 帧，两侧是构建 contain 的透明衬垫 '.'）——
 * 与图像轨 31 列盒同宽。开窗后字母轨也装进 cells.columns，盒贴边即
 * （最宽姿势的）美术贴边；各姿势自身更窄的边距是美术固有，同 deepy。
 * 回归锁「全部帧内容 ⊆ [5, 5+31)」防素材更新后悄悄越窗被截。 */
const WHALE_GIRL_LETTER_WINDOW_START = 5

const whaleGirlWindowCache = new Map<string, readonly string[][]>()

function renderedWhaleGirlWindowRows(kit: Parameters<typeof renderedDeepyAnimation>[0], key: string): readonly string[][] | undefined {
  const animation = kit.byKey[key]
  if (animation === undefined) return undefined
  const cacheKey = kit.id + ':window:' + key
  let rendered = whaleGirlWindowCache.get(cacheKey)
  if (rendered === undefined) {
    rendered = Object.freeze(animation.frames.map(frame =>
      renderSpriteRows(
        frame.rows.map(row => row.slice(WHALE_GIRL_LETTER_WINDOW_START, WHALE_GIRL_LETTER_WINDOW_START + WHALE_GIRL_CELLS.columns)),
        kit.palette,
      ),
    ))
    whaleGirlWindowCache.set(cacheKey, rendered)
  }
  return rendered
}

/** 鲸娘字母格渲染（31 列开窗半块路径，供两条渲染路径复用）：
 *  缺 kit / 缺预渲染 → DeepySkin.render（再缺由它落到 WhaleSkin）。 */
function renderWhaleGirlLetterGrid(input: CompanionSkinRenderInput): React.ReactNode {
  const { pose, moodSince, now, animationSemantic } = input
  const kit = loadWhaleGirlKit()
  if (kit === undefined) return DeepySkin.render({ ...input, width: WHALE_GIRL_CELLS.columns })
  const animationKey = resolveWhaleGirlAnimationKey(pose, animationSemantic, key => kit.byKey[key] !== undefined)
  const rendered = renderedWhaleGirlWindowRows(kit, animationKey)
  const animation = kit.byKey[animationKey]
  if (rendered === undefined || animation === undefined) {
    return DeepySkin.render({ ...input, width: WHALE_GIRL_CELLS.columns })
  }
  const frameIndex = frameAt(animation, now - moodSince)
  const rows = rendered[frameIndex] ?? rendered[0] ?? []
  return (
    <Box flexDirection="column" flexShrink={0} width={WHALE_GIRL_CELLS.columns}>
      {rows.map((row, index) => (
        <Text key={index} wrap="truncate-end">{row}</Text>
      ))}
    </Box>
  )
}

export const WhaleGirlSkin: CompanionSkin = {
  id: 'whaleGirl',
  title: '鲸娘',
  cells: WHALE_GIRL_CELLS,
  /** optional：有终端图像协议（kitty/sixel）时用原生像素帧，无协议退
   *  字母格（renderWhaleGirlLetterGrid，老路径原样保留）。 */
  graphics: 'optional',
  semanticMap: WHALE_GIRL_KEY_ANIMATION,
  render(input) {
    // kit 缺失的回退必须发生在 render() 本体（同步），老回归契约如此。
    if (loadWhaleGirlKit() === undefined) return DeepySkin.render({ ...input, width: WHALE_GIRL_CELLS.columns })
    // render 是普通函数，hooks 落在真正的组件里（无协议环境 mount 后
    // 立即退回字母格，行为与旧版逐字节一致）。
    return <WhaleGirlImageSkin {...input} />
  },
}

// ==================== 鲸娘 · 图像协议渲染层 =================================
//
// 素材：assets/whaleGirl/img/<key>/<两位帧号>.png（默认 288px 高、等比定宽、
// **保留真实 alpha**——构建期不做阈值/收缩，2026-10-02 返场改版，见
// scripts/build-whale-girl-images.mjs）+ timings.json（key -> [{ dur, file }]，
// 267 帧全保留，dur 沿用 GIF delay）。
//
// 分层：
// - WhaleGirlImageSkin：协议裁决（useTerminalImageProtocol）——无 kitty/
//   sixel 直接退字母格（现有 42×15 半块路径）；
// - WhaleGirlRasterSkin：timings 选帧（dur 累加取模，与 frameAt 同语义）
//   + 惰性解码（只解当前动画，PNG→RGBA 走 sharp，进程内 LRU 缓存；
//   解码窗口【持帧】——保持上一帧画面直到新帧就绪，字母格只在冷启动
//   （会话内从未成功上过图像）兜底；常用互动键可见后预热，2026-10-03
//   抽搐修复：互动换键不得闪回字母格/旧渲染）；
// - 尺寸：15 行预算 + 帧宽高比 + useTerminalImageCellSize() 真实像元，
//   宽度钳在 42 列（§16.6 列宽不变），16px 像元下正好 1:1 像素显示；
// - presentation='transcript'：唯一非模态且 opt-in Sixel 的档位——宠物
//   是面板里的常驻位（固定不滚区），归 transcript 生命周期；'preview'
//   是模态卡片专属（更大字节预算 + 编码优先级），不能占。
// - transparent：sixel 编码期把 coverage 提升为硬掩码（中间 alpha 由
//   渲染层做 2×2 Bayer 有序抖动——软边），kitty 侧全保真半透明；素材
//   保留 0-255 渐变 alpha，两个协议都拿到平滑抗锯齿边缘。

interface WhaleGirlImageTiming {
  readonly dur: number
  readonly file: string
}

interface WhaleGirlImageAnimation {
  readonly key: string
  readonly frames: readonly WhaleGirlImageTiming[]
  /** 全部帧 dur 总和（循环周期）。 */
  readonly totalMs: number
}

interface WhaleGirlImageKit {
  /** img/ 目录的绝对路径（帧 PNG 解码用）。 */
  readonly dir: string
  readonly byKey: Readonly<Record<string, WhaleGirlImageAnimation>>
}

/** 与 deepy.ts 同一套层级教训：源码层 4 层 + 编译层（lib/types）5 层。 */
const WHALE_GIRL_IMG_DIR_CANDIDATES = [
  '../../../../assets/whaleGirl/img',
  '../../../../../assets/whaleGirl/img',
]

let whaleGirlImageKitCache: WhaleGirlImageKit | undefined | null

/** 校验即拒绝（同 loadSpriteKit 契约）：timings.json 形状不对 → 整份
 *  视为不可用，图像路径整体退字母格，不渲染半成品。 */
function parseWhaleGirlImageKit(raw: unknown, dir: string): WhaleGirlImageKit | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const byKey: Record<string, WhaleGirlImageAnimation> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length === 0) return undefined
    const frames: WhaleGirlImageTiming[] = []
    for (const entry of value as { dur?: unknown; file?: unknown }[]) {
      if (typeof entry?.dur !== 'number' || !(entry.dur > 0)) return undefined
      if (typeof entry.file !== 'string' || !/^[0-9]{2}\.png$/.test(entry.file)) return undefined
      frames.push({ dur: entry.dur, file: entry.file })
    }
    byKey[key] = { key, frames, totalMs: frames.reduce((sum, frame) => sum + frame.dur, 0) }
  }
  return { dir, byKey }
}

/** 惰性加载 + 缓存图像 timings；缺失/校验失败返回 undefined（退字母格）。 */
export function loadWhaleGirlImageKit(): WhaleGirlImageKit | undefined {
  if (whaleGirlImageKitCache !== undefined) return whaleGirlImageKitCache ?? undefined
  for (const candidate of WHALE_GIRL_IMG_DIR_CANDIDATES) {
    try {
      const dir = fileURLToPath(new URL(candidate, import.meta.url))
      if (!existsSync(join(dir, 'timings.json'))) continue
      const kit = parseWhaleGirlImageKit(JSON.parse(readFileSync(join(dir, 'timings.json'), 'utf8')), dir)
      if (kit !== undefined) {
        whaleGirlImageKitCache = kit
        return kit
      }
    } catch {
      // 下一个候选路径
    }
  }
  whaleGirlImageKitCache = null
  return undefined
}

/** elapsed 时刻应显示第几帧：dur 累加取模，与 deepy.frameAt 同语义
 *  （确定性、可单测；回归里与 frameAt 逐 elapsed 比对）。 */
export function whaleGirlImageFrameIndexAt(animation: WhaleGirlImageAnimation, elapsedMs: number): number {
  if (animation.frames.length === 0 || animation.totalMs <= 0) return 0
  let remainder = Math.max(0, elapsedMs) % animation.totalMs
  for (let index = 0; index < animation.frames.length; index += 1) {
    const frame = animation.frames[index]!
    if (remainder < frame.dur) return index
    remainder -= frame.dur
  }
  return animation.frames.length - 1
}

/** 已解码动画的 LRU（Map 迭代序 = 最近使用序）；失败集合防止坏动画
 *  每帧重试。字节上限防 267 帧全量常驻（全解约 92.6MB RGBA）。
 *  R5-1：迭代序由「已提交使用路径」的 touchDecodedAnimation 维护（缓存
 *  命中不再只是 get）；写入/驱逐发布 revision，消费者经
 *  useSyncExternalStore 订阅，把「key 未变但缓存失去」变成解码 effect
 *  的显式输入——被逐出的活跃键能按需恢复解码，而不是永久冻结。 */
const decodedImageAnimations = new Map<string, readonly TerminalImageSource[]>()
const failedImageAnimations = new Set<string>()
let decodedImageBytes = 0
const DECODED_IMAGE_BYTES_CAP = 32 * 1024 * 1024

/** 缓存写入/驱逐的版本号（R5-1 订阅面）：getSnapshot 返回原始 number，
 *  Object.is 稳定，不制造 uSES #185。touch 只动迭代序、不发布（否则
 *  自激通知形成自我渲染循环）。 */
let decodedImageCacheRevision = 0
const decodedImageCacheListeners = new Set<() => void>()
function publishDecodedImageCacheChange(): void {
  decodedImageCacheRevision += 1
  for (const listener of [...decodedImageCacheListeners]) listener()
}
/** 订阅缓存写入/驱逐（uSES 的 subscribe 面；回归直接用它观测 revision）。 */
export function subscribeDecodedImageCache(listener: () => void): () => void {
  decodedImageCacheListeners.add(listener)
  return () => { decodedImageCacheListeners.delete(listener) }
}

/** LRU 升温（R5-1）：把命中的键移到最近使用位。只动迭代顺序，不动键集
 *  与字节账本——不发布 revision。只能在 commit 后的 effect 里调用（不
 *  允许 render 期写共享缓存）；键不在缓存（解码窗口/隐藏实例）时 no-op，
 *  隐藏实例不保活。 */
function touchDecodedAnimation(key: string): void {
  const frames = decodedImageAnimations.get(key)
  if (frames === undefined) return
  decodedImageAnimations.delete(key)
  decodedImageAnimations.set(key, frames)
}

/** 解码一个动画的全部帧（顺序、确定性）；任一帧失败 → 整个动画 undefined。 */
async function decodeWhaleGirlAnimation(dir: string, animation: WhaleGirlImageAnimation): Promise<readonly TerminalImageSource[] | undefined> {
  try {
    const sharp = await loadSharp()
    if (sharp === undefined) return undefined
    const frames: TerminalImageSource[] = []
    for (const frame of animation.frames) {
      const decoded = await sharp(readFileSync(join(dir, animation.key, frame.file)), { failOn: 'error' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      if (decoded.info.channels !== 4
        || decoded.data.byteLength !== decoded.info.width * decoded.info.height * 4) return undefined
      frames.push({
        data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
        width: decoded.info.width,
        height: decoded.info.height,
      })
    }
    return frames
  } catch {
    return undefined
  }
}

function rememberDecodedAnimation(key: string, frames: readonly TerminalImageSource[]): void {
  const previous = decodedImageAnimations.get(key)
  if (previous !== undefined) {
    decodedImageAnimations.delete(key)
    decodedImageBytes -= previous.reduce((sum, frame) => sum + frame.data.byteLength, 0)
  }
  decodedImageAnimations.set(key, frames)
  decodedImageBytes += frames.reduce((sum, frame) => sum + frame.data.byteLength, 0)
  while (decodedImageBytes > DECODED_IMAGE_BYTES_CAP && decodedImageAnimations.size > 1) {
    const oldest = decodedImageAnimations.keys().next().value
    if (oldest === undefined) break
    const evicted = decodedImageAnimations.get(oldest)
    decodedImageAnimations.delete(oldest)
    decodedImageBytes -= evicted?.reduce((sum, frame) => sum + frame.data.byteLength, 0) ?? 0
  }
  // 插入/替换/驱逐都改变了消费者可见的缓存内容：发布 revision，让
  // 「key 未变但缓存失去」的消费者重跑解码 effect（R5-1）。
  publishDecodedImageCacheChange()
}

/** 预热键集（抽搐修复）：面板证明可见且动画时钟走动后，把常用互动键
 *  （idle 主键 + poke 左/右 + smile-hearts）异步预解进 LRU——让互动切换
 *  的未解码窗口尽量不发生。导出供回归钉住集合。 */
export const WHALE_GIRL_PREHEAT_KEYS: readonly string[] = [
  WHALE_GIRL_MOOD_ANIMATION.idle,
  'poke-left',
  'poke-right',
  'smile-hearts',
]

/** 在途解码登记（同键去重：活跃解码路径与预热共用一个 Promise）。 */
const inflightImageDecodes = new Map<string, Promise<readonly TerminalImageSource[] | undefined>>()

/** 解码发起计数（R5-1 回归观测点）：只在真正创建新的在途 Promise 时
 *  递增——断言「坏键不逐 tick 解码」「同键并发只解一次」「驱逐恢复
 *  有界」都用它。 */
let whaleGirlDecodeRequestCount = 0

/** 解码一个动画并入库：成功进 LRU，失败进失败集（后续解析自动跳到兜底
 *  语义键）；同键并发请求共用在途 Promise，不重复解码。永不 reject、
 *  不触发任何 React 更新（消费方的时钟/事件驱动重渲染）。 */
function requestWhaleGirlAnimationFrames(kit: WhaleGirlImageKit, key: string): Promise<readonly TerminalImageSource[] | undefined> {
  const inflight = inflightImageDecodes.get(key)
  if (inflight !== undefined) return inflight
  whaleGirlDecodeRequestCount += 1
  const pending = decodeWhaleGirlAnimation(kit.dir, kit.byKey[key]!)
    .then(frames => {
      inflightImageDecodes.delete(key)
      if (frames === undefined) failedImageAnimations.add(key)
      else rememberDecodedAnimation(key, frames)
      return frames
    })
    .catch(() => {
      inflightImageDecodes.delete(key)
      failedImageAnimations.add(key)
      return undefined
    })
  inflightImageDecodes.set(key, pending)
  return pending
}

/** 预热一个键（幂等：缺键/已缓存/已失败跳过）；失败静默——与按需解码
 *  同语义地进失败集，不闪不响。 */
function preheatWhaleGirlAnimation(kit: WhaleGirlImageKit, key: string): void {
  if (kit.byKey[key] === undefined) return
  if (decodedImageAnimations.has(key) || failedImageAnimations.has(key)) return
  void requestWhaleGirlAnimationFrames(kit, key)
}

/** 测试观测点：当前进程已解码了哪些动画（惰性解码断言用）。 */
export function whaleGirlDecodedAnimationKeys(): readonly string[] {
  return [...decodedImageAnimations.keys(), ...failedImageAnimations]
}

/** 测试接缝（R5-1）：LRU 迭代序 = 最近使用序（touch 升温后的顺序）。 */
export function decodedImageAnimationOrderForTests(): readonly string[] {
  return [...decodedImageAnimations.keys()]
}

/** 测试接缝（R5-1）：注入假帧驱动 32MiB 驱逐压力（不触发真实解码）。 */
export function injectDecodedAnimationForTests(key: string, frames: readonly TerminalImageSource[]): void {
  rememberDecodedAnimation(key, frames)
}

/** 测试观测点（R5-1）：解码发起总次数（去重/有界断言）。 */
export function whaleGirlDecodeRequestCountForTests(): number {
  return whaleGirlDecodeRequestCount
}

/** 测试接缝：清图像层缓存（timings kit + 已解码动画 + 失败集合 + 字母开窗渲染）。 */
export function resetWhaleGirlImageCacheForTests(): void {
  whaleGirlImageKitCache = undefined
  decodedImageAnimations.clear()
  failedImageAnimations.clear()
  decodedImageBytes = 0
  inflightImageDecodes.clear()
  whaleGirlWindowCache.clear()
  whaleGirlDecodeRequestCount = 0
  publishDecodedImageCacheChange()
}

/** 面板可见性门（visible=false 零工作契约）：PanelHost 对非 active 的
 *  enabled 面板包 display:none 的 Box——沿 DOM 祖先链查它。初始 false，
 *  布局期更新（不触发额外渲染循环），解码 effect 只在证明可见后开跑。 */
function useBoxDisplayed(): [(element: DOMElement | null) => void, boolean] {
  const elementRef = React.useRef<DOMElement | null>(null)
  const displayedRef = React.useRef(false)
  const [displayed, setDisplayed] = React.useState(false)
  const setElement = React.useCallback((element: DOMElement | null) => { elementRef.current = element }, [])
  React.useLayoutEffect(() => {
    let hidden = false
    let node: DOMElement | undefined = elementRef.current?.parentNode
    while (node !== undefined && !hidden) {
      if (node.style?.display === 'none') hidden = true
      node = node.parentNode
    }
    // 只在真变化时入队。这个无 deps 的 layout effect 每个 commit 都会
    // 跑：旧写法的 bail-out 更新器（值不变则返回原值）虽然不重渲染，
    // enqueue 本身却逐 commit 发生——与 /context 滚动这类提交风暴交叠
    // 时把 react-reconciler 的 nestedUpdateCount 棍到 50，#185 于 commit
    // 期抛出（真机 crash.log 2026-10-03 07:21/07:22 两条，栈直指本
    // effect 的 setDisplayed 行，componentStack 指向 SplashMascot 下的
    // WhaleGirlRasterSkin）。ref 镜像让稳态零入队，链条断根。
    const next = !hidden
    if (displayedRef.current !== next) {
      displayedRef.current = next
      setDisplayed(next)
    }
  })
  return [setElement, displayed]
}

/** 鲸娘图像路径的帧缓存 hook：activeKey 为 undefined（面板不可见/无
 *  动画）时不做任何事；命中缓存同步返回，未命中异步解码完成后返回。
 *  R5-1：缓存写入/驱逐经 useSyncExternalStore 订阅成为解码 effect 的
 *  显式输入——「key 未变但缓存失去（被共享预热/别的实例挤出）」时
 *  effect 重跑、按需重新解码，画面不再永久冻结；命中在 commit 后升温
 *  LRU（touchDecodedAnimation），活跃键获得真实的最近使用保护。导出
 *  供回归在真渲染器下钉住 LRU/恢复语义（生产消费者 WhaleGirlRasterSkin）。 */
export function useDecodedWhaleGirlFrames(
  activeKey: string | undefined,
  kit: WhaleGirlImageKit | undefined,
): readonly TerminalImageSource[] | undefined {
  const [settled, setSettled] = React.useState<{ readonly key: string; readonly frames: readonly TerminalImageSource[] } | undefined>(undefined)
  // 快照是原始 number：键集/字节变化才递增（touch 不递增），Object.is
  // 稳定；通知只在外部事件（解码完成微任务/测试注入）发生，稳态零入队。
  const cacheRevision = React.useSyncExternalStore(subscribeDecodedImageCache, () => decodedImageCacheRevision)
  React.useEffect(() => {
    if (activeKey === undefined || kit === undefined) return
    if (!decodedImageAnimations.has(activeKey) && !failedImageAnimations.has(activeKey)) {
      let live = true
      // 解码走共享在途登记（与预热同键去重）；setSettled 只在本组件仍是
      // 消费者时入队（预热先完成时，缓存由 revision 通知的渲染同步命中）。
      void requestWhaleGirlAnimationFrames(kit, activeKey).then(frames => {
        if (live && frames !== undefined) setSettled({ key: activeKey, frames })
      })
      return () => { live = false }
    }
    return
  }, [activeKey, kit, cacheRevision])
  // 已提交使用路径的 LRU 升温：每次 commit 触一次（幂等，只动迭代序）；
  // activeKey 不在缓存（解码窗口）或为 undefined（隐藏实例）时 no-op。
  React.useLayoutEffect(() => {
    if (activeKey !== undefined) touchDecodedAnimation(activeKey)
  })
  const cached = activeKey !== undefined ? decodedImageAnimations.get(activeKey) : undefined
  if (cached !== undefined) return cached
  return settled !== undefined && settled.key === activeKey ? settled.frames : undefined
}

/** 协议裁决层：render() 只产出本组件，hooks 全部在这里落地。 */
function WhaleGirlImageSkin(input: CompanionSkinRenderInput): React.ReactNode {
  // 请求能力探测（无协议终端 probe 一次即回落，不再打扰）。
  useTerminalImages(true)
  const protocol = useTerminalImageProtocol()
  if (protocol !== 'kitty' && protocol !== 'sixel') return renderWhaleGirlLetterGrid(input)
  return <WhaleGirlRasterSkin {...input} />
}

/** 图像渲染层：timings 选帧 + 惰性解码 + 单元格盒（15 行预算、宽按
 *  帧比例钳 42 列）。解码窗口【持帧】（上一帧画面保持到新帧就绪）；字母
 *  格只在冷启动（从未成功上过图像）兜底；常用互动键可见后预热。 */
function WhaleGirlRasterSkin(input: CompanionSkinRenderInput): React.ReactNode {
  const { pose, moodSince, now, animationSemantic } = input
  const cellSize = useTerminalImageCellSize()
  const imageKit = loadWhaleGirlImageKit()
  const [boxRef, displayed] = useBoxDisplayed()
  // 失败键跳兜底：解码失败过的键不再成为活跃键（落回心情层语义键），失败
  // 的互动不会把画面钉死在持帧上——下一时钟渲染平滑改演兜底动画，不闪。
  const animationKey = imageKit !== undefined
    ? resolveWhaleGirlAnimationKey(pose, animationSemantic, key => imageKit.byKey[key] !== undefined && !failedImageAnimations.has(key))
    : undefined
  // visible=false 零工作：display:none 祖先链未排除前不解码、不订阅时钟。
  const frames = useDecodedWhaleGirlFrames(displayed ? animationKey : undefined, imageKit)
  const animation = animationKey !== undefined ? imageKit?.byKey[animationKey] : undefined

  // 预热（抽搐修复）：可见且【动画时钟走动】后，把常用互动键异步预解进
  // LRU（不阻塞首帧；失败静默进失败集）。时钟从未走动 = active=false 冻结
  // 态（SplashMascot 定格 idle 帧 0、零时钟）——不预热，冻结契约不破。
  const lastNowRef = React.useRef(now)
  const clockAdvancedRef = React.useRef(false)
  if (now !== lastNowRef.current) {
    lastNowRef.current = now
    clockAdvancedRef.current = true
  }
  React.useEffect(() => {
    if (!displayed || imageKit === undefined || !clockAdvancedRef.current) return
    for (const key of WHALE_GIRL_PREHEAT_KEYS) preheatWhaleGirlAnimation(imageKit, key)
  }, [displayed, imageKit, clockAdvancedRef.current])

  // 持帧（抽搐修复）：动画键切到未解码键（LRU 未命中/在途解码）的窗口里
  // 不再闪回字母格——保持上一帧画面直到新帧就绪；字母格兜底只在「本会话
  // 从未成功渲染过图像」的冷启动阶段出现，图像一旦上过屏终生不再回退
  // （组件实例级 ref：重挂载走模块 LRU 同步命中，字母格窗口实际只存在于
  // 冷启动）。渲染期写 ref 是「上一个渲染值」模式（同 useBoxDisplayed 的
  // displayedRef 镜像）：值由 props 纯派生、幂等。
  const everRenderedImageRef = React.useRef(false)
  const heldImageRef = React.useRef<React.ReactNode>(undefined)

  // 单元格盒：15 行预算 + 帧自身宽高比（source.width/height，与档位
  // 无关）+ 真实像元；宽钳 42 列（§16.6）。8×16 像元下 288px 档
  // （301×288）≈ 31 列，渲染层 fit 只降采样，显示恒 1:1 或更密。
  // 外层盒恒定 42×15：ref 挂在它上面（可见性门要求任何分支都在树里），
  // 字母格→图像切换时面板几何零跳动。
  let image: React.ReactNode
  if (imageKit !== undefined && cellSize !== undefined && frames !== undefined && animation !== undefined) {
    const frameIndex = whaleGirlImageFrameIndexAt(animation, now - moodSince)
    const source = frames[frameIndex] ?? frames[0]
    if (source !== undefined) {
      const cellRatio = cellSize.height / cellSize.width
      const frameRatio = source.width / source.height
      // 盒宽=图宽（钳在 cells.columns 内；超宽像元比下 contain 收行不裁剪）。
      const rawColumns = Math.max(1, Math.round(cellRatio * WHALE_GIRL_CELLS.rows * frameRatio))
      const columns = whaleGirlImageBoxColumns(cellSize, frameRatio)
      const rows: number = rawColumns > columns
        ? Math.max(1, Math.round(columns / (cellRatio * frameRatio)))
        : WHALE_GIRL_CELLS.rows
      image = (
        <Image transparent source={source} width={columns} height={rows} alt="" presentation="transcript">
          {/* 空格垫底：真 kitty/sixel 下渲染器自己接管这些格子（children 被跳过）
              且 raster 覆盖；无图形协议（或渲染器未启用图像）时 ink-image 按
              普通 box 画 children——空格保证每帧重画这些 cell，字母格切换后
              不残留旧帧（headless/降级路径的可观测性与确定性）。 */}
          <Text>{Array.from({ length: rows }, () => ' '.repeat(columns)).join('\n')}</Text>
        </Image>
      )
      // 图像成功上屏：记「已渲染过」并留存本帧（持帧源）；held 元素引用
      // 稳定，持帧期间逐 tick 重渲染不触发子树重画（画面冻结在上一帧）。
      everRenderedImageRef.current = true
      heldImageRef.current = image
    }
  }
  return (
    <Box ref={boxRef} flexDirection="column" flexShrink={0} alignItems="center" justifyContent="center"
      width={WHALE_GIRL_CELLS.columns} height={WHALE_GIRL_CELLS.rows}>
      {image ?? (everRenderedImageRef.current ? heldImageRef.current : renderWhaleGirlLetterGrid(input))}
    </Box>
  )
}

const WHALE_CELLS = Object.freeze({ columns: 40, rows: 13 })

/** 现有像素鲸鱼：直接消费 nativeWhalePose（与开屏 splash 同一规划器、
 *  同一帧表、同一 LAYERED_CACHE）。 */
export const WhaleSkin: CompanionSkin = {
  id: 'whale',
  title: 'Whale',
  cells: WHALE_CELLS,
  graphics: 'none',
  render({ pose }) {
    return <WhaleArt pose={pose.nativeWhalePose} width={WHALE_CELLS.columns} />
  },
}

const skins = new Map<string, CompanionSkin>([
  [DeepySkin.id, DeepySkin],
  [WhaleGirlSkin.id, WhaleGirlSkin],
  [WhaleSkin.id, WhaleSkin],
])

/** 按 id 取皮肤；未知 id 回退默认（DeepySkin）。 */
export function resolveCompanionSkin(id: string | undefined): CompanionSkin {
  if (id !== undefined) {
    const skin = skins.get(id)
    if (skin !== undefined) return skin
  }
  return DeepySkin
}

/** 自定义皮肤注册接缝（用户自定义 / 插件皮肤的进入点；描述符校验
 *  规则随 Phase 7 的插件皮肤一起落地）。 */
export function registerCompanionSkin(skin: CompanionSkin): void {
  skins.set(skin.id, skin)
}
