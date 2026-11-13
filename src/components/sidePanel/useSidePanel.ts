/**
 * useSidePanel: the whole side-panel controller in one hook (design doc
 * §16.5 — Chat.tsx only gains one hook call, one keyboard delegation line,
 * and one runCommand case).
 *
 * State split:
 * - splitEnabled / open / ratio / panels live in the module-level live
 *   stores (tuiDisplayPrefs) so /settings, cordis.yml and key toggles all
 *   write the same place and the layout re-renders above the channel's
 *   version bump;
 * - focus / zoom / activePanelId are Chat-session React state (they never
 *   persist: a restart opens on the first enabled panel, focus in chat).
 *
 * Keyboard priority (v2.1 contract): Chat's modal guards (approval /
 * question / dialog / fullscreen scenes) run first, then this controller's
 * GLOBAL shortcuts (sidePanel, sidePanelZoom — both focuses), then — when
 * the focus is in the right column — the active panel's own keys (Phase 3
 * dispatcher), then the host fallback below (panel switching, zoom,
 * resize, Esc). Plain Ctrl combos fall through to Chat so interrupt /
 * exit / redraw keep working from the panel; the one exception is the
 * keymap `paste` action while the column actually renders — it is owned by
 * the panel column (issue #1767), see the branch in handleKey.
 */
import React from 'react'
import { actionMatches } from '../../utils/keymap.js'
import {
  applySidePanelOpen,
  applySidePanelRatio,
  getHiddenTemporarySidePanels,
  getSidePanelOpen,
  getSidePanelPanels,
  getSidePanelRatio,
  getSidePanelSplitEnabled,
  resolveSidePanelIds,
  SIDE_PANEL_ID_PATTERN,
  subscribeHiddenTemporarySidePanels,
  subscribeSidePanelOpen,
  subscribeSidePanelPanels,
  subscribeSidePanelRatio,
  subscribeSidePanelSplitEnabled,
} from '../../tuiDisplayPrefs.js'
import {
  canSplit,
  nudgeRatio,
  resolveSidePanelGeometry,
  resolveSplit,
  RESIZE_STEP_COLUMNS,
  type SidePanelSplit,
} from './dimensions.js'
import type { SidePanelKeyFlags, SidePanelRuntime } from './types.js'
import { panelBridgeRequests, panelBridgeState } from './panelBridge.js'
import { panelStore } from './PanelStore.js'

export type { SidePanelKeyFlags } from './types.js'

export type SidePanelFocus = 'chat' | 'panel'

export interface UseSidePanelOptions {
  /** Content width after PageMargin (what Chat's useTerminalSize reports). */
  readonly columns: number
  readonly fullscreen: boolean
  /** Fullscreen draft editor covers the whole page: force collapsed. */
  readonly editorOpen: boolean
}

export interface SidePanelKeyEventLike {
  stopImmediatePropagation?: () => void
}

export interface SidePanelController {
  /** Resolved split, or null when the chat takes the full width. */
  readonly geometry: SidePanelSplit | null
  readonly split: boolean
  readonly chatColumns: number
  readonly panelColumns: number
  /** Whether a split COULD render right now (setting + width + mode). */
  readonly splitAvailable: boolean
  readonly open: boolean
  readonly zoom: boolean
  readonly focus: SidePanelFocus
  readonly activePanelId: string | undefined
  readonly enabledPanelIds: readonly string[]
  /** 键盘分发与 Panel 注册的接缝（PanelHost / usePanelInput 用）。 */
  readonly runtime: SidePanelRuntime
  focusChat: () => void
  focusPanel: () => void
  /** Ctrl+B smart three-state: closed → open+focus; chat → panel; panel → close. */
  toggleSmart: () => void
  /** /panel toggle: plain open/close (focus returns to chat on close). */
  toggleOpen: () => void
  toggleZoom: () => void
  nudge: (deltaColumns: number) => void
  /** Set the visible chat width in cells, leaving zoom and preserving focus. */
  resize: (chatColumns: number) => void
  openPanel: (id: string, opts?: { readonly focus?: boolean }) => void
  /** /panel command dispatcher; false = unknown argument. */
  command: (raw: string) => boolean
  /** Keyboard entry point (see the priority contract in the file header). */
  handleKey: (input: string, key: SidePanelKeyFlags, event?: SidePanelKeyEventLike) => boolean
}

function useLive<T>(subscribe: (listener: () => void) => () => void, get: () => T): T {
  return React.useSyncExternalStore(subscribe, get)
}

export function useSidePanel(options: UseSidePanelOptions): SidePanelController {
  const { columns, fullscreen, editorOpen } = options
  const splitEnabled = useLive(subscribeSidePanelSplitEnabled, getSidePanelSplitEnabled)
  const openSetting = useLive(subscribeSidePanelOpen, getSidePanelOpen)
  const ratio = useLive(subscribeSidePanelRatio, getSidePanelRatio)
  const panelsCsv = useLive(subscribeSidePanelPanels, getSidePanelPanels)
  // The registry half of the enabled set (`sidePanel.panels: '*'`). Subscribe
  // to panelStore but expose an id-string snapshot: badge/hint events also
  // rebuild the store's array identity, and a per-delta Chat re-render would
  // be pure waste — the joined string only changes when a panel registers or
  // unregisters.
  const registeredCsv = React.useSyncExternalStore(
    panelStore.subscribe,
    () => panelStore.list().map(entry => entry.definition.id).join(','),
  )
  // The temporary panels this run is hiding (`/settings` toggles them there,
  // not in the stored value): a frozen array whose identity only moves when
  // the set does, so it is a valid snapshot.
  const hiddenTemporaryIds = React.useSyncExternalStore(
    subscribeHiddenTemporarySidePanels,
    getHiddenTemporarySidePanels,
  )
  const [focus, setFocus] = React.useState<SidePanelFocus>('chat')
  const [zoom, setZoom] = React.useState(false)
  const [activeIdState, setActiveIdState] = React.useState<string | undefined>(undefined)

  // Panel 键盘分发器（v2.1：活动 Panel 的业务键先吃，宿主回退键兜底）。
  // 稳定引用：注册表本身放 ref，runtime 对象在整个会话期不变。
  const inputHandlersRef = React.useRef(new Map<string, { handler: Parameters<SidePanelRuntime['registerInput']>[1]; enabled: boolean }>())
  const runtime = React.useMemo<SidePanelRuntime>(() => ({
    registerInput: (panelId, handler, enabled) => {
      inputHandlersRef.current.set(panelId, { handler, enabled })
      return () => {
        if (inputHandlersRef.current.get(panelId)?.handler === handler) {
          inputHandlersRef.current.delete(panelId)
        }
      }
    },
    dispatchKey: (panelId, input, key) => {
      const entry = inputHandlersRef.current.get(panelId)
      if (entry === undefined || !entry.enabled) return false
      return entry.handler(input, key) === true
    },
  }), [])

  // ONE derivation of the enabled set, shared by the PanelBar, /panel, the
  // digit keys, the bridge admission and /settings: the stored value plus the
  // live registry (issue #1662).
  const enabledPanelIds = React.useMemo(
    () => resolveSidePanelIds(
      panelsCsv,
      registeredCsv === '' ? [] : registeredCsv.split(','),
      hiddenTemporaryIds,
    ),
    [panelsCsv, registeredCsv, hiddenTemporaryIds],
  )
  // Stable callbacks (the bridge subscription is mounted once) read the
  // latest enabled set through this ref instead of capturing it.
  const enabledIdsRef = React.useRef(enabledPanelIds)
  enabledIdsRef.current = enabledPanelIds
  const activePanelId = activeIdState !== undefined && enabledPanelIds.includes(activeIdState)
    ? activeIdState
    : enabledPanelIds[0]

  const splitAvailable = fullscreen && !editorOpen && splitEnabled && canSplit(columns)
  const open = openSetting && splitAvailable
  const geometry = React.useMemo(
    () => resolveSidePanelGeometry({ columns, open, zoom, ratio }),
    [columns, open, zoom, ratio],
  )
  const split = geometry !== null
  const chatColumns = geometry?.chat ?? columns
  const panelColumns = geometry?.panel ?? 0

  const focusChat = React.useCallback(() => setFocus('chat'), [])
  const focusPanel = React.useCallback(() => setFocus('panel'), [])

  const toggleSmart = React.useCallback(() => {
    if (!splitAvailable) return
    if (!getSidePanelOpen()) {
      applySidePanelOpen(true)
      setFocus('panel')
      return
    }
    if (focus === 'chat') {
      setFocus('panel')
      return
    }
    applySidePanelOpen(false)
    setFocus('chat')
  }, [splitAvailable, focus])

  const toggleOpen = React.useCallback(() => {
    const next = !getSidePanelOpen()
    applySidePanelOpen(next)
    if (!next) setFocus('chat')
  }, [])

  const toggleZoom = React.useCallback(() => {
    setZoom(previous => !previous)
  }, [])

  const nudge = React.useCallback((deltaColumns: number) => {
    applySidePanelRatio(nudgeRatio(columns, getSidePanelRatio(), deltaColumns))
  }, [columns])

  const resize = React.useCallback((chatWidth: number) => {
    if (!split) return
    // Encode the middle of a cell so resolveSplit's floor cannot lose a
    // column to floating-point rounding, including at either minimum.
    const next = resolveSplit(columns, (chatWidth + 0.5) / columns)
    applySidePanelRatio((next.chat + 0.5) / columns)
    setZoom(false)
  }, [columns, split])

  const openPanel = React.useCallback((id: string, opts?: { readonly focus?: boolean }) => {
    if (!enabledIdsRef.current.includes(id)) return
    setActiveIdState(id)
    applySidePanelOpen(true)
    if (opts?.focus !== false) setFocus('panel')
  }, [])

  const cyclePanel = React.useCallback((delta: number) => {
    const ids = enabledIdsRef.current
    if (ids.length === 0) return
    const current = activeIdState !== undefined && ids.includes(activeIdState)
      ? activeIdState
      : ids[0]!
    const index = ids.indexOf(current)
    const next = ids[(index + delta + ids.length) % ids.length]!
    setActiveIdState(next)
  }, [activeIdState])

  const command = React.useCallback((raw: string): boolean => {
    const arg = raw.trim().toLowerCase()
    if (arg === '') {
      if (!splitAvailable) return false
      applySidePanelOpen(true)
      setFocus('panel')
      return true
    }
    if (arg === 'toggle') {
      toggleOpen()
      return true
    }
    if (arg === 'focus') {
      if (!splitAvailable) return false
      applySidePanelOpen(true)
      setFocus('panel')
      return true
    }
    if (arg === 'zoom') {
      if (!splitAvailable) return false
      applySidePanelOpen(true)
      setZoom(previous => !previous)
      return true
    }
    if (SIDE_PANEL_ID_PATTERN.test(arg) && enabledIdsRef.current.includes(arg)) {
      if (!splitAvailable) return false
      setActiveIdState(arg)
      applySidePanelOpen(true)
      setFocus('panel')
      return true
    }
    return false
  }, [splitAvailable, toggleOpen])

  const handleKey = React.useCallback((input: string, key: SidePanelKeyFlags, event?: SidePanelKeyEventLike): boolean => {
    const stop = () => event?.stopImmediatePropagation?.()
    if (actionMatches('sidePanel', input, key)) {
      if (!splitAvailable) return false
      toggleSmart()
      stop()
      return true
    }
    if (actionMatches('sidePanelZoom', input, key)) {
      if (!split) return false
      toggleZoom()
      stop()
      return true
    }
    if (focus !== 'panel') return false
    // 粘贴是 Ctrl/Alt 组合里唯一会把剪贴板内容写进草稿的动作：分栏渲染时
    // 先给活动 Panel（btw composer 能接），它不接也必须吞掉——否则键继续
    // 漏给仍处于 active 的主输入框（issue #1767）。分栏没渲染时（编辑器
    // 展开 / 窄屏）不拦：PanelHost 已卸载、dispatchKey 必然落空，可见的
    // 输入框只有主输入框/全屏编辑器。其余会改草稿的组合（Ctrl+W/U/K/Z、
    // Alt+Backspace 等）仍照旧放行，属既有行为，不在本次范围。
    if (split && actionMatches('paste', input, key)) {
      if (activePanelId !== undefined) runtime.dispatchKey(activePanelId, input, key)
      stop()
      return true
    }
    // Panel-focused keys. Ctrl/Alt combos fall through to Chat
    // (interrupt, exit, redraw and the other global actions keep working
    // from the panel); plain keys are the panel surface's own. Esc is the
    // exception: this ink reports a lone ESC as { escape, meta }, so the
    // meta pass-through must NOT claim it — Esc belongs to the panel
    // first (Detail → Dashboard) and then to the host fallback (→ chat).
    if (key.ctrl === true || (key.meta === true && key.escape !== true)) return false
    // v2.1 第一棒：活动 Panel 的业务键优先（Subagent Detail 的 ←/→ 翻页、
    // Esc 返回 Dashboard 都先由它自己决定）；它没吃才轮到宿主回退键。
    if (activePanelId !== undefined && runtime.dispatchKey(activePanelId, input, key)) {
      stop()
      return true
    }
    if (key.escape === true) {
      setFocus('chat')
      stop()
      return true
    }
    if (key.leftArrow === true || input === '[') {
      cyclePanel(-1)
      stop()
      return true
    }
    if (key.rightArrow === true || input === ']') {
      cyclePanel(1)
      stop()
      return true
    }
    if (input === 'z') {
      toggleZoom()
      stop()
      return true
    }
    if (input === '+' || input === '=') {
      nudge(-RESIZE_STEP_COLUMNS)
      stop()
      return true
    }
    if (input === '-' || input === '_') {
      nudge(RESIZE_STEP_COLUMNS)
      stop()
      return true
    }
    if (input >= '1' && input <= '9') {
      const ids = enabledIdsRef.current
      const target = ids[Number.parseInt(input, 10) - 1]
      if (target !== undefined) setActiveIdState(target)
      stop()
      return true
    }
    // Every other plain key: swallowed — the right column owns the
    // keyboard while focused (Phase 3 dispatches to the active panel first).
    stop()
    return true
  }, [splitAvailable, split, focus, activePanelId, runtime, toggleSmart, toggleZoom, cyclePanel, nudge])

  // ctx.tuiPanels 的 UI 通道（设计文档 §18.2）：bridge 只在 Chat 挂载期间
  // 有消费者（open() 无消费者时向插件返回 false）；请求在本地启用集合里
  // 裁决，state 回写供服务侧 close()/focus() 判断当前 active。
  React.useEffect(() => {
    panelBridgeRequests.attach()
    return () => { panelBridgeRequests.detach() }
  }, [])
  const bridgeViewRef = React.useRef({ open, activePanelId, enabledPanelIds, splitAvailable, openPanel })
  bridgeViewRef.current = { open, activePanelId, enabledPanelIds, splitAvailable, openPanel }
  React.useEffect(() => panelBridgeRequests.subscribe(request => {
    const view = bridgeViewRef.current
    if (request.kind === 'open') {
      // 未启用的 Panel（含已撤下的注册）直接忽略——open() 的布尔返回
      // 只承诺请求已送达活的 Chat 控制器。
      if (!view.enabledPanelIds.includes(request.id)) return
      if (!view.splitAvailable) return
      view.openPanel(request.id, { focus: true })
      return
    }
    if (request.kind === 'focus') {
      if (view.open && view.activePanelId === request.id) setFocus('panel')
      return
    }
    if (view.activePanelId === request.id) {
      applySidePanelOpen(false)
      setFocus('chat')
    }
  }), [])
  React.useEffect(() => {
    panelBridgeState.set({ open, activePanelId, focus })
  }, [open, activePanelId, focus])

  return {
    geometry,
    split,
    chatColumns,
    panelColumns,
    splitAvailable,
    open,
    zoom,
    focus,
    activePanelId,
    enabledPanelIds,
    runtime,
    focusChat,
    focusPanel,
    toggleSmart,
    toggleOpen,
    toggleZoom,
    nudge,
    resize,
    openPanel,
    command,
    handleKey,
  }
}
