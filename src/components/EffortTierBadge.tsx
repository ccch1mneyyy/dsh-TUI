/**
 * EffortTierBadge — 输入行尾的档位字样徽标：三幕点焰的第二幕载体
 * （与 EffortInputBorder 的双框扫光同一时间轴、同一触发），切到最高
 * 思考强度档时光带行至中段，输入行居中浮现档名（当前档名大写，字母间距从
 * 10 个空格减速聚拢到 1 个——连续位置逐字母取整保证帧帧有移动，
 * 明亮蓝加粗，由暗渐亮），随后随图层整体渐隐让位——行数恒定，静
 * 止时完全不渲染；输入行有文字时不显示（绝不遮挡内容）。
 *
 * 触发判定在渲染期做（props-变化-调整模式，与边框/充能组件同模
 * 式）；冷启动恢复偏好/单档表/无档位表/无共享时钟均不触发。时钟
 * 复用 Ink core 共享时钟，仅动画窗口订阅（keepAlive），播完归零。
 */
import React, { useContext, useEffect, useReducer, useState } from 'react'
import { Text } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import { rgbString } from '../trajectory/motion.js'
import type { RGBColor } from './Spinner/spinnerUtils.js'
import { IGNITION_TIMELINE, ignitionHues } from '../trajectory/effortIgnition.js'

type Overlay = { label: string; startedAtMs: number }

/** 字母间距聚拢：从 10 个空格减速收敛到 1 个（ease-out，快收慢停）。 */
const GAP_START = 10
const GAP_END = 1
const CONVERGE_MS = 500

export function EffortTierBadge({
  effort,
  levels,
  onLight,
  columns,
  leadingColumns,
}: {
  /** 当前思考强度档 id；`undefined` 表示路线未声明。 */
  effort: string | undefined
  /** 当前路线的档位表（低→高，末位为最高档）；未知时传 `undefined`。 */
  levels: readonly string[] | undefined
  onLight: boolean
  /** 终端列数——居中锚点按终端几何中心计算（纯文本流，不引入嵌套 Box）。 */
  columns: number
  /** badge 文本流之前该行已被占据的列数（❯ 与块光标等）——居中换算成
   *  badge 流内列时要扣掉，否则整体偏右一个前缀宽。 */
  leadingColumns: number
}): React.ReactNode {
  const clock = useContext(ClockContext)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [prevEffort, setPrevEffort] = useState(effort)
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0)

  // 渲染期触发（与边框/充能同模式）：effort 变化的首帧就以新状态渲染。
  if (effort !== prevEffort) {
    setPrevEffort(effort)
    if (
      clock !== null &&
      effort !== undefined &&
      levels !== undefined &&
      levels.length > 1 &&
      effort === levels[levels.length - 1]
    ) {
      setOverlay({ label: effort.toUpperCase(), startedAtMs: clock.now() })
    }
  }

  const elapsedMs =
    overlay === null ? Infinity : Math.max(0, (clock?.now() ?? Date.now()) - overlay.startedAtMs)
  useEffect(() => {
    if (overlay === null || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [overlay, clock])
  useEffect(() => {
    if (overlay !== null && elapsedMs >= IGNITION_TIMELINE.fadeEndMs) setOverlay(null)
  }, [overlay, elapsedMs])

  if (overlay === null || elapsedMs < IGNITION_TIMELINE.labelStartMs) return null
  const brighten = Math.min(1, (elapsedMs - IGNITION_TIMELINE.labelStartMs) / IGNITION_TIMELINE.labelBrightenMs)
  const fade =
    elapsedMs < IGNITION_TIMELINE.fadeStartMs
      ? 1
      : Math.max(0, 1 - (elapsedMs - IGNITION_TIMELINE.fadeStartMs) / (IGNITION_TIMELINE.fadeEndMs - IGNITION_TIMELINE.fadeStartMs))
  const alpha = brighten * fade
  if (alpha <= 0) return null
  const band: RGBColor = onLight ? { r: 240, g: 240, b: 242 } : { r: 27, g: 30, b: 40 }
  // 明亮蓝：accent 混白 35% 提亮（用户拍板的高亮观感）。
  const hue = ignitionHues(onLight)[0]
  const whiten = (x: number): number => Math.round(x + (255 - x) * 0.35)
  const bright: RGBColor = { r: whiten(hue.r), g: whiten(hue.g), b: whiten(hue.b) }
  const mix = (x: number, y: number): number => Math.round(x + (y - x) * alpha)
  const color = rgbString({ r: mix(band.r, bright.r), g: mix(band.g, bright.g), b: mix(band.b, bright.b) })
  // 字母间距聚拢（Codex 的 converge 语义）：间距是连续浮点，字母位置
  // 以**行中心为锚**对称收缩——pos_i = center + (i-(n-1)/2)·(1+gap)，
  // 左右字母各向中心移动一半（奇数档名的居中字母原位不动），两侧速
  // 度天然均衡；每字母独立按连续位置取整落列，不同字母在不同帧跨
  // 格，每帧至少一个在动（把间距整体取整会让 ease-out 慢末段上百毫
  // 秒才跨一格，看起来就是卡顿）。曲线混入 15% 线性做末段保底速度。
  const progress = Math.min(1, Math.max(0, (elapsedMs - IGNITION_TIMELINE.labelStartMs) / CONVERGE_MS))
  // 跳变间隔均匀化：离散格子上「减速」若靠曲线导数趋零实现，末段会
  // 出现几十帧不动一格的长停顿再突跳（卡感来源）。改为 90% 线性 +
  // 10% easeOutQuad 的轻缓收尾——跳变间隔全程近似恒定（约 55ms/格），
  // 仅末端轻微放慢，终端上的观感是均匀顺滑的聚拢。
  const eased = 1 - progress
  const easedWithFloor = 0.9 * eased + 0.1 * (1 - progress * progress)
  const gapF = GAP_END + (GAP_START - GAP_END) * easedWithFloor
  const letterCount = overlay.label.length
  // 锚点是**终端几何中心**（不是 ❯/光标之后可用区的中心——那会整体
  // 偏右约 1.5 格；可用区起点在左，其"中点"不含左部占位）。左右字母
  // 严格镜像——Math.round 对 .5 恒向上，正负方向舍入不对称会让跨格
  // 时刻错开；左字母的落列由右字母的舍入结果镜像得出（2C − col），
  // M/X 每次同帧反向同跳，全程对称于终端中心。
  const C = Math.round((columns - 1) / 2) - leadingColumns
  let spaced = ''
  let column = 0
  for (let i = 0; i < letterCount; i++) {
    const off = (i - (letterCount - 1) / 2) * (1 + gapF)
    const at =
      off >= 0
        ? Math.round(C + off)
        : 2 * C - Math.round(C - off)
    spaced += ' '.repeat(Math.max(0, at - column)) + overlay.label[i]!
    column = at + 1
  }
  return (
    <Text bold color={color}>
      {spaced}
    </Text>
  )
}
