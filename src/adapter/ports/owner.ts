/**
 * Internal host ownership primitives.
 *
 * These are TUI-host implementation details, not protocol semantics. They
 * describe who owns an activation and how host-owned resources are released;
 * they deliberately say nothing about plugin manifests, permission policy or
 * negotiation.
 */

export interface HostOwnerRef {
  /** Verified plugin/component identity, assigned by the Kernel. */
  readonly componentId: string
  /** Opaque activation instance id, also assigned by the Kernel. */
  readonly activationId?: string
}

/** Idempotent release handle for host-owned resources. */
export type HostDisposer = () => void

/** Marker used by kernel/slices to declare an effect class for shadow policy. */
export type HostEffectClass = 'read-only' | 'subscribe' | 'register' | 'mutate'
