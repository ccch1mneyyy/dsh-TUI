/**
 * Internal Host Port for the TUI scene registry.
 *
 * Scenes are host-internal full-screen contributions. This port expresses
 * only the host's call intent; it does not carry protocol coordinates,
 * negotiation, manifests, permissions, or caller-supplied owner values.
 */

import type { HostDisposer } from './owner.js'

export interface HostSceneDescriptor {
  readonly id: string
  readonly title?: string
  /** The component is host-owned and not a serializable protocol value. */
  readonly component: unknown
}

export interface HostScenesPort {
  register(descriptor: HostSceneDescriptor): HostDisposer
  list(): readonly HostSceneDescriptor[]
  open(id: string): boolean
  close(): void
  readonly active: HostSceneDescriptor | undefined
  subscribe(listener: () => void): HostDisposer
}

export type HostScenesDisposer = HostDisposer
