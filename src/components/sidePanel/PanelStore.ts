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
 *  的 () => void 订阅者可安全忽略）。opened/closed/focused/blurred 等
 *  useSidePanel 侧的事件本阶段尚未接入（TODO §18.3）。 */
export type PanelStoreEvent =
  | { readonly type: 'registered'; readonly id: string }
  | { readonly type: 'unregistered'; readonly id: string }
  | { readonly type: 'badge'; readonly id: string }
  | { readonly type: 'error'; readonly id: string }
  | { readonly type: 'disabled'; readonly id: string }

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
    return () => {
      // badge/lastError 更新会替换 entry 对象——按 registrationId 认亲，
      // 而不是对象恒等（否则一次 badge 就会让撤下变成 no-op）。
      if (this.entries.get(definition.id)?.registrationId === entry.registrationId) {
        this.entries.delete(definition.id)
        this.crashTimes.delete(definition.id)
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
