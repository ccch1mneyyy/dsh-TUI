/**
 * TUI Channel Consumer (P5).
 *
 * A Channel Consumer owns the visible terminal side of
 * `tui.dsh/v1alpha1#Channel`. This module is the conformance-facing client:
 * it opens a provider, subscribes to snapshots, enforces monotonic versions
 * and full-snapshot continuity, invokes JSON-value methods, and closes the
 * channel. It never interprets provider business methods itself.
 *
 * Continuity violations are fail-closed by default: the consumer throws
 * instead of silently retaining a discontinuous snapshot.
 */

import { validateTuiChannelOutput, validateTuiChannelSnapshot } from '../spec/index.js'
import type { TuiChannelInvokeOutput, TuiChannelSnapshot } from '../spec/index.js'
import type { ChannelProvider, ChannelProviderOpenInput } from './provider.js'

export interface ChannelConsumerOptions {
  /** When true (default), a continuity violation throws immediately and the
   * discontinuous snapshot is not retained. */
  readonly failClosed?: boolean
}

export interface ChannelConsumer {
  open(input: ChannelProviderOpenInput): Promise<TuiChannelSnapshot>
  subscribe(
    channelId: string,
    afterVersion: number,
    listener: (snapshot: TuiChannelSnapshot) => void,
  ): Promise<() => void>
  invoke(channelId: string, method: string, args: readonly unknown[]): Promise<TuiChannelInvokeOutput>
  close(channelId: string): Promise<{ readonly closed: true }>
  lastSnapshot(): TuiChannelSnapshot | undefined
  /** Version continuity failures observed while consuming (gap/backwards/
   * wire-revision change). A conformant replay must keep this empty. */
  continuityErrors(): readonly string[]
}

/** Wrap a Channel Provider with the consumer-side protocol envelope checks. */
export function createChannelConsumer(
  provider: ChannelProvider,
  options: ChannelConsumerOptions = {},
): ChannelConsumer {
  const failClosed = options.failClosed !== false
  let last: TuiChannelSnapshot | undefined
  const continuityErrors: string[] = []

  function accept(snapshotValue: unknown, allowEqual = false): TuiChannelSnapshot {
    const snapshot = validateTuiChannelSnapshot(snapshotValue)
    const errorCountBefore = continuityErrors.length
    if (last !== undefined) {
      if (snapshot.channelId !== last.channelId) {
        continuityErrors.push(`channel id changed: ${last.channelId} -> ${snapshot.channelId}`)
      } else if (snapshot.wireRevision !== last.wireRevision) {
        continuityErrors.push(`wire revision changed: ${last.wireRevision} -> ${snapshot.wireRevision}`)
      } else if (snapshot.version < last.version) {
        continuityErrors.push(`version went backwards: ${last.version} -> ${snapshot.version}`)
      } else if (snapshot.version === last.version && !allowEqual) {
        continuityErrors.push(`version did not advance: ${last.version} -> ${snapshot.version}`)
      } else if (snapshot.version > last.version && snapshot.version !== last.version + 1) {
        continuityErrors.push(`version gap: expected ${last.version + 1}, got ${snapshot.version}`)
      }
    }
    const hasNewError = continuityErrors.length > errorCountBefore
    if (hasNewError && failClosed) {
      throw new Error(`dsh-tui: Channel continuity violation: ${continuityErrors[continuityErrors.length - 1]}`)
    }
    // When not fail-closed, keep advancing `last` to the snapshot that was
    // actually observed so later continuity messages describe the real
    // sequence rather than a stale pre-violation baseline.
    if (last === undefined || snapshot.version >= last.version) {
      last = snapshot
    }
    return snapshot
  }

  return Object.freeze({
    async open(input) {
      const snapshot = await provider.open(input)
      last = undefined
      continuityErrors.length = 0
      return accept(snapshot)
    },
    async subscribe(channelId, afterVersion, listener) {
      let firstReplay = true
      return provider.subscribe(channelId, afterVersion, value => {
        // Provider semantics are "not earlier than afterVersion": an equal
        // version echo after `open()` is the first snapshot of a subscription
        // and must be accepted, while later equal-version duplicates still
        // violate continuity.
        listener(accept(value, firstReplay))
        firstReplay = false
      })
    },
    async invoke(channelId, method, args) {
      const output = await provider.invoke(channelId, method, args)
      const validated = validateTuiChannelOutput('invoke', output) as TuiChannelInvokeOutput
      if (validated.snapshot !== undefined) accept(validated.snapshot, true)
      return validated
    },
    async close(channelId) {
      const output = await provider.close(channelId)
      return validateTuiChannelOutput('close', output) as { readonly closed: true }
    },
    lastSnapshot() {
      return last
    },
    continuityErrors() {
      return Object.freeze([...continuityErrors])
    },
  })
}
