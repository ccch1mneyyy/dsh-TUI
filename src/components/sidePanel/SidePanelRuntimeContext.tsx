/**
 * 侧栏 context 两件套：
 * - SidePanelRuntimeContext：useSidePanel 创建的运行时（键盘分发）+
 *   当前 channel（内置 Adapter 的数据源；插件 Panel 不经过这里，它们
 *   在 Phase 6 拿策展快照）。
 * - PanelContext：PanelHost 为每个 Panel 子树提供的身份（panelId），
 *   usePanelInput 据此把业务键注册进分发器；不在 Panel 里（整屏
 *   形态）时为 null，usePanelInput 退化为普通 useInput。
 */
import React from 'react'
import type { ChannelUi } from '../../adapter/channel/ui-policy.js'
import type { ActivityView } from '../../dsh-adapter/activity-store.js'
import type { SidePanelRuntime } from './types.js'

export interface SidePanelRuntimeContextValue {
  readonly runtime: SidePanelRuntime
  readonly channel: ChannelUi
  /** workingActivity 投影（Companion 等 Panel 用；activity 插件未装时
   *  缺省，Panel 退回 channel.working / spinnerMode）。 */
  readonly activity?: ActivityView
  /** Chat 的审批 / 问卷待处理快照（Companion 的 attention 输入）。 */
  readonly attention?: { readonly approvals: number; readonly questions: number }
}

export const SidePanelRuntimeContext = React.createContext<SidePanelRuntimeContextValue | null>(null)

export function useSidePanelChannel(): ChannelUi {
  const ctx = React.useContext(SidePanelRuntimeContext)
  if (ctx === null) throw new Error('useSidePanelChannel must be used under PanelHost')
  return ctx.channel
}

export const PanelContext = React.createContext<{ readonly panelId: string } | null>(null)
