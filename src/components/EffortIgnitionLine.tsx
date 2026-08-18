/**
 * EffortIgnitionLine — 思考强度切到最高档时的状态行点焰（一次性）。
 *
 * 触发条件：{@link props.effort} 从一个已存在的档位变为当前档位表的
 * 最高档（表末位），且档位表多于一级——冷启动恢复偏好、单档模型都不
 * 触发。播完自卸载（渲染 null，行消失）。
 *
 * SGR-only 合规（见 motion.ts 的硬规则）：动画期间行数恒为一、glyph
 * 恒为空格，帧间变化全部是背景色——连续同色列合并成段渲染，每帧只
 * 发出色序。时钟复用 Ink core 共享时钟（失焦/滚出自动停摆，见
 * ClockContext），不在本组件创建任何定时器。
 */
import React, { useContext, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import {
  IGNITION_TOTAL_MS,
  ignitionLineColors,
  randomIgnitionStyle,
  type IgnitionStyle,
} from '../trajectory/effortIgnition.js'
import type { Color } from '../ink/styles.js'

/** 一段同色（或同「无背景」）的连续列。 */
type Run = { color: Color | undefined; len: number }

/** 把逐列色压缩成连续段，段数远小于列数时显著减少节点与 SGR 切换。 */
function toRuns(colors: ReadonlyArray<Color | undefined>): Run[] {
  const runs: Run[] = []
  for (const color of colors) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color) last.len++
    else runs.push({ color, len: 1 })
  }
  return runs
}

export function EffortIgnitionLine({
  effort,
  levels,
  columns,
  onLight,
  style,
}: {
  /** 当前思考强度档 id；`undefined` 表示路线未声明。 */
  effort: string | undefined
  /** 当前路线的档位表（低→高，末位为最高档）；未知时传 `undefined`。 */
  levels: readonly string[] | undefined
  columns: number
  onLight: boolean
  /** 固定风格（验证脚本逐风格回归用）；缺省随机且不与上次重复。 */
  style?: IgnitionStyle
}): React.ReactNode {
  const clock = useContext(ClockContext)
  const [ignition, setIgnition] = useState<{ style: IgnitionStyle; startedAtMs: number } | null>(
    null,
  )
  const [prevEffort, setPrevEffort] = useState(effort)
  const prevStyle = useRef<IgnitionStyle | undefined>(undefined)
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0)

  // 触发判定在渲染期做（React 官方的「props 变化即调整 state」模式），
  // 不放 effect——effect 晚一帧，effort 变化的首帧会以旧状态闪现。从
  // 「已有档位」变为「另一档位」且新档位是末位最高档才触发；首次载入
  // / 单档表 / 档位表未知 / 无共享时钟（headless 嵌入，帧永不到来，
  // 冻结的着色行永不退场）都不触发。
  if (effort !== prevEffort) {
    setPrevEffort(effort)
    if (
      clock !== null &&
      effort !== undefined &&
      levels !== undefined &&
      levels.length > 1 &&
      effort === levels[levels.length - 1]
    ) {
      const nextStyle = style ?? randomIgnitionStyle(prevStyle.current)
      prevStyle.current = nextStyle
      setIgnition({ style: nextStyle, startedAtMs: clock.now() })
    }
  }

  // 动画期间才订阅共享时钟：帧回调只强制重渲染，不持任何状态。波本身
  // 是活动内容，keepAlive=true——否则在没有任何其他动画组件的场景（如
  // 本组件的独立验证）里时钟根本不走，帧永不到来。
  useEffect(() => {
    if (ignition === null || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [ignition, clock])

  const totalMs = ignition === null ? 0 : IGNITION_TOTAL_MS[ignition.style]
  // Clamp at zero: the shared clock can hand back a stale tickTime for one
  // frame after waking from pause, which would read as a large negative
  // elapsed; the band renders empty and self-heals next tick regardless.
  const elapsedMs =
    ignition === null ? Infinity : Math.max(0, (clock?.now() ?? Date.now()) - ignition.startedAtMs)

  // 播完即净：置回 null，行随之卸载（一次性布局变化，不在 SGR-only
  // 约束的帧间动画之内）。
  useEffect(() => {
    if (ignition !== null && elapsedMs >= totalMs) setIgnition(null)
  }, [ignition, elapsedMs, totalMs])

  if (ignition === null || elapsedMs >= totalMs || columns <= 0) return null
  const colors = ignitionLineColors({
    style: ignition.style,
    elapsedMs,
    width: columns,
    onLight,
  })
  const runs = toRuns(colors)
  if (runs.length === 0) return null
  return (
    <Box height={1} width="100%" flexShrink={0}>
      {runs.map((run, index) =>
        run.color === undefined ? (
          <Text key={index}>{' '.repeat(run.len)}</Text>
        ) : (
          <Text key={index} backgroundColor={run.color}>
            {' '.repeat(run.len)}
          </Text>
        ),
      )}
    </Box>
  )
}
