/**
 * Internal Host Port for the TUI side-panel registry (ctx.tuiPanels).
 *
 * Panels are host-internal sidebar contributions. This port expresses only
 * the host's call intent; it does not carry protocol coordinates,
 * negotiation, manifests, permissions, or caller-supplied owner values.
 */

import type { HostDisposer } from './owner.js'

export interface HostPanelSummary {
  readonly id: string
  readonly title: string
  readonly source: 'plugin'
}

export interface HostPanelsPort {
  register(descriptor: { readonly id: string; readonly title?: string }): HostDisposer
  list(): readonly HostPanelSummary[]
  open(id: string): boolean
  close(id: string): boolean
  subscribe(listener: (event: { readonly type: string; readonly id: string }) => void): HostDisposer
}

export type HostPanelsDisposer = HostDisposer
