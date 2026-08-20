/**
 * EffortInputBorder — 输入框层上的三幕点焰叠加（对齐 Codex 的完整
 * 语义：光扫过、档位字样浮现、整体渐隐）。
 *
 * 输入框只有顶/底两条横边框（round、无左右）——本组件自绘这两行，
 * **同步**承载动画；档位字样由输入行尾的 EffortTierBadge 短暂显示
 * （见 PromptInput），动画全程行数恒定。切到最高思考强度档时：
 *
 *   1. 扫光 [0, 1s)——一段高亮彩色光带沿顶/底边框同步自左向右扫过
 *      （wave 波形逐列变色），期间输入框完全正常可用；
 *   2. 档位字样 [600ms, ~1.1s)——光带行至中段时，输入行居中浮现
 *      档名大写（由暗渐亮加粗、间距聚拢，见 EffortTierBadge）；
 *   3. 渐隐 [1.5s, 2s)——字样连同光色一起向主题色淡出，末帧归零：
 *      静止时顶/底边框就是原主题色，内容区无任何附加物。
 *
 * glyph 变化仅限字样行的出现/让位（一次性）；其余帧间变化全部是既
 * 有 `─` 的前景色。触发判定在渲染期做（props-变化-调整模式）；从
 * 「已有档位」切到档位表末位最高档才触发，冷启动恢复偏好/单档表/
 * 无档位表/无共享时钟均不触发。时钟复用 Ink core 共享时钟，仅动画
 * 窗口订阅（keepAlive），播完回到零开销静止边框。
 */
import React, { useContext, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import type { Color } from '../ink/styles.js'
import type { Theme } from '../theme.js'
import { IGNITION_TIMELINE, ignitionLineColors } from '../trajectory/effortIgnition.js'

type Overlay = { label: string; startedAtMs: number }

/** 边框行（顶/底共用同一色段序列——同步变色）。 */
function BorderRow({
  left,
  right,
  runs,
  idleColor,
}: {
  left: string
  right: string
  runs: ReadonlyArray<{ glyph: string; color: keyof Theme | Color }>
  idleColor: keyof Theme | Color
}): React.ReactNode {
  return (
    <Text>
      <Text color={idleColor}>{left}</Text>
      {runs.map((run, i) => (
        <Text key={i} color={run.color}>
          {run.glyph}
        </Text>
      ))}
      <Text color={idleColor}>{right}</Text>
    </Text>
  )
}

export function EffortInputBorder({
  effort,
  levels,
  columns,
  onLight,
  idleColor,
  children,
}: {
  /** 当前思考强度档 id；`undefined` 表示路线未声明。 */
  effort: string | undefined
  /** 当前路线的档位表（低→高，末位为最高档）；未知时传 `undefined`。 */
  levels: readonly string[] | undefined
  columns: number
  onLight: boolean
  /** 静止边框色（主题 token 名，如 'promptBorder' / 'planMode'）。 */
  idleColor: keyof Theme | Color
  children: React.ReactNode
}): React.ReactNode {
  const clock = useContext(ClockContext)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [prevEffort, setPrevEffort] = useState(effort)
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0)

  // 渲染期触发：effort 变化的首帧就以新状态渲染（effect 会晚一帧）。
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

  // 仅动画窗口订阅共享时钟；静止边框零定时器零重渲染。
  const elapsedMs =
    overlay === null ? Infinity : Math.max(0, (clock?.now() ?? Date.now()) - overlay.startedAtMs)
  useEffect(() => {
    if (overlay === null || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [overlay, clock])
  useEffect(() => {
    if (overlay !== null && elapsedMs >= IGNITION_TIMELINE.fadeEndMs) setOverlay(null)
  }, [overlay, elapsedMs])

  const midWidth = Math.max(0, columns - 2)
  const sweepColors =
    overlay !== null && elapsedMs < IGNITION_TIMELINE.sweepMs && midWidth > 0
      ? ignitionLineColors({ elapsedMs, width: midWidth, onLight })
      : []
  // 顶/底共用的色段序列（同步）：扫光列取波形色，其余列回主题色。
  const runs: Array<{ glyph: string; color: keyof Theme | Color }> = []
  for (let index = 0; index < midWidth; index++) {
    const color = sweepColors[index] as keyof Theme | Color | undefined ?? idleColor
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color) last.glyph += '─'
    else runs.push({ glyph: '─', color })
  }

  return (
    <Box
      flexDirection="column"
      alignItems="flex-start"
      justifyContent="flex-start"
      width="100%"
      flexShrink={0}
    >
      <BorderRow left="╭" right="╮" runs={runs} idleColor={idleColor} />
      {children}
      <BorderRow left="╰" right="╯" runs={runs} idleColor={idleColor} />
    </Box>
  )
}
