import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'

/**
 * 落地页参数行的**三段式宽度分配**（2026-10）。
 *
 * 参数行是输入框下那一行四段值：`模型 · 思考深度 · agent preset 显示名 ·
 * 权限 preset 名`。改造前是「逐段累加、第一个超预算的段直接 break」，于是
 * **从尾部整段消失**（权限 → preset → 思考深度 → 模型）——preset 显示名一长
 * （名册的 `config.name`，长度不可控），最先走的恰好是那一屏唯一的安全读数
 * （`danger-full-access` = 不审批 + 全盘写）。
 *
 * 现在的三档（自顶向下，第一个成立者胜出）：
 *
 *   ① FIT       —— 四段按原样装得下 → **原样返回**（常规场景逐字节不变）；
 *   ② TRUNCATED —— 装不下 → 挑**可缩减量最大**（`宽度 - 下限`）的段做**尾部
 *                   截断**（`truncateToWidth(text, max - 1) + '…'`），一次减掉
 *                   当前超宽量；减到各自的 `PARAM_SEGMENT_MIN_WIDTH` 或装下为止。
 *                   **权限段不被截断**、宽度 ≤ 下限的段不可减（`Max` 这类短段
 *                   因此永不被砍）——所以这一档**四段都在**，被压缩的是最长的
 *                   非权限段；
 *   ③ FALLBACK  —— 非权限段全压到下限仍装不下（极窄屏）→ **逐字节复刻改造前
 *                   的尾部省段**：用**原始宽度**按显示顺序累加、首个超预算即
 *                   break（权限段最先被省，用户裁决的"极窄屏与今天一致"）。
 *
 * 纯函数：不改入参、不读环境、同样输入恒同样输出——`verify-launchpad.tsx`
 * 的 Q 组表驱动回归钉死三档与边界（含"撤实现必红"留证）。
 *
 * **改动本契约时必须同时更新的地方**：本模块顶部的两个常量与三条注释、
 * `Launchpad.tsx` 的接入点、`scripts/verify-launchpad.tsx` 的 Q 组、
 * `docs/interaction{,.en}.md` 与 `docs/user-guide{,.en}.md`（+ `guide/**` 副本）。
 */

/**
 * 段之间的分隔符——**与组件渲染的那串是同一个**（两侧各两格）。导出它是为了让
 * `Launchpad.tsx` 画分隔符时直接用它、别再造一份字面量：这里的宽度记账与那边
 * 画出来的字符必须是同一个决定，否则改一处就悄悄错位。
 */
export const PARAM_SEPARATOR = '  ·  '
/** 分隔符占据的显示格数（`·` 是 U+00B7，按窄字符算 1 格）。 */
const PARAM_SEPARATOR_WIDTH = stringWidth(PARAM_SEPARATOR)

/**
 * 每段被压缩后的**显示宽度下限**（含 `…`）：12 格 ≈ 11 个可见字符，仍能读出
 * 段首词（`Standard (G…`、`deepseek-fl…`）；再小就只剩两三个字符，阅读价值不
 * 足以继续挤压别的段——那时让位给兜底档更诚实。量级参照同族常量
 * `LAUNCHPAD_CONTINUE_TITLE_MAX = 16`（`launchpadActions.ts`）。
 */
export const PARAM_SEGMENT_MIN_WIDTH = 12

/**
 * **永不被截断**的段：权限 preset 名是启动第一屏唯一的安全读数（危险权限 =
 * 不审批 + 全盘写），半截的权限名和没有权限名一样不可靠。它是"截断阶段"的
 * 豁免；兜底档仍按改造前的顺序整段省（用户裁决，见模块头注释③）。
 */
export const PARAM_UNTRUNCABLE_SEGMENT = 'permission'

/**
 * 参数行的一段（与 `Launchpad.tsx` 的 `paramParts` 同形）。
 * `S` 是段的字面量联合（`LaunchpadParamSegment`），泛型原样透传、不丢字面量类型
 * ——Chat 侧按 `segment` 分派选择器。
 */
export interface ParamPart<S extends string = string> {
  /** 段的身份（焦点环、选择器分派都用它）。 */
  readonly segment: S
  /** 当前显示值（拟合前的原值）。 */
  readonly value: string
  /** 模型段带主题色（其余 dim）；原样透传给组件。 */
  readonly colored?: boolean
}

/** 拟合后的一段：显示值 + 是否被截断 + 完整名（tooltip 用）。 */
export interface FittedParamPart<S extends string = string> {
  /** 段的身份（原样透传）。 */
  readonly segment: S
  /** 最终显示值；被截断时以 `…` 结尾，其余与 `fullValue` 逐字节相同。 */
  readonly value: string
  /** 模型段带主题色（原样透传）。 */
  readonly colored?: boolean
  /** 完整名（截断前的原值）——hover tooltip 显示它。 */
  readonly fullValue: string
  /** 本段是否被尾部截断（`value !== fullValue` 的等价标志）。 */
  readonly truncated: boolean
}

/** 一行参数行的显示宽度：各段宽之和 + 分隔符 ×（段数 - 1）。 */
function lineWidth(parts: readonly { value: string }[]): number {
  let sum = 0
  for (const [index, part] of parts.entries()) {
    if (index > 0) sum += PARAM_SEPARATOR_WIDTH
    sum += stringWidth(part.value)
  }
  return sum
}

/** 一段的"原样"输出（FIT 档与兜底档都用它：`fullValue` = 原值、未截断）。 */
function fitWhole<S extends string>(part: ParamPart<S>): FittedParamPart<S> {
  return { ...part, fullValue: part.value, truncated: false }
}

/**
 * 一段的**可缩减量**：权限段恒 0（不被截断），宽度 ≤ 下限的段也是 0（减不动，
 * 例如 `Max`）——"可缩减量最大者先减"只在 > 0 的段里选。
 */
function reducibleOf(segment: string, width: number): number {
  if (segment === PARAM_UNTRUNCABLE_SEGMENT) return 0
  return Math.max(0, width - PARAM_SEGMENT_MIN_WIDTH)
}

/**
 * 挑**可缩减量最大**的段（D2 的缩减优先序；并列时取显示顺序在前的，保证同输入
 * 恒同输出）。
 *
 * @param targets - 各段的**当前**目标宽度（被压过的段已经变小）。
 * @returns 段下标；全都减不动（权限段 / 宽度 ≤ 下限的短段）时返回 `-1`。
 */
function pickMostReducible<S extends string>(parts: readonly ParamPart<S>[], targets: readonly number[]): number {
  let pick = -1
  let best = 0
  for (const [index, width] of targets.entries()) {
    const reducible = reducibleOf(parts[index].segment, width)
    if (reducible > best) {
      pick = index
      best = reducible
    }
  }
  return pick
}

/**
 * 第二档：逐步尾部截断。每轮挑可缩减量最大的段，把它压到
 * `max(下限, 当前宽度 - 剩余超宽)`。
 *
 * @param total - 四段的**原始**总宽（`fitParamParts` 已算过，避免重复记账）。
 * @returns 装得下的四段；压到各段下限仍超预算时返回 `undefined`（交给兜底档）。
 */
function fitByTruncating<S extends string>(
  parts: readonly ParamPart<S>[],
  budget: number,
  total: number,
): readonly FittedParamPart<S>[] | undefined {
  const original = parts.map(part => stringWidth(part.value))
  /** 各段**当前**的目标宽度（未被压过的保持原始宽度）。 */
  const targets = [...original]
  let overflow = total - budget
  while (overflow > 0) {
    const pick = pickMostReducible(parts, targets)
    // 全是权限段 / 宽度 ≤ 下限的段：这一档减不动了。
    if (pick < 0) return undefined
    const target = Math.max(PARAM_SEGMENT_MIN_WIDTH, targets[pick] - overflow)
    overflow -= targets[pick] - target
    targets[pick] = target
  }
  const fitted = parts.map((part, index): FittedParamPart<S> => {
    if (targets[index] >= original[index]) return fitWhole(part)
    // 尾部截断：留一格给 `…`（码位安全，CJK 不会切半个字形）。
    return { ...part, value: truncateToWidth(part.value, targets[index] - 1) + '…', fullValue: part.value, truncated: true }
  })
  // 宽度记账用**截断后的真实文本**再算一次（宽字符可能让实际值比目标更窄），
  // 只有真的 ≤ 预算才认这一档——本函数的输出恒满足"总宽 ≤ budget"。
  return lineWidth(fitted) <= budget ? fitted : undefined
}

/**
 * 第三档（兜底）：**逐字节复刻改造前的尾部省段**——用**原始宽度**按显示顺序
 * 累加、首个超预算即 break。故意不改写、不"顺手保权限"：用户裁决极窄屏形态与
 * 今天一致（v2 才考虑兜底保权限），回归（Q5/Q7）拿独立的同形循环做期望。
 */
function dropFromTail<S extends string>(parts: readonly ParamPart<S>[], budget: number): readonly FittedParamPart<S>[] {
  const fitted: FittedParamPart<S>[] = []
  let used = 0
  for (const part of parts) {
    const width = stringWidth(part.value)
    const next = fitted.length === 0 ? width : used + PARAM_SEPARATOR_WIDTH + width
    if (next > budget) break
    fitted.push(fitWhole(part))
    used = next
  }
  return fitted
}

/**
 * 参数行的宽度分配（落地页唯一的入口；组件不要再自己写累加循环）。
 *
 * @param parts - 按**显示顺序**给出的段（模型 · 思考深度 · preset · 权限）。
 * @param budget - 这一行的显示宽度预算（`max(24, min(columns - 4, 72)) - 2`）。
 * @returns 拟合后的段（新数组；FIT 档与入参逐字节等值，TRUNCATED 档四段都在）。
 */
export function fitParamParts<S extends string>(
  parts: readonly ParamPart<S>[],
  budget: number,
): readonly FittedParamPart<S>[] {
  const total = lineWidth(parts)
  // ① 装得下：原样（普通宽度下与改造前逐字节一致）。
  if (total <= budget) return parts.map(part => fitWhole(part))
  // ② 截断：四段都在，权限段一字不减。
  const truncated = fitByTruncating(parts, budget, total)
  if (truncated !== undefined) return truncated
  // ③ 兜底：今天的尾部省段。
  return dropFromTail(parts, budget)
}
