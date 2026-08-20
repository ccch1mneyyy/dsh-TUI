/**
 * EffortChargeGlyph — 输入提示前缀 `❯ ` 的最高档强调与充能。
 *
 * 思考强度处于当前路线最高档期间，前缀换为点火强调色（加粗，与点焰波
 * 共用 hues[0]——同一瞬间前缀与波是同一种橙）；切到最高档的瞬间做一次
 * 150ms「充能」渐变（accentRamp 的暗端 → 全值）。冷启动已在最高档时
 * 不充能（充能只属于切换瞬间），离开最高档恢复原样的 dim 行为。
 *
 * 触发判定在渲染期做（React 官方的「props 变化即调整 state」模式，
 * 与 EffortInputBorder 同一模式）——放 effect 会晚一帧，effort 变化
 * 的首帧以全亮闪现、下一帧才跌回暗端重来。充能只动颜色，glyph 恒为
 * `❯ `，SGR-only 规则天然成立。
 *
 * 时钟复用 Ink core 共享时钟，且只在充能未满的那 150ms 内订阅；稳态
 * 零定时器、零重渲染，前缀色取记忆化常量。
 */
import React, { useContext, useEffect, useReducer, useState } from 'react'
import { Text, useTheme } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import { accentRamp } from '../trajectory/effortIgnition.js'
import { rgbString } from '../trajectory/motion.js'
import { interpolateColor } from './Spinner/spinnerUtils.js'
import { isLightThemeActive } from '../theme.js'

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
  const [prevEffort, setPrevEffort] = useState(effort)
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0)

  const topActive =
    effort !== undefined && levels !== undefined && levels.length > 1 && effort === levels[levels.length - 1]

  // Render-phase trigger (same pattern as EffortInputBorder): switching from
  // an existing tier onto the top tier starts the charge NOW, not one effect
  // later — the first frame of the new effort must not flash fully lit.
  // Cold mounts enter the steady state directly; without a shared clock
  // (headless embeds) there is no charge either — no frames would ever arrive.
  if (effort !== prevEffort) {
    setPrevEffort(effort)
    if (topActive && clock !== null) {
      setChargeStartedAt(clock.now())
    }
  }

  // Only the 150ms charge window subscribes to the shared clock; steady
  // state has zero timers and zero re-renders.
  const chargeElapsed =
    chargeStartedAt === null
      ? Infinity
      : // Clamp at zero: the shared clock can hand back a stale tickTime for
        // one frame after waking from pause.
        Math.max(0, (clock?.now() ?? Date.now()) - chargeStartedAt)
  const charging = chargeElapsed < CHARGE_MS
  useEffect(() => {
    if (!charging || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [charging, clock])

  if (!topActive) return <Text dimColor={working}>❯ </Text>
  const ramp = accentRamp(isLightThemeActive(themeName))
  if (!charging) {
    // Steady state re-derives on every render (two allocations + one blend
    // per keystroke — negligible) instead of caching: a cached colour would
    // go stale across a light/dark theme flip while the tier stays active.
    const color = rgbString(ramp.full)
    return (
      <Text bold color={color} dimColor={working}>
        ❯{' '}
      </Text>
    )
  }
  const charge = Math.min(1, chargeElapsed / CHARGE_MS)
  return (
    <Text bold color={rgbString(interpolateColor(ramp.dim, ramp.full, charge))} dimColor={working}>
      ❯{' '}
    </Text>
  )
}
