/**
 * ctx.tuiPanels — 插件侧栏 Panel 服务（设计文档 §8/§18，v2.1 修订，Phase 6）。
 *
 * 与 tuiStatus/tuiScenes 同一接缝家族：一份 Cordis-free 的进程级 store
 * （components/sidePanel/PanelStore，注册/badge/错误隔离）+ 一层薄的
 * Cordis 服务做准入（requirePluginCaller → activationFiber owner →
 * bindCallerEffect 撤下 → 能力 shadow policy → 重复 id
 * DUPLICATE_CONTRIBUTION_ID → Object.freeze descriptor）。
 *
 * 本阶段范围（§18.2 简化版）：
 * - register：宿主自动加 '<pluginId>:' 前缀；mountPolicy 强制 'active'；
 *   minColumns 默认 28；预算 = 每插件 ≤4 个 / 全局 ≤32 个。
 * - list：只读摘要（id/title/source，不含组件）。
 * - open/close：仅自己注册的 id；open 为 mutate 且限速（每插件每 5s 至多
 *   1 次，超过丢弃并记 ledger）；UI 触达经 panelBridge（useSidePanel 订阅）。
 * - badge：仅自己注册的 id → panelStore.setBadge。
 * - subscribe：仅涉及自己 Panel 的事件（registered/unregistered/badge/
 *   error/disabled，以及 useSidePanel 实际状态派生的 opened/closed/focused/
 *   blurred——去重后经 PanelStore.setPresentation 发出）。
 * - compact：分栏不在渲染时（inline、终端窄于分栏阈值、侧栏收起、整页编辑器）
 *   由 PanelCompactRows 挂在提示框上方（与富状态视图同一位置），总预算 3 行。
 * - host 共用导航动词（surface-host.ts）：openSession/openFile/copy/
 *   openScene/openPanel(+params)/useParams/toast；实现见 pluginPanelAdapter。
 */

import type React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanScalarText } from './sanitize.js'
import { activationFiber, assertCallerContext, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import type { TuiChartKit, TuiChartRowKit } from '../components/design-system/chartTypes.js'
import type { TuiJsonValue, TuiSurfaceHostApi } from './surface-host.js'
import { componentIdentityOf } from './component-identity.js'
import { isPluginNamespace } from '../pluginIdentity.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import { panelStore, type PanelStoreEvent } from '../components/sidePanel/PanelStore.js'
import type { PanelDefinition, PanelOwner } from '../components/sidePanel/types.js'
import { makePluginPanelCompactComponent, makePluginPanelComponent } from '../components/sidePanel/pluginPanelAdapter.js'
import { panelBridgeRequests } from '../components/sidePanel/panelBridge.js'
import { isTemporarySidePanelId, setTemporarySidePanelHidden } from '../tuiDisplayPrefs.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { TuiPluginStorage } from './plugin-storage.js'
import {
  countPanelsOwnedBy,
  countPluginPanels,
  deletePanelOwnerRecord,
  getPanelOwnerRecord,
  requestOwnPanelOpen,
  setPanelOwnerRecord,
  type PanelOwnerRecord,
} from './panel-runtime-registry.js'
import { clearSurfaceParams, panelParamsKey } from './surface-host.js'

export type { TuiJsonValue, TuiSurfaceHostApi, TuiSurfaceOpenFileOptions } from './surface-host.js'

/** 插件 Panel API 版本（§18.2）：descriptor.apiVersion 必须精确匹配。 */
export const TUI_PANEL_API_VERSION = 1

// 单段小写 slug（宿主自动加 '<pluginId>:' 前缀形成最终 panel id）。
const SUB_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u
const TITLE_CELLS = 80
const MIN_COLUMNS_FLOOR = 12
const MIN_COLUMNS_CEIL = 64
const DEFAULT_MIN_COLUMNS = 28
/** 每插件 Panel 预算（§18.4）。 */
export const MAX_PANELS_PER_PLUGIN = 4
/** 全局插件 Panel 注册预算（§18.4）。 */
export const MAX_PLUGIN_PANELS_TOTAL = 32
/** open() 限速窗口：每插件每窗口至多 1 次（实现与 host.openPanel 共用，见 registry）。 */
export { PANEL_OPEN_RATE_LIMIT_MS } from './panel-runtime-registry.js'

// ── 插件面 props 契约（照 TuiStatusViewUi 的收窄法）────────────────────

type TuiPanelForbiddenBoxProps =
  | 'ref'
  | 'tabIndex'
  | 'autoFocus'
  | 'onContextMenu'
  | 'onFocus'
  | 'onFocusCapture'
  | 'onBlur'
  | 'onBlurCapture'
  | 'onKeyDown'
  | 'onKeyDownCapture'

/** Box 保留 click/hover/drag/onWheel；焦点/键盘/上下文菜单被收走。 */
export type TuiPanelBoxProps = Omit<
  React.ComponentProps<typeof import('../ui.js').Box>,
  TuiPanelForbiddenBoxProps
>

export type TuiPanelTextProps = Omit<
  React.ComponentProps<typeof import('../ui.js').Text>,
  'ref'
>

/** Image 走既有图片预算/协议回退路径（与 status view 的 Image 同一通道）。 */
export type TuiPanelImageProps = React.ComponentProps<typeof import('../ui.js').Image>

export type TuiPanelScrollBoxProps = Omit<
  React.ComponentProps<typeof import('../ui.js').ScrollBox>,
  'ref'
>

export type TuiPanelDividerProps = React.ComponentProps<
  typeof import('../components/design-system/Divider.js').Divider
>

/**
 * 面板内 markdown 正文：只收字符串。宽度走面板作用域的 TerminalSizeContext
 * （PanelHost 已把 columns 收窄到面板宽），主题走只读 useTheme。
 *
 * 与上面几个**刻意不同**：它们是「直通宿主组件、只砍危险 prop」的 Omit 收窄，
 * 这两个是**新定义的包装面**——只承诺一个字段，宿主组件的 props、实现与依赖
 * 怎么改都不动这里的契约（包装在 components/sidePanel/panelMarkdown.tsx）。
 */
export interface TuiPanelMarkdownProps {
  readonly children: string
}

/** 面板内单个代码块：收原始文本 + 可选语言标签；围栏长度、语言标签清洗与
 *  语法高亮都由宿主包装层负责，插件拿不到 token 或 highlight 句柄。 */
export interface TuiPanelCodeBlockProps {
  readonly code: string
  readonly language?: string
}

/**
 * 面板内 UI kit：宿主 React + 收窄组件 + Panel 尺寸感知 + 可视化套件
 * （TuiChartKit：StackedBar/Sparkline/Meter/ColumnChart/Heatmap/Legend/
 * Table、format、seriesColor/hashSeries；实验性，docs/plugin-ui-kit-design.md
 * §1）。钩子和元素必须走宿主 React（与 plugin scene 同一 single-React 规则）。
 */
export interface TuiPanelUi extends TuiChartKit {
  readonly Box: React.ComponentType<TuiPanelBoxProps>
  readonly Text: React.ComponentType<TuiPanelTextProps>
  readonly Image: React.ComponentType<TuiPanelImageProps>
  readonly ScrollBox: React.ComponentType<TuiPanelScrollBoxProps>
  readonly Divider: React.ComponentType<TuiPanelDividerProps>
  /** 恒等于 Panel 的 { width, height }。 */
  readonly useTerminalSize: () => { readonly columns: number; readonly rows: number }
  /**
   * 面板内唯一合法定时源：内部是 useAnimationFrame(ms) 的时间值（[1]）。
   * 不暴露 hook 本体是因为其另一个返回值是必须挂到动画元素上的 ref——
   * 插件乱挂会破坏共享时钟的可见性测度；时间值本身已覆盖面板动画的
   * 全部需求（传 null 暂停）。
   */
  readonly useAnimationTime: (intervalMs: number | null) => number
  /** 只读主题。 */
  readonly useTheme: typeof import('../ui.js').useTheme
  /** 面板内 markdown 正文（实验性）；只收字符串，拿不到 token/句柄。 */
  readonly Markdown: React.ComponentType<TuiPanelMarkdownProps>
  /** 面板内单个代码块（实验性）；围栏与高亮由宿主负责。 */
  readonly CodeBlock: React.ComponentType<TuiPanelCodeBlockProps>
}

// ── 两个新成员的类型守卫（照 status.ts 的 Assert 写法）────────────────────
//
// 把「成员必须是收窄包装、不能换成原组件」钉成编译错误：一旦有人把成员换回
// `typeof Markdown` / `CodeBlockFrame`，ComponentProps 里就会重新出现
// token/highlight/dimColor 这些字段，Extract 不再是 never，Assert<false> 直接红。

type Assert<T extends true> = T

type _TuiPanelMarkdownForbidsHostProps = Assert<
  Extract<
    'dimColor' | 'cacheTokens' | 'inlineMathImages',
    keyof React.ComponentProps<TuiPanelUi['Markdown']>
  > extends never
    ? true
    : false
>

type _TuiPanelMarkdownRequiresChildren = Assert<
  'children' extends keyof React.ComponentProps<TuiPanelUi['Markdown']> ? true : false
>

type _TuiPanelCodeBlockForbidsTokensAndHandle = Assert<
  Extract<
    'token' | 'highlight' | 'dimColor' | 'forceWidth' | 'ref',
    keyof React.ComponentProps<TuiPanelUi['CodeBlock']>
  > extends never
    ? true
    : false
>

type _TuiPanelCodeBlockRequiresCode = Assert<
  'code' extends keyof React.ComponentProps<TuiPanelUi['CodeBlock']> ? true : false
>

// ── 可视化套件成员：必须是 kit 自己的收窄契约（chartTypes.ts），不是宿主组件 ──
//
// 双向钉住：成员 props 必须恰好是 kit 契约的 props；有人把成员声明换成宿主
// 内部组件（ProgressBar/ContextBarView…），props 集合就不再相等。

type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type _TuiPanelChartKitMembers = Assert<
  SameType<React.ComponentProps<TuiPanelUi['StackedBar']>, React.ComponentProps<TuiChartKit['StackedBar']>>
  & SameType<React.ComponentProps<TuiPanelUi['Sparkline']>, React.ComponentProps<TuiChartKit['Sparkline']>>
  & SameType<React.ComponentProps<TuiPanelUi['Meter']>, React.ComponentProps<TuiChartKit['Meter']>>
  & SameType<React.ComponentProps<TuiPanelUi['ColumnChart']>, React.ComponentProps<TuiChartKit['ColumnChart']>>
  & SameType<React.ComponentProps<TuiPanelUi['Heatmap']>, React.ComponentProps<TuiChartKit['Heatmap']>>
  & SameType<React.ComponentProps<TuiPanelUi['Legend']>, React.ComponentProps<TuiChartKit['Legend']>>
  & SameType<React.ComponentProps<TuiPanelUi['Table']>, React.ComponentProps<TuiChartKit['Table']>>
  & SameType<TuiPanelUi['format'], TuiChartKit['format']>
>

/** 套件成员不得暴露宿主句柄（ref、宿主内部的字面色/主题名入口）：一旦契约
 *  里长出这些字段，Extract 不再是 never，Assert<false> 直接红。 */
type _TuiPanelChartKitForbidsHostProps = Assert<
  Extract<
    'ref' | 'themeName' | 'rawColor' | 'children',
    | keyof React.ComponentProps<TuiPanelUi['StackedBar']>
    | keyof React.ComponentProps<TuiPanelUi['Sparkline']>
    | keyof React.ComponentProps<TuiPanelUi['Meter']>
    | keyof React.ComponentProps<TuiPanelUi['Table']>
  > extends never
    ? true
    : false
>

export type TuiPanelBadgeLevel = 'info' | 'warning' | 'error'
export type TuiPanelMode = 'split' | 'zoom' | 'fullscreen'

/** v2.1 键盘契约的插件视图：preventDefault() = 阻止宿主回退键。 */
export interface TuiPanelKeyEvent {
  readonly input: string
  readonly key: import('../components/sidePanel/types.js').SidePanelKeyFlags
  preventDefault(): void
}

/** 策展只读会话快照：SidePanelRuntimeContext 的结构拷贝，不含转录
 * 正文/凭证/文件内容（§18.2）。 */
export interface TuiPanelSnapshot {
  readonly sessionId: string
  readonly cwd: string
  readonly lang: string
  readonly working: boolean
  readonly spinnerMode: string
  readonly version: number
  readonly goal: Readonly<{
    readonly objective: string
    readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
    readonly roundsStarted: number
    readonly maxGoalRounds: number
  }> | undefined
  readonly todos: readonly Readonly<{ readonly content: string; readonly status: string }>[]
  readonly backgroundJobs: readonly Readonly<{
    readonly id: string
    readonly kind: string
    readonly label: string
    readonly status: string
    readonly progress?: string
    readonly detail?: string
    readonly startedAt: number
  }>[]
  readonly subagents: readonly Readonly<{
    readonly agentId: string
    readonly description: string
    readonly status: string
    readonly mode?: string
    readonly model?: string
    readonly startedAt: number
    readonly completedAt?: number
  }>[]
  readonly attention: Readonly<{ readonly approvals: number; readonly questions: number }>
  readonly activity: Readonly<Record<string, unknown>> | undefined
  /**
   * 用量（后端中立，实验性）：全部来自 ChannelUi 已有字段，与底栏 `ctx`、
   * `/tokens`、Info 面板同源——插件读它展示占用率，就与宿主的数字一致。
   */
  readonly usage: TuiPanelUsage
}

/** {@link TuiPanelSnapshot.usage}。 */
export type TuiPanelUsage = Readonly<{
  /** 上下文占用（底栏 ctx 的唯一真源）；什么都还不知道时 undefined。 */
  occupancy: Readonly<{
    usedTokens: number
    contextWindow: number | undefined
    source: 'projection' | 'backend' | 'sample'
  }> | undefined
  /** 占用的组成（启发式，只是拆分、不是总量）；meter 不发布时 undefined。 */
  breakdown: Readonly<{ systemTokens: number; toolsTokens: number; messageTokens: number }> | undefined
  /** 本会话主会话累计 token。 */
  tokens: Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number }>
  /** 后端自报花费优先；否则官方 DeepSeek 路由有计价金额时的本地估算（CNY）；都没有为 undefined。 */
  cost: Readonly<{ currency: string; amount: number; source: 'backend' | 'estimate' }> | undefined
}>

/** 面板内 host API（§18.2；sendToChat 本阶段恒 false——授权未落地）。
 *  共用导航动词（openSession/openFile/copy/openScene/openPanel/useParams/
 *  toast）见 {@link TuiSurfaceHostApi}。 */
export interface TuiPanelHostApi extends TuiSurfaceHostApi {
  /** 策展只读快照（每次调用结构拷贝）。 */
  snapshot(): TuiPanelSnapshot
  readonly focused: boolean
  notify(level: TuiPanelBadgeLevel, unread?: number): void
  clearBadge(): void
  /** 本阶段返回 false 并 toast 一次：需要 panels.chat.attach 授权（后续版本）。 */
  sendToChat(payload: { readonly title: string; readonly content: string }): boolean
  /** 自己的 tuiPluginStorage 句柄（服务未挂时 undefined）。 */
  readonly storage: TuiPluginStorage | undefined
  /** 仅 focused 期间投递（v2.1 分发器）。 */
  onKey(listener: (event: TuiPanelKeyEvent) => void): () => void
  /** 侧栏展开且自己 active 时聚焦（useSidePanel 侧裁决）。 */
  focus(): boolean
}

/** 插件 Panel 组件 props。 */
export interface TuiPanelProps {
  /** 宿主 React——所有钩子与元素必须经它（single-React 规则）。 */
  readonly React: typeof React
  readonly ui: TuiPanelUi
  readonly host: TuiPanelHostApi
  readonly width: number
  readonly height: number
  readonly focused: boolean
  readonly visible: boolean
  readonly mode: TuiPanelMode
}

/** compact 行的 kit：Box/Text + 单行可视化子集（StackedBar/Sparkline/Meter/
 *  format/seriesColor/hashSeries）。 */
export interface TuiPanelCompactUi extends Pick<TuiPanelUi, 'Box' | 'Text'>, TuiChartRowKit {}

/**
 * compact 行 props。分栏不在渲染时（inline、终端窄于分栏阈值、侧栏收起、
 * 整页编辑器打开）挂在提示框上方（富状态视图那一排）；已启用面板按启用
 * 顺序取，总预算 3 行，放不下自己 maxRows 的跳过。width = 行宽（显示单元）。
 */
export interface TuiPanelCompactProps {
  readonly React: typeof React
  readonly ui: TuiPanelCompactUi
  readonly width: number
  readonly badge: { readonly level: TuiPanelBadgeLevel; readonly unread: number } | null
  /**
   * The same curated snapshot as a panel's `host.snapshot()`, minus `version`
   * (built on call; `usage` is what the footer shows). Props stay identical
   * while nothing a row reads changed — no re-render per streamed token: the
   * function's identity only changes once the row has called it AND a
   * snapshot input (usage, goal, todos, jobs, subagents, attention, …) moved
   * since.
   */
  readonly snapshot: () => TuiPanelCompactSnapshot
}

/**
 * A compact row's snapshot. `version` bumps on every streamed delta while the
 * row re-renders only when what it shows moved, so it is left out rather than
 * handed over stale.
 */
export type TuiPanelCompactSnapshot = Omit<TuiPanelSnapshot, 'version'>

type _TuiPanelCompactUiIsRowKit = Assert<
  SameType<React.ComponentProps<TuiPanelCompactUi['StackedBar']>, React.ComponentProps<TuiChartRowKit['StackedBar']>>
  & SameType<React.ComponentProps<TuiPanelCompactUi['Meter']>, React.ComponentProps<TuiChartRowKit['Meter']>>
  & ('ColumnChart' extends keyof TuiPanelCompactUi ? false : true)
  & ('ScrollBox' extends keyof TuiPanelCompactUi ? false : true)
>

/** 注册 descriptor（§18.2）。 */
export interface TuiPanelDescriptor {
  readonly apiVersion: typeof TUI_PANEL_API_VERSION
  /** 单段小写 slug；宿主自动加 '<pluginId>:' 前缀。 */
  readonly id: string
  readonly title: string
  /** 显示宽度必须为 1。 */
  readonly icon?: string
  readonly minColumns?: number
  readonly order?: number
  readonly component?: React.ComponentType<TuiPanelProps>
  readonly compact?: {
    readonly maxRows: 1 | 2 | 3
    readonly component: React.ComponentType<TuiPanelCompactProps>
  }
}

/**
 * subscribe 的事件。opened/closed/focused/blurred 来自 useSidePanel 的实际
 * 状态（去重）：opened = 成为分栏里正在显示的面板；closed = 不再显示（切到
 * 别的标签、侧栏收起、终端变窄、退出全屏）；focused/blurred = 键盘焦点进出
 * 该面板（总在 opened 之后、closed 之前）。全屏场景盖住整个界面时不发 closed。
 */
export type TuiPanelEvent =
  | { readonly type: 'registered'; readonly id: string }
  | { readonly type: 'unregistered'; readonly id: string }
  | { readonly type: 'badge'; readonly id: string }
  | { readonly type: 'error'; readonly id: string }
  | { readonly type: 'disabled'; readonly id: string }
  | { readonly type: 'opened'; readonly id: string }
  | { readonly type: 'closed'; readonly id: string }
  | { readonly type: 'focused'; readonly id: string }
  | { readonly type: 'blurred'; readonly id: string }

/** list() 的只读摘要（不含组件）。 */
export interface TuiPanelSummary {
  readonly id: string
  readonly title: string
  readonly source: 'plugin'
}

/** Host-only facade（driver 探针用；不经插件面导出）。 */
export interface TuiPanelHost {
  register(descriptor: { readonly id: string; readonly title?: string }): () => void
  list(): readonly TuiPanelSummary[]
  open(id: string): boolean
  close(id: string): boolean
  subscribe(listener: (event: TuiPanelEvent) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiPanels: TuiPanelRuntime
  }
}

export const name = 'dsh-tui-panels'

interface PanelState {
  readonly runtime: AdapterRuntimeOptions
  host: TuiPanelHost | undefined
}

const panelStates = new WeakMap<TuiPanelRuntime, PanelState>()

function panelStateFor(runtime: TuiPanelRuntime): PanelState {
  const state = panelStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiPanels host state is unavailable')
  return state
}

/** Anonymous activation ids are session-only, never persistent identities. */
const fallbackPluginIds = new WeakMap<object, string>()
let fallbackSeq = 0

/** The namespace a panel registers under: the verified Component id whenever
 *  it fits the shared plugin-namespace grammar (manifest ids such as
 *  `com.example.echo` included), so `<pluginId>:<sub>` is a durable address
 *  `sidePanel.panels` can persist; otherwise a session-only `session:actN`. */
function pluginIdFor(caller: Context, owner: object): string {
  const identity = componentIdentityOf(caller)
  if (identity !== undefined && isPluginNamespace(identity.componentId)) {
    return identity.componentId
  }
  let fallback = fallbackPluginIds.get(owner)
  if (fallback === undefined) {
    fallbackSeq += 1
    fallback = 'session:act' + String(fallbackSeq)
    fallbackPluginIds.set(owner, fallback)
  }
  return fallback
}

/**
 * ctx.tuiPanels —— 插件侧栏 Panel 准入服务。拒绝一律 warn + 返回
 * undefined/false（与 tuiStatus.registerView 同语义），绝不抛给插件。
 */
export class TuiPanelRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiPanels')
    compositionRoot(ctx)
    const state: PanelState = {
      runtime: adapterRuntimeFor(ctx),
      host: undefined,
    }
    state.host = Object.freeze({
      register(descriptor) {
        const finalId = String(descriptor.id ?? '')
        if (!finalId.includes(':') || panelStore.get(finalId) !== undefined) {
          throw new Error('invalid or duplicate host panel id: ' + finalId)
        }
        const definition: PanelDefinition = {
          id: finalId,
          title: String(descriptor.title ?? finalId),
          source: 'plugin',
          pluginId: 'dsh-tui-host',
          mountPolicy: 'active',
          minColumns: DEFAULT_MIN_COLUMNS,
          component: () => null,
        }
        return panelStore.register(definition, 'builtin')
      },
      list() {
        return panelStore.list()
          .filter(entry => entry.definition.source === 'plugin')
          .map(entry => Object.freeze({ id: entry.definition.id, title: entry.definition.title ?? entry.definition.id, source: 'plugin' as const }))
      },
      open(id: string) {
        return panelBridgeRequests.request('open', id)
      },
      close(id: string) {
        return panelBridgeRequests.request('close', id)
      },
      subscribe(listener: (event: TuiPanelEvent) => void) {
        return panelStore.subscribe(event => {
          // hint 是宿主底栏的内部 chrome（面板自己广告键位），不进插件事件面。
          if (event.type === 'hint') return
          const entry = panelStore.get(event.id)
          if (entry?.definition.source === 'plugin') listener(event)
        })
      },
    })
    panelStates.set(this, state)
  }

  /**
   * 注册一个侧栏 Panel。成功返回 cleanup-aware disposer；拒绝 warn 并
   * 返回 undefined（feature-detect 可辨）。identity 语义与 tuiStatus
   * 相同（只喂 effect ledger 的 pluginId）。
   */
  register(descriptor: TuiPanelDescriptor, identity?: Context): (() => void) | undefined {
    assertCapabilityShadowPolicy('host.panels.register', panelStateFor(this).runtime.mode, panelStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiPanels.register', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiPanels.register requires a live non-root plugin activation')
      return undefined
    }
    if (identity !== undefined) {
      try {
        assertCallerContext(caller, identity, 'tuiPanels.register')
      } catch {
        caller.logger.warn('dsh-tui: tuiPanels.register rejected an identity belonging to another activation')
        return undefined
      }
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      caller.logger.warn('dsh-tui: tuiPanels.register requires a live activation owner')
      return undefined
    }
    const ledger = caller.get('tuiEffectLedger')

    const raw = descriptor as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected an invalid descriptor')
      return undefined
    }
    const d = raw as {
      apiVersion?: unknown
      id?: unknown
      title?: unknown
      icon?: unknown
      minColumns?: unknown
      order?: unknown
      component?: unknown
      compact?: unknown
    }
    if (d.apiVersion !== TUI_PANEL_API_VERSION) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected a descriptor with apiVersion ' + String(d.apiVersion) + ' (expected ' + TUI_PANEL_API_VERSION + ')')
      return undefined
    }
    if (typeof d.id !== 'string' || !SUB_ID_PATTERN.test(d.id)) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected an invalid panel id')
      return undefined
    }
    if (typeof d.title !== 'string' || cleanScalarText(d.title, TITLE_CELLS).length === 0) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + d.id + '" — title must be a non-empty string')
      return undefined
    }
    if (d.icon !== undefined && (typeof d.icon !== 'string' || stringWidth(d.icon) !== 1)) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + d.id + '" — icon display width must be 1')
      return undefined
    }
    if (d.component !== undefined && typeof d.component !== 'function') {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + d.id + '" — component must be a function')
      return undefined
    }
    let compactMaxRows: 1 | 2 | 3 | undefined
    let compactComponent: unknown
    if (d.compact !== undefined) {
      if (typeof d.compact !== 'object' || d.compact === null) {
        caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + d.id + '" — invalid compact descriptor')
        return undefined
      }
      const rows = (d.compact as { maxRows?: unknown }).maxRows
      if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > 3) {
        caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + d.id + '" — compact.maxRows must be an integer from 1 to 3')
        return undefined
      }
      compactComponent = (d.compact as { component?: unknown }).component
      if (typeof compactComponent !== 'function') {
        caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + d.id + '" — compact.component must be a function')
        return undefined
      }
      compactMaxRows = rows as 1 | 2 | 3
    }
    if (d.component === undefined && d.compact === undefined) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + d.id + '" — at least one of component/compact is required')
      return undefined
    }
    if (d.minColumns !== undefined
      && (typeof d.minColumns !== 'number' || !Number.isInteger(d.minColumns) || d.minColumns < MIN_COLUMNS_FLOOR || d.minColumns > MIN_COLUMNS_CEIL)) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + d.id + '" — minColumns must be an integer from ' + MIN_COLUMNS_FLOOR + ' to ' + MIN_COLUMNS_CEIL)
      return undefined
    }
    if (d.order !== undefined && (typeof d.order !== 'number' || !Number.isFinite(d.order))) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + d.id + '" — order must be a finite number')
      return undefined
    }

    const pluginId = pluginIdFor(caller, owner)
    const finalId = pluginId + ':' + d.id
    if (panelStore.get(finalId) !== undefined) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + finalId + '" — already registered')
      ledger?.record(
        { operation: 'bind', resource: { kind: 'panel', id: finalId }, result: 'failed', errorCode: 'DUPLICATE_CONTRIBUTION_ID' },
        identity,
      )
      return undefined
    }
    if (countPanelsOwnedBy(owner) >= MAX_PANELS_PER_PLUGIN) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + finalId + '" — a plugin may register at most ' + MAX_PANELS_PER_PLUGIN + ' panels')
      ledger?.record(
        { operation: 'bind', resource: { kind: 'panel', id: finalId }, result: 'failed', errorCode: 'PANEL_BUDGET_EXCEEDED' },
        identity,
      )
      return undefined
    }
    if (countPluginPanels() >= MAX_PLUGIN_PANELS_TOTAL) {
      caller.logger.warn('dsh-tui: tuiPanels.register rejected "' + finalId + '" — ' + MAX_PLUGIN_PANELS_TOTAL + ' plugin panels are already registered')
      ledger?.record(
        { operation: 'bind', resource: { kind: 'panel', id: finalId }, result: 'failed', errorCode: 'PANEL_BUDGET_EXCEEDED' },
        identity,
      )
      return undefined
    }

    const title = cleanScalarText(d.title, TITLE_CELLS)
    // One record per registration: the rendered panel's host verbs are bound
    // to it, so they refuse once this registration is gone — a reload that
    // registers the same id gets a record of its own.
    const ownerRecord: PanelOwnerRecord = { id: finalId, caller, owner, pluginId, lastOpenAt: 0 }
    const definition: PanelDefinition = Object.freeze({
      id: finalId,
      title,
      icon: d.icon,
      order: d.order,
      minColumns: d.minColumns ?? DEFAULT_MIN_COLUMNS,
      source: 'plugin',
      pluginId,
      // v2.1：插件 Panel 强制 active 挂载（防常驻面板烧资源）。
      mountPolicy: 'active',
      component: makePluginPanelComponent(finalId, (d.component ?? (() => null)) as React.ComponentType<TuiPanelProps>, ownerRecord),
      compact: compactMaxRows === undefined
        ? undefined
        : {
          maxRows: compactMaxRows,
          component: makePluginPanelCompactComponent(finalId, compactComponent as React.ComponentType<TuiPanelCompactProps>),
        },
    })
    const ownerTag: PanelOwner = { pluginId, activation: owner }
    // owner record 先于 store 注册：register() 同步发出 registered（屏上面板
    // 重注册时还会重放 opened/focused），subscribe 的过滤要靠这条记录认主。
    setPanelOwnerRecord(finalId, ownerRecord)
    let unregister: () => void
    try {
      unregister = panelStore.register(definition, ownerTag)
    } catch (error) {
      deletePanelOwnerRecord(finalId)
      throw error
    }
    // 注册只动注册表：启用集合由 `sidePanel.panels` 的值派生
    // （`*` = 全部已注册面板），注册路径绝不改写设置或 live store。

    let disposed = false
    let ownerCleanup: (() => unknown) | undefined
    const dispose = () => {
      if (disposed) return
      disposed = true
      // 先撤 store（unregistered 事件还需 owner record 做订阅过滤），再清
      // owner 数据。
      unregister()
      deletePanelOwnerRecord(finalId)
      clearSurfaceParams(panelParamsKey(finalId))
      // 临时面板的「本次运行隐藏」随这一次注册一起结束：同一个 activation
      // 再次注册拿到的是同一个 session:actN:x，重新注册是一次新的贡献
      // （与旧机制在注册时清掉显式移除同义），不能让它一出生就被藏住。
      if (isTemporarySidePanelId(finalId)) setTemporarySidePanelHidden(finalId, false)
      caller.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'panel', id: finalId }, result: 'applied' },
        identity,
      )
      const cleanup = ownerCleanup
      ownerCleanup = undefined
      cleanup?.()
    }
    const bound = bindCallerEffect(caller, dispose, cleanup => {
      ownerCleanup = cleanup
    })
    if (!bound) return undefined
    ledger?.record(
      { operation: 'bind', resource: { kind: 'panel', id: finalId }, result: 'applied' },
      identity,
    )
    return dispose
  }

  /** 只读摘要（仅自己注册的 Panel；不含组件）。 */
  list(): readonly TuiPanelSummary[] {
    assertCapabilityShadowPolicy('host.panels.list', panelStateFor(this).runtime.mode, panelStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiPanels.list', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return []
    return panelStore.list()
      .filter(entry => entry.definition.source === 'plugin' && getPanelOwnerRecord(entry.definition.id)?.owner === owner)
      .map(entry => Object.freeze({
        id: entry.definition.id,
        title: entry.definition.title ?? entry.definition.id,
        source: 'plugin' as const,
      }))
  }

  /**
   * 打开自己注册的 Panel（展开侧栏并聚焦），可带深链参数（JSON，≤16 KiB，
   * 冻结深拷贝；面板内 `host.useParams()` 读回）。mutate + 限速：每插件每
   * 5s 至多 1 次，超限丢弃并记 ledger；面板已在分栏里显示时与场景重开同义，
   * 只更新参数并返回 true，不计限速。返回 false = 未注册/不属于自己的
   * id、参数非法、超限、或没有活的 Chat 控制器消费请求。
   */
  open(id: string, params?: TuiJsonValue): boolean {
    assertCapabilityShadowPolicy('host.panels.open', panelStateFor(this).runtime.mode, panelStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiPanels.open', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return false
    return requestOwnPanelOpen(caller, owner, id, params)
  }

  /** 关闭自己注册的 Panel：若它是当前 active Panel，则收起侧栏。 */
  close(id: string): boolean {
    assertCapabilityShadowPolicy('host.panels.close', panelStateFor(this).runtime.mode, panelStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiPanels.close', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return false
    const record = getPanelOwnerRecord(String(id ?? ''))
    if (record === undefined || record.owner !== owner) {
      caller.logger.warn('dsh-tui: tuiPanels.close rejected "' + String(id) + '" — not registered by this activation')
      return false
    }
    return panelBridgeRequests.request('close', String(id))
  }

  /** 设置/清除自己 Panel 的 badge。 */
  badge(id: string, badge: { level: TuiPanelBadgeLevel; unread: number } | null): boolean {
    assertCapabilityShadowPolicy('host.panels.badge', panelStateFor(this).runtime.mode, panelStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiPanels.badge', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return false
    const record = getPanelOwnerRecord(String(id ?? ''))
    if (record === undefined || record.owner !== owner) {
      caller.logger.warn('dsh-tui: tuiPanels.badge rejected "' + String(id) + '" — not registered by this activation')
      return false
    }
    if (badge === null) {
      panelStore.clearBadge(String(id))
      return true
    }
    if (typeof badge !== 'object' || !['info', 'warning', 'error'].includes(String((badge as { level?: unknown }).level))
      || typeof (badge as { unread?: unknown }).unread !== 'number') {
      caller.logger.warn('dsh-tui: tuiPanels.badge rejected an invalid badge')
      return false
    }
    panelStore.setBadge(String(id), {
      level: (badge as { level: TuiPanelBadgeLevel }).level,
      unread: (badge as { unread: number }).unread,
    })
    return true
  }

  /** 订阅涉及自己 Panel 的事件（registered/unregistered/badge/error/
   * disabled 与 opened/closed/focused/blurred；屏上面板被重注册时，新注册
   * 紧跟 registered 收到重放的 opened/focused）。 */
  subscribe(listener: (event: TuiPanelEvent) => void): () => void {
    assertCapabilityShadowPolicy('host.panels.subscribe', panelStateFor(this).runtime.mode, panelStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiPanels.subscribe', this)
    const owner = activationFiber(caller)
    if (owner === undefined || typeof listener !== 'function') return () => {}
    const wrapped = (event: PanelStoreEvent): void => {
      // 同上：hint 只是宿主底栏的 chrome，不派发给插件订阅者。
      if (event.type === 'hint') return
      const record = getPanelOwnerRecord(event.id)
      if (record === undefined || record.owner !== owner) return
      try {
        listener(event)
      } catch (error) {
        caller.logger.warn('dsh-tui: tuiPanels listener failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    const dispose = panelStore.subscribe(wrapped)
    bindCallerEffect(caller, dispose)
    return dispose
  }
}

export function getHostPanelRuntime(runtime: TuiPanelRuntime | undefined): TuiPanelHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return panelStateFor(runtime).host ?? undefined
  } catch {
    return undefined
  }
}

export default TuiPanelRuntime
