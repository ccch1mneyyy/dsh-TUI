/** Load and verify the pinned dsh-TUI admission profile. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdmissionCatalog } from './tui-extension.js'
import type { ContractRegistry, PermissionRegistry, RegistryEntry } from './types.js'

export const DSH_STD_REVISION = 'a2faa86243a5693ee4970e3d8b3aaf361edea298'
export const ECOSYSTEM_SPEC_REVISION = 'be1e9a219bd01decf79d825e0c3ac1685bde2be4'

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

export function locateSpecDir(start: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = start
  for (let index = 0; index < 8; index++) {
    if (existsSync(join(dir, 'ecosystem-spec', REGISTRY_FILE))) return join(dir, 'ecosystem-spec')
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
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.kind !== 'string') return false
  if (!isRecord(value.coordinates)
    || typeof value.coordinates.apiVersion !== 'string'
    || typeof value.coordinates.kind !== 'string') return false
  if (!Array.isArray(value.permissions) || !value.permissions.every(permission => typeof permission === 'string')) return false
  if (privateDefinition) {
    return value.authority === 'dsh-tui'
      && typeof value.profile === 'string'
      && typeof value.profileHash === 'string'
  }
  return typeof value.package === 'string' && value.package.startsWith('@dsh-std/')
}

function structurallySound(data: { registry: unknown; permissions: unknown; schemas: Record<string, unknown> }): boolean {
  if (!isRecord(data.registry)
    || typeof data.registry.profileVersion !== 'string'
    || !isRecord(data.registry.std)
    || !Array.isArray(data.registry.imports)
    || !Array.isArray(data.registry.definitions)
    || !Array.isArray(data.registry.facetApiVersions)
    || !data.registry.facetApiVersions.every(version => typeof version === 'string')) return false
  if (!data.registry.imports.every(entry => soundEntry(entry, false))) return false
  if (!data.registry.definitions.every(entry => soundEntry(entry, true))) return false
  if (!isRecord(data.permissions) || !Array.isArray(data.permissions.permissions)) return false
  for (const permission of data.permissions.permissions) {
    if (!isRecord(permission) || typeof permission.name !== 'string'
      || (permission.default !== 'allow' && permission.default !== 'deny')) return false
  }
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
  if (!Array.isArray((data.registry as unknown as { imports?: unknown }).imports)
    || !Array.isArray((data.registry as unknown as { definitions?: unknown }).definitions)) {
    return ['registry imports/definitions are malformed']
  }
  const { protocols } = createAdmissionCatalog()
  for (const entry of registryEntries(data.registry)) {
    const key = `${entry.coordinates.apiVersion}#${entry.coordinates.kind}`
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
  if (!Array.isArray((data.registry as unknown as { definitions?: unknown }).definitions)) {
    return ['registry definitions are malformed']
  }
  for (const entry of data.registry.definitions) {
    let profile: Record<string, unknown>
    try {
      profile = loadJson(data.dir, entry.profile) as Record<string, unknown>
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
