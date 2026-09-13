/**
 * Internal Host Port for TUI DecisionEvents.
 *
 * DecisionEvents are the TUI-private interception/notification vocabulary.
 * This Host Port intentionally exposes only the host-internal read-only
 * topology probe and an optional host-owned subscription surface; it does
 * not define the event protocol coordinates/permissions or accept an owner.
 */

import type { HostDisposer } from './owner.js'

export interface HostDecisionsPort {
  /** Read-only probe of the currently dispatchable decision event names. */
  probe(): readonly string[]
  /** Host-owned subscription; ownership is derived by the Kernel, not passed
   * by the caller. */
  subscribe(event: string, listener: (payload: Record<string, unknown>) => unknown): HostDisposer
}

export type HostDecisionsDisposer = HostDisposer
