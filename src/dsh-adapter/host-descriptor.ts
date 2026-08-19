/** Build the current dsh-TUI Host Descriptor from the pinned admission profile. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContractCoordinate, HostContract, HostDescriptor } from '../plugin-spec/types.js'
import { digestFile, loadSpecData, verifyContractProfiles } from '../plugin-spec/registry.js'
import { TUI_DECISION_EVENT_NAMES } from '../plugin-spec/tui-extension.js'
import { createContractIndex, validateHost } from '../plugin-spec/validate.js'
import { check } from '../plugin-spec/schema-check.js'

export const HOST_SUPPORTED_CONTRACTS: readonly ContractCoordinate[] = Object.freeze([
  { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' },
  { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' },
  { apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver' },
  { apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' },
])

/** The facet version is part of the host identity, not a protocol definition.
 * Keep a conservative fallback so a descriptor remains schema-valid when the
 * optional vendored registry is unavailable; the contract list is still
 * empty in that degraded state. */
export const HOST_FACET_API_VERSIONS: readonly string[] = Object.freeze(['v1alpha1'])

export interface HostDescriptorOptions {
  hostId?: string
  hostVersion?: string
  generationId: string
  headless?: boolean
  supported?: readonly ContractCoordinate[]
  specDir?: string
}

export interface HostDescriptorBuild {
  descriptor: HostDescriptor
  readonly dropped: readonly string[]
  readonly warnings: readonly string[]
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value
  seen.add(value as object)
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen)
  return Object.freeze(value)
}

export function readOwnPackageVersion(): string {
  const candidates: string[] = []
  try {
    candidates.push(fileURLToPath(import.meta.resolve('@deepseek-harness-tui/dsh-tui/package.json')))
  } catch {
    // Fall through to the source/package walk-up path.
  }
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let index = 0; index < 8; index++) {
    candidates.push(join(dir, 'package.json'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
      if (manifest.name === '@deepseek-harness-tui/dsh-tui'
        && typeof manifest.version === 'string'
        && manifest.version !== '') return manifest.version
    } catch {
      // Keep looking.
    }
  }
  return '0.0.0'
}

function supportSpec(coordinate: ContractCoordinate): unknown {
  if (coordinate.apiVersion === 'tui.dsh/v1alpha1' && coordinate.kind === 'DecisionEvents') {
    return { features: [...TUI_DECISION_EVENT_NAMES] }
  }
  return undefined
}

export function buildHostDescriptor(options: HostDescriptorOptions): HostDescriptorBuild {
  const warnings: string[] = []
  const dropped: string[] = []
  const contracts: HostContract[] = []
  const data = loadSpecData(options.specDir)
  // `loadSpecData` rejects malformed/empty facet declarations. Preserve the
  // pinned values exactly when data is valid; use the schema-valid fallback
  // only for the completely unavailable/degraded path.
  const facetApiVersions = data === undefined
    ? [...HOST_FACET_API_VERSIONS]
    : [...data.registry.facetApiVersions]
  const profileFailures = data === undefined ? [] : verifyContractProfiles(data)

  if (data === undefined) {
    warnings.push('admission profile unavailable (dsh-ecosystem-spec/); advertising an empty protocol surface')
  } else {
    const index = createContractIndex(data.registry, data.permissions)
    for (const coordinate of options.supported ?? HOST_SUPPORTED_CONTRACTS) {
      const key = `${coordinate.apiVersion}#${coordinate.kind}`
      const entry = index.lookupContract(coordinate)
      const definition = index.protocols.resolve(coordinate)
      if (entry === undefined || definition === undefined) {
        dropped.push(key)
        warnings.push(`${key}: live implementation has no pinned ProtocolCatalog definition`)
        continue
      }
      if ('profile' in entry) {
        if (profileFailures.length > 0) {
          dropped.push(key)
          warnings.push(`${key}: TUI contract profile self-check failed (${profileFailures.join(' | ')})`)
          continue
        }
        let actual: string
        try {
          actual = digestFile(data.dir, entry.profile)
        } catch {
          dropped.push(key)
          warnings.push(`${key}: TUI profile is unreadable (${entry.profile})`)
          continue
        }
        if (actual !== entry.profileHash) {
          dropped.push(key)
          warnings.push(`${key}: TUI profile hash drifted (expected ${entry.profileHash}, actual ${actual})`)
          continue
        }
      }
      const spec = supportSpec(coordinate)
      try {
        definition.validateSupport(spec)
      } catch (error) {
        dropped.push(key)
        warnings.push(`${key}: support spec rejected by its definition (${error instanceof Error ? error.message : String(error)})`)
        continue
      }
      contracts.push({
        ...coordinate,
        ...(spec === undefined ? {} : { spec }),
        definition: 'package' in entry
          ? { source: 'dsh-std', package: entry.package }
          : { source: 'tui-profile', profileHash: entry.profileHash },
        permissions: [...entry.permissions],
      })
    }
  }

  const descriptor: HostDescriptor = {
    $schema: 'urn:dsh-tui:host-descriptor:0.15',
    hostId: options.hostId ?? 'dsh-tui',
    hostVersion: options.hostVersion ?? readOwnPackageVersion(),
    facetApiVersions: [...facetApiVersions],
    contracts,
    runtime: {
      location: 'local',
      generationId: options.generationId,
      headless: options.headless ?? false,
    },
    trustLevel: 'trusted-in-process',
    platform: { os: process.platform, arch: process.arch, node: process.version },
  }

  if (data !== undefined) {
    try {
      validateHost(createContractIndex(data.registry, data.permissions), descriptor)
    } catch (error) {
      warnings.push(`constructed descriptor failed semantic validation: ${error instanceof Error ? error.message : String(error)}`)
      descriptor.contracts.length = 0
    }
    try {
      check(descriptor, data.schemas.host, data.schemas.host)
    } catch (error) {
      warnings.push(`constructed descriptor failed schema validation: ${error instanceof Error ? error.message : String(error)}`)
      descriptor.contracts.length = 0
    }
  }
  // The descriptor is handed to untrusted admission/diagnostic callers.  A
  // cached mutable object would let one caller delete contracts or forge the
  // runtime generation for every later negotiation, so freeze the complete
  // graph and return immutable diagnostic arrays as well.
  return Object.freeze({
    descriptor: freezeDeep(descriptor),
    dropped: Object.freeze(dropped),
    warnings: Object.freeze(warnings),
  })
}
