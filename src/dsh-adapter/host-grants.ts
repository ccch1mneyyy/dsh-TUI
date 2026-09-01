/**
 * Internal host-only GrantStore access.
 *
 * The public `ctx.tuiPluginHost.grants` is a caller-safe facade that derives
 * the principal from the calling activation. The full-parameter GrantStore
 * (which accepts an explicit principal) is intentionally kept out of the
 * public plugin-host surface; internal adapter services that need to evaluate
 * permissions for an already-verified activation or run grant-file change
 * watches use this module instead.
 */

import type { GrantStore } from '../adapter/standard/grants.js'
import { concreteService } from './host-access.js'

const hostGrantStores = new WeakMap<object, GrantStore>()

/** Register the raw grant store for one host runtime instance. */
export function bindHostGrantStore(host: object, store: GrantStore): void {
  hostGrantStores.set(host, store)
}

/** Resolve the raw host grant store; returns undefined for bare/degraded mounts. */
export function getHostGrantStore(host: unknown): GrantStore | undefined {
  if (host === undefined) return undefined
  try {
    return hostGrantStores.get(concreteService(host as object))
  } catch {
    return undefined
  }
}
