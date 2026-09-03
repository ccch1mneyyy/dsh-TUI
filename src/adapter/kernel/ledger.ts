/**
 * Kernel-internal effect ledger entry.
 *
 * This is the internal write channel for the legacy `ctx.tuiEffectLedger`
 * after P1 wiring: `TuiEffectLedgerRuntime` routes every public write through
 * `createKernelLedger()`, which enforces shadow policy and owner derivation
 * before the existing JSONL writer serializes the record. It is NOT an
 * unwired experimental block.
 *
 * The effect ledger is a Kernel cross-cutting concern. This module is NOT a
 * Host Port: callers cannot pass a forged owner, and the Kernel recorder must
 * derive ownership from the current Cordis activation before recording.
 * Use this only inside Kernel/Standard internal services.
 *
 * The public record() method therefore accepts the current Context and lets an
 * injected owner resolver map it to the verified HostOwnerRef. There is no
 * caller-facing path that accepts an owner/principal/activationId.
 */

import type { HostOwnerRef } from '../ports/owner.js'
import { assertCapabilityShadowPolicy, assertShadowPolicy, type AdapterMode } from './runtime.js'

export type KernelLedgerOperation = 'create' | 'bind' | 'replace' | 'release' | 'cleanup-failed'
export type KernelLedgerResult = 'applied' | 'pending' | 'failed'

export interface KernelLedgerEntry {
  readonly operation: KernelLedgerOperation
  readonly resource: { readonly kind: string; readonly id: string }
  readonly result: KernelLedgerResult
  readonly errorCode?: string
  readonly replaces?: { readonly resourceId?: string; readonly activationInstance?: string }
  readonly valueDigest?: string
}

export interface KernelLedgerRecord {
  readonly entry: KernelLedgerEntry
  /** Owner is assigned by the Kernel from the current Cordis activation. */
  readonly owner: HostOwnerRef
}

export type KernelLedgerSink = (record: KernelLedgerRecord) => void

/** Maps a Cordis Context (or test stub) to a Kernel-owned HostOwnerRef. */
export type KernelOwnerResolver = (context: unknown) => HostOwnerRef

/** Conservative fallback for contexts without a verified component identity. */
export const baseOwnerResolver: KernelOwnerResolver = () => ({ componentId: 'host' })

export interface KernelLedger {
  readonly record: (entry: KernelLedgerEntry, context: unknown) => void
}

/** Build an internal Kernel ledger recorder. The sink receives a complete
 * owner-resolved record; no public Host Port can bypass owner derivation.
 * Every write entry is guarded by the active shadow policy (mutate cannot run
 * in passive or replay shadow). */
export function createKernelLedger(
  sink: KernelLedgerSink,
  mode: AdapterMode = 'new',
  resolveOwner: KernelOwnerResolver = baseOwnerResolver,
  slices?: readonly string[],
): KernelLedger {
  return Object.freeze({
    record(entry: KernelLedgerEntry, context: unknown) {
      assertCapabilityShadowPolicy('host.ledger.record', mode, slices)
      sink({ entry, owner: resolveOwner(context) })
    },
  })
}
