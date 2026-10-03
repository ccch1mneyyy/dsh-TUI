/**
 * planPose（设计分文档 §2 + v2.1 修订）：皮肤无关的动画词汇。
 *
 * v2.1 的关键修订（评审 §八）：whaleIdle 是**多层同时发生**的规划器
 * （tail + fin + blink + heart + sleep 各自独立），单一 gesture 字段会
 * 丢信息、也无法做到帧级一致。因此：
 * - gestures 是一个集合（wag + flutter 可以同时成立）；
 * - nativeWhalePose 原样携带 WhaleLayerPose——鲸鱼皮肤 100% 复用现有
 *   分层渲染（与开屏 splash 同一规划器、同一帧表，帧级 parity 免费），
 *   其他皮肤只消费自己能理解的通用语义子集。
 *
 * 实现上就是 nextWhaleIdleStep 的薄包装：mood 映射到它的 working 输入
 * （waiting/thinking/working/responding → working=true，与分文档一致；
 * attention 也算 working——有需要用户处理的事时宠物应该醒着且活跃），
 * 规划器本身一行不动。
 */
import type { WhaleLayerPose } from '../../whaleLayers.js'
import {
  initialWhaleIdleState,
  nextWhaleIdleStep,
  type WhaleIdleState,
} from '../../whaleIdle.js'
import type { CompanionMood } from './mood.js'

export type CompanionGesture = 'wag' | 'flutter' | 'spout' | 'nod' | 'wave'

export interface CompanionPose {
  readonly mood: CompanionMood
  /** 0.. 单调递增，皮肤按自己的帧率取模（由 now/120 派生）。 */
  readonly tick: number
  readonly gestures: ReadonlySet<CompanionGesture>
  readonly blink: boolean
  readonly heart: 0 | 1 | 2 | 3
  readonly sleepZ: 0 | 1 | 2 | 3 | 4 | 5
  readonly facing: 'left' | 'right'
  /** 鲸鱼皮肤专用：与开屏 splash 完全一致的原始分层姿态。 */
  readonly nativeWhalePose: WhaleLayerPose
}

export interface CompanionPoseStep {
  readonly state: WhaleIdleState
  readonly pose: CompanionPose
  readonly delayMs: number
}

export const initialCompanionPoseState = initialWhaleIdleState

const AWAKE_ACTIVE_MOODS: ReadonlySet<CompanionMood> = new Set([
  'waiting',
  'thinking',
  'working',
  'responding',
  'attention',
])

export function nextCompanionPoseStep(
  prev: WhaleIdleState,
  input: { readonly mood: CompanionMood; readonly heart: boolean },
  now: number,
): CompanionPoseStep {
  const step = nextWhaleIdleStep(
    prev,
    { working: AWAKE_ACTIVE_MOODS.has(input.mood), heart: input.heart },
    now,
  )
  const layers = step.pose
  const gestures = new Set<CompanionGesture>()
  if (layers.tail > 0) gestures.add('wag')
  if (layers.fin > 0) gestures.add('flutter')
  if (layers.spout > 0) gestures.add('spout')
  return {
    state: step.state,
    pose: {
      mood: input.mood,
      tick: Math.max(0, Math.floor(now / 120)),
      gestures,
      blink: layers.blink,
      heart: Math.min(3, Math.max(0, layers.heart)) as 0 | 1 | 2 | 3,
      sleepZ: Math.min(5, Math.max(0, layers.sleep)) as 0 | 1 | 2 | 3 | 4 | 5,
      facing: 'left',
      nativeWhalePose: layers,
    },
    delayMs: step.delayMs,
  }
}
