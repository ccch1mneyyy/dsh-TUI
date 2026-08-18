/**
 * EffortChargeGlyph — 输入提示前缀 `❯ ` 的最高档强调与充能。
 *
 * 思考强度处于当前路线最高档期间，前缀换为点火强调色（加粗）；切到
 * 最高档的瞬间做一次 150ms「充能」渐变（由色板深端亮到全值，对应
 * Codex 的 charge）。冷启动已在最高档时不充能（充能只属于切换瞬间），
 * 离开最高档恢复原样的 dim 行为。glyph 恒为 `❯ `——充能只动颜色，
 * SGR-only 规则天然成立。
 *
 * 时钟复用 Ink core 共享时钟，且只在充能未满的那 150ms 内订阅；稳态
 * 零定时器、零重渲染。
 */
import React, { useContext, useEffect, useReducer, useRef, useState } from 'react'
import { Text, useTheme } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import { ignitionHues } from '../trajectory/effortIgnition.js'
import { rgbString } from '../trajectory/motion.js'
import { interpolateColor } from './Spinner/spinnerUtils.js'

/** 充能时长（ms）。 */
const CHARGE_MS = 150

export function EffortChargeGlyph({
  effort,
  levels,
  working,
}: {
  /** 当前思考强度档 id；`undefined` 表示路线未声明。 */
  effort: string | undefined
  /** 当前路线的档位表（低→高，末位为最高档）。 */
  levels: readonly string[] | undefined
  /** 模型工作中时前缀照旧压暗（既有语义）。 */
  working: boolean
}): React.ReactNode {
  const clock = useContext(ClockContext)
  const [themeName] = useTheme()
  const [chargeStartedAt, setChargeStartedAt] = useState<number | null>(null)
  const prevEffort = useRef<string | undefined>(undefined)
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0)

  const topActive =
    effort !== undefined && levels !== undefined && levels.length > 1 && effort === levels[levels.length - 1]

  // 充能起点：从「已有档位」切到最高档的瞬间（与 EffortIgnitionLine 的
  // 触发判定同一模式）；冷启动直接进入稳态。
  useEffect(() => {
    const previous = prevEffort.current
    prevEffort.current = effort
    if (topActive && previous !== undefined && effort !== previous) {
      setChargeStartedAt(clock?.now() ?? Date.now())
    }
  }, [effort, topActive, clock])

  // 只在充能未满期间订阅时钟：充满后稳态零开销。
  const charging =
    chargeStartedAt !== null && (clock?.now() ?? Date.now()) - chargeStartedAt < CHARGE_MS
  useEffect(() => {
    if (!charging || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [charging, clock])

  if (!topActive) return <Text dimColor={working}>❯ </Text>
  const elapsed = chargeStartedAt === null ? Infinity : (clock?.now() ?? Date.now()) - chargeStartedAt
  const charge = Math.min(1, Math.max(0, elapsed / CHARGE_MS))
  const [dark, , bright] = ignitionHues(themeName === 'light')
  const color = rgbString(interpolateColor(dark, bright, charge))
  return (
    <Text bold color={color} dimColor={working}>
      ❯{' '}
    </Text>
  )
}
