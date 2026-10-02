/**
 * Panel 系统的核心契约（设计文档 §6.2 + v2.1 修订）。
 *
 * Panel 不知道自己在右侧、比例多少、终端总宽多少；只知道 width /
 * height / focused / visible / mode。以后把侧栏改到底部，Panel 不用重写。
 */
import type React from 'react'
import type { I18nKey } from '../../i18n.js'

export type PanelMountPolicy =
  /** 只有 active 时才挂载（插件默认——防止常驻面板烧资源）。 */
  | 'active'
  /** 启用即挂载，非 active 时 display:none + focused/visible=false——
   *  状态（计时、内部路由、滚动位）保留，但不动画、不收键盘（内置
  todo/jobs/agents/companion 用）。 */
  | 'enabled'

export interface PanelCapabilities {
  readonly scroll?: boolean
  readonly search?: boolean
  readonly selection?: boolean
  readonly zoom?: boolean
  readonly sendToChat?: boolean
  /** 有整屏对应物：PanelBar 右端出现 ⤢「全屏」按钮（点击交给宿主
   *  openFullscreen(panelId)）。没有整屏形态的面板不声明，按钮不出现。 */
  readonly fullscreen?: boolean
}

export interface PanelProps {
  readonly width: number
  readonly height: number
  readonly focused: boolean
  /** 非 active（mountPolicy=enabled 时仍挂载）或侧栏收起时 false：
   *  组件应停掉高频刷新（useAnimationFrame 传 null），store 继续更新。 */
  readonly visible: boolean
  readonly mode: 'split' | 'zoom' | 'fullscreen'
}

export interface PanelCompactProps {
  readonly width: number
  readonly badge: PanelBadge | null
}

export interface PanelDefinition {
  /** /^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)*$/；插件用 plugin:sub 命名空间。 */
  readonly id: string
  /** 内置 Panel 走 i18n key；插件给字面量 title。 */
  readonly titleKey?: I18nKey
  readonly title?: string
  /** PanelBar 胶囊里的单格图标（显示宽度必须为 1；缺省用首字母）。 */
  readonly icon?: string
  readonly order?: number
  /** 低于此宽度时 PanelBar 照显、Host 提示「宽度不足」。 */
  readonly minColumns?: number
  readonly defaultEnabled?: boolean
  readonly source: 'builtin' | 'plugin'
  readonly pluginId?: string
  readonly mountPolicy?: PanelMountPolicy
  readonly capabilities?: PanelCapabilities
  readonly component: React.ComponentType<PanelProps>
  /** 可选的 1~3 行紧凑呈现（侧栏收起/窄屏时的紧凑槽，Phase 6 挂载）。 */
  readonly compact?: {
    readonly maxRows: 1 | 2 | 3
    readonly component: React.ComponentType<PanelCompactProps>
  }
}

export type PanelOwner = 'builtin' | { readonly pluginId: string; readonly activation?: unknown }

export interface PanelBadge {
  readonly level: 'info' | 'warning' | 'error'
  readonly unread: number
  readonly latestAt: number
}

export interface PanelEntry {
  readonly definition: PanelDefinition
  readonly owner: PanelOwner
  /** 同 id 重注册时递增，用于重挂 error boundary。 */
  readonly registrationId: number
  readonly badge: PanelBadge | null
  readonly lastError: { readonly message: string; readonly at: number } | null
  /** 插件 Panel 连续崩溃后本会话内禁用（PanelHost 渲染禁用卡）。 */
  readonly disabled?: boolean
}

/** 侧栏按键事件（v2.1：Panel 的业务键优先于宿主回退键）。 */
export interface SidePanelKeyFlags {
  readonly escape?: boolean
  readonly leftArrow?: boolean
  readonly rightArrow?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly pageUp?: boolean
  readonly pageDown?: boolean
  readonly return_?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
}

/** 返回 true = 已消费（宿主回退键不再触发）。 */
export type PanelKeyHandler = (input: string, key: SidePanelKeyFlags) => boolean | void

/**
 * 侧栏运行时：PanelHost / usePanelInput 与 useSidePanel 之间的接缝。
 * 由 useSidePanel 创建（Chat 侧），经 context 抵达右栏子树。
 */
export interface SidePanelRuntime {
  /** 注册 Panel 的键盘处理器；enabled=false 时保留注册但不投递。 */
  registerInput: (panelId: string, handler: PanelKeyHandler, enabled: boolean) => () => void
  /** 键盘分发的第一棒：焦点在右栏时先问活动 Panel 吃不吃这个键。 */
  dispatchKey: (panelId: string, input: string, key: SidePanelKeyFlags) => boolean
}
