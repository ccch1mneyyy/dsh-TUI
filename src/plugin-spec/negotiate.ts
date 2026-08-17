/** Five-state admission decision using dsh-std projection and ProtocolCatalog. */

import { defineProtocolDeclaration } from '@dsh-std/core'
import { projectManifest } from '@dsh-std/manifest'
import type { ContractIndex } from './validate.js'
import { rawScopeCovers } from './permission-scope.js'
import type { HostDescriptor, ManifestPermission, NegotiationDecision, PluginManifest } from './types.js'

const coordinateKey = (ref: { apiVersion: string; kind: string }): string => `${ref.apiVersion}#${ref.kind}`

export interface GrantedPermission {
  name: string
  scope: string
  /** Explicit effective answer. Omitted means a legacy positive grant row. */
  granted?: boolean
}

export function negotiate(
  index: ContractIndex,
  manifest: PluginManifest,
  host: HostDescriptor,
  grants: readonly GrantedPermission[] = [],
): NegotiationDecision {
  const supported = new Map(host.contracts.map(contract => [coordinateKey(contract), contract]))
  const required = manifest.requires.contracts.filter(reference => reference.optional !== true)
  const optional = manifest.requires.contracts.filter(reference => reference.optional === true)

  const unknown = manifest.requires.contracts.filter(reference => {
    try {
      return index.resolveContractRef(reference).unregisteredVersion
    } catch {
      return false
    }
  })
  if (unknown.length > 0) {
    return {
      decision: 'unknown',
      reasonCode: 'UNKNOWN_PROTOCOL_VERSION',
      unknownContracts: unknown.map(coordinateKey),
    }
  }

  if (!host.facetApiVersions.includes(manifest.facets.host.apiVersion)) {
    return {
      decision: 'rejected',
      reasonCode: 'FACET_API_VERSION_UNAVAILABLE',
      facetApiVersion: manifest.facets.host.apiVersion,
      hostFacetApiVersions: host.facetApiVersions,
    }
  }

  const missingRequired = required.filter(reference => !supported.has(coordinateKey(reference)))
  const missingOptional = optional.filter(reference => !supported.has(coordinateKey(reference)))
  if (missingRequired.length > 0) {
    return {
      decision: 'rejected',
      reasonCode: 'REQUIRED_PROTOCOL_UNAVAILABLE',
      missingRequired: missingRequired.map(coordinateKey),
    }
  }

  const projected = projectManifest(manifest)
  const facet = projected.spec.facets.find(candidate => candidate.name === 'host')
  const supportedKeys = new Set(host.contracts.map(contract => coordinateKey(contract)))
  const declaration = defineProtocolDeclaration({
    participant: { id: manifest.id },
    // An optional protocol that is absent is intentionally omitted from the
    // evaluator input; its degraded state was already recorded above. This
    // keeps ProtocolCatalog's required-support error meaningful for every
    // remaining requirement.
    requires: (facet?.protocols?.requires ?? []).filter(reference =>
      reference.optional !== true || supportedKeys.has(coordinateKey(reference))),
  })
  const hostDeclaration = defineProtocolDeclaration({
    participant: { id: host.hostId },
    supports: host.contracts.map(contract => ({
      apiVersion: contract.apiVersion,
      kind: contract.kind,
      ...(Object.hasOwn(contract, 'spec') ? { spec: contract.spec } : {}),
    })),
  })
  const report = index.protocols.negotiate([declaration, hostDeclaration])
  if (!report.compatible) {
    return {
      decision: 'rejected',
      reasonCode: 'PROTOCOL_NEGOTIATION_FAILED',
      issues: report.issues,
    }
  }

  const hostPermissions = new Set(host.contracts.flatMap(contract => contract.permissions))
  const denied = manifest.permissions.filter((request: ManifestPermission) => {
    if (!hostPermissions.has(request.name)) return true
    const definition = index.permissions.permissions.find(permission => permission.name === request.name)
    if (definition === undefined) return true
    const matching = grants.filter(grant => grant.name === request.name
      && rawScopeCovers(grant.name, grant.scope, request.scope, manifest.id))
    // Explicit revocation wins over an allow-default permission. This keeps
    // admission diagnostics aligned with the runtime checkpoint instead of
    // reporting a plugin as compatible until its first invocation fails.
    if (matching.some(grant => grant.granted === false)) return true
    if (definition.default === 'allow') return false
    return !matching.some(grant => grant.granted !== false)
  })
  if (denied.length > 0) {
    return {
      decision: 'waiting_authorization',
      reasonCode: 'PERMISSION_NOT_GRANTED',
      deniedPermissions: denied.map(request => `${request.name}@${request.scope}`),
    }
  }

  return missingOptional.length > 0
    ? { decision: 'compatible_degraded', missingOptional: missingOptional.map(coordinateKey) }
    : { decision: 'compatible' }
}
