/**
 * Adapter runtime / shadow-mode switch and effect-class enforcement.
 *
 * This is the Kernel's incremental-migration control surface. It does not load
 * drivers or perform business translation; it selects and records shadow
 * policy per capability, and provides the unified assertion every
 * effect-producing Port/slice entry must call.
 */

import type { HostEffectClass } from '../ports/owner.js'
import { isReplayIsolationActive } from './replay-isolation.js'

export type AdapterMode = 'legacy' | 'passive-shadow' | 'replay-shadow' | 'new'
export type AdapterSliceName = string

export interface AdapterRuntimeOptions {
  readonly mode: AdapterMode
  readonly slices: readonly AdapterSliceName[]
}

export const DEFAULT_ADAPTER_MODE: AdapterMode = 'legacy'

/**
 * Effect classification per adapter capability.
 *
 * Every capability that can produce an effect must be registered here so the
 * runtime can enforce shadow policy uniformly instead of relying on ad-hoc
 * call-site checks.
 */
export const ADAPTER_CAPABILITY_EFFECT_CLASSES: Readonly<Record<string, HostEffectClass>> = Object.freeze({
  'host.descriptor': 'read-only',
  'host.diagnostics': 'read-only',
  'host.admission': 'mutate',
  'host.grants.evaluate': 'read-only',
  'host.grants.subscribe': 'subscribe',
  'host.ledger.record': 'mutate',
  'host.commands.register': 'register',
  'host.commands.invoke': 'mutate',
  'host.commands.liveProbe': 'register',
  'host.storage.open': 'mutate',
  'host.storage.read': 'read-only',
  'host.storage.write': 'mutate',
  'host.storage.probe': 'read-only',
  'host.storage.liveProbe': 'mutate',
  'host.messages.subscribe': 'subscribe',
  'host.messages.probe': 'read-only',
  'host.messages.liveProbe': 'subscribe',
  'host.decision.subscribe': 'subscribe',
  'host.decision.probe': 'read-only',
  'host.presentation.ask': 'mutate',
  'host.presentation.approve': 'mutate',
  'host.presentation.dialog': 'mutate',
  'host.scenes.register': 'register',
  'host.scenes.list': 'read-only',
  'host.scenes.open': 'mutate',
  'host.scenes.close': 'mutate',
  'host.scenes.active': 'read-only',
  'host.scenes.subscribe': 'subscribe',
  'host.settings.register': 'register',
  'host.settings.list': 'read-only',
  'host.settings.section': 'read-only',
  'host.settings.subscribe': 'subscribe',
  'host.status.set': 'mutate',
  'host.status.snapshot': 'read-only',
  'host.status.subscribe': 'subscribe',
  'host.renderers.register': 'register',
  'host.renderers.render': 'read-only',
  'host.shortcuts.register': 'register',
  'host.shortcuts.list': 'read-only',
  'host.shortcuts.dispatch': 'mutate',
  'host.themes.register': 'register',
  'host.themes.snapshot': 'read-only',
  'host.themes.resolver': 'read-only',
  'host.themes.subscribe': 'subscribe',
  'host.dialogs.select': 'mutate',
  'host.dialogs.confirm': 'mutate',
  'host.dialogs.input': 'mutate',
  'host.toast.show': 'mutate',
  'host.command-trees.register': 'register',
  'host.command-trees.children': 'read-only',
  'host.command-trees.descriptions': 'read-only',
  'host.workspaces.register': 'register',
  'host.workspaces.list': 'read-only',
  'host.workspaces.resolve': 'read-only',
  'host.workspaces.describe': 'read-only',
  'host.workspaces.commandShell': 'mutate',
  'host.workspaces.rename': 'mutate',
  'host.workspaces.commands': 'read-only',
  'host.workspaces.runCommand': 'mutate',
  'host.channel.projection.snapshot': 'read-only',
  'host.channel.projection.subscribe': 'subscribe',
  'host.channel.state.snapshot': 'read-only',
  'host.channel.transcript.rows': 'read-only',
  'host.channel.transcript.trace-events': 'read-only',
  'host.channel.actions.loadOlder': 'mutate',
  'host.channel.actions.submit': 'mutate',
  'host.channel.actions.steer': 'mutate',
  'host.channel.actions.cancel': 'mutate',
  'host.channel.actions.interruptAndDeliver': 'mutate',
  'host.channel.actions.clear': 'mutate',
  'host.channel.actions.notify': 'mutate',
  'host.channel.plugins.run-external-command': 'mutate',
  'host.channel.plugins.open-scene': 'mutate',
  'host.channel.plugins.close-scene': 'mutate',
  'host.channel.plugins.settings-sections': 'read-only',
  'host.channel.plugins.subscribe-settings-sections': 'subscribe',
})


/** Map a capability to its incremental migration slice. */
export const ADAPTER_CAPABILITY_SLICES: Readonly<Record<string, string>> = Object.freeze({
  'host.descriptor': 'descriptor',
  'host.diagnostics': 'descriptor',
  'host.admission': 'admission',
  'host.grants.evaluate': 'admission',
  'host.grants.subscribe': 'admission',
  'host.ledger.record': 'ledger',
  'host.commands.register': 'commands',
  'host.commands.invoke': 'commands',
  'host.commands.liveProbe': 'commands',
  'host.storage.open': 'storage',
  'host.storage.read': 'storage',
  'host.storage.write': 'storage',
  'host.storage.probe': 'storage',
  'host.storage.liveProbe': 'storage',
  'host.messages.subscribe': 'messages',
  'host.messages.probe': 'messages',
  'host.messages.liveProbe': 'messages',
  'host.decision.subscribe': 'decisions',
  'host.decision.probe': 'decisions',
  'host.presentation.ask': 'presentation',
  'host.presentation.approve': 'presentation',
  'host.presentation.dialog': 'presentation',
  'host.scenes.register': 'scenes',
  'host.scenes.list': 'scenes',
  'host.scenes.open': 'scenes',
  'host.scenes.close': 'scenes',
  'host.scenes.active': 'scenes',
  'host.scenes.subscribe': 'scenes',
  'host.settings.register': 'settings',
  'host.settings.list': 'settings',
  'host.settings.section': 'settings',
  'host.settings.subscribe': 'settings',
  'host.status.set': 'status',
  'host.status.snapshot': 'status',
  'host.status.subscribe': 'status',
  'host.renderers.register': 'renderers',
  'host.renderers.render': 'renderers',
  'host.shortcuts.register': 'shortcuts',
  'host.shortcuts.list': 'shortcuts',
  'host.shortcuts.dispatch': 'shortcuts',
  'host.themes.register': 'themes',
  'host.themes.snapshot': 'themes',
  'host.themes.resolver': 'themes',
  'host.themes.subscribe': 'themes',
  'host.dialogs.select': 'presentation',
  'host.dialogs.confirm': 'presentation',
  'host.dialogs.input': 'presentation',
  'host.toast.show': 'toast',
  'host.command-trees.register': 'command-trees',
  'host.command-trees.children': 'command-trees',
  'host.command-trees.descriptions': 'command-trees',
  'host.workspaces.register': 'workspaces',
  'host.workspaces.list': 'workspaces',
  'host.workspaces.resolve': 'workspaces',
  'host.workspaces.describe': 'workspaces',
  'host.workspaces.commandShell': 'workspaces',
  'host.workspaces.rename': 'workspaces',
  'host.workspaces.commands': 'workspaces',
  'host.workspaces.runCommand': 'workspaces',
  'host.channel.projection.snapshot': 'channel',
  'host.channel.projection.subscribe': 'channel',
  'host.channel.state.snapshot': 'channel',
  'host.channel.transcript.rows': 'channel',
  'host.channel.transcript.trace-events': 'channel',
  'host.channel.actions.loadOlder': 'channel',
  'host.channel.actions.submit': 'channel',
  'host.channel.actions.steer': 'channel',
  'host.channel.actions.cancel': 'channel',
  'host.channel.actions.interruptAndDeliver': 'channel',
  'host.channel.actions.clear': 'channel',
  'host.channel.actions.notify': 'channel',
  'host.channel.plugins.run-external-command': 'channel',
  'host.channel.plugins.open-scene': 'channel',
  'host.channel.plugins.close-scene': 'channel',
  'host.channel.plugins.settings-sections': 'channel',
  'host.channel.plugins.subscribe-settings-sections': 'channel',
})

export function sliceForCapability(capability: string): string | undefined {
  return ADAPTER_CAPABILITY_SLICES[capability]
}

/**
 * If an explicit slice allowlist is provided, only capabilities from those
 * slices are governed by the selected AdapterMode. An empty/undefined slice
 * list means the whole adapter surface is governed (the conservative default).
 */
function isSelectedSlice(capability: string, slices: readonly string[] | undefined): boolean {
  if (slices === undefined || slices.length === 0) return true
  const slice = sliceForCapability(capability)
  return slice !== undefined && slices.includes(slice)
}

export function effectClassFor(capability: string): HostEffectClass | undefined {
  return ADAPTER_CAPABILITY_EFFECT_CLASSES[capability]
}

export function parseAdapterMode(value: string | undefined): AdapterMode {
  const normalized = value?.trim().toLowerCase()
  switch (normalized) {
    case 'passive-shadow':
    case 'replay-shadow':
    case 'new':
      return normalized
    default:
      return DEFAULT_ADAPTER_MODE
  }
}

export const ADAPTER_SLICE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'dialog': 'presentation',
  'dialogs': 'presentation',
  'decision': 'decisions',
  'decision-events': 'decisions',
  'decisionevents': 'decisions',
  'command-tree': 'command-trees',
  'commandtrees': 'command-trees',
  'workspace': 'workspaces',
  'setting': 'settings',
  'scene': 'scenes',
  'shortcut': 'shortcuts',
  'renderer': 'renderers',
  'theme': 'themes',
})

const KNOWN_ADAPTER_SLICES: ReadonlySet<string> = new Set(Object.values(ADAPTER_CAPABILITY_SLICES))

function canonicalAdapterSlice(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return ADAPTER_SLICE_ALIASES[trimmed] ?? trimmed
}

/**
 * Normalize an explicit adapter-slice allowlist.
 *
 * Slice ids are case-insensitive and surrounding whitespace is ignored.
 * Known aliases are mapped to their canonical slice id. Unknown ids are
 * rejected loudly (fail-closed) instead of being silently ignored: a typo in
 * `DSH_TUI_ADAPTER_SLICES` must never accidentally broaden or narrow the
 * governed adapter surface without the operator noticing.
 */
export function normalizeAdapterSliceList(slices: readonly string[]): readonly string[] {
  const normalized: string[] = []
  for (const raw of slices) {
    const name = canonicalAdapterSlice(raw)
    if (name === '') continue
    if (!KNOWN_ADAPTER_SLICES.has(name)) {
      throw new Error(
        `dsh-tui: unknown adapter slice "${raw}"; valid slices: ${[...KNOWN_ADAPTER_SLICES].sort().join(', ')}`,
      )
    }
    if (!normalized.includes(name)) normalized.push(name)
  }
  return Object.freeze(normalized)
}

export function parseAdapterRuntime(env: NodeJS.ProcessEnv = process.env): AdapterRuntimeOptions {
  return Object.freeze({
    mode: parseAdapterMode(env.DSH_TUI_ADAPTER_MODE),
    slices: normalizeAdapterSliceList((env.DSH_TUI_ADAPTER_SLICES ?? '').split(',')),
  })
}

/**
 * Immutable fallback snapshot factory for objects that are not bound to a
 * Cordis composition (standalone stores, in-package local registries, unbound
 * grant stores). Each object captures the process environment at construction
 * time; once captured, that object never re-reads mutable process state.
 * Production composition-bound services must use `adapterRuntimeFor(ctx)`
 * instead so each composition root gets its own stable snapshot.
 */
export function defaultAdapterRuntime(): AdapterRuntimeOptions {
  return parseAdapterRuntime()
}

/**
 * Effect classification determines which shadow modes are allowed:
 * - read-only may run as passive shadow and replay shadow;
 * - subscribe/register require replay or direct switch;
 * - mutate only runs in legacy/new (it must never pretend to be a shadow).
 */
export function isPassiveShadowAllowed(effectClass: HostEffectClass): boolean {
  return effectClass === 'read-only'
}

export function shadowPolicyAllowed(effectClass: HostEffectClass, mode: AdapterMode): boolean {
  if (mode === 'legacy' || mode === 'new') return true
  if (mode === 'replay-shadow') {
    // On a real production host replay-shadow is fail-closed: without an
    // explicit isolated replay section, subscribe/register-capable entries
    // are refused just like passive-shadow. They are only allowed while the
    // replay harness has entered an isolated mock/replay context.
    if (!isReplayIsolationActive()) return effectClass === 'read-only'
    return effectClass !== 'mutate'
  }
  return mode === 'passive-shadow' && isPassiveShadowAllowed(effectClass)
}

export function assertShadowPolicy(effectClass: HostEffectClass, mode: AdapterMode): void {
  if (!shadowPolicyAllowed(effectClass, mode)) {
    throw new Error(
      `dsh-tui: shadow policy denies ${effectClass} in ${mode} mode`,
    )
  }
}

/**
 * Hard guard-position invariant for adapter capability methods:
 * every mediated/effectful entry MUST call this guard (or the
 * `assertAdapterCapability` convenience) as its FIRST side-effect-free
 * preflight step, BEFORE creating subscriptions, registrations, file watches,
 * writes, mounts or any other observable side effect. This is also enforced
 * by `verify:adapter-shadow` for service methods and returned handles.
 */
export function assertCapabilityShadowPolicy(
  capability: string,
  mode: AdapterMode,
  slices?: readonly string[],
): void {
  // The slice allowlist is an incremental-migration switch for legacy/new
  // only. Shadow modes are global safety modes: a capability outside the
  // listed slice must still be denied if it would produce a real effect.
  if (!isSelectedSlice(capability, slices) && (mode === 'legacy' || mode === 'new')) return
  const effectClass = effectClassFor(capability)
  if (effectClass === undefined) {
    throw new Error(`dsh-tui: capability has no registered effect class: ${capability}`)
  }
  assertShadowPolicy(effectClass, mode)
}

/** Convenience for legacy adapter service methods: parse the process runtime
 * once per call and assert the capability's shadow policy. This keeps
 * migration-era service entry points on the same unified effect matrix. */
let defaultRuntimeSnapshot: AdapterRuntimeOptions | undefined

export function assertAdapterCapability(capability: string): void {
  defaultRuntimeSnapshot ??= parseAdapterRuntime()
  assertCapabilityShadowPolicy(capability, defaultRuntimeSnapshot.mode, defaultRuntimeSnapshot.slices)
}
