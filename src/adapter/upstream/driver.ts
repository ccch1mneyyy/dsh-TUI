/**
 * Upstream driver contract.
 *
 * Upstream drivers are the only place allowed to import `@deepseek-ai/*`.
 * Each driver translates one DSH capability into a host Port; it does not
 * define protocols, manifest semantics, permission policy or Host Descriptor.
 */

import type { CapabilityLifecycle } from '../kernel/lifecycle.js'
import type { HostEffectClass } from '../ports/owner.js'
import type { Detection } from './detection.js'

export interface UpstreamDriverMount {
  readonly disposer: () => void
  /** Optional host ports mounted by this driver. Keys are the HostFacade
   * port names (for example `workspace`, `scenes`, `settings`). */
  readonly ports?: Readonly<Record<string, unknown>>
}

export interface UpstreamDriver {
  readonly id: string
  readonly upstreamFamily: string
  readonly capability: string
  /** Must return structured Detection, never a bare boolean. */
  detect(context: unknown): Detection
  /**
   * Optional synchronous evidence-based lifecycle projection. Drivers that
   * cover several publishable contracts (for example the host-descriptor
   * driver) use this instead of a single generic Detection so the Kernel can
   * run `declared → staged → live` over all contracts in one place.
   */
  lifecycles?(context: unknown): readonly CapabilityLifecycle[]
  /**
   * Optional asynchronous live verification. This is where reversible probes
   * live (temporary command registration, isolated storage file, temporary
   * observer subscription). The Kernel calls it only outside passive shadow /
   * real-service replay; the replay harness may call it on isolated mock
   * context.
   */
  verifyLive?(context: unknown): Promise<readonly CapabilityLifecycle[]>
  /**
   * Effect class produced by this driver's mount. The Kernel enforces the
   * unified shadow policy before calling `mount`, so passive/replay production
   * modes cannot obtain real effects through a driver mount.
   */
  readonly mountEffectClass: HostEffectClass
  /**
   * Mount this driver into a kernel runtime. The kernel supplies Ports; the
   * driver performs only translation and returns a disposal handle.
   */
  mount(context: unknown, kernelPorts: unknown): Promise<UpstreamDriverMount>
}
