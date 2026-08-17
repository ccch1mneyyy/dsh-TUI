/**
 * manifest / Host Descriptor 语义校验——上游 run.js 的 validatePlugin /
 * validateHost / resolveContractRef / resolveSubscription 保真 TS 移植。
 * schema 结构校验（check()）之外的业务规则都集中在这里：
 *
 * - 坐标三层解析：未知 group → 抛错（INVALID_MANIFEST 级）；已知 group 未知
 *   kind → 抛错；已知 group+kind 未注册版本 → 合法 manifest，交给协商器
 *   回答 `unknown`（C-030 trigger (a)）；
 * - C-030：optional 引用必须带 fallback，未注册版本不豁免（F3 红队修复）；
 * - C-003：facets.host.apiVersion 必须是注册值；
 * - 订阅必须指向 event 契约；
 * - Host Descriptor（C-010）：坐标唯一、契约已注册、schemaHash 钉死一致、
 *   权限已注册。
 *
 * 所有函数失败即抛带路径/坐标的 Error，不返回部分结果——与 run.js 一致。
 */

import type {
  ContractCoordinate,
  ContractRegistry,
  HostDescriptor,
  PermissionRegistry,
  PluginManifest,
  RegistryEntry,
  SubscriptionRef,
} from './types.js'

/** registry 的查询索引：坐标为主键，扁平名为别名（社区 v0.15 §3.2 映射表）。 */
export interface ContractIndex {
  registry: ContractRegistry
  permissions: PermissionRegistry
  /** 注册的 facet host API 版本（C-003 的权威来源）。 */
  facetApiVersions: string[]
  /** 坐标直查（无三层解析——Host Descriptor 语义校验用，未命中即 undefined）。 */
  lookupContract(coordinate: ContractCoordinate): RegistryEntry | undefined
  resolveContractRef(ref: ContractCoordinate): { entry: RegistryEntry | null; unregisteredVersion: boolean }
  resolveSubscription(sub: SubscriptionRef): RegistryEntry
}

const coordinateKey = (coordinate: ContractCoordinate): string =>
  `${coordinate.apiVersion}#${coordinate.kind}`

/** apiVersion 的 group 段（`messages.dsh/v1alpha1` → `messages.dsh`）。 */
export const groupOf = (apiVersion: string): string => apiVersion.split('/')[0]

export function createContractIndex(
  registry: ContractRegistry,
  permissions: PermissionRegistry,
): ContractIndex {
  const byCoordinate = new Map(registry.entries.map(entry => [coordinateKey(entry.coordinates), entry]))
  const byName = new Map(registry.entries.map(entry => [entry.name, entry]))

  function resolveContractRef(ref: ContractCoordinate): { entry: RegistryEntry | null; unregisteredVersion: boolean } {
    const key = coordinateKey(ref)
    const exact = byCoordinate.get(key)
    if (exact) return { entry: exact, unregisteredVersion: false }
    const sameGroup = registry.entries.filter(entry => groupOf(entry.coordinates.apiVersion) === groupOf(ref.apiVersion))
    if (sameGroup.length === 0) throw new Error(`unknown contract group: ${groupOf(ref.apiVersion)}`)
    if (!sameGroup.some(entry => entry.coordinates.kind === ref.kind)) throw new Error(`unknown contract kind: ${key}`)
    return { entry: null, unregisteredVersion: true }
  }

  function resolveSubscription(sub: SubscriptionRef): RegistryEntry {
    let entry: RegistryEntry | undefined
    if (typeof sub === 'string') {
      entry = byName.get(sub) ?? byCoordinate.get(sub)
      if (!entry) throw new Error(`unknown subscription reference: ${sub}`)
    } else {
      entry = byCoordinate.get(coordinateKey(sub))
      if (!entry) throw new Error(`unknown subscription coordinate: ${coordinateKey(sub)}`)
    }
    if (entry.kind !== 'event') {
      throw new Error(`subscription must reference an event contract: ${typeof sub === 'string' ? sub : sub.apiVersion}`)
    }
    return entry
  }

  return {
    registry,
    permissions,
    facetApiVersions: registry.facetApiVersions ?? [],
    lookupContract: coordinate => byCoordinate.get(coordinateKey(coordinate)),
    resolveContractRef,
    resolveSubscription,
  }
}

/**
 * Validate a plugin manifest's semantics (schema check runs separately).
 * Throws on the first violation.
 */
export function validatePlugin(index: ContractIndex, manifest: PluginManifest): void {
  // C-003: the requested facet host API version must be a registered value.
  if (!index.facetApiVersions.includes(manifest.facets.host.apiVersion)) {
    throw new Error(`unregistered facet apiVersion: ${manifest.facets.host.apiVersion}`)
  }
  const ids = manifest.contributes.commands.map(command => command.id)
  if (new Set(ids).size !== ids.length) throw new Error('$.contributes.commands: duplicate command id')
  const resolved = new Set<string>()
  for (const ref of manifest.requires.contracts) {
    // C-030: fallback is mandatory on every optional reference — including
    // references whose version is unregistered (no version exception).
    if (ref.optional === true && !ref.fallback) {
      throw new Error(`optional contract without fallback: ${coordinateKey(ref)}`)
    }
    const { unregisteredVersion } = index.resolveContractRef(ref)
    if (unregisteredVersion) continue // valid manifest; negotiator answers `unknown`
    const key = coordinateKey(ref)
    if (resolved.has(key)) throw new Error(`duplicate contract reference: ${key}`)
    resolved.add(key)
  }
  for (const sub of manifest.subscriptions) index.resolveSubscription(sub)
}

/**
 * Validate a Host Descriptor's semantics (C-010): contracts must exist in
 * the registry with a pinned schemaHash; a coordinate may only appear once;
 * declared permissions must be registered.
 */
export function validateHost(index: ContractIndex, host: HostDescriptor): void {
  const seen = new Set<string>()
  const knownPermissions = new Set(index.permissions.permissions.map(permission => permission.name))
  for (const contract of host.contracts) {
    const key = coordinateKey(contract)
    if (seen.has(key)) throw new Error(`host declares duplicate contract: ${key}`)
    seen.add(key)
    const entry = index.lookupContract(contract)
    if (!entry) throw new Error(`host declares unknown contract: ${key}`)
    if (entry.schemaHash !== contract.schemaHash) throw new Error(`host schemaHash mismatch: ${key}`)
    for (const permission of contract.permissions) {
      if (!knownPermissions.has(permission)) throw new Error(`host declares unknown permission: ${permission}`)
    }
  }
}
