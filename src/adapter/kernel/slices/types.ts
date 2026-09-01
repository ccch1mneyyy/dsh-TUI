/**
 * Kernel slice: one vertical capability slice.
 *
 * A slice owns:
 * - an upstream driver (detection/live-verification/mount),
 * - the Host Port(s) the driver can mount,
 * - the Standard/effect capabilities it declares and governs.
 *
 * The Kernel uses this only for composition/diagnostics; it never performs
 * business translation itself.
 */

import type { UpstreamDriver } from '../../upstream/driver.js'

export interface KernelSlice {
  readonly id: string
  readonly capability: string
  readonly driver: UpstreamDriver
  /** Effect-class capabilities governed by this slice (Standard declaration). */
  readonly standardDeclarations: readonly string[]
}
