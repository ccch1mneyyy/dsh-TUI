/**
 * Host-side per-panel owner registry for ctx.tuiPanels (§18.2).
 *
 * The PanelStore owns registration/badges; THIS map owns what only the
 * Cordis side knows: which activation registered a panel id, its plugin id,
 * and the lazy bridges the rendered panel's host API needs (toast, scenes,
 * plugin storage). Kept module-level next to the process-level PanelStore —
 * a WeakMap on the service would die with the service object while the
 * PanelStore (and rendered panels) outlive it.
 */

import type { Context } from '@deepseek-ai/cordis'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import type { ChannelUi } from '../adapter/ports/channel-ui.js'
import type { TuiPluginStorage } from './plugin-storage.js'
import { panelBridgeRequests, panelBridgeState } from '../components/sidePanel/panelBridge.js'
import {
  freezeSurfaceParams,
  getSurfaceParams,
  panelParamsKey,
  resolveSurfaceFileRequest,
  setSurfaceParams,
  surfaceCopy,
  surfaceOpenSession,
  useSurfaceParams,
  type TuiJsonValue,
} from './surface-host.js'
import { openHostFilePreview, type TuiSceneRuntime } from './scenes.js'

/** open() 限速窗口：每插件每窗口至多 1 次（tuiPanels.open 与 host.openPanel 共用）。 */
export const PANEL_OPEN_RATE_LIMIT_MS = 5_000

export interface PanelOwnerRecord {
  /** The panel id this registration holds (one record per registration). */
  readonly id: string
  /** Canonical activation context (kept alive by the bound effect; the panel
   * is unregistered before the activation tears down, so late host-API calls
   * through a disposed ctx degrade, never crash the store). */
  readonly caller: Context
  /** activationFiber identity — ownership check for every mutating call. */
  readonly owner: object
  readonly pluginId: string
  /** open() rate limit: at most one open per plugin per 5s (§18.2). */
  lastOpenAt: number
  storage?: TuiPluginStorage
}

const ownerRecords = new Map<string, PanelOwnerRecord>()

export function getPanelOwnerRecord(id: string): PanelOwnerRecord | undefined {
  return ownerRecords.get(id)
}

export function setPanelOwnerRecord(id: string, record: PanelOwnerRecord): void {
  ownerRecords.set(id, record)
}

export function deletePanelOwnerRecord(id: string): void {
  ownerRecords.delete(id)
}

/**
 * The host verbs below take the record of the registration that made the
 * rendered panel, never a bare id: they act only while that registration is
 * still the live one, so a callback a panel kept past its unload refuses —
 * even across a reload that registers the same durable id again.
 */
function liveRecord(registration: PanelOwnerRecord): PanelOwnerRecord | undefined {
  return ownerRecords.get(registration.id) === registration ? registration : undefined
}

export function isLivePanelRegistration(registration: PanelOwnerRecord): boolean {
  return liveRecord(registration) !== undefined
}

export function countPanelsOwnedBy(owner: object): number {
  let count = 0
  for (const record of ownerRecords.values()) if (record.owner === owner) count += 1
  return count
}

export function countPluginPanels(): number {
  return ownerRecords.size
}

/** Plugin Panel 的 toast：经注册激活自己的 tuiToast 服务（无服务时静默
 * false，与 scenes 降级语义一致）。 */
export function pluginPanelToast(registration: PanelOwnerRecord, text: string): boolean {
  const record = liveRecord(registration)
  if (record === undefined) return false
  const toast = record.caller.get('tuiToast') as { show(text: string): boolean } | undefined
  if (toast === undefined || typeof toast.show !== 'function') return false
  try {
    return toast.show(text)
  } catch {
    return false
  }
}

/** 打开自己注册的全屏场景：转 tuiScenes（它自己做 owner 校验、参数校验与降级）。 */
export function pluginPanelOpenScene(registration: PanelOwnerRecord, sceneId: string, params?: TuiJsonValue): boolean {
  const record = liveRecord(registration)
  if (record === undefined) return false
  const scenes = record.caller.get('tuiScenes') as { open(id: string, params?: TuiJsonValue): boolean } | undefined
  if (scenes === undefined || typeof scenes.open !== 'function') return false
  try {
    return params === undefined ? scenes.open(sceneId) : scenes.open(sceneId, params)
  } catch {
    return false
  }
}

/** 打开自己注册的另一个（或同一个）Panel：转 tuiPanels.open（owner 校验、
 *  参数校验、5s 限速与 shadow policy 都在那里）。 */
export function pluginPanelOpenPanel(registration: PanelOwnerRecord, panelId: string, params?: TuiJsonValue): boolean {
  const record = liveRecord(registration)
  if (record === undefined) return false
  const panels = record.caller.get('tuiPanels') as { open(id: string, params?: TuiJsonValue): boolean } | undefined
  if (panels === undefined || typeof panels.open !== 'function') return false
  try {
    return params === undefined ? panels.open(panelId) : panels.open(panelId, params)
  } catch {
    return false
  }
}

/**
 * tuiPanels.open 与 host.openPanel 的共同实现：只开自己注册的 Panel；参数
 * 先校验（非法即 false，不消耗限速窗口）；无 Chat 消费者直接 false（请求
 * 从未送达，不消耗限速窗口）。面板已在分栏里显示时与场景重开同义：只更新
 * 参数、返回 true，不发打开请求、不计限速（深链在已打开的面板里翻页）；
 * 否则每插件每 5s 至多 1 次。参数在请求送达前写入，面板挂载时 useParams()
 * 第一帧就能读到。
 */
export function requestOwnPanelOpen(caller: Context, owner: object, id: unknown, params: unknown): boolean {
  const record = getPanelOwnerRecord(String(id ?? ''))
  if (record === undefined || record.owner !== owner) {
    caller.logger.warn('dsh-tui: tuiPanels.open rejected "' + String(id) + '" — not registered by this activation')
    return false
  }
  const frozen = freezeSurfaceParams(params)
  if (!frozen.ok) {
    caller.logger.warn('dsh-tui: tuiPanels.open rejected params for "' + String(id) + '" — ' + frozen.reason)
    return false
  }
  if (!panelBridgeRequests.hasConsumer()) return false
  const shown = panelBridgeState.get()
  if (shown.open && shown.activePanelId === String(id)) {
    setSurfaceParams(panelParamsKey(String(id)), frozen.value)
    return true
  }
  const now = Date.now()
  if (now - record.lastOpenAt < PANEL_OPEN_RATE_LIMIT_MS) {
    caller.logger.warn('dsh-tui: tuiPanels.open dropped "' + String(id) + '" — rate limited to one open per ' + PANEL_OPEN_RATE_LIMIT_MS + 'ms')
    caller.get('tuiEffectLedger')?.record(
      { operation: 'bind', resource: { kind: 'panel', id: String(id) }, result: 'failed', errorCode: 'RATE_LIMITED' },
    )
    return false
  }
  const key = panelParamsKey(String(id))
  const previous = getSurfaceParams(key)
  setSurfaceParams(key, frozen.value)
  if (!panelBridgeRequests.request('open', String(id))) {
    setSurfaceParams(key, previous)
    return false
  }
  record.lastOpenAt = now
  return true
}

/** host.useParams() 的面板实现（钩子：必须在面板组件渲染期调用）。 */
export function usePluginPanelParams(id: string): TuiJsonValue | undefined {
  return useSurfaceParams(panelParamsKey(id))
}

/** host.openSession：与 /resume 同一条 channel.resumeTo 路径；每插件每 2s 至多 1 次。 */
export function pluginPanelOpenSession(
  registration: PanelOwnerRecord,
  channel: Pick<ChannelUi, 'resumeTo' | 'notify' | 'sessionId'> | undefined,
  sessionId: unknown,
): Promise<boolean> {
  const record = liveRecord(registration)
  if (record === undefined) return Promise.resolve(false)
  return surfaceOpenSession(
    { owner: record.owner, runtime: adapterRuntimeFor(record.caller) },
    channel,
    sessionId,
    message => { record.caller.logger.warn(message) },
  )
}

/** host.openFile：校验 + 相对路径按会话 cwd 解析，交给宿主只读预览场景。 */
export function pluginPanelOpenFile(registration: PanelOwnerRecord, cwd: string | undefined, path: unknown, options: unknown): boolean {
  const record = liveRecord(registration)
  if (record === undefined) return false
  const warn = (message: string): void => { record.caller.logger.warn(message) }
  const request = resolveSurfaceFileRequest(cwd, path, options, warn)
  if (request === undefined) return false
  let scenes: TuiSceneRuntime | undefined
  try {
    scenes = record.caller.get('tuiScenes') as TuiSceneRuntime | undefined
  } catch {
    return false
  }
  return openHostFilePreview(scenes, request)
}

/** host.copy：宿主统一的剪贴板路径（OSC 52 + 本地工具兜底），并提示一次；
 *  mutate（shadow 模式拒绝）+ 每插件每秒至多 1 次。 */
export function pluginPanelCopy(
  registration: PanelOwnerRecord,
  text: unknown,
  writeRaw: ((data: string) => void) | null | undefined,
  notify: ((text: string) => void) | undefined,
): boolean {
  const record = liveRecord(registration)
  if (record === undefined) return false
  const caller = { owner: record.owner, runtime: adapterRuntimeFor(record.caller) }
  return surfaceCopy(caller, text, writeRaw, notify, message => { record.caller.logger.warn(message) })
}

/** 自己的 tuiPluginStorage 句柄（懒开、每 Panel 一次；无服务时 undefined）。 */
export function pluginPanelStorage(registration: PanelOwnerRecord): TuiPluginStorage | undefined {
  const record = liveRecord(registration)
  if (record === undefined) return undefined
  if (record.storage !== undefined) return record.storage
  const service = record.caller.get('tuiPluginStorage') as
    | { open(pluginCtx: Context): TuiPluginStorage }
    | undefined
  if (service === undefined || typeof service.open !== 'function') return undefined
  try {
    record.storage = service.open(record.caller)
    return record.storage
  } catch {
    return undefined
  }
}

/** 侧栏展开且自己是 active 时聚焦（useSidePanel 侧裁决）。 */
export function pluginPanelFocus(registration: PanelOwnerRecord): boolean {
  return liveRecord(registration) !== undefined && panelBridgeRequests.request('focus', registration.id)
}
