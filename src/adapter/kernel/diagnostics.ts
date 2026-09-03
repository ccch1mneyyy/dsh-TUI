/**
 * Kernel diagnostics surface.
 *
 * @internal P2: a snapshot formatter consumed by `/doctor` and local
 * diagnostics. The richer `KernelRuntime.diagnosticSnapshot()` is the
 * canonical kernel state surface; this helper remains for the legacy
 * /doctor line shape. It never writes, registers, subscribes or mutates host
 * capabilities.
 */

import type { HostDescriptorSnapshot } from '../ports/descriptor.js'
import type { AdapterRuntimeOptions } from './runtime.js'

export interface AdapterDiagnostics {
  readonly runtime: AdapterRuntimeOptions
  readonly descriptor: HostDescriptorSnapshot
  readonly permissions: readonly string[]
}

export function collectAdapterDiagnostics(
  runtime: AdapterRuntimeOptions,
  descriptor: HostDescriptorSnapshot,
  permissions: readonly string[],
): AdapterDiagnostics {
  return Object.freeze({
    runtime: Object.freeze({ ...runtime }),
    descriptor,
    permissions: Object.freeze([...permissions]),
  })
}
