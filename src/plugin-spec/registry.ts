/** Load and verify the pinned dsh-TUI admission profile. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdmissionCatalog } from './tui-extension.js'
import type { ContractRegistry, PermissionEntry, PermissionRegistry, RegistryEntry } from './types.js'

export const DSH_STD_REVISION = '614dfa1ac168db79fcf4577cf0ebb34e2e3b944b'
export const ECOSYSTEM_SPEC_REVISION = 'd28c267fe7fd775428ec2dccd65b0b7efd4dacee'

export interface SpecData {
  dir: string
  registry: ContractRegistry
  permissions: PermissionRegistry
  schemas: {
    host: Record<string, unknown>
    ledger: Record<string, unknown>
    claim: Record<string, unknown>
  }
}

const REGISTRY_FILE = join('registry', 'registry-0.15.json')
const EXPECTED_PROFILE_VERSION = 'tui-admission/0.15'
const EXPECTED_STD_REPOSITORY = 'https://github.com/Yan-Zero/dsh-std'
const EXPECTED_STD_SUBMODULE = 'vendor/dsh-std'
const EXPECTED_STD_MANIFEST_VERSION = '0.15'
const EXPECTED_PERMISSION_REGISTRY_VERSION = '0.1'

// The permission registry is policy, not merely input data. Keep the
// admission defaults and scopes pinned to the reviewed dsh-ecosystem-spec
// revision so a locally modified copy cannot silently widen a capability.
const EXPECTED_PERMISSIONS: readonly Pick<PermissionEntry, 'name' | 'default' | 'revocable' | 'scope'>[] = Object.freeze([
  { name: 'storage.local.read', default: 'deny', revocable: true, scope: 'plugin namespace' },
  { name: 'storage.local.write', default: 'deny', revocable: true, scope: 'plugin namespace' },
  { name: 'commands.invoke', default: 'allow', revocable: true, scope: 'declared command id' },
  { name: 'messages.observe.read', default: 'deny', revocable: true, scope: 'message observation scope' },
  { name: 'session.input.intercept', default: 'deny', revocable: true, scope: 'decision event subscription' },
  { name: 'session.rewind.intercept', default: 'deny', revocable: true, scope: 'decision event subscription' },
  { name: 'session.switch.intercept', default: 'deny', revocable: true, scope: 'decision event subscription' },
  { name: 'session.compact.intercept', default: 'deny', revocable: true, scope: 'decision event subscription' },
])

export function locateSpecDir(start: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = start
  for (let index = 0; index < 8; index++) {
    if (existsSync(join(dir, 'dsh-ecosystem-spec', REGISTRY_FILE))) return join(dir, 'dsh-ecosystem-spec')
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function loadJson(dir: string, relative: string): unknown {
  return JSON.parse(readFileSync(join(dir, relative), 'utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function soundEntry(value: unknown, privateDefinition: boolean): boolean {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === ''
    || (value.kind !== 'capability' && value.kind !== 'event')) return false
  if (!isRecord(value.coordinates)
    || typeof value.coordinates.apiVersion !== 'string' || value.coordinates.apiVersion === ''
    || typeof value.coordinates.kind !== 'string' || value.coordinates.kind === '') return false
  if (!Array.isArray(value.permissions) || !value.permissions.every(permission => typeof permission === 'string')) return false
  if (privateDefinition) {
    return value.authority === 'dsh-tui'
      && typeof value.profile === 'string'
      && value.profile.length > 0
      && typeof value.profileHash === 'string'
      && /^sha256:[0-9a-f]{64}$/u.test(value.profileHash)
  }
  return typeof value.package === 'string' && /^@dsh-std\/[a-z0-9][a-z0-9-]*$/u.test(value.package)
}

function structurallySound(data: { registry: unknown; permissions: unknown; schemas: Record<string, unknown> }): boolean {
  if (!isRecord(data.registry)
    || data.registry.profileVersion !== EXPECTED_PROFILE_VERSION
    || !isRecord(data.registry.std)
    || data.registry.std.repository !== EXPECTED_STD_REPOSITORY
    || data.registry.std.submodule !== EXPECTED_STD_SUBMODULE
    || data.registry.std.manifestVersion !== EXPECTED_STD_MANIFEST_VERSION
    || !Array.isArray(data.registry.imports)
    || !Array.isArray(data.registry.definitions)
    || !Array.isArray(data.registry.facetApiVersions)
    || data.registry.facetApiVersions.length === 0
    || !data.registry.facetApiVersions.every(version => typeof version === 'string'
      && /^v[0-9]+(?:alpha[0-9]+|beta[0-9]+)?$/u.test(version))) return false
  if (new Set(data.registry.facetApiVersions).size !== data.registry.facetApiVersions.length) return false
  if (!data.registry.imports.every(entry => soundEntry(entry, false))) return false
  if (!data.registry.definitions.every(entry => soundEntry(entry, true))) return false
  const entries = [...data.registry.imports, ...data.registry.definitions]
  const names = new Set<string>()
  const coordinates = new Set<string>()
  for (const entry of entries) {
    if (names.has(entry.name)) return false
    names.add(entry.name)
    const key = `${entry.coordinates.apiVersion}#${entry.coordinates.kind}`
    if (coordinates.has(key)) return false
    coordinates.add(key)
    if ('authority' in entry && !entry.coordinates.apiVersion.startsWith('tui.dsh/')) return false
  }
  if (!isRecord(data.permissions)
    || data.permissions.registryVersion !== EXPECTED_PERMISSION_REGISTRY_VERSION
    || !Array.isArray(data.permissions.permissions)
    || data.permissions.permissions.length !== EXPECTED_PERMISSIONS.length) return false
  const expectedPermissions = new Map(EXPECTED_PERMISSIONS.map(permission => [permission.name, permission]))
  const permissionNames = new Set<string>()
  for (const permission of data.permissions.permissions) {
    if (!isRecord(permission) || typeof permission.name !== 'string'
      || (permission.default !== 'allow' && permission.default !== 'deny')
      || typeof permission.revocable !== 'boolean'
      || typeof permission.scope !== 'string'
      || permission.scope.trim() === '') return false
    if (permissionNames.has(permission.name)) return false
    permissionNames.add(permission.name)
    const expected = expectedPermissions.get(permission.name)
    if (expected === undefined
      || permission.default !== expected.default
      || permission.revocable !== expected.revocable
      || permission.scope !== expected.scope) return false
    if ('rationale' in permission && permission.rationale !== undefined && typeof permission.rationale !== 'string') return false
  }
  if (permissionNames.size !== expectedPermissions.size) return false
  const knownPermissions = new Set(expectedPermissions.keys())
  if (!entries.every(entry => entry.permissions.every(permission => knownPermissions.has(permission)))) return false
  return Object.values(data.schemas).every(isRecord)
}

export function loadSpecData(dir: string | undefined = locateSpecDir()): SpecData | undefined {
  if (dir === undefined) return undefined
  try {
    const data = {
      dir,
      registry: loadJson(dir, REGISTRY_FILE),
      permissions: loadJson(dir, join('registry', 'permissions-0.1.json')),
      schemas: {
        host: loadJson(dir, join('schemas', 'host-descriptor.schema.json')),
        ledger: loadJson(dir, join('schemas', 'effect-ledger-record.schema.json')),
        claim: loadJson(dir, join('schemas', 'conformance-claim.schema.json')),
      },
    }
    return structurallySound(data) ? data as SpecData : undefined
  } catch {
    return undefined
  }
}

export function registryEntries(registry: ContractRegistry): RegistryEntry[] {
  return Array.isArray(registry.imports) && Array.isArray(registry.definitions)
    ? [...registry.imports, ...registry.definitions]
    : []
}

export function digestFile(dir: string, relative: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(readFileSync(join(dir, relative))).digest('hex')}`
}

/** Verify definition availability and private profile digest pins. */
export function verifyRegistry(data: SpecData): string[] {
  const failures: string[] = []
  const registry = data?.registry as unknown as Record<string, unknown> | undefined
  if (!isRecord(registry)
    || !Array.isArray(registry.imports)
    || !Array.isArray(registry.definitions)) {
    return ['registry imports/definitions are malformed']
  }
  const names = new Set<string>()
  const coordinates = new Set<string>()
  const { protocols } = createAdmissionCatalog()
  for (const raw of [...registry.imports, ...registry.definitions]) {
    const privateDefinition = registry.definitions.includes(raw)
    if (!soundEntry(raw, privateDefinition)) {
      failures.push('registry entry is malformed')
      continue
    }
    const entry = raw as RegistryEntry
    const key = `${entry.coordinates.apiVersion}#${entry.coordinates.kind}`
    if (names.has(entry.name)) failures.push(`${entry.name}: duplicate registry name`)
    names.add(entry.name)
    if (coordinates.has(key)) failures.push(`${key}: duplicate registry coordinate`)
    coordinates.add(key)
    if ('authority' in entry && !entry.coordinates.apiVersion.startsWith('tui.dsh/')) {
      failures.push(`${key}: dsh-tui definition must use the private protocol group`)
    }
    if (!protocols.understands(entry.coordinates)) failures.push(`${key}: ProtocolCatalog definition unavailable`)
    if ('profile' in entry) {
      let actual: string
      try {
        actual = digestFile(data.dir, entry.profile)
      } catch {
        failures.push(`${entry.name}: private profile unreadable (${entry.profile})`)
        continue
      }
      if (actual !== entry.profileHash) failures.push(`${entry.name}: profileHash drifted (registry ${entry.profileHash}, actual ${actual})`)
    }
  }
  return failures
}

/** Verify the TUI-owned definitions; public definitions live in dsh-std. */
export function verifyContractProfiles(data: SpecData): string[] {
  const requiredKeys = [
    'name', 'version', 'kind', 'coordinates', 'caller', 'permissions',
    'errors', 'concurrency', 'timeout', 'cleanup', 'privacyClass', 'securityBoundary',
  ]
  const failures: string[] = []
  if (!isRecord(data?.registry)
    || !Array.isArray((data.registry as unknown as { definitions?: unknown }).definitions)) {
    return ['registry definitions are malformed']
  }
  for (const entry of data.registry.definitions) {
    if (!soundEntry(entry, true)) {
      failures.push('registry definition is malformed')
      continue
    }
    let profile: Record<string, unknown>
    try {
      const loaded = loadJson(data.dir, entry.profile)
      if (!isRecord(loaded)) {
        failures.push(`${entry.name}: private profile is not an object (${entry.profile})`)
        continue
      }
      profile = loaded
    } catch {
      failures.push(`${entry.name}: private profile unreadable (${entry.profile})`)
      continue
    }
    for (const key of requiredKeys) {
      if (!(key in profile)) failures.push(`${entry.name}: contract profile missing "${key}"`)
    }
    const coordinates = profile.coordinates as { apiVersion?: unknown; kind?: unknown } | undefined
    if (coordinates?.apiVersion !== entry.coordinates.apiVersion || coordinates.kind !== entry.coordinates.kind) {
      failures.push(`${entry.name}: profile/registry coordinates mismatch`)
    }
    const actualPermissions = [...((profile.permissions as string[] | undefined) ?? [])].sort()
    if (JSON.stringify(actualPermissions) !== JSON.stringify([...entry.permissions].sort())) {
      failures.push(`${entry.name}: profile/registry permissions mismatch`)
    }
    if (!('operations' in profile) || profile.securityBoundary !== false) {
      failures.push(`${entry.name}: capability boundary is incomplete`)
    }
  }
  return failures
}
