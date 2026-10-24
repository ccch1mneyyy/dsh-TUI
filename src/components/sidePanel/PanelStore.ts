/**
 * PanelStore：Panel 定义 + 运行时状态（badge / 最近错误）一个 store
 * （设计文档 §6.4 / §16.2——注册即有 badge 槽，释放即清，没有第二条
 * 内置专用路径；插件 API 只是给它加准入外壳）。
 *
 * 通知不轮询：各业务 store（channel / BackgroundJobStore / …）的订阅
 * 回调里由 Adapter 调 setBadge。有界：每 Panel 一条 badge，无历史列表，
 * unread 饱和到 99。
 */
import type { PanelBadge, PanelDefinition, PanelEntry, PanelOwner } from './types.js'

export const PANEL_UNREAD_CAP = 99

/** 连续崩溃禁用阈值（会话内，时间窗内累计；设计文档 §18.4）。 */
export const PANEL_CRASH_DISABLE_THRESHOLD = 3
/** 崩溃计数的滑动时间窗。 */
export const PANEL_CRASH_WINDOW_MS = 60_000

/** PanelStore 对外事件（subscribe 的 listener 参数；useSyncExternalStore
 *  的 () => void 订阅者可安全忽略）。opened/closed/focused/blurred 来自
 *  useSidePanel 的实际状态（{@link PanelStore.setPresentation}，去重），
 *  不重建 list() 快照。 */
export type PanelStoreEvent =
  | { readonly type: 'registered'; readonly id: string }
  | { readonly type: 'unregistered'; readonly id: string }
  | { readonly type: 'badge'; readonly id: string }
  | { readonly type: 'hint'; readonly id: string }
  | { readonly type: 'error'; readonly id: string }
  | { readonly type: 'disabled'; readonly id: string }
  | PanelLifecycleEvent

/** 面板呈现生命周期：opened = 成为分栏里正在显示的面板；closed = 不再显示；
 *  focused/blurred = 键盘焦点进出（总在 opened 之后、closed 之前）。 */
export type PanelLifecycleEvent =
  | { readonly type: 'opened'; readonly id: string }
  | { readonly type: 'closed'; readonly id: string }
  | { readonly type: 'focused'; readonly id: string }
  | { readonly type: 'blurred'; readonly id: string }

/** useSidePanel 回写的呈现状态（与 panelBridgeState 同源）。 */
export interface PanelPresentation {
  /** 分栏正在渲染（侧栏展开且当前布局放得下）。 */
  readonly open: boolean
  readonly activePanelId: string | undefined
  readonly focus: 'chat' | 'panel'
}

function compareEntries(a: PanelEntry, b: PanelEntry): number {
  // 内置 Panel 排在插件 Panel 之前；同 source 内按 order，再按注册顺序。
  const sourceA = a.definition.source === 'builtin' ? 0 : 1
  const sourceB = b.definition.source === 'builtin' ? 0 : 1
  if (sourceA !== sourceB) return sourceA - sourceB
  const orderA = a.definition.order ?? 0
  const orderB = b.definition.order ?? 0
  if (orderA !== orderB) return orderA - orderB
  return a.registrationId - b.registrationId
}

export class PanelStore {
  private entries = new Map<string, PanelEntry>()
  private listeners = new Set<(event: PanelStoreEvent) => void>()
  private snapshot: readonly PanelEntry[] = Object.freeze([])
  private sequence = 0
  /** source='plugin' 的连续崩溃时间戳（会话内；注册/重注册即清零）。 */
  private crashTimes = new Map<string, number[]>()
  /** 上一次发出生命周期事件时的呈现：正在显示的面板与它是否有焦点。 */
  private presented: { readonly id: string | undefined; readonly focused: boolean } = { id: undefined, focused: false }
  /** useSidePanel 最近一次回写的呈现（重注册屏上面板时重放，见 register）。 */
  private lastView: PanelPresentation | undefined

  /** 重复 id → DUPLICATE_CONTRIBUTION_ID（与 tuiStatus 同一约定）。 */
  register(definition: PanelDefinition, owner: PanelOwner): () => void {
    if (this.entries.has(definition.id)) {
      throw new Error(`DUPLICATE_CONTRIBUTION_ID: panel "${definition.id}" is already registered`)
    }
    this.sequence += 1
    const entry: PanelEntry = {
      definition,
      owner,
      registrationId: this.sequence,
      badge: null,
      lastError: null,
    }
    this.entries.set(definition.id, entry)
    this.crashTimes.delete(definition.id)
    this.emit({ type: 'registered', id: definition.id })
    // 重注册屏上的面板（activation 重启在同一同步段里先撤后注册）：撤下已清空
    // presented，而控制器的 open/active/focus 都没变，它的 effect 不会再回写。
    // 重放最近一次呈现，让新注册拿到 opened（+focused），之后的 closed/blurred
    // 也才有起点。一个刚注册、恰好是 active 候选的面板同理。
    const view = this.lastView
    if (view !== undefined && view.open && view.activePanelId === definition.id) this.setPresentation(view)
    return () => {
      // badge/lastError 更新会替换 entry 对象——按 registrationId 认亲，
      // 而不是对象恒等（否则一次 badge 就会让撤下变成 no-op）。
      if (this.entries.get(definition.id)?.registrationId === entry.registrationId) {
        this.entries.delete(definition.id)
        this.crashTimes.delete(definition.id)
        // 撤下即退出呈现：它的生命周期以 unregistered 收尾，不再补 closed。
        if (this.presented.id === definition.id) this.presented = { id: undefined, focused: false }
        this.emit({ type: 'unregistered', id: definition.id })
      }
    }
  }

  list(): readonly PanelEntry[] {
    return this.snapshot
  }

  get(id: string): PanelEntry | undefined {
    return this.entries.get(id)
  }

  /** 只允许 owner 或宿主调用（调用侧自律，与 tuiStatus 相同）。
   *  level/unread 都没变时不通知：适配器在每次 channel 变化（流式时每个
   *  delta）都会调这里，每次通知都会让订阅 list() 的宿主重渲染。 */
  setBadge(id: string, badge: Omit<PanelBadge, 'latestAt'> | null): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    const unread = badge === null ? 0 : Math.min(PANEL_UNREAD_CAP, Math.max(0, badge.unread))
    const current = entry.badge
    if (badge === null ? current === null : current !== null && current.level === badge.level && current.unread === unread) return
    const next: PanelBadge | null = badge === null ? null : { level: badge.level, unread, latestAt: Date.now() }
    this.entries.set(id, { ...entry, badge: next })
    this.emit({ type: 'badge', id })
  }

  /**
   * 面板广告自己当前的键位片段（见 PanelEntry.hint）。每次 channel delta 都会
   * 有适配器调 setBadge，这里同理按值短路：没变就不通知宿主重渲染。
   */
  setHint(id: string, hint: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.hint === hint) return
    this.entries.set(id, { ...entry, hint })
    this.emit({ type: 'hint', id })
  }

  clearBadge(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.badge === null) return
    this.entries.set(id, { ...entry, badge: null })
    this.emit({ type: 'badge', id })
  }

  reportError(id: string, error: unknown): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    const message = error instanceof Error ? error.message : String(error)
    this.entries.set(id, { ...entry, lastError: { message, at: Date.now() } })
    this.emit({ type: 'error', id })
    // 插件 Panel 的连续崩溃禁用（§18.4）：时间窗内第 N 次崩溃落禁用卡。
    if (entry.definition.source !== 'plugin' || entry.disabled) return
    const now = Date.now()
    const window = (this.crashTimes.get(id) ?? []).filter(at => now - at <= PANEL_CRASH_WINDOW_MS)
    window.push(now)
    this.crashTimes.set(id, window)
    if (window.length >= PANEL_CRASH_DISABLE_THRESHOLD) {
      const current = this.entries.get(id)
      if (current !== undefined && !current.disabled) {
        this.entries.set(id, { ...current, disabled: true })
        this.crashTimes.delete(id)
        this.emit({ type: 'disabled', id })
      }
    }
  }

  /**
   * 呈现生命周期（§18.3）：useSidePanel 每次 open/active/focus 变化回写这里，
   * 按差分发 opened/closed/focused/blurred，同一状态重复回写不发事件。
   * 只认已注册的面板；不重建 list() 快照（订阅 list() 的宿主不因此重渲染）。
   */
  setPresentation(view: PanelPresentation): void {
    this.lastView = view
    const candidate = view.open ? view.activePanelId : undefined
    const id = candidate !== undefined && this.entries.has(candidate) ? candidate : undefined
    const focused = id !== undefined && view.focus === 'panel'
    const previous = this.presented
    if (previous.id === id && previous.focused === focused) return
    this.presented = { id, focused }
    const events: PanelLifecycleEvent[] = []
    if (previous.id !== id) {
      if (previous.id !== undefined) {
        if (previous.focused) events.push({ type: 'blurred', id: previous.id })
        events.push({ type: 'closed', id: previous.id })
      }
      if (id !== undefined) {
        events.push({ type: 'opened', id })
        if (focused) events.push({ type: 'focused', id })
      }
    } else if (id !== undefined) {
      events.push({ type: focused ? 'focused' : 'blurred', id })
    }
    // 回写发生在 useSidePanel 的 effect 里：一个订阅者抛错既不能打断其余
    // 订阅者，也不能把 Chat 的 effect 带崩（插件订阅在服务层另有兜底）。
    for (const event of events) {
      for (const listener of [...this.listeners]) {
        try {
          listener(event)
        } catch {
          // swallowed: lifecycle delivery is best-effort per listener
        }
      }
    }
  }

  subscribe = (listener: (event: PanelStoreEvent) => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: PanelStoreEvent): void {
    this.snapshot = Object.freeze([...this.entries.values()].sort(compareEntries))
    for (const listener of [...this.listeners]) listener(event)
  }
}

/** 进程级单例（内置经 registerBuiltinPanels，插件经 Phase 6 的准入外壳）。 */
export const panelStore = new PanelStore()
