/** Immutable adapter runtime snapshot bound to one Cordis composition. */

import { compositionRoot } from '../../dsh-adapter/host-access.js'
import {
  parseAdapterRuntime,
  type AdapterRuntimeOptions,
} from './runtime.js'

type AdapterContext = Parameters<typeof compositionRoot>[0]

const snapshots = new WeakMap<object, AdapterRuntimeOptions>()

/**
 * Capture adapter mode and slice selection once for a composition. Runtime
 * policy must not be re-read from process.env by individual services: doing
 * so lets an in-process caller change shadow policy after mount.
 */
export function adapterRuntimeFor(ctx: AdapterContext): AdapterRuntimeOptions {
  const root = compositionRoot(ctx)
  const key = root as unknown as object
  const existing = snapshots.get(key)
  if (existing !== undefined) return existing
  const snapshot = parseAdapterRuntime()
  snapshots.set(key, snapshot)
  return snapshot
}

/** Test/embedding hook: explicit env input remains available without making
 * production services depend on mutable process state after construction. */
export function snapshotAdapterRuntime(env: NodeJS.ProcessEnv): AdapterRuntimeOptions {
  return parseAdapterRuntime(env)
}
