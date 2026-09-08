/**
 * Minimal real Adapter Kernel runtime (P2).
 *
 * Responsibility:
 * - register/mount upstream driver objects,
 * - run structured detection and the `declared → staged → live` lifecycle,
 * - run reversible live verification outside passive/replay production modes,
 * - keep a unified evidence snapshot used by Host Descriptor / HostFacade /
 *   diagnostics,
 * - support passive-shadow (read-only detect only) and replay-shadow
 *   (isolated mock/replay contexts; the harness calls refresh with
 *   `allowReplay` on mock data only).
 *
 * This is intentionally small: business translation, protocol semantics and
 * plugin admission remain in upstream/standard layers. The Kernel only owns
 * composition, lifecycle promotion and diagnostics.
 */

import type { HostDescriptorPort, HostDescriptorSnapshot } from '../ports/descriptor.js'
import type { CapabilityLifecycle } from './lifecycle.js'
import { verifyAndPromote } from './lifecycle.js'
import { isReplayIsolationActive } from './replay-isolation.js'
import { normalizeAdapterSliceList, shadowPolicyAllowed, sliceForCapability, type AdapterMode } from './runtime.js'
import type { UpstreamDriver, UpstreamDriverMount } from '../upstream/driver.js'
import type { Detection } from '../upstream/detection.js'
import type { HostDescriptorBuild } from '../standard/descriptor.js'
import { buildHostDescriptorFromLifecycles } from '../standard/descriptor.js'
import { createShadowGuardedHostFacade, type HostFacade } from './host-facade.js'
import type { KernelSlice } from './slices/types.js'
import { onTuiChannelRegistered } from '../channel/host-registry.js'

export interface KernelRuntimeOptions {
  readonly context: unknown
  readonly mode: AdapterMode
  readonly slices?: readonly string[]
  readonly generationId: string
  readonly drivers?: readonly UpstreamDriver[]
  /** P3 vertical slice definitions. Their drivers are mounted in addition to
   * any explicit `drivers` and their mounted Ports are exposed by facade(). */
  readonly kernelSlices?: readonly KernelSlice[]
  readonly hostId?: string
  readonly hostVersion?: string
  readonly headless?: boolean
  /** Freshness window for live lifecycle evidence, in milliseconds. */
  readonly refreshTtlMs?: number
}

/** Real ports handed to mounted upstream drivers. Drivers may consume the
 * read-only descriptor port; mutation/authorization stays in Kernel/Standard. */
export interface KernelRuntimeDriverPorts {
  readonly descriptor: HostDescriptorPort
}

export interface KernelDriverDiagnostic {
  readonly id: string
  readonly capability: string
  readonly mounted: boolean
  readonly portMounted: boolean
}

export interface KernelDiagnosticSnapshot {
  readonly mode: AdapterMode
  readonly generationId: string
  readonly lifecycles: readonly CapabilityLifecycle[]
  readonly drivers: readonly KernelDriverDiagnostic[]
  readonly detections: readonly { readonly id: string; readonly detection: Detection }[]
  readonly descriptor: HostDescriptorSnapshot
  readonly lastRefresh: 'pending' | 'completed' | 'failed' | 'skipped'
  readonly refreshError?: string
}

export interface KernelRefreshOptions {
  /** Allow reversible live verification while mode is replay-shadow. This is
   * only safe on an isolated replay/mock context, not on a real host. */
  readonly allowReplay?: boolean
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value
  seen.add(value as object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

export class KernelRuntime {
  readonly mode: AdapterMode
  readonly generationId: string
  private readonly context: unknown
  private readonly drivers: readonly UpstreamDriver[]
  private readonly kernelSlices: readonly KernelSlice[] | undefined
  private readonly slices: readonly string[] | undefined
  private readonly hostId: string | undefined
  private readonly hostVersion: string | undefined
  private readonly headless: boolean | undefined
  private lifecycles: readonly CapabilityLifecycle[]
  private descriptorCache: HostDescriptorBuild | undefined
  private readonly mountDisposers = new Map<string, UpstreamDriverMount>()
  private readonly mountedPorts = new Map<string, Readonly<Record<string, unknown>>>()
  private readonly mountedDriverIds = new Set<string>()
  private readonly driverDetections = new Map<string, Detection>()
  private readonly liveVerifiedAt = new Map<string, number>()
  private readonly lastVerifiedLifecycles = new Map<string, readonly CapabilityLifecycle[]>()
  private readonly refreshTtlMs: number
  private lastRefreshAt: number | undefined
  private refreshState: 'pending' | 'completed' | 'failed' | 'skipped' = 'pending'
  private refreshError: string | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private refreshInFlight: Promise<readonly CapabilityLifecycle[]> | undefined
  private refreshRerunRequested = false
  private mountPromise: Promise<void> | undefined
  private unsubscribeChannelListener: (() => void) | undefined
  private disposed = false

  constructor(options: KernelRuntimeOptions) {
    this.context = options.context
    this.mode = options.mode
    this.generationId = options.generationId
    this.kernelSlices = options.kernelSlices
    const selectedSlices = normalizeAdapterSliceList(options.slices ?? [])
    this.slices = selectedSlices
    const requestedKernelSlices = selectedSlices.length === 0
      ? (options.kernelSlices ?? [])
      : (options.kernelSlices ?? []).filter(slice =>
          selectedSlices.includes(slice.id)
          || selectedSlices.includes(slice.capability)
          || slice.standardDeclarations.some(declaration => {
            const mapped = sliceForCapability(declaration)
            return mapped !== undefined && selectedSlices.includes(mapped)
          }))
    this.drivers = Object.freeze([
      ...requestedKernelSlices.map(slice => slice.driver),
      ...(options.drivers ?? []),
    ])
    this.hostId = options.hostId
    this.hostVersion = options.hostVersion
    this.headless = options.headless
    this.refreshTtlMs = options.refreshTtlMs ?? 30_000
    this.lifecycles = Object.freeze([])
    this.detect()
    // The TUI plugin can create/register its live Channel after this Kernel has
    // already started. Re-run refresh/mount on registration so a late Channel
    // is picked up without requiring a host restart.
    this.unsubscribeChannelListener = onTuiChannelRegistered(this.context, () => {
      if (this.disposed) return
      void this.refresh().catch(() => undefined)
      void this.mount().catch(() => undefined)
    })
  }

  /** Synchronous detection: never performs reversible/side-effectful probes.
   * It consumes each driver's structured `detect()` for diagnostics and, for
   * drivers with a lifecycle projection, builds the publication evidence. */
  detect(): readonly CapabilityLifecycle[] {
    const detected: CapabilityLifecycle[] = []
    for (const driver of this.drivers) {
      // Structured driver detection is consumed here (not in a parallel
      // path); it feeds diagnostics and remains available for doctor output.
      try {
        this.driverDetections.set(driver.id, driver.detect(this.context))
      } catch (error) {
        this.driverDetections.set(driver.id, {
          state: 'unsupported',
          reason: `driver.detect() threw: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      if (driver.lifecycles !== undefined) {
        const projected = driver.lifecycles(this.context)
        detected.push(...projected.map(verifyAndPromote))
      } else {
        // P3 slices often expose only detect()/verifyLive(). Their cached
        // verified features are only a *current* fact inside a fresh,
        // successful verification window; outside that window (failed
        // refresh, expired TTL, unsupported detect, or dispose) the cache must
        // not be treated as live/detected state anymore.
        const detection = this.driverDetections.get(driver.id)
        if (
          this.hasFreshVerification()
          && detection?.state !== 'unsupported'
          && !this.disposed
        ) {
          const cached = this.lastVerifiedLifecycles.get(driver.id)
          if (cached !== undefined) detected.push(...cached)
        }
      }
      // A driver without a lifecycle projection is not yet part of the P2
      // publication path; it remains a diagnostic-only driver.
    }
    // Preserve a live capability only while its last successful reversible
    // verification is still fresh. Detection alone is no longer a permanent
    // live claim: when probe evidence is missing, refresh has failed, or the
    // freshness TTL has expired, the lifecycle falls back to the current sync
    // (staged/degraded) projection. DecisionEvents is deliberately re-derived
    // on every detect so removing the dispatch marker removes publication
    // immediately.
    this.replaceLifecycles(this.preserveFreshVerifiedLifecycles(detected))
    return this.lifecycles
  }

  private hasFreshVerification(): boolean {
    return !this.disposed
      && this.refreshState === 'completed'
      && this.lastRefreshAt !== undefined
      && (Date.now() - this.lastRefreshAt) <= this.refreshTtlMs
  }

  private preserveFreshVerifiedLifecycles(detected: readonly CapabilityLifecycle[]): CapabilityLifecycle[] {
    const previous = new Map(this.lifecycles.map(lifecycle => [lifecycle.capability, lifecycle]))
    const now = Date.now()
    const next: CapabilityLifecycle[] = []
    for (const lifecycle of detected) {
      const prior = previous.get(lifecycle.capability)
      const decisionLifecycle = lifecycle.capability.includes('#DecisionEvents')
        || lifecycle.coordinate?.kind === 'DecisionEvents'
      const verifiedAt = this.liveVerifiedAt.get(lifecycle.capability)
      const fresh = verifiedAt !== undefined && (now - verifiedAt) <= this.refreshTtlMs
      if (!decisionLifecycle && prior?.state === 'live'
        && this.refreshState === 'completed'
        && fresh
        && this.sameCriticalMethodEvidence(prior, lifecycle)) {
        next.push(prior)
      } else {
        next.push(lifecycle)
      }
    }
    return next
  }

  private lifecycleKey(lifecycles: readonly CapabilityLifecycle[]): string {
    return lifecycles
      .map(lifecycle => [
        lifecycle.capability,
        lifecycle.state,
        lifecycle.coordinate?.apiVersion ?? '',
        lifecycle.coordinate?.kind ?? '',
        JSON.stringify(lifecycle.detection),
        JSON.stringify(lifecycle.liveFeatures ?? []),
      ].join('::'))
      .sort()
      .join('||')
  }

  private replaceLifecycles(next: readonly CapabilityLifecycle[]): void {
    const previousKey = this.lifecycleKey(this.lifecycles)
    this.lifecycles = Object.freeze(next.map(lifecycle => deepFreeze(lifecycle)))
    if (this.lifecycleKey(this.lifecycles) !== previousKey) {
      this.invalidateDescriptor()
    }
  }

  private sameCriticalMethodEvidence(previous: CapabilityLifecycle, current: CapabilityLifecycle): boolean {
    if (current.detection.state === 'unsupported') return false
    const priorMethods = new Set((previous.detection.state === 'supported' || previous.detection.state === 'degraded'
      ? (previous.detection.evidence ?? []).filter(item => item.kind === 'method').map(item => item.id)
      : []))
    if (priorMethods.size === 0) return false
    const currentMethods = new Set((current.detection.state === 'supported' || current.detection.state === 'degraded'
      ? (current.detection.evidence ?? []).filter(item => item.kind === 'method').map(item => item.id)
      : []))
    for (const id of priorMethods) {
      if (!currentMethods.has(id)) return false
    }
    return true
  }

  /**
   * Run reversible live verification.
   *
   * In passive-shadow production mode this is skipped (read-only only). In
   * replay-shadow production mode this is also skipped unless the caller
   * explicitly passes `allowReplay: true` for an isolated replay/mock context.
   */
  async refresh(options: KernelRefreshOptions = {}): Promise<readonly CapabilityLifecycle[]> {
    if (this.refreshInFlight !== undefined) {
      // A refresh is already running. If the live Channel registers (or any
      // other state changes) while it is in flight, ask for a background rerun
      // after the current pass completes so late registrations are not only
      // observed on the next TTL.
      this.refreshRerunRequested = true
      return this.refreshInFlight
    }
    const run = this.refreshInternal(options)
    this.refreshInFlight = run
    try {
      return await run
    } finally {
      if (this.refreshInFlight === run) this.refreshInFlight = undefined
      if (this.refreshRerunRequested && !this.disposed) {
        this.refreshRerunRequested = false
        void this.refresh(options).catch(() => undefined)
      }
    }
  }

  private async refreshInternal(options: KernelRefreshOptions = {}): Promise<readonly CapabilityLifecycle[]> {
    if (this.disposed) {
      this.refreshState = 'skipped'
      this.refreshError = 'kernel disposed while refresh was in flight'
      return this.lifecycles
    }
    const isReplayIsolated = this.mode === 'replay-shadow'
      && options.allowReplay === true
      && isReplayIsolationActive()
    if (this.mode === 'passive-shadow') {
      this.refreshState = 'skipped'
      this.refreshError = 'passive-shadow: reversible live probes are not run on a real host'
      return this.lifecycles
    }
    if (this.mode === 'replay-shadow' && !isReplayIsolated) {
      this.refreshState = 'skipped'
      this.refreshError = 'replay-shadow: run through the replay harness with an isolated replay context, not real-host live refresh'
      return this.lifecycles
    }
    try {
      if (this.disposed) {
        this.refreshState = 'skipped'
        this.refreshError = 'kernel disposed while refresh was in flight'
        return this.lifecycles
      }
      const lifecycles: CapabilityLifecycle[] = []
      for (const driver of this.drivers) {
        if (this.disposed) {
          this.refreshState = 'skipped'
          this.refreshError = 'kernel disposed while refresh was in flight'
          return this.lifecycles
        }
        // Mutate-class drivers must never run their live verifier under a
        // shadow/replay mode: their probes write real host state (status,
        // toasts) even when the Kernel runs on an isolated replay context.
        // In legacy/new modes the runtime is not a shadow, so the live path is
        // allowed.
        if (driver.mountEffectClass === 'mutate' && this.mode !== 'new' && this.mode !== 'legacy') {
          continue
        }
        let verified: readonly CapabilityLifecycle[]
        if (driver.verifyLive !== undefined) {
          verified = (await driver.verifyLive(this.context)).map(verifyAndPromote)
          if (this.disposed) {
            this.refreshState = 'skipped'
            this.refreshError = 'kernel disposed while refresh was in flight'
            return this.lifecycles
          }
        } else {
          // Keep the sync projection for drivers with no live verifier.
          verified = (driver.lifecycles?.(this.context) ?? []).map(verifyAndPromote)
        }
        this.lastVerifiedLifecycles.set(driver.id, Object.freeze([...verified]))
        lifecycles.push(...verified)
      }
      if (this.disposed) {
        this.refreshState = 'skipped'
        this.refreshError = 'kernel disposed while refresh was in flight'
        return this.lifecycles
      }
      this.replaceLifecycles(lifecycles)
      this.refreshState = 'completed'
      this.refreshError = undefined
      this.lastRefreshAt = Date.now()
      this.liveVerifiedAt.clear()
      for (const lifecycle of this.lifecycles) {
        if (lifecycle.state === 'live') this.liveVerifiedAt.set(lifecycle.capability, this.lastRefreshAt)
      }
    } catch (error) {
      this.refreshState = 'failed'
      this.refreshError = error instanceof Error ? error.message : String(error)
      this.lastRefreshAt = Date.now()
      // A failed refresh must not leave a stale live claim. Downgrade to the
      // current synchronous detection (staged/degraded/unsupported).
      this.liveVerifiedAt.clear()
      try {
        this.detect()
      } catch {
        // Detection errors are diagnostics-only; keep this.lifecycles honest.
      }
    }
    return this.lifecycles
  }

  currentLifecycles(): readonly CapabilityLifecycle[] {
    return this.lifecycles
  }

  /** Whether async live verification has completed successfully. */
  isRefreshCompleted(): boolean {
    return this.refreshState === 'completed'
  }

  /** Diagnostic refresh state. */
  refreshStatus(): 'pending' | 'completed' | 'failed' | 'skipped' {
    return this.refreshState
  }

  descriptorBuild(): HostDescriptorBuild {
    // Re-applying the synchronous projection before publication enforces live
    // freshness: stale/failed live claims are downgraded before any host
    // descriptor/hostDescriptor read returns. When the evidence is stale,
    // kick a real refresh in the background so a long-running process can
    // recover live support without a manual restart.
    if (this.needsAutoRefresh()) {
      this.startAutoRefreshTimer()
      void this.refresh().catch(() => undefined)
    }
    this.detect()
    if (this.descriptorCache === undefined) {
      // P3 feature lifecycles are internal Host Port facts (e.g.
      // `host.workspaces.list`) and intentionally have no protocol
      // coordinate. Keep them for Kernel diagnostics, but do not pass them
      // into the public Host Descriptor builder: they are not negotiated
      // protocol contracts and must not appear as descriptor noise or
      // publication claims.
      const publicLifecycles = this.lifecycles.filter(lifecycle => {
        if (lifecycle.coordinate !== undefined) return true
        const hash = lifecycle.capability.indexOf('#')
        return hash > 0 && hash < lifecycle.capability.length - 1
      })
      this.descriptorCache = buildHostDescriptorFromLifecycles(
        publicLifecycles,
        {
          generationId: this.generationId,
          hostId: this.hostId,
          hostVersion: this.hostVersion,
          headless: this.headless,
        },
      )
    }
    return this.descriptorCache
  }

  descriptorPort(): HostDescriptorPort {
    const runtime = this
    return Object.freeze({
      get generationId() {
        return runtime.generationId
      },
      snapshot(): HostDescriptorSnapshot {
        const build = runtime.descriptorBuild()
        return Object.freeze({
          hostId: build.descriptor.hostId,
          hostVersion: build.descriptor.hostVersion,
          generationId: build.descriptor.runtime.generationId,
          contracts: Object.freeze(build.descriptor.contracts.map(contract => `${contract.apiVersion}#${contract.kind}`)),
          dropped: Object.freeze([...build.dropped]),
          warnings: Object.freeze([...build.warnings]),
        })
      },
    })
  }

  /** The internal thin HostFacade backed by this Kernel runtime's snapshot. */
  facade(): HostFacade {
    const mounted: Record<string, unknown> = {
      descriptor: this.descriptorPort(),
    }
    for (const record of this.mountedPorts.values()) {
      Object.assign(mounted, record)
    }
    return createShadowGuardedHostFacade(mounted as never, this.mode)
  }

  diagnosticSnapshot(): KernelDiagnosticSnapshot {
    const build = this.descriptorBuild()
    return Object.freeze({
      mode: this.mode,
      generationId: this.generationId,
      lifecycles: this.lifecycles,
      drivers: Object.freeze(this.drivers.map(driver => Object.freeze({
        id: driver.id,
        capability: driver.capability,
        mounted: this.mountedDriverIds.has(driver.id),
        portMounted: this.mountedPorts.has(driver.id),
      }))),
      detections: Object.freeze(this.drivers.map(driver => Object.freeze({
        id: driver.id,
        detection: this.driverDetections.get(driver.id) ?? {
          state: 'unsupported' as const,
          reason: 'driver.detect() was not consumed',
        },
      }))),
      descriptor: this.descriptorPort().snapshot(),
      lastRefresh: this.refreshState,
      ...(this.refreshError === undefined ? {} : { refreshError: this.refreshError }),
    })
  }

  /** Mount all drivers that have not been mounted yet. */
  async mount(): Promise<void> {
    if (this.disposed) return
    if (this.mountPromise !== undefined) return this.mountPromise
    const run = this.mountInternal()
    this.mountPromise = run
    try {
      await run
    } finally {
      if (this.mountPromise === run) this.mountPromise = undefined
    }
  }

  private async mountInternal(): Promise<void> {
    const ports: KernelRuntimeDriverPorts = Object.freeze({
      descriptor: this.descriptorPort(),
    })
    const newlyMounted: string[] = []
    try {
      for (const driver of this.drivers) {
        if (this.disposed) {
          this.rollbackNewMounts(newlyMounted)
          return
        }
        if (this.mountedDriverIds.has(driver.id)) continue
        if (driver.mountEffectClass === undefined) {
          throw new Error(`dsh-tui: driver "${driver.id}" must declare mountEffectClass`)
        }
        // Shadow modes must not abort the whole mount transaction because the
        // first selected driver is non-read-only. Skip disallowed drivers and
        // continue mounting the read-only/replay-safe slices that remain.
        if (!shadowPolicyAllowed(driver.mountEffectClass, this.mode)) continue
        const mount = await driver.mount(this.context, ports)
        if (this.disposed) {
          // The whole runtime was disposed while this asynchronous mount was
          // in flight. Dispose the mount that just completed and stop; any
          // earlier mounts from this call were already removed by dispose().
          try {
            mount.disposer()
          } catch {
            // Best-effort async teardown.
          }
          this.rollbackNewMounts(newlyMounted)
          return
        }
        this.mountDisposers.set(driver.id, mount)
        if (mount.ports !== undefined) this.mountedPorts.set(driver.id, mount.ports)
        this.mountedDriverIds.add(driver.id)
        newlyMounted.push(driver.id)
      }
    } catch (error) {
      // Transactional mount: if one driver fails, roll back every driver
      // mounted by this call in reverse order before rethrow.
      this.rollbackNewMounts(newlyMounted)
      throw error
    }
    this.detect()
    this.startAutoRefreshTimer()
  }

  private rollbackNewMounts(ids: readonly string[]): void {
    for (const id of [...ids].reverse()) {
      const mount = this.mountDisposers.get(id)
      if (mount === undefined) continue
      try {
        mount.disposer()
      } catch {
        // Best-effort rollback; each driver owns its own fault isolation.
      }
      this.mountDisposers.delete(id)
      this.mountedPorts.delete(id)
      this.mountedDriverIds.delete(id)
    }
  }

  private needsAutoRefresh(): boolean {
    if (this.disposed || this.mode !== 'new') return false
    if (this.refreshState === 'failed') {
      return this.lastRefreshAt === undefined
        || (Date.now() - this.lastRefreshAt) >= this.refreshTtlMs
    }
    return this.refreshState === 'completed'
      && this.lastRefreshAt !== undefined
      && (Date.now() - this.lastRefreshAt) >= this.refreshTtlMs
  }

  private startAutoRefreshTimer(): void {
    if (this.disposed || this.mode !== 'new' || this.refreshTimer !== undefined) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      if (this.disposed || this.mode !== 'new') return
      void this.refresh()
        .catch(() => undefined)
        .finally(() => {
          if (!this.disposed && this.mode === 'new') this.startAutoRefreshTimer()
        })
    }, Math.max(this.refreshTtlMs, 1_000))
    if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref()
  }

  dispose(): void {
    this.disposed = true
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
    if (this.unsubscribeChannelListener !== undefined) {
      this.unsubscribeChannelListener()
      this.unsubscribeChannelListener = undefined
    }
    // A disposed Kernel must not continue to expose previously live P3
    // feature facts.
    this.lifecycles = Object.freeze([])
    this.lastVerifiedLifecycles.clear()
    this.liveVerifiedAt.clear()
    for (const driver of this.drivers) {
      const mount = this.mountDisposers.get(driver.id)
      if (mount === undefined) continue
      try {
        mount.disposer()
      } catch {
        // Kernel teardown must be best-effort; every driver is responsible for
        // its own fault isolation.
      }
      this.mountDisposers.delete(driver.id)
      this.mountedPorts.delete(driver.id)
      this.mountedDriverIds.delete(driver.id)
    }
  }

  private invalidateDescriptor(): void {
    this.descriptorCache = undefined
  }
}

/** Convenience constructor. */
export function createKernelRuntime(options: KernelRuntimeOptions): KernelRuntime {
  return new KernelRuntime(options)
}
