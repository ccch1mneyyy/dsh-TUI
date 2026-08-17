/** Build the current dsh-TUI Host Descriptor from the pinned admission profile. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContractCoordinate, HostContract, HostDescriptor } from '../plugin-spec/types.js'
import { digestFile, loadSpecData } from '../plugin-spec/registry.js'
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
  dropped: string[]
  warnings: string[]
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
  const advertisedFacets = data?.registry.facetApiVersions
    ?.filter(version => /^v[0-9]+(?:alpha[0-9]+|beta[0-9]+)$/u.test(version))
  const facetApiVersions = advertisedFacets !== undefined && advertisedFacets.length > 0
    ? advertisedFacets
    : [...HOST_FACET_API_VERSIONS]

  if (data === undefined) {
    warnings.push('admission profile unavailable (ecosystem-spec/); advertising an empty protocol surface')
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
  return { descriptor, dropped, warnings }
}
