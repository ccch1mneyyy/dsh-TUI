/**
 * Internal read-only Host Descriptor access Port.
 *
 * This is a narrow host-internal diagnostic capability. It deliberately does
 * NOT expose the dsh-ecosystem-spec Host Descriptor protocol object, does NOT
 * carry apiVersion/kind/negotiation/permission semantics, and does NOT accept
 * caller-supplied owner/principal/activation data. The protocol-shaped
 * descriptor is built and owned by the Standard/Spec plane + Kernel lifecycle
 * and is never a Host Port surface.
 */

export interface HostDescriptorSnapshot {
  readonly hostId: string
  readonly hostVersion: string
  readonly generationId: string
  /** Human/machine-readable diagnostic labels (`apiVersion#kind`). */
  readonly contracts: readonly string[]
  readonly dropped: readonly string[]
  readonly warnings: readonly string[]
}

export interface HostDescriptorPort {
  readonly generationId: string
  /** Current read-only diagnostic snapshot for internal TUI/kernel use. */
  snapshot(): HostDescriptorSnapshot
}
