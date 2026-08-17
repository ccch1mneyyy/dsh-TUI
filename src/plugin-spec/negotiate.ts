/**
 * 五态协商器——上游 run.js 的 negotiate() 保真 TS 移植（C-030）。
 *
 * 判定顺序即优先级 `unknown > rejected > waiting_authorization >
 * compatible_degraded > compatible`：
 *
 * 1. unknown：任一引用落在注册表之外（已知 group+kind 的未注册版本）——
 *    无法判定，回答 rejected 等于假装知道它不兼容；
 * 2. rejected：manifest 的 facet apiVersion 不在宿主声明面内（C-010/C-003，
 *    fail closed），或必填契约在宿主侧不可用（宿主未声明，或声明的
 *    schemaHash 与注册表钉死值不一致）；
 * 3. waiting_authorization：契约齐了，但有权限未授予——宿主未声明该权限，
 *    或权限定义缺失/default=deny 且不在 grants 里；
 * 4. compatible_degraded / compatible：只差 optional 与否。
 */

import type { ContractIndex } from './validate.js'
import type { HostDescriptor, NegotiationDecision, PluginManifest } from './types.js'

const coordinateKey = (ref: { apiVersion: string; kind: string }): string =>
  `${ref.apiVersion}#${ref.kind}`

/**
 * Negotiate a validated manifest against a Host Descriptor.
 * `grants` = 已授予的权限名集合（GrantStore 在批 2 提供；库层面保持
 * run.js 的数组签名）。
 */
export function negotiate(
  index: ContractIndex,
  manifest: PluginManifest,
  host: HostDescriptor,
  grants: readonly string[] = [],
): NegotiationDecision {
  const supported = new Map(host.contracts.map(contract => [coordinateKey(contract), contract]))
  const required = manifest.requires.contracts.filter(ref => !ref.optional)
  const optional = manifest.requires.contracts.filter(ref => ref.optional)

  // `unknown` outranks every other outcome (C-030 priority): a referenced
  // version outside the registry cannot be judged — answering rejected here
  // would pretend we KNOW it is incompatible.
  const unjudgable = manifest.requires.contracts.filter(ref => {
    try {
      return index.resolveContractRef(ref).unregisteredVersion
    } catch {
      return false
    }
  })
  if (unjudgable.length > 0) {
    return {
      decision: 'unknown',
      reasonCode: 'UNKNOWN_CONTRACT',
      unknownContracts: unjudgable.map(coordinateKey),
    }
  }

  // C-010/C-003: the manifest's facet host API version must be within the
  // host's declared facet API surface — otherwise the requested Host API
  // range is unavailable (fail closed).
  if (!host.facetApiVersions.includes(manifest.facets.host.apiVersion)) {
    return {
      decision: 'rejected',
      reasonCode: 'FACET_API_VERSION_UNAVAILABLE',
      facetApiVersion: manifest.facets.host.apiVersion,
      hostFacetApiVersions: host.facetApiVersions,
    }
  }

  const available = (ref: { apiVersion: string; kind: string }): boolean => {
    const hostContract = supported.get(coordinateKey(ref))
    const registryEntry = index.lookupContract(ref)
    return Boolean(hostContract && registryEntry && hostContract.schemaHash === registryEntry.schemaHash)
  }
  const missingRequired = required.filter(ref => !available(ref))
  const missingOptional = optional.filter(ref => !available(ref))

  const hostPermissions = new Set(host.contracts.flatMap(contract => contract.permissions))
  const granted = new Set(grants)
  const deniedPermissions = manifest.permissions.filter(permission => {
    if (!hostPermissions.has(permission.name)) return true
    const definition = index.permissions.permissions.find(item => item.name === permission.name)
    return !definition || (definition.default === 'deny' && !granted.has(permission.name))
  })

  if (missingRequired.length > 0) {
    return {
      decision: 'rejected',
      reasonCode: 'REQUIRED_CONTRACT_UNAVAILABLE',
      missingRequired: missingRequired.map(coordinateKey),
    }
  }
  if (deniedPermissions.length > 0) {
    return {
      decision: 'waiting_authorization',
      reasonCode: 'PERMISSION_NOT_GRANTED',
      deniedPermissions: deniedPermissions.map(permission => permission.name),
    }
  }
  return missingOptional.length > 0
    ? { decision: 'compatible_degraded', missingOptional: missingOptional.map(coordinateKey) }
    : { decision: 'compatible' }
}
