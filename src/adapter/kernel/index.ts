/**
 * Adapter Kernel.
 *
 * P1 provided the read-only skeleton. P2 adds:
 * - a minimal real `KernelRuntime` (driver registration/mount, detection,
 *   declared → staged → live, diagnostics);
 * - reversible live probes for Command / LocalStorage / MessageObserver;
 * - passive/replay harness support in `replay.ts`.
 * P3 adds per-capability kernel slices and mounted Host Ports.
 */

export * from './runtime.js'
export * from './lifecycle.js'
export * from './host-facade.js'
export * from './kernel-runtime.js'
export * from './diagnostics.js'
export * from './ledger.js'
export * from './legacy-facade.js'
export * from './replay.js'
export * from './slices/index.js'
