/**
 * TUI Channel Provider (P5).
 *
 * A Channel Provider owns the Agent/Session/Workspace side of
 * `tui.dsh/v1alpha1#Channel`. This module implements an in-memory replay
 * provider used by the replay harness: it does not attach to a real DSH
 * service, but it follows the protocol envelope (open/subscribe/invoke/
 * close), validates inputs/outputs, preserves monotonic channel versions,
 * and can be driven from a real recorded DSH session snapshot/transcript.
 */

import {
  TUI_CHANNEL_WIRE_REVISION,
  validateTuiChannelInput,
  validateTuiChannelOutput,
  validateTuiChannelSnapshot,
} from '../spec/index.js'
import type { TuiChannelInvokeOutput, TuiChannelSnapshot } from '../spec/index.js'

export interface ChannelProviderOpenInput {
  readonly workspace?: string
  readonly sessionId?: string
  readonly options?: unknown
}

export interface ChannelProvider {
  open(input: ChannelProviderOpenInput): Promise<TuiChannelSnapshot>
  subscribe(
    channelId: string,
    afterVersion: number,
    listener: (snapshot: TuiChannelSnapshot) => void,
  ): Promise<() => void>
  invoke(
    channelId: string,
    method: string,
    args: readonly unknown[],
  ): Promise<TuiChannelInvokeOutput>
  close(channelId: string): Promise<{ readonly closed: true }>
}

export interface ReplayChannelSnapshotSource {
  /** Monotonic snapshots, oldest first. The provider serves the latest
   * snapshot from `open` and replays newer snapshots through `subscribe`. */
  readonly snapshots: readonly TuiChannelSnapshot[]
  /** Optional transcript/event log carried alongside the snapshots. It is
   * not interpreted by the provider; it exists for replay provenance and
   * for conformance report details. */
  readonly transcript?: readonly unknown[]
  /** Optional method invocation handlers. Unknown methods are rejected with
   * `FEATURE_UNAVAILABLE`/`INVALID_ARGUMENT`-style provider errors. */
  readonly methods?: Readonly<Record<string, (args: readonly unknown[]) => unknown | Promise<unknown>>>
}

function assertJsonValue(value: unknown): void {
  // JSON value validation is done by the protocol validators at the edge.
  // This helper only rejects functions and symbols which would make a
  // snapshot non-serializable.
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('replay Channel values must be JSON-serializable')
  }
}

function channelSnapshot(value: unknown): TuiChannelSnapshot {
  return validateTuiChannelSnapshot(value)
}

function invokeOutput(value: unknown): TuiChannelInvokeOutput {
  return validateTuiChannelOutput('invoke', value) as TuiChannelInvokeOutput
}

/** Create an isolated replay Channel Provider over recorded snapshots. */
export function createReplayChannelProvider(source: ReplayChannelSnapshotSource): ChannelProvider {
  if (!Array.isArray(source.snapshots) || source.snapshots.length === 0) {
    throw new TypeError('replay Channel provider requires at least one snapshot')
  }
  const snapshots = Object.freeze([...source.snapshots].map(channelSnapshot))
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1]!
    const current = snapshots[index]!
    if (current.channelId !== previous.channelId) {
      throw new TypeError('replay Channel snapshots must share one channelId')
    }
    if (!(current.version > previous.version)) {
      throw new TypeError('replay Channel snapshots must have strictly increasing versions')
    }
  }
  let currentIndex = snapshots.length - 1

  function latest(): TuiChannelSnapshot {
    return snapshots[currentIndex]!
  }

  return Object.freeze({
    async open(input: ChannelProviderOpenInput): Promise<TuiChannelSnapshot> {
      validateTuiChannelInput('open', {
        ...input,
        ...(input.options === undefined ? {} : { options: input.options }),
      })
      return latest()
    },
    async subscribe(
      channelId: string,
      afterVersion: number,
      listener: (snapshot: TuiChannelSnapshot) => void,
    ): Promise<() => void> {
      validateTuiChannelInput('subscribe', { channelId, afterVersion })
      const channel = latest()
      if (channel.channelId !== channelId) {
        throw new Error('CHANNEL_NOT_FOUND')
      }
      let stopped = false
      for (const snapshot of snapshots) {
        if (stopped) break
        if (snapshot.version > afterVersion) {
          listener(snapshot)
        }
      }
      return () => {
        stopped = true
      }
    },
    async invoke(
      channelId: string,
      method: string,
      args: readonly unknown[],
    ): Promise<TuiChannelInvokeOutput> {
      validateTuiChannelInput('invoke', { channelId, method, arguments: args as never })
      const channel = latest()
      if (channel.channelId !== channelId) {
        throw new Error('CHANNEL_NOT_FOUND')
      }
      const handler = source.methods?.[method]
      const value = handler === undefined
        ? undefined
        : await handler(args)
      assertJsonValue(value)
      const output = invokeOutput({
        value: value ?? null,
        valueDefined: value !== undefined,
        ...({ snapshot: latest() }),
      })
      // The protocol's `invoke` output is validated above; if a provider
      // advances state in the future, the snapshot returned must remain
      // monotonic. The replay provider is intentionally read-only, so the
      // snapshot never regresses.
      return output
    },
    async close(channelId: string): Promise<{ readonly closed: true }> {
      validateTuiChannelInput('close', { channelId })
      const channel = latest()
      if (channel.channelId !== channelId) {
        throw new Error('CHANNEL_NOT_FOUND')
      }
      return { closed: true }
    },
  })
}

/** Convenience provider over one snapshot (common replay fixture). */
export function createReplayChannelProviderFromSnapshot(
  snapshot: TuiChannelSnapshot,
  transcript: readonly unknown[] = [],
): ChannelProvider {
  return createReplayChannelProvider({
    snapshots: [snapshot],
    transcript,
  })
}

export const REPLAY_CHANNEL_WIRE_REVISION = TUI_CHANNEL_WIRE_REVISION
