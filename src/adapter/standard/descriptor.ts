/** Build the current dsh-TUI Host Descriptor from live Kernel lifecycle evidence. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContractCoordinate, HostContract, HostDescriptor } from './types.js'
import type { CapabilityLifecycle } from '../kernel/lifecycle.js'
import { hasProbeEvidence, hasVerificationEvidence } from '../kernel/lifecycle.js'
import { digestFile, loadSpecData, verifyContractProfiles } from './registry.js'
import { TUI_DECISION_EVENT_NAMES } from './tui-extension.js'
import { HOST_SUPPORTED_CONTRACTS } from '../spec/protocol-constants.js'
import { createContractIndex, validateHost } from './validate.js'
import { check } from './schema-check.js'

export { HOST_SUPPORTED_CONTRACTS }

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
  /**
   * Canonical live publication source. Only `lifecycles` with state `live`
   * (or explicitly split feature-level live evidence) are published. A
   * `degraded` lifecycle is never published as a whole capability; it must
   * first be split into feature-level live evidence.
   */
  lifecycles?: readonly CapabilityLifecycle[]
  /**
   * Explicit legacy-compatibility topology. This is NOT live probe evidence:
   * it represents the old mounted-service declaration path that remains the
   * default in `legacy` adapter mode. It is intentionally kept separate from
   * the live-only publication path and is used only by the dedicated legacy
   * host descriptor builder / legacy production branch.
   */
  legacySupported?: readonly ContractCoordinate[]
  /** Feature-level legacy DecisionEvents declaration, when the read-only
   * topology probe has verified them. Empty/undefined means no features. */
  legacyDecisionFeatures?: readonly string[]
  /** Marks a build as a legacy compatibility declaration (adds warnings). */
  legacy?: boolean
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

function coordinateFromCapability(capability: string): ContractCoordinate | undefined {
  const index = capability.indexOf('#')
  if (index <= 0 || index === capability.length - 1) return undefined
  return {
    apiVersion: capability.slice(0, index),
    kind: capability.slice(index + 1),
  }
}

function coordinateOf(lifecycle: CapabilityLifecycle): ContractCoordinate | undefined {
  return lifecycle.coordinate ?? coordinateFromCapability(lifecycle.capability)
}

function supportSpec(
  coordinate: ContractCoordinate,
  lifecycle?: CapabilityLifecycle,
  legacyFeatures?: readonly string[],
): unknown {
  if (coordinate.apiVersion === 'tui.dsh/v1alpha1' && coordinate.kind === 'DecisionEvents') {
    // Never fall back to the full event vocabulary. New mode only advertises
    // liveFeatures verified by the driver probe; legacy mode only advertises
    // features passed from the read-only legacy topology probe.
    const features = legacyFeatures ?? [...(lifecycle?.liveFeatures ?? [])]
    return { features: [...new Set(features)].sort() }
  }
  return undefined
}

/**
 * Whether a lifecycle's probe evidence is sufficient to publish the whole
 * capability contract.
 *
 * The protocol definitions for Command / LocalStorage / MessageObserver do not
 * support feature-granular support specs, so a probe must prove the real
 * operational capability (not merely a catalog/list or mounted-runtime
 * diagnostic). DecisionEvents is feature-granular and is handled separately.
 */
function hasPublishableCapabilityProbe(
  lifecycle: CapabilityLifecycle,
  coordinate: ContractCoordinate,
): boolean {
  const detection = lifecycle.detection
  if (detection.state !== 'supported' && detection.state !== 'degraded') return false
  const evidence = detection.evidence ?? []
  if (coordinate.kind === 'Command') {
    return evidence.some(item => item.kind === 'probe' && /(?:execute|invoke)/u.test(item.id))
  }
  if (coordinate.kind === 'LocalStorage' || coordinate.kind === 'MessageObserver') {
    return evidence.some(item => item.kind === 'probe' && !item.id.includes('probeDiagnostic'))
  }
  return true
}

/**
 * DecisionEvents publication additionally requires the actual mediated
 * subscription method to exist. A real channel/probe with a missing
 * `subscribeDecision()` is still a degraded/non-publishable capability.
 */
function hasDecisionSubscriptionMethod(lifecycle: CapabilityLifecycle): boolean {
  const detection = lifecycle.detection
  if (detection.state !== 'supported' && detection.state !== 'degraded') return false
  return (detection.evidence ?? []).some(item =>
    item.kind === 'method' && item.id.includes('subscribeDecision'))
}

function hasDecisionCriticalMissing(lifecycle: CapabilityLifecycle): boolean {
  const detection = lifecycle.detection
  if (detection.state !== 'degraded') return false
  return detection.missing.some(item => item.includes('subscribeDecision'))
}

function hasPublishableDecisionFeatureEvidence(lifecycle: CapabilityLifecycle): boolean {
  return hasProbeEvidence(lifecycle)
    && !hasDecisionCriticalMissing(lifecycle)
    && hasDecisionSubscriptionMethod(lifecycle)
    && (lifecycle.liveFeatures?.length ?? 0) > 0
}

/**
 * Select the publishable contract set from live lifecycle evidence.
 *
 * `degraded` remains a diagnostic fact here: it is never promoted to a whole
 * supported contract. If a protocol supports feature granularity, the caller
 * must split the degraded capability into feature-level live lifecycles (or
 * pass `liveFeatures` on a live lifecycle) before this builder can publish it.
 */
function publishableLifecycles(
  lifecycles: readonly CapabilityLifecycle[],
  warnings: string[],
  dropped: string[],
): readonly { lifecycle: CapabilityLifecycle; coordinate: ContractCoordinate }[] {
  const published: { lifecycle: CapabilityLifecycle; coordinate: ContractCoordinate }[] = []
  for (const lifecycle of lifecycles) {
    const coordinate = coordinateOf(lifecycle)
    if (coordinate === undefined) {
      dropped.push(lifecycle.capability)
      warnings.push(`${lifecycle.capability}: lifecycle has no contract coordinate; cannot publish`)
      continue
    }
    const key = `${coordinate.apiVersion}#${coordinate.kind}`
    if (lifecycle.state === 'live') {
      if (!hasVerificationEvidence(lifecycle) || !hasPublishableCapabilityProbe(lifecycle, coordinate)) {
        dropped.push(key)
        warnings.push(`${key}: live lifecycle lacks a publishable real capability probe; not published`)
        continue
      }
      if (coordinate.apiVersion === 'tui.dsh/v1alpha1' && coordinate.kind === 'DecisionEvents') {
        if (lifecycle.liveFeatures === undefined || lifecycle.liveFeatures.length === 0) {
          dropped.push(key)
          warnings.push(`${key}: live DecisionEvents has no verified feature-level evidence; not published`)
          continue
        }
        if (!hasPublishableDecisionFeatureEvidence(lifecycle)) {
          dropped.push(key)
          warnings.push(`${key}: live DecisionEvents lacks a real probe and/or the mediated subscribeDecision method; not published`)
          continue
        }
      }
      published.push({ lifecycle, coordinate })
    } else if (lifecycle.state === 'degraded') {
      if (lifecycle.liveFeatures !== undefined && lifecycle.liveFeatures.length > 0
        && coordinate.apiVersion === 'tui.dsh/v1alpha1'
        && coordinate.kind === 'DecisionEvents'
        && hasPublishableDecisionFeatureEvidence(lifecycle)) {
        // Feature-granular publication: only the decomposed live features are
        // advertised, never the whole degraded capability. Probe evidence is
        // mandatory even for feature splits — no probe, no publication — and
        // the mediated subscribeDecision method must also exist.
        published.push({ lifecycle, coordinate })
        warnings.push(`${key}: degraded capability split into live feature-level evidence (${lifecycle.liveFeatures.join(', ')})`)
      } else if (lifecycle.liveFeatures !== undefined && lifecycle.liveFeatures.length > 0
        && coordinate.apiVersion === 'tui.dsh/v1alpha1'
        && coordinate.kind === 'DecisionEvents') {
        dropped.push(key)
        warnings.push(`${key}: degraded DecisionEvents has feature evidence without a real probe/mediated subscribeDecision method; not published`)
      } else {
        dropped.push(key)
        warnings.push(`${key}: degraded capability was not split into publishable live features; not published`)
      }
    } else {
      dropped.push(key)
      warnings.push(`${key}: capability is ${lifecycle.state}, not live; not published`)
    }
  }
  return published
}

/**
 * Build Host Descriptor only from live lifecycle evidence. This is the
 * canonical production entry point; it never accepts a bare supported array as
 * final fact.
 */
export function buildHostDescriptorFromLifecycles(
  lifecycles: readonly CapabilityLifecycle[],
  options: Omit<HostDescriptorOptions, 'lifecycles'> = { generationId: 'unknown' },
): HostDescriptorBuild {
  return buildHostDescriptor({ ...options, lifecycles })
}

export interface LegacyHostDescriptorOptions {
  hostId?: string
  hostVersion?: string
  generationId: string
  headless?: boolean
  specDir?: string
  /** Coordinates declared by the legacy mounted-service topology. */
  supported: readonly ContractCoordinate[]
  /** Feature-level DecisionEvents declaration from the read-only legacy probe. */
  decisionFeatures?: readonly string[]
}

/**
 * Build the explicit legacy-mode Host Descriptor.
 *
 * P6 keeps this as a first-class mode, not a compatibility shim: it preserves
 * the old default (`legacy` adapter mode) publication semantics. Command /
 * LocalStorage / MessageObserver are declared when their legacy service rows
 * are mounted, without running the new Kernel or any reversible live probe.
 * It is deliberately distinct from the live-only
 * `buildHostDescriptorFromLifecycles` path and returns warnings identifying it
 * as a legacy declaration.
 */
export function buildLegacyHostDescriptor(options: LegacyHostDescriptorOptions): HostDescriptorBuild {
  return buildHostDescriptor({
    hostId: options.hostId,
    hostVersion: options.hostVersion,
    generationId: options.generationId,
    headless: options.headless,
    specDir: options.specDir,
    legacy: true,
    legacySupported: options.supported,
    legacyDecisionFeatures: options.decisionFeatures,
  })
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
  const legacyMode = options.legacy === true && options.legacySupported !== undefined

  // Live lifecycle evidence is the only caller-facing publication source.
  // The old no-lifecycles fallback (advertising HOST_SUPPORTED_CONTRACTS) has
  // been removed: without live lifecycle evidence this host must not claim any
  // negotiated support. Callers that only want static diagnostics get an empty
  // contract surface plus an explicit non-live/host-unavailable warning.
  if (options.lifecycles === undefined && !legacyMode) {
    warnings.push('no live lifecycle evidence supplied; host descriptor advertises no contracts (host unavailable / non-live)')
  }
  if (legacyMode) {
    warnings.push('legacy compatibility descriptor: contracts declared from the mounted legacy service topology without live probe evidence')
  }
  // Admission is a live/feature-split evidence path only. Degraded/staged
  // capabilities are never admitted solely because a service row is mounted.
  //
  // The explicit exception is the legacy compatibility path used by the
  // default `legacy` adapter mode. It is a separate, non-live declaration of
  // the old mounted-service topology (kept alive for zero-behavior-change
  // migration), not a fake live claim and never mixed into new-mode live
  // descriptors.
  const selected = legacyMode
    ? options.legacySupported!.map(coordinate => ({ coordinate, lifecycle: undefined }))
    : options.lifecycles === undefined
      ? []
      : publishableLifecycles(options.lifecycles, warnings, dropped)

  if (data === undefined) {
    warnings.push('admission profile unavailable (dsh-ecosystem-spec/); advertising an empty protocol surface')
  } else {
    const index = createContractIndex(data.registry, data.permissions)
    for (const item of selected) {
      const coordinate = item.coordinate
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
      const lifecycle = item.lifecycle
      // Legacy declarations use the same definition/registry resolution but
      // do not invent a live support spec.
      const spec = legacyMode
        ? supportSpec(coordinate, undefined, options.legacyDecisionFeatures)
        : supportSpec(coordinate, lifecycle)
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
