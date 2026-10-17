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
 * - subscribe：仅涉及自己 Panel 的事件（本阶段 registered/unregistered/
 *   badge/error/disabled；opened/closed/focused/blurred/sidebar-toggled 事件
 *   源在 useSidePanel 侧，留 TODO）。
 * - compact：descriptor 校验 + 存档，渲染槽不挂载（TODO §18.1）。
 */

import type React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanScalarText } from './sanitize.js'
import { activationFiber, assertCallerContext, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import { componentIdentityOf } from './component-identity.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import { panelStore, type PanelStoreEvent } from '../components/sidePanel/PanelStore.js'
import type { PanelDefinition, PanelOwner } from '../components/sidePanel/types.js'
import { makePluginPanelComponent } from '../components/sidePanel/pluginPanelAdapter.js'
import { panelBridgeRequests } from '../components/sidePanel/panelBridge.js'
import { applySidePanelPanels, getSidePanelPanels, parseSidePanelIds } from '../tuiDisplayPrefs.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { TuiPluginStorage } from './plugin-storage.js'
import {
  countPanelsOwnedBy,
  countPluginPanels,
  deletePanelOwnerRecord,
  getPanelOwnerRecord,
  setPanelOwnerRecord,
} from './panel-runtime-registry.js'

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
/** open() 限速窗口：每插件每窗口至多 1 次。 */
export const PANEL_OPEN_RATE_LIMIT_MS = 5_000

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
 * 面板内 UI kit：宿主 React + 收窄组件 + Panel 尺寸感知。钩子和元素
 * 必须走宿主 React（与 plugin scene 同一 single-React 规则）。
 */
export interface TuiPanelUi {
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
}

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
}

/** 面板内 host API（§18.2；sendToChat 本阶段恒 false——授权未落地）。 */
export interface TuiPanelHostApi {
  /** 策展只读快照（每次调用结构拷贝）。 */
  snapshot(): TuiPanelSnapshot
  readonly focused: boolean
  notify(level: TuiPanelBadgeLevel, unread?: number): void
  clearBadge(): void
  /** 本阶段返回 false 并 toast 一次：需要 panels.chat.attach 授权（后续版本）。 */
  sendToChat(payload: { readonly title: string; readonly content: string }): boolean
  /** 仅打开自己注册的全屏场景（tuiScenes 做 owner 校验）。 */
  openScene(id: string): boolean
  toast(text: string): boolean
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

/** compact 行 props（本阶段仅校验，不挂载渲染——槽位 TODO §18.1）。 */
export interface TuiPanelCompactProps {
  readonly React: typeof React
  readonly ui: Pick<TuiPanelUi, 'Box' | 'Text'>
  readonly width: number
  readonly badge: { readonly level: TuiPanelBadgeLevel; readonly unread: number } | null
}

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

/** subscribe 的事件（本阶段：注册/撤下/badge/错误/禁用；opened/closed/
 * focused/blurred/sidebar-toggled 的事件源在 useSidePanel 侧，留 TODO）。 */
export type TuiPanelEvent =
  | { readonly type: 'registered'; readonly id: string }
  | { readonly type: 'unregistered'; readonly id: string }
  | { readonly type: 'badge'; readonly id: string }
  | { readonly type: 'error'; readonly id: string }
  | { readonly type: 'disabled'; readonly id: string }

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

/** 裸挂载（测试夹具、运行期 ctx.plugin）的兜底命名空间：按 activation
 * fiber 发号。只服务这两种用例——生产插件走 Component identity 或 loader
 * 条目 id。发号器**不能**当生产路径：面板 id 会被写进用户设置当长期地址
 * （`dsh-tui.sidePanel.panels` 里的 `<pluginId>:<id>`），按激活顺序发号意味着
 * 组合一变（另一个同类插件先注册面板）同一个插件就换号，旧持久项没人认领。
 *
 * `act<N>` 因此是发号器的**保留区**：稳定来源（Component id / loader 条目 id）
 * 撞上这个形状一律不算稳定身份（stablePluginId），否则一个合法却恰叫 `act1`
 * 的条目会和自动发号抢同一个前缀——条目先拿到 `act1` 却不推进计数器，它第一个
 * 运行期子插件随后也领到 `act1`，同名局部 id 被 DUPLICATE_CONTRIBUTION_ID 拒掉；
 * 反过来自动发号先占了 `act1` 时，同名的条目同样会和它撞上。 */
const fallbackPluginIds = new WeakMap<object, string>()
let fallbackSeq = 0
const SYNTHETIC_PLUGIN_ID_PATTERN = /^act[0-9]+$/u

/** 稳定命名空间：单段小写 slug，且不占用发号器的保留区 `act<N>`。
 * Component id 那边其实够不着保留区——manifest 校验要求 id 带 `.`/`-` 分隔符，
 * 而 `act<N>` 是纯数字后缀，形状上撞不上；两条来源共用这一条判定是防御性的
 * （上游哪天放宽 id 规则，规则仍然成立，不必两处改）。 */
function stablePluginId(name: string): string | undefined {
  return SUB_ID_PATTERN.test(name) && !SYNTHETIC_PLUGIN_ID_PATTERN.test(name) ? name : undefined
}

/** 组合层加在每条入口 id 前面的路径前缀。app-boot 用根 Include 装载整个组合树
 * （mountRootInclude，条目 id 就是 'include'），cordis-loader 的 Entry 取 id 时
 * 拼成父条目 id + EntryTree.sep + options.id（Entry.id getter）。真机上每个
 * bundle 条目与用户 patch 条目都这样进来——所以条目 id 的常态是带前缀的，不是
 * 边角。宿主自己的插件清单在显示条目身份时也把这个前缀当「组合专用标记」剥掉
 * （dsh-client-ui-settings-plugin-inventory），剥离后剩下的才是用户写进
 * cordis.yml / cordis.patch.yml、跨重启稳定的那个 id。
 *
 * 只剥这一层，而且要求运行时 id **恰好**是前缀 + 这一行自己配置的 id：仅仅撞上
 * 前缀的直接根条目（loader 允许 id 带冒号）不算组合行，不能被剥成别人的命名
 * 空间。剥完仍带分隔符的（嵌套 Include 子树的 'include:<a>:<b>'，或行 id 自己
 * 就带冒号）继续按多段拒绝——面板 id 的读取方按第一个冒号切分，多段根本没有
 * 表达方式。 */
const COMPOSITION_MARKER = 'include:'

/** 条目 id 的稳定命名空间：直接是单段 slug，或是剥掉组合标记后的单段 slug。
 * 组合层的剥法见 COMPOSITION_MARKER（必须是这一行自己的 id，不是前缀撞对）。 */
function stableEntryPluginId(entry: { id?: unknown; options?: { id?: unknown } }): string | undefined {
  const id = entry.id
  if (typeof id !== 'string') return undefined
  const direct = stablePluginId(id)
  if (direct !== undefined) return direct
  const configured = entry.options?.id
  if (typeof configured !== 'string' || id !== COMPOSITION_MARKER + configured) return undefined
  return stablePluginId(configured)
}

/** loader 条目（cordis.yml / cordis.patch.yml 里的一行）**直接**拥有这个激活时，
 * 它的 `id` 就是那个稳定可读的地址：用户自己写的、跨重启不变。
 *
 * 「直接拥有」是硬条件，不能只看 `entry.id`：条目自己的根 fiber 才等于
 * `entry.fiber`（`Entry._init` 里 `registry.plugin()` 的返回值）。运行期
 * `ctx.plugin()` 挂出的子插件会沿上下文继承父条目的 `entry`（loader 的
 * `internal/plugin` 监听直接把 `fiber.parent[Entry.key]` 赋给子 fiber），
 * 只认 id 的话一个条目下父子注册同名面板就会挤在同一个 `<entry>:<id>` 上，
 * 后注册的被 DUPLICATE_CONTRIBUTION_ID 拒绝；继承来的条目不算数，落回 actN。
 *
 * 组合标记要先剥掉：根 Include 装载的条目运行时 id 是 `include:<id>`，且必须
 * 恰好等于 `include:` + 这一行配置的 id（见 COMPOSITION_MARKER）。剥完仍是
 * 多段的 id（嵌套 Include 子树的 `a:b`）照旧拒绝；
 * 发号器保留的 `act<N>` 形状同样不算稳定身份（见 stablePluginId），因为面板
 * id 的读取方按**第一个**冒号切分（SidePanelColumn 的 bare 标题推导）。
 * locate() 那种向祖先上溯的归属更不行，那样运行期挂载会被记到宿主条目名下
 * （`dsh-tui:search`），比 actN 更误导。 */
function loaderEntryIdFor(owner: object): string | undefined {
  try {
    const entry = (owner as {
      entry?: { id?: unknown; options?: { id?: unknown }; fiber?: unknown } | null
    }).entry
    if (entry === undefined || entry === null || entry.fiber !== owner) return undefined
    return stableEntryPluginId(entry)
  } catch {
    return undefined
  }
}

function pluginIdFor(caller: Context, owner: object): string {
  const identity = componentIdentityOf(caller)
  if (identity !== undefined) {
    const stable = stablePluginId(identity.componentId)
    if (stable !== undefined) return stable
  }
  const entryId = loaderEntryIdFor(owner)
  if (entryId !== undefined) return entryId
  let fallback = fallbackPluginIds.get(owner)
  if (fallback === undefined) {
    fallbackSeq += 1
    fallback = 'act' + String(fallbackSeq)
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
      component: makePluginPanelComponent(finalId, (d.component ?? (() => null)) as React.ComponentType<TuiPanelProps>),
      // compact 本阶段只校验不挂载（渲染槽 TODO §18.1）。
      compact: compactMaxRows === undefined ? undefined : { maxRows: compactMaxRows, component: () => null },
    })
    const ownerTag: PanelOwner = { pluginId, activation: owner }
    const unregister = panelStore.register(definition, ownerTag)
    setPanelOwnerRecord(finalId, { caller, owner, pluginId, lastOpenAt: 0 })
    // 注册即入侧栏启用列表（PanelBar 可见；/panel 与 /settings 仍可移除）。
    enablePanelIdInStore(finalId)

    let disposed = false
    let ownerCleanup: (() => unknown) | undefined
    const dispose = () => {
      if (disposed) return
      disposed = true
      // 先撤 store（unregistered 事件还需 owner record 做订阅过滤），再清
      // owner 数据与启用列表。
      unregister()
      deletePanelOwnerRecord(finalId)
      disablePanelIdInStore(finalId)
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
   * 打开自己注册的 Panel（展开侧栏并聚焦）。mutate + 限速：每插件每
   * 5s 至多 1 次，超限丢弃并记 ledger。返回 false = 未注册/不属于自己的
   * id、超限、或没有活的 Chat 控制器消费请求。
   */
  open(id: string): boolean {
    assertCapabilityShadowPolicy('host.panels.open', panelStateFor(this).runtime.mode, panelStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiPanels.open', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return false
    const record = getPanelOwnerRecord(String(id ?? ''))
    if (record === undefined || record.owner !== owner) {
      caller.logger.warn('dsh-tui: tuiPanels.open rejected "' + String(id) + '" — not registered by this activation')
      return false
    }
    // 无 Chat 消费者：直接 false，不消耗限速窗口（请求从未送达）。
    if (!panelBridgeRequests.hasConsumer()) return false
    const now = Date.now()
    if (now - record.lastOpenAt < PANEL_OPEN_RATE_LIMIT_MS) {
      caller.logger.warn('dsh-tui: tuiPanels.open dropped "' + String(id) + '" — rate limited to one open per ' + PANEL_OPEN_RATE_LIMIT_MS + 'ms')
      caller.get('tuiEffectLedger')?.record(
        { operation: 'bind', resource: { kind: 'panel', id: String(id) }, result: 'failed', errorCode: 'RATE_LIMITED' },
      )
      return false
    }
    if (!panelBridgeRequests.request('open', String(id))) return false
    record.lastOpenAt = now
    return true
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

  /** 订阅涉及自己 Panel 的事件（本阶段 registered/unregistered/badge/
   * error/disabled；opened/closed/focused/blurred/sidebar-toggled TODO）。 */
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

// ── 启用列表接线（tuiDisplayPrefs 的 panels CSV；无环的 module store）──

/** 本进程内由插件注册、尚未撤下的面板 id：配置应用时并回启用 CSV，免得
 * 先于 dsh-tui 行注册的面板被配置覆盖挤掉。 */
const registeredPanelIds = new Set<string>()

/** 用户在 /settings 显式移除的已注册面板 id（Session 级）：配置 CSV 分辨不出
 * 「用户移除了它」与「文档还不知道它」，没有这份记录并集会把它一次次并回。 */
const removedPanelIds = new Set<string>()

/** 注册成功后把最终 id 追加进侧栏启用 CSV（已存在则不动）——注册即
 * 可见：PanelBar 出胶囊、open()/1-9/z 生效；/panel 与 /settings 仍可移除。
 * 重新注册是一次新的贡献：上一轮的显式移除不再对它生效。 */
function enablePanelIdInStore(id: string): void {
  registeredPanelIds.add(id)
  removedPanelIds.delete(id)
  const ids = [...parseSidePanelIds(getSidePanelPanels())]
  if (!ids.includes(id)) ids.push(id)
  applySidePanelPanels(ids.join(','))
}

/** 撤下时把最终 id 从启用 CSV 摘掉（PanelHost 对缺失的 active 自动回
 * 退到第一个已启用 Panel），并从注册集合里移除，后续配置应用不再并回。 */
function disablePanelIdInStore(id: string): void {
  registeredPanelIds.delete(id)
  const ids = parseSidePanelIds(getSidePanelPanels()).filter(candidate => candidate !== id)
  applySidePanelPanels(ids.join(','))
}

/** 应用 `sidePanel.panels` 配置，已注册的面板 id 并回尾部（除非被显式移除）。 */
export function applyConfiguredSidePanelPanels(configured: string | undefined): void {
  const ids = [...parseSidePanelIds(configured ?? getSidePanelPanels())]
  for (const id of registeredPanelIds) {
    if (removedPanelIds.has(id) || ids.includes(id)) continue
    ids.push(id)
  }
  applySidePanelPanels(ids.join(','))
}

/**
 * /settings 编辑那一跳：先记下用户删掉的已注册 id，再走并集。boot settings **不得**走这里——
 * 那时 CSV 缺席的已注册 id 只说明它注册得晚，不是用户移除。
 */
export function applySidePanelPanelsFromSettings(configured: string | undefined): void {
  if (configured !== undefined) {
    const ids = new Set(parseSidePanelIds(configured))
    for (const id of registeredPanelIds) if (!ids.has(id)) removedPanelIds.add(id)
  }
  applyConfiguredSidePanelPanels(configured)
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
