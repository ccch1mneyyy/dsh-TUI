/**
 * TUI Channel Provider (P5).
 *
 * A Channel Provider owns the Agent/Session/Workspace side of
 * `tui.dsh/v1alpha1#Channel`. This module implements an in-memory replay
 * provider used by the replay harness: it does not attach to a real DSH
 * service, but it follows the protocol envelope (open/subscribe/invoke/
 * close), validates inputs/outputs, preserves monotonic channel versions,
 * and can be driven from a real recorded DSH session snapshot/transcript.
 *
 * The replay provider is intentionally protocol-envelope focused:
 * - unknown methods are rejected (never treated as a successful no-op);
 * - feature/support validation happens in the replay harness, not here;
 * - values are bounded in size/depth and deep-frozen before being handed out;
 * - method handlers only run inside the harness-provided replay isolation.
 */

import {
  TUI_CHANNEL_WIRE_REVISION,
  validateTuiChannelInput,
  validateTuiChannelOutput,
  validateTuiChannelSnapshot,
} from '../spec/index.js'
import { isReplayIsolationActive } from '../kernel/replay-isolation.js'
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
   * `FEATURE_UNAVAILABLE` (or `INVALID_ARGUMENT` for malformed input). */
  readonly methods?: Readonly<Record<string, (args: readonly unknown[]) => unknown | Promise<unknown>>>
}

/** Safety bound for replay JSON payloads. */
export const REPLAY_JSON_MAX_BYTES = 512 * 1024
/** Safety bound for replay JSON nesting depth. */
export const REPLAY_JSON_MAX_DEPTH = 64

function deepFreezeCopy<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (value === null || typeof value !== 'object') return value
  const existing = seen.get(value as object)
  if (existing !== undefined) return existing as T
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value as object, copy)
    for (const item of value) copy.push(deepFreezeCopy(item, seen))
    return Object.freeze(copy) as T
  }
  const copy: Record<string, unknown> = {}
  seen.set(value as object, copy)
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = deepFreezeCopy(item, seen)
  }
  return Object.freeze(copy) as T
}

function assertBoundedJson(value: unknown, label: string, depth = 0, ancestors = new Set<object>()): void {
  if (depth > REPLAY_JSON_MAX_DEPTH) {
    throw new TypeError(`${label}: JSON nesting exceeds ${REPLAY_JSON_MAX_DEPTH} levels`)
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label}: JSON numbers must be finite`)
    return
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label}: must be a JSON value`)
  }
  if (ancestors.has(value)) throw new TypeError(`${label}: must not contain cycles`)
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertBoundedJson(item, `${label}[${index}]`, depth + 1, ancestors)
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label}: must contain only plain objects`)
    }
    for (const [key, item] of Object.entries(value)) {
      assertBoundedJson(item, `${label}.${key}`, depth + 1, ancestors)
    }
  }
  ancestors.delete(value)
}

function assertJsonSize(value: unknown, label: string): void {
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    throw new TypeError(`${label}: value is not JSON-serializable`)
  }
  if (json === undefined) throw new TypeError(`${label}: value is not JSON-serializable`)
  if (Buffer.byteLength(json, 'utf8') > REPLAY_JSON_MAX_BYTES) {
    throw new TypeError(`${label}: JSON payload exceeds ${REPLAY_JSON_MAX_BYTES} bytes`)
  }
}

function channelSnapshot(value: unknown): TuiChannelSnapshot {
  const validated = validateTuiChannelSnapshot(value)
  assertBoundedJson(validated, 'Channel snapshot')
  assertJsonSize(validated, 'Channel snapshot')
  return deepFreezeCopy(validated)
}

function invokeOutput(value: unknown): TuiChannelInvokeOutput {
  const validated = validateTuiChannelOutput('invoke', value) as TuiChannelInvokeOutput
  assertBoundedJson(validated, 'Channel invoke output')
  assertJsonSize(validated, 'Channel invoke output')
  return deepFreezeCopy(validated)
}

/** Create an isolated replay Channel Provider over recorded snapshots. */
export function createReplayChannelProvider(source: ReplayChannelSnapshotSource): ChannelProvider {
  if (!Array.isArray(source.snapshots) || source.snapshots.length === 0) {
    throw new TypeError('replay Channel provider requires at least one snapshot')
  }
  if (source.methods !== undefined && (source.methods === null
    || typeof source.methods !== 'object'
    || (Object.getPrototypeOf(source.methods) !== Object.prototype && Object.getPrototypeOf(source.methods) !== null))) {
    throw new TypeError('replay Channel methods must be a plain object map')
  }
  for (const [name, handler] of Object.entries(source.methods ?? {})) {
    if (typeof handler !== 'function') {
      throw new TypeError(`replay Channel method "${name}" must be a function`)
    }
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
  let closed = false

  function latest(): TuiChannelSnapshot {
    return snapshots[currentIndex]!
  }

  function assertOpen(): void {
    if (closed) throw new Error('CHANNEL_CLOSED')
  }

  return Object.freeze({
    async open(input: ChannelProviderOpenInput): Promise<TuiChannelSnapshot> {
      validateTuiChannelInput('open', {
        ...input,
        ...(input.options === undefined ? {} : { options: input.options }),
      })
      // The replay provider is a deterministic fixture harness, not a DSH
      // endpoint that resolves workspace/session authorities. Selector
      // resolution is explicitly unsupported: silently returning the latest
      // snapshot for a wrong selector would be a false conformance claim.
      if ((input.workspace !== undefined && input.workspace !== '')
        || (input.sessionId !== undefined && input.sessionId !== '')) {
        throw new Error('REPLAY_PROVIDER_UNSUPPORTED_SELECTOR: replay provider does not resolve workspace/sessionId selectors')
      }
      closed = false
      return latest()
    },
    async subscribe(
      channelId: string,
      afterVersion: number,
      listener: (snapshot: TuiChannelSnapshot) => void,
    ): Promise<() => void> {
      validateTuiChannelInput('subscribe', { channelId, afterVersion })
      assertOpen()
      const channel = latest()
      if (channel.channelId !== channelId) {
        throw new Error('CHANNEL_NOT_FOUND')
      }
      let stopped = false
      // RFC: subscribe is "not earlier than afterVersion", so equal/version 0
      // snapshots must also be delivered.
      for (const snapshot of snapshots) {
        if (stopped) break
        if (snapshot.version >= afterVersion) {
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
      assertBoundedJson(args, 'Channel.invoke arguments')
      assertJsonSize(args, 'Channel.invoke arguments')
      assertOpen()
      const channel = latest()
      if (channel.channelId !== channelId) {
        throw new Error('CHANNEL_NOT_FOUND')
      }
      const handler = source.methods !== undefined && Object.hasOwn(source.methods, method)
        ? source.methods[method]
        : undefined
      if (typeof handler !== 'function') {
        // Unknown methods are protocol errors, never a successful no-op.
        throw new Error(`FEATURE_UNAVAILABLE: unknown Channel method "${method}"`)
      }
      if (!isReplayIsolationActive()) {
        throw new Error('replay Channel method handlers may only run inside replay isolation')
      }
      const value = await handler(args)
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
      closed = true
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

function assertJsonValue(value: unknown): void {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('replay Channel values must be JSON-serializable')
  }
  assertBoundedJson(value, 'Channel.invoke result')
  assertJsonSize(value, 'Channel.invoke result')
}

export const REPLAY_CHANNEL_WIRE_REVISION = TUI_CHANNEL_WIRE_REVISION
