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
import type { TuiPluginStorage } from './plugin-storage.js'
import { panelBridgeRequests } from '../components/sidePanel/panelBridge.js'

export interface PanelOwnerRecord {
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
export function pluginPanelToast(id: string, text: string): boolean {
  const record = ownerRecords.get(id)
  if (record === undefined) return false
  const toast = record.caller.get('tuiToast') as { show(text: string): boolean } | undefined
  if (toast === undefined || typeof toast.show !== 'function') return false
  try {
    return toast.show(text)
  } catch {
    return false
  }
}

/** 打开自己注册的全屏场景：转 tuiScenes（它自己做 owner 校验与降级）。 */
export function pluginPanelOpenScene(id: string, sceneId: string): boolean {
  const record = ownerRecords.get(id)
  if (record === undefined) return false
  const scenes = record.caller.get('tuiScenes') as { open(id: string): boolean } | undefined
  if (scenes === undefined || typeof scenes.open !== 'function') return false
  try {
    return scenes.open(sceneId)
  } catch {
    return false
  }
}

/** 自己的 tuiPluginStorage 句柄（懒开、每 Panel 一次；无服务时 undefined）。 */
export function pluginPanelStorage(id: string): TuiPluginStorage | undefined {
  const record = ownerRecords.get(id)
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
export function pluginPanelFocus(id: string): boolean {
  return panelBridgeRequests.request('focus', id)
}
