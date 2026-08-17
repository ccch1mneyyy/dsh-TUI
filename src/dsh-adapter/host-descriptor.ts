/**
 * Host Descriptor construction (C-010): a pure function turning the vendored
 * registry + runtime facts into the machine-readable descriptor.
 *
 * Honesty rules:
 *
 * - Only contracts the RUNNING CODE actually provides are advertised —
 *   {@link HOST_SUPPORTED_CONTRACTS} grows one entry per batch as the
 *   capability lands (a declared-but-unimplemented contract would let
 *   negotiation answer `compatible` for a capability the plugin will never
 *   get).
 * - Every advertised contract re-digests its vendored schema file at build
 *   time; a drifted/unreadable file drops the contract from the descriptor
 *   with a warning (fail closed — the host refuses to advertise a contract
 *   whose pinned hash it cannot verify, C-020).
 * - Vendored data missing entirely (packaging accident) → an empty contract
 *   surface + warning, never a crash (the descriptor is diagnostic input,
 *   not boot-critical).
 *
 * The result feeds /plugins (diagnostics) and negotiation; it is NOT sent
 * anywhere.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContractCoordinate, HostContract, HostDescriptor } from '../plugin-spec/types.js'
import { digestFile, loadSpecData } from '../plugin-spec/registry.js'
import { createContractIndex } from '../plugin-spec/validate.js'

/**
 * Contracts this build of the TUI actually provides: Command
 * (registration/invoke via the official dsh-commands spine; error-code
 * standardization — DUPLICATE_CONTRIBUTION_ID — lands with the effect
 * ledger batch), LocalStorage (./plugin-storage.js), and MessageObserver
 * (./message-observer.js). The plugin-host runtime additionally FILTERS
 * this list by runtime reality before building (e.g. Command drops out
 * when the commands service is not mounted on the context).
 */
export const HOST_SUPPORTED_CONTRACTS: readonly ContractCoordinate[] = [
  { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' },
  { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' },
  { apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver' },
]

export interface HostDescriptorOptions {
  /** Defaults to 'dsh-tui'. */
  hostId?: string
  /** Defaults to the installed package's own package.json version. */
  hostVersion?: string
  /** Runtime generation id (C-050) — from the plugin-host runtime. */
  generationId: string
  /** Defaults to false (interactive TUI). */
  headless?: boolean
  /** Contracts to advertise; defaults to {@link HOST_SUPPORTED_CONTRACTS}. */
  supported?: readonly ContractCoordinate[]
  /** Spec data directory (injectable for tests). */
  specDir?: string
}

export interface HostDescriptorBuild {
  descriptor: HostDescriptor
  /** Coordinates dropped instead of advertised (drift/skew/unreadable). */
  dropped: string[]
  /** Human-readable explanations for every drop and data problem. */
  warnings: string[]
}

/** The installed dsh-tui package's own version (fallback '0.0.0'). */
export function readOwnPackageVersion(): string {
  const candidates: string[] = []
  try {
    candidates.push(fileURLToPath(import.meta.resolve('@deepseek-harness-tui/dsh-tui/package.json')))
  } catch {
    // Self-reference resolution unavailable (unusual embedder) — walk up.
  }
  // Walk-up fallback: nearest package.json named like this package.
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, 'package.json'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
      if (manifest.name === '@deepseek-harness-tui/dsh-tui' && typeof manifest.version === 'string' && manifest.version !== '') {
        return manifest.version
      }
    } catch {
      // Keep looking.
    }
  }
  return '0.0.0'
}

export function buildHostDescriptor(options: HostDescriptorOptions): HostDescriptorBuild {
  const warnings: string[] = []
  const dropped: string[] = []
  const contracts: HostContract[] = []
  const data = loadSpecData(options.specDir)
  let facetApiVersions: string[] = []
  if (data === undefined) {
    warnings.push('vendored spec data unavailable (ecosystem-spec/); advertising an empty contract surface')
  } else {
    facetApiVersions = data.registry.facetApiVersions ?? []
    if (facetApiVersions.length === 0) {
      warnings.push('registry declares no facetApiVersions')
    }
    const index = createContractIndex(data.registry, data.permissions)
    for (const coordinate of options.supported ?? HOST_SUPPORTED_CONTRACTS) {
      const key = `${coordinate.apiVersion}#${coordinate.kind}`
      const entry = index.lookupContract(coordinate)
      if (entry === undefined) {
        dropped.push(key)
        warnings.push(`${key}: supported by code but absent from the registry — dropped (code/registry skew)`)
        continue
      }
      let actual: string
      try {
        actual = digestFile(data.dir, entry.schema)
      } catch {
        dropped.push(key)
        warnings.push(`${key}: contract file unreadable (${entry.schema}) — dropped (fail closed)`)
        continue
      }
      if (actual !== entry.schemaHash) {
        dropped.push(key)
        warnings.push(`${key}: schemaHash drifted (registry ${entry.schemaHash}, actual ${actual}) — dropped (fail closed)`)
        continue
      }
      contracts.push({
        apiVersion: entry.coordinates.apiVersion,
        kind: entry.coordinates.kind,
        version: entry.version,
        schemaHash: entry.schemaHash,
        permissions: [...entry.permissions],
      })
    }
  }
  return {
    descriptor: {
      $schema: 'https://dsh.community/schemas/host-descriptor-0.15.json',
      hostId: options.hostId ?? 'dsh-tui',
      hostVersion: options.hostVersion ?? readOwnPackageVersion(),
      facetApiVersions,
      contracts,
      runtime: {
        location: 'local',
        generationId: options.generationId,
        headless: options.headless ?? false,
      },
      trustLevel: 'trusted-in-process',
      platform: { os: process.platform, arch: process.arch, node: process.version },
    },
    dropped,
    warnings,
  }
}
