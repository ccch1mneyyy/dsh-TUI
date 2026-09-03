/** Types shared by the dsh-std admission adapter and the TUI runtime. */

import type { PluginManifest as StandardPluginManifest } from '@dsh-std/manifest'
import type { ContractCoordinate, ContractRef } from '../kernel/driver-types.js'

export type { ContractCoordinate, ContractRef }

export interface ManifestPermission {
  name: string
  scope: string
  reason?: string
}

export type SubscriptionRef = ContractCoordinate & { scope?: string } | string

/** Community v0.15 is parsed and frozen by @dsh-std/manifest. */
export type { ComponentManifest } from '@dsh-std/manifest'

export type PluginManifest = StandardPluginManifest

export type HostContractDefinition =
  | { source: 'dsh-std'; package: `@dsh-std/${string}` }
  | { source: 'tui-profile'; profileHash: `sha256:${string}` }

export interface HostContract extends ContractCoordinate {
  spec?: unknown
  definition: HostContractDefinition
  permissions: string[]
}

export interface HostDescriptor {
  $schema: 'urn:dsh-tui:host-descriptor:0.15'
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

export type NegotiationDecision =
  | { decision: 'compatible' }
  | { decision: 'compatible_degraded'; missingOptional: string[] }
  | { decision: 'waiting_authorization'; reasonCode: string; deniedPermissions: string[] }
  | {
      decision: 'rejected'
      reasonCode: string
      missingRequired?: string[]
      facetApiVersion?: string
      hostFacetApiVersions?: string[]
      issues?: readonly unknown[]
    }
  | { decision: 'unknown'; reasonCode: string; unknownContracts: string[] }

export const NEGOTIATION_ERROR_CODES = [
  'REQUIRED_PROTOCOL_UNAVAILABLE',
  'PROTOCOL_NEGOTIATION_FAILED',
  'FACET_API_VERSION_UNAVAILABLE',
  'PERMISSION_NOT_GRANTED',
  'UNKNOWN_PROTOCOL_VERSION',
  'DUPLICATE_CONTRIBUTION_ID',
  'INVALID_MANIFEST',
] as const
export type NegotiationErrorCode = (typeof NEGOTIATION_ERROR_CODES)[number]

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

interface RegistryEntryBase {
  name: string
  coordinates: ContractCoordinate
  kind: 'capability' | 'event'
  permissions: string[]
  eventEnvelope?: string
}

export interface ImportedRegistryEntry extends RegistryEntryBase {
  package: `@dsh-std/${string}`
}

export interface PrivateRegistryEntry extends RegistryEntryBase {
  authority: 'dsh-tui'
  profile: string
  profileHash: `sha256:${string}`
}

export type RegistryEntry = ImportedRegistryEntry | PrivateRegistryEntry

export interface ContractRegistry {
  profileVersion: string
  std: {
    repository: string
    submodule: string
    manifestVersion: string
  }
  imports: ImportedRegistryEntry[]
  definitions: PrivateRegistryEntry[]
  facetApiVersions: string[]
}
