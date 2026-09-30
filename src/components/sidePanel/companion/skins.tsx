/**
 * Companion 皮肤接口与注册表（设计分文档 §3 + v2.1）：皮肤拿到的是
 * CompanionPose（多层语义 + nativeWhalePose）与渲染上下文；皮肤只实现
 * 自己理解的语义子集，未支持的姿态退化而不是报错。
 *
 * 用户的 deepy 是默认皮肤（DEEPY_MOOD_ANIMATION 逐心情整段动画）；
 * WhaleSkin 复用开屏分层规划器的 nativeWhalePose（与 splash 帧级一致）。
 * 插件皮肤（纯数据帧表，分文档 §6）留到 Phase 7，注册表先把接缝定好：
 * 皮肤 = id + cells + render(pose, ctx)，自定义皮肤走同一接口进入。
 */
import React from 'react'
import { Box, Text } from '../../../ui.js'
import { WhaleArt } from '../../Whale.js'
import type { I18nKey } from '../../../i18n.js'
import { DEEPY_CELLS, DEEPY_MOOD_ANIMATION, frameAt, loadDeepyKit, renderedDeepyAnimation } from './deepy.js'
import type { CompanionPose } from './pose.js'

export interface CompanionSkinRenderInput {
  readonly pose: CompanionPose
  /** 当前心情进入的时刻（动画从 0 计 elapsed 的起点）。 */
  readonly moodSince: number
  readonly now: number
  /** 可用宽度（皮肤永不超宽：宽度不足由 Panel 决定用不用 small）。 */
  readonly width: number
}

export interface CompanionSkin {
  readonly id: string
  readonly titleKey?: I18nKey
  readonly title?: string
  /** 固定占位（列×行），永不随帧变化（§16.6 列宽不变硬约束）。 */
  readonly cells: { readonly columns: number; readonly rows: number }
  readonly graphics: 'none' | 'optional' | 'required'
  render(input: CompanionSkinRenderInput): React.ReactNode
}

/** deepy 小鲸鱼（默认）：mood → 动画，elapsed → frameAt 确定性选帧。 */
export const DeepySkin: CompanionSkin = {
  id: 'deepy',
  title: 'Deepy',
  cells: DEEPY_CELLS,
  graphics: 'none',
  render({ pose, moodSince, now }) {
    const kit = loadDeepyKit()
    if (kit === undefined) return WhaleSkin.render({ pose, moodSince, now, width: DEEPY_CELLS.columns })
    const animationKey = DEEPY_MOOD_ANIMATION[pose.mood] ?? 'idle'
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
