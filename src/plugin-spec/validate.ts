/** Semantic validation layered on the official manifest parser/projection. */

import { projectManifest } from '@dsh-std/manifest'
import { createAdmissionCatalog } from './tui-extension.js'
import { registryEntries } from './registry.js'
import { INTERCEPT_PERMISSIONS, normalizePermissionScope } from './permission-scope.js'
import type {
  ContractCoordinate,
  ContractRegistry,
  HostDescriptor,
  PermissionRegistry,
  PluginManifest,
  RegistryEntry,
  SubscriptionRef,
} from './types.js'

export interface ContractIndex {
  registry: ContractRegistry
  permissions: PermissionRegistry
  facetApiVersions: string[]
  protocols: ReturnType<typeof createAdmissionCatalog>['protocols']
  manifests: ReturnType<typeof createAdmissionCatalog>['manifests']
  lookupContract(coordinate: ContractCoordinate): RegistryEntry | undefined
  resolveContractRef(ref: ContractCoordinate): { entry: RegistryEntry | null; unregisteredVersion: boolean }
  resolveSubscription(sub: SubscriptionRef): RegistryEntry
}

const coordinateKey = (coordinate: ContractCoordinate): string => `${coordinate.apiVersion}#${coordinate.kind}`
export const groupOf = (apiVersion: string): string => apiVersion.split('/')[0] ?? ''

export function createContractIndex(registry: ContractRegistry, permissions: PermissionRegistry): ContractIndex {
  const entries = registryEntries(registry)
  const byCoordinate = new Map(entries.map(entry => [coordinateKey(entry.coordinates), entry]))
  const byName = new Map(entries.map(entry => [entry.name, entry]))
  const { protocols, manifests } = createAdmissionCatalog()

  const resolveContractRef = (ref: ContractCoordinate): { entry: RegistryEntry | null; unregisteredVersion: boolean } => {
    const exact = byCoordinate.get(coordinateKey(ref))
    if (exact !== undefined) return { entry: exact, unregisteredVersion: false }
    const sameGroup = entries.filter(entry => groupOf(entry.coordinates.apiVersion) === groupOf(ref.apiVersion))
    if (sameGroup.length === 0) throw new Error(`unknown protocol group: ${groupOf(ref.apiVersion)}`)
    if (!sameGroup.some(entry => entry.coordinates.kind === ref.kind)) {
      throw new Error(`unknown protocol kind: ${coordinateKey(ref)}`)
    }
    return { entry: null, unregisteredVersion: true }
  }

  const resolveSubscription = (subscription: SubscriptionRef): RegistryEntry => {
    const entry = typeof subscription === 'string'
      ? byName.get(subscription)
      : byCoordinate.get(coordinateKey(subscription))
    if (entry === undefined) {
      throw new Error(`unknown subscription: ${typeof subscription === 'string' ? subscription : coordinateKey(subscription)}`)
    }
    if (entry.kind !== 'event') throw new Error(`subscription must reference an event: ${entry.name}`)
    return entry
  }

  return {
    registry,
    permissions,
    facetApiVersions: [...registry.facetApiVersions],
    protocols,
    manifests,
    lookupContract: coordinate => byCoordinate.get(coordinateKey(coordinate)),
    resolveContractRef,
    resolveSubscription,
  }
}

export function validatePlugin(index: ContractIndex, manifest: PluginManifest): void {
  if (!index.facetApiVersions.includes(manifest.facets.host.apiVersion)) {
    throw new Error(`facet apiVersion is not admitted: ${manifest.facets.host.apiVersion}`)
  }
  for (const requirement of manifest.requires.contracts) {
    index.resolveContractRef(requirement)
    if (requirement.optional === true && !requirement.fallback) {
      throw new Error(`optional protocol requires a TUI fallback: ${coordinateKey(requirement)}`)
    }
  }
  for (const subscription of manifest.subscriptions) index.resolveSubscription(subscription)

  const knownPermissions = new Set(index.permissions.permissions.map(permission => permission.name))
  const commandIds = new Set(manifest.contributes.commands.map(command => command.id))
  const requiresDecisionEvents = manifest.requires.contracts.some(requirement =>
    requirement.kind === 'DecisionEvents'
    && groupOf(requirement.apiVersion) === groupOf('tui.dsh/v1alpha1'))
  const capabilityForPermission: Readonly<Record<string, { apiVersion: string; kind: string }>> = {
    'commands.invoke': { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' },
    'storage.local.read': { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' },
    'storage.local.write': { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' },
    'messages.observe.read': { apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver' },
    'session.input.intercept': { apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' },
    'session.rewind.intercept': { apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' },
    'session.switch.intercept': { apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' },
    'session.compact.intercept': { apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' },
  }
  for (const permission of manifest.permissions) {
    if (!knownPermissions.has(permission.name)) {
      throw new Error(`permission is not admitted by the TUI profile: ${permission.name}`)
    }
    if (normalizePermissionScope(permission.name, permission.scope, manifest.id) === undefined) {
      throw new Error(`permission scope cannot be enforced: ${permission.name}@${permission.scope}`)
    }
    if (permission.name === 'commands.invoke' && !commandIds.has(permission.scope)) {
      throw new Error(`commands.invoke scope is not a declared command: ${permission.scope}`)
    }
    if (INTERCEPT_PERMISSIONS.has(permission.name) && !requiresDecisionEvents) {
      throw new Error(`${permission.name} requires tui.dsh/v1alpha1#DecisionEvents`)
    }
    const capability = capabilityForPermission[permission.name]
    // An otherwise valid contract reference may use an unregistered version
    // from the same protocol group. Keep that manifest structurally valid so
    // negotiation can return UNKNOWN_PROTOCOL_VERSION rather than letting the
    // permission/capability cross-check mask the version-drift decision.
    if (capability !== undefined && !manifest.requires.contracts.some(requirement =>
      requirement.kind === capability.kind && groupOf(requirement.apiVersion) === groupOf(capability.apiVersion))) {
      throw new Error(`${permission.name} requires ${capability.apiVersion}#${capability.kind}`)
    }
  }
  for (const commandId of commandIds) {
    if (!manifest.permissions.some(permission => permission.name === 'commands.invoke' && permission.scope === commandId)) {
      throw new Error(`declared command is missing commands.invoke permission scope: ${commandId}`)
    }
  }

  const projected = projectManifest(manifest)
  const report = index.manifests.validate(projected, index.protocols)
  const errors = report.issues.filter(issue => issue.severity === 'error')
  if (errors.length > 0) throw new Error(errors.map(issue => issue.message).join('; '))
}

export function validateHost(index: ContractIndex, host: HostDescriptor): void {
  const seen = new Set<string>()
  const knownPermissions = new Set(index.permissions.permissions.map(permission => permission.name))
  for (const contract of host.contracts) {
    const key = coordinateKey(contract)
    if (seen.has(key)) throw new Error(`host declares duplicate protocol: ${key}`)
    seen.add(key)
    const entry = index.lookupContract(contract)
    const definition = index.protocols.resolve(contract)
    if (entry === undefined || definition === undefined) throw new Error(`host declares an unknown protocol: ${key}`)
    definition.validateSupport(Object.hasOwn(contract, 'spec') ? contract.spec : undefined)
    if ('package' in entry) {
      if (contract.definition.source !== 'dsh-std' || contract.definition.package !== entry.package) {
        throw new Error(`host dsh-std definition source mismatch: ${key}`)
      }
    } else if (contract.definition.source !== 'tui-profile' || contract.definition.profileHash !== entry.profileHash) {
      throw new Error(`host TUI profile definition hash mismatch: ${key}`)
    }
    const expectedPermissions = [...entry.permissions].sort()
    const actualPermissions = [...contract.permissions].sort()
    if (expectedPermissions.length !== actualPermissions.length
      || expectedPermissions.some((permission, index) => permission !== actualPermissions[index])) {
      throw new Error(`host permission advertisement mismatch: ${key}`)
    }
    for (const permission of contract.permissions) {
      if (!knownPermissions.has(permission)) throw new Error(`host declares unknown permission: ${permission}`)
    }
  }
}
