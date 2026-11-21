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
import type { TrajBuild } from '../../dsh-adapter/trajectory/index.js'
import type { SidePanelRuntime } from './types.js'

export interface SidePanelRuntimeContextValue {
  readonly runtime: SidePanelRuntime
  readonly channel: ChannelUi
  /** workingActivity 投影（Companion 等 Panel 用；activity 插件未装时
   *  缺省，Panel 退回 channel.working / spinnerMode）。 */
  readonly activity?: ActivityView
  /** Chat 的审批 / 问卷待处理快照（Companion 的 attention 输入）。 */
  readonly attention?: { readonly approvals: number; readonly questions: number }
  /** 会话轨迹投影（Chat 折叠的那一份，与全屏轨迹场景共用；未折叠完成为
   *  undefined）。轨迹 Panel 直接渲染它，不自己再折一次。 */
  readonly trajectory?: TrajBuild
  /** 「全屏」出口：把某个 Panel 的内容切到整屏形态（PanelBar 的 ⤢ 用它）。
   *  未接（或该 Panel 没有整屏形态）时 undefined，按钮照画但点击无效——
   *  宿主是否可展开由 PanelDefinition.capabilities.fullscreen 决定。 */
  readonly openFullscreen?: (panelId: string) => void
  /** 「回主输入框」出口：Panel 把内容送聊天（attachContext）后把列焦点交回
   *  聊天——chip 就在眼前、可直接接着打字，toast 里的「Esc 可撤」也立刻
   *  成立（剥 chip 的那把 Esc 只有主输入框有焦点时才收得到）。宿主
   *  （PanelHost）从 controller.focusChat 注入；未接时送完焦点不动。 */
  readonly focusChat?: () => void
  /** 激活右栏焦点（如右键菜单选中面板内行时确保右栏获得焦点）。 */
  readonly focusPanel?: () => void
  /** 插件生命周期动作入口（enable/disable/remove）：委托给 Chat 的确认/回滚浮层。 */
  readonly managePlugin?: (action: 'enable' | 'disable' | 'remove', bundleName: string) => void
  /** 插件面板 `d` 出口：把完整诊断写进转录并聚焦聊天。 */
  readonly showPluginDiagnostics?: () => void
  /** 空列表/面板内 `i` 键触发插件安装引导（切回主输入框预填 `/plugin install `）。 */
  readonly installPlugin?: () => void
  /** Chat 侧插件写操作结算后的单调版本号（供无 `plugin-manager/changed` 桩或局部流程刷新）。 */
  readonly pluginWriteRevision?: number
}

export const SidePanelRuntimeContext = React.createContext<SidePanelRuntimeContextValue | null>(null)

export function useSidePanelChannel(): ChannelUi {
  const ctx = React.useContext(SidePanelRuntimeContext)
  if (ctx === null) throw new Error('useSidePanelChannel must be used under PanelHost')
  return ctx.channel
}

/** 会话轨迹投影；Chat 还没折叠出来（或不在 PanelHost 下）时 undefined。 */
export function useSidePanelTrajectory(): TrajBuild | undefined {
  return React.useContext(SidePanelRuntimeContext)?.trajectory
}

/** 「全屏」出口：宿主没接时返回 undefined（按钮点击静默无效）。 */
export function useSidePanelFullscreen(): ((panelId: string) => void) | undefined {
  return React.useContext(SidePanelRuntimeContext)?.openFullscreen
}

/** 「回主输入框」出口：宿主没接时返回 undefined（送聊天后焦点不动）。 */
export function useSidePanelFocusChat(): (() => void) | undefined {
  return React.useContext(SidePanelRuntimeContext)?.focusChat
}

/** 激活右栏焦点出口；未接时返回 undefined。 */
export function useSidePanelFocusPanel(): (() => void) | undefined {
  return React.useContext(SidePanelRuntimeContext)?.focusPanel
}

export interface SidePanelPluginActions {
  readonly managePlugin?: (action: 'enable' | 'disable' | 'remove', bundleName: string) => void
  readonly installPlugin?: () => void
  readonly pluginWriteRevision?: number
  readonly showPluginDiagnostics?: () => void
}

/** 插件面板宿主动作与写结算版本号；未接时字段为 undefined。 */
export function useSidePanelPluginActions(): SidePanelPluginActions {
  const ctx = React.useContext(SidePanelRuntimeContext)
  return {
    managePlugin: ctx?.managePlugin,
    installPlugin: ctx?.installPlugin,
    pluginWriteRevision: ctx?.pluginWriteRevision,
    showPluginDiagnostics: ctx?.showPluginDiagnostics,
  }
}

export const PanelContext = React.createContext<{ readonly panelId: string } | null>(null)
