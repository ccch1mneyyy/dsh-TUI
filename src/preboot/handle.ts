/**
 * Handoff between the `--import` preload (`entry.ts`) and the dsh-tui
 * plugin's `apply`.
 *
 * The fast launcher (`dst`) starts the dsh process as
 * `node --import <lib/types/preboot/entry.js> <dsh bin.js> --profile dsh-tui`.
 * The preload mounts the real root tree (`host.tsx`) with a boot channel
 * BEFORE dsh composes and loads its plugin tree, then publishes the slot on
 * `globalThis` under a well-known symbol. When the plugin's `apply` reaches
 * its render step it takes the slot and calls `ready(live)`; the mounted Chat
 * keeps running and only its channel and host props change.
 *
 * `globalThis` + `Symbol.for` is deliberate: the preload and the plugin are
 * loaded through different entry points and must not depend on module
 * identity to find each other. Both sides live in this package, so the
 * `BootSlot` shape is the whole contract.
 */
import type { BootSlot } from './host.js'

/** Well-known key the preload publishes under. */
export const PREBOOT_HANDLE_KEY = Symbol.for('@deepseek-harness-tui/dsh-tui:preboot-handle')

/** Environment marker the fast launcher sets so the preload activates. */
export const PREBOOT_ENV = 'DSH_TUI_PREBOOT'

type HandleHost = typeof globalThis & { [PREBOOT_HANDLE_KEY]?: BootSlot }

/** Publish the slot for the plugin to find (called by the preload). */
export function publishPrebootSlot(slot: BootSlot): void {
  ;(globalThis as HandleHost)[PREBOOT_HANDLE_KEY] = slot
}

/** Peek at the published slot without consuming it. */
export function peekPrebootSlot(): BootSlot | undefined {
  return (globalThis as HandleHost)[PREBOOT_HANDLE_KEY]
}

/**
 * Take the published slot, removing it from `globalThis` so exactly one
 * consumer adopts it (a recompose re-running `apply` must not find a stale
 * slot). Taking it claims it: the preload's boot watchdog (a slot nobody
 * takes means the profile never mounted dsh-tui) stands down, and the
 * plugin's startup path owns the boot screen from here.
 */
export function takePrebootSlot(): BootSlot | undefined {
  const host = globalThis as HandleHost
  const slot = host[PREBOOT_HANDLE_KEY]
  if (slot !== undefined) {
    delete host[PREBOOT_HANDLE_KEY]
    // Optional call: the slot is a cross-entry-point contract, and a slot
    // published by an older preload has no claim().
    slot.claim?.()
  }
  return slot
}

/**
 * Dispose a still-published (never adopted) boot slot. Startup error paths
 * call this before printing anything: while the boot screen owns the
 * alt-screen and intercepts stderr, an error message would vanish.
 */
export function disposePendingPreboot(): void {
  takePrebootSlot()?.dispose()
}
