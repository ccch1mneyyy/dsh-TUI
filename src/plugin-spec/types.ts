/**
 * Community Consensus v0.15 的类型面——与 `ecosystem-spec/` 的 vendored
 * schema/registry 一一对应。本目录（plugin-spec）是零依赖纯库：校验、
 * 协商与 registry 自检的 TS 移植，蓝本是上游
 * `conformance/tests/run.js`（v0.15 + 红队验收修复版）。
 *
 * 加载时强制不在本仓库（dsh CLI 的 Loader 才决定挂哪些插件）；这里的
 * validate/negotiate 服务于诊断面（/plugins check）与运行时降级的决策
 * 依据。
 */

/** 元协议坐标（K8s 风格 apiVersion + kind）。 */
export interface ContractCoordinate {
  apiVersion: string
  kind: string
}

/** manifest 的契约引用：坐标 + optional/fallback（fallback 是 optional 的
 *  必填字段，C-030）。 */
export interface ContractRef extends ContractCoordinate {
  optional?: boolean
  fallback?: string
}

export interface ManifestPermission {
  name: string
  scope: string
  reason?: string
}

export type SubscriptionRef = ContractCoordinate & { scope?: string } | string

/** dsh-plugin.json（v0.15）。只声明本库消费到的字段；schema 负责完整约束。 */
export interface PluginManifest {
  $schema: string
  id: string
  name: string
  version: string
  manifestVersion: string
  facets: { host: { entry: string; apiVersion: string } }
  requires: { contracts: ContractRef[] }
  permissions: ManifestPermission[]
  contributes: { commands: Array<{ id: string; title: string; description?: string }> }
  subscriptions: SubscriptionRef[]
  license: string
  source: { repository: string; revision?: string }
}

export interface HostContract extends ContractCoordinate {
  version?: string
  schemaHash: string
  permissions: string[]
}

/** Host Descriptor（v0.15，C-010）。 */
export interface HostDescriptor {
  $schema: string
  hostId: string
  hostVersion: string
  facetApiVersions: string[]
  contracts: HostContract[]
  runtime: {
    location: 'local' | 'remote' | 'container'
    generationId: string
    headless: boolean
    remoteAttach?: boolean
  }
  trustLevel: 'trusted-in-process'
  platform: { os: string; arch: string; node?: string }
}

/** 五态协商决策（C-030）；优先级 unknown > rejected >
 *  waiting_authorization > compatible_degraded > compatible。 */
export type NegotiationDecision =
  | { decision: 'compatible' }
  | { decision: 'compatible_degraded'; missingOptional: string[] }
  | { decision: 'waiting_authorization'; reasonCode: string; deniedPermissions: string[] }
  | { decision: 'rejected'; reasonCode: string; missingRequired?: string[]; facetApiVersion?: string; hostFacetApiVersions?: string[] }
  | { decision: 'unknown'; reasonCode: string; unknownContracts: string[] }

/** 标准协商错误码（C-030 + C-041 的重复贡献码）。 */
export const NEGOTIATION_ERROR_CODES = [
  'REQUIRED_CONTRACT_UNAVAILABLE',
  'FACET_API_VERSION_UNAVAILABLE',
  'PERMISSION_NOT_GRANTED',
  'UNKNOWN_CONTRACT',
  'DUPLICATE_CONTRIBUTION_ID',
  'INVALID_MANIFEST',
] as const
export type NegotiationErrorCode = (typeof NEGOTIATION_ERROR_CODES)[number]

/** permissions-0.1.json 的条目。 */
export interface PermissionEntry {
  name: string
  default: 'allow' | 'deny'
  revocable: boolean
  scope: string
  rationale?: string
}

export interface PermissionRegistry {
  registryVersion: string
  permissions: PermissionEntry[]
}

/** registry-0.15.json 的契约条目。 */
export interface RegistryEntry {
  name: string
  coordinates: ContractCoordinate
  kind: 'capability' | 'event'
  version: string
  schema: string
  schemaHash: string
  permissions: string[]
  requiredHostBehavior: string[]
  eventEnvelope?: string
}

export interface ContractRegistry {
  registryVersion: string
  entries: RegistryEntry[]
  facetApiVersions?: string[]
}
