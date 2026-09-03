/**
 * Host-only live-probe access.
 *
 * The reversible live probes used by the Kernel's driver are deliberately not
 * methods on the plugin-visible Cordis services. A plugin can obtain
 * `ctx.tuiPluginStorage`, `ctx.tuiMessageObserver` or `ctx.tuiPluginHost` and
 * call ordinary public methods, but it cannot discover a `probeReversible`
 * method from the normal package export surface.
 *
 * IMPORTANT trust boundary:
 *
 * This module is NOT a security boundary. dsh-TUI's plugin model is
 * trusted-in-process; any code running in the same process can locate the
 * package root through `package.json` and absolutely import the compiled
 * internal file (for example `lib/adapter/kernel/host-probe-access.js`).
 * The package `exports` map blocks ordinary deep imports, but it cannot stop
 * same-process absolute-path loading. The host-only token and registration
 * functions therefore exist to prevent accidental public-API pollution and
 * obvious misuse, not to defend against a malicious in-process plugin.
 *
 * Hardening choices:
 * - `HOST_PROBE_TOKEN` is a module-local symbol and is NOT exported from this
 *   module or from any package public entry.
 * - The registration functions refuse to replace an existing host runner on a
 *   concrete service, so an in-process caller cannot overwrite the real probe
 *   with a fake one after the host has bootstrapped.
 * - The run functions accept an optional token only for backwards-compatible
 *   calling conventions; when no token is supplied they still execute the
 *   registered host runner. They are internal module functions, not package
 *   public API.
 */

/** Opaque host-only token. Module-local; deliberately not exported. */
const HOST_PROBE_TOKEN: unique symbol = Symbol('dsh-tui.host-probe-token')

export interface CommandLiveProbeResult {
  readonly ok: true
  readonly name: string
  readonly lifecycleAppends: number
}

export interface StorageLiveProbeResult {
  readonly service: 'tuiPluginStorage'
  readonly ok: true
  readonly operations: readonly string[]
  readonly tempNamespace: string
}

export interface MessageLiveProbeResult {
  readonly service: 'tuiMessageObserver'
  readonly ok: true
  readonly before: number
  readonly during: number
  readonly after: number
  readonly delivered: number
}

/** The Cordis traceable-proxy unwrap marker used by the host-access module. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function unwrapService(service: unknown): object | undefined {
  if (service === null || typeof service !== 'object') return undefined
  let current: object = service
  const seen = new WeakSet<object>()
  while (!seen.has(current)) {
    seen.add(current)
    let original: unknown
    try {
      original = Reflect.get(current, CORDIS_ORIGINAL)
    } catch {
      break
    }
    if (original === null || typeof original !== 'object' || original === current) break
    current = original
  }
  return current
}

type CommandRunner = (token?: unknown) => Promise<CommandLiveProbeResult>
type StorageRunner = (token?: unknown) => Promise<StorageLiveProbeResult>
type MessageRunner = (token?: unknown) => Promise<MessageLiveProbeResult>

const commandRunners = new WeakMap<object, CommandRunner>()
const storageRunners = new WeakMap<object, StorageRunner>()
const messageRunners = new WeakMap<object, MessageRunner>()

/**
 * Register a live-probe runner for a concrete host service.
 *
 * If a runner is already registered for the same unwrapped service, the call
 * is a no-op: the host bootstrap owns the WeakMap slot and an in-process
 * caller must not be able to replace a real probe with a forged runner.
 */
export function registerCommandLiveProbe(service: object, runner: CommandRunner): void {
  const key = unwrapService(service) ?? service
  if (!commandRunners.has(key)) commandRunners.set(key, runner)
}

export function registerStorageLiveProbe(service: object, runner: StorageRunner): void {
  const key = unwrapService(service) ?? service
  if (!storageRunners.has(key)) storageRunners.set(key, runner)
}

export function registerMessageLiveProbe(service: object, runner: MessageRunner): void {
  const key = unwrapService(service) ?? service
  if (!messageRunners.has(key)) messageRunners.set(key, runner)
}

export function hasCommandLiveProbe(service: unknown): boolean {
  const key = unwrapService(service)
  return key !== undefined && commandRunners.has(key)
}

export function hasStorageLiveProbe(service: unknown): boolean {
  const key = unwrapService(service)
  return key !== undefined && storageRunners.has(key)
}

export function hasMessageLiveProbe(service: unknown): boolean {
  const key = unwrapService(service)
  return key !== undefined && messageRunners.has(key)
}

function assertOptionalHostToken(token: unknown): void {
  if (token !== undefined && token !== HOST_PROBE_TOKEN) {
    throw new Error('dsh-tui: host-only live probe access denied')
  }
}

export async function runCommandLiveProbe(service: unknown, token?: unknown): Promise<CommandLiveProbeResult> {
  assertOptionalHostToken(token)
  const key = unwrapService(service)
  const runner = key === undefined ? undefined : commandRunners.get(key)
  if (runner === undefined) throw new Error('dsh-tui: host command live probe accessor is not registered')
  return runner(token)
}

export async function runStorageLiveProbe(service: unknown, token?: unknown): Promise<StorageLiveProbeResult> {
  assertOptionalHostToken(token)
  const key = unwrapService(service)
  const runner = key === undefined ? undefined : storageRunners.get(key)
  if (runner === undefined) throw new Error('dsh-tui: host storage live probe accessor is not registered')
  return runner(token)
}

export async function runMessageLiveProbe(service: unknown, token?: unknown): Promise<MessageLiveProbeResult> {
  assertOptionalHostToken(token)
  const key = unwrapService(service)
  const runner = key === undefined ? undefined : messageRunners.get(key)
  if (runner === undefined) throw new Error('dsh-tui: host message live probe accessor is not registered')
  return runner(token)
}
