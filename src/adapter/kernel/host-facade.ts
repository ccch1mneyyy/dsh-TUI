/**
 * HostFacade: thin composition / identity entry over mounted Host Ports.
 *
 * P2 callers normally obtain this from `KernelRuntime.facade()`, which backs
 * the descriptor port with the unified kernel lifecycle evidence.
 * `facadeFromLegacy` remains only as a long-term compatibility fallback for
 * bare/test compositions (outside P6 removal scope; owner: dsh-tui adapter).
 * Hard rules:
 * - It performs no business logic, no protocol translation, no capability
 *   detection, no registry, and stores no mutable host state.
 * - It is for TUI host-internal code only. External plugins continue to use
 *   dsh-std / dsh-ecosystem-spec public protocol surfaces.
 * - It only exposes Host Ports; admission, permission evaluation and ledger
 *   writes are Kernel/Standard internal services and must never be exposed
 *   as ordinary Host Ports.
 */

import type { HostDescriptorPort } from '../ports/descriptor.js'
import type { HostPresentationPort } from '../ports/presentation.js'
import type { HostWorkspacePort } from '../ports/workspace.js'
import type { HostScenesPort } from '../ports/scenes.js'
import type { HostSettingsPort } from '../ports/settings.js'
import type {
  HostStatusPort,
  HostShortcutsPort,
  HostRenderersPort,
  HostThemesPort,
  HostToastPort,
  HostCommandTreesPort,
} from '../ports/extensions.js'
import type { HostDecisionsPort } from '../ports/decisions.js'
import type { HostChannelPort } from '../ports/channel.js'
import {
  assertShadowPolicy,
  effectClassFor,
  type AdapterMode,
} from './runtime.js'
import { CHANNEL_PORT_METHOD_CAPABILITIES as CHANNEL_PORT_CAPABILITIES } from '../channel/features.js'

export interface HostFacade {
  readonly descriptor: HostDescriptorPort
  readonly presentation?: HostPresentationPort
  readonly workspace?: HostWorkspacePort
  readonly scenes?: HostScenesPort
  readonly settings?: HostSettingsPort
  readonly status?: HostStatusPort
  readonly shortcuts?: HostShortcutsPort
  readonly renderers?: HostRenderersPort
  readonly themes?: HostThemesPort
  readonly toast?: HostToastPort
  readonly commandTrees?: HostCommandTreesPort
  readonly decisions?: HostDecisionsPort
  readonly channel?: HostChannelPort
}

export interface HostFacadePorts {
  readonly descriptor: HostDescriptorPort
  readonly presentation?: HostPresentationPort
  readonly workspace?: HostWorkspacePort
  readonly scenes?: HostScenesPort
  readonly settings?: HostSettingsPort
  readonly status?: HostStatusPort
  readonly shortcuts?: HostShortcutsPort
  readonly renderers?: HostRenderersPort
  readonly themes?: HostThemesPort
  readonly toast?: HostToastPort
  readonly commandTrees?: HostCommandTreesPort
  readonly decisions?: HostDecisionsPort
  readonly channel?: HostChannelPort
}

/**
 * Per-method shadow-policy capabilities for mounted Host Ports.
 *
 * Every method on a mounted Port is guarded by the Kernel effect matrix. This
 * is the last line of defense after `KernelRuntime.mount()` has already
 * rejected whole drivers whose mountEffectClass is not allowed in a shadow
 * mode: even a read-only-mounted Port cannot silently execute a mutate /
 * register / subscribe method while the runtime is passive/replay-shadow.
 */
const PORT_METHOD_CAPABILITIES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  presentation: Object.freeze({
    ask: 'host.presentation.ask',
    approve: 'host.presentation.approve',
    dialog: 'host.presentation.dialog',
  }),
  workspace: Object.freeze({
    list: 'host.workspaces.list',
    resolve: 'host.workspaces.resolve',
    describe: 'host.workspaces.describe',
    commandShell: 'host.workspaces.commandShell',
    rename: 'host.workspaces.rename',
    commands: 'host.workspaces.commands',
    runCommand: 'host.workspaces.runCommand',
  }),
  scenes: Object.freeze({
    register: 'host.scenes.register',
    list: 'host.scenes.list',
    open: 'host.scenes.open',
    close: 'host.scenes.close',
    active: 'host.scenes.active',
    subscribe: 'host.scenes.subscribe',
  }),
  settings: Object.freeze({
    register: 'host.settings.register',
    list: 'host.settings.list',
    section: 'host.settings.section',
    subscribe: 'host.settings.subscribe',
  }),
  status: Object.freeze({
    set: 'host.status.set',
    snapshot: 'host.status.snapshot',
    subscribe: 'host.status.subscribe',
  }),
  shortcuts: Object.freeze({
    register: 'host.shortcuts.register',
    list: 'host.shortcuts.list',
    dispatch: 'host.shortcuts.dispatch',
  }),
  renderers: Object.freeze({
    register: 'host.renderers.register',
    render: 'host.renderers.render',
  }),
  themes: Object.freeze({
    register: 'host.themes.register',
    snapshot: 'host.themes.snapshot',
    resolve: 'host.themes.resolver',
    subscribe: 'host.themes.subscribe',
  }),
  toast: Object.freeze({
    show: 'host.toast.show',
  }),
  commandTrees: Object.freeze({
    register: 'host.command-trees.register',
    children: 'host.command-trees.children',
    descriptions: 'host.command-trees.descriptions',
  }),
  decisions: Object.freeze({
    probe: 'host.decision.probe',
    subscribe: 'host.decision.subscribe',
  }),
})

function assertPortMethod(mode: AdapterMode, capability: string): void {
  const effectClass = effectClassFor(capability)
  if (effectClass === undefined) {
    throw new Error(`dsh-tui: Host Port method has no registered effect class: ${capability}`)
  }
  assertShadowPolicy(effectClass, mode)
}

function wrapPort<T extends object>(port: T, portName: string, mode: AdapterMode): T {
  const capabilities = PORT_METHOD_CAPABILITIES[portName]
  if (capabilities === undefined) {
    throw new Error(`dsh-tui: no shadow-policy map for Host Port "${portName}"`)
  }
  const wrapped: Record<string, unknown> = {}
  for (const key of Object.keys(port)) {
    const capability = capabilities[key]
    if (capability === undefined) {
      throw new Error(`dsh-tui: Host Port "${portName}" method "${key}" is missing from the shadow-policy map`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(port, key)
    if (descriptor?.get !== undefined) {
      Object.defineProperty(wrapped, key, {
        enumerable: true,
        get() {
          assertPortMethod(mode, capability)
          return descriptor.get!.call(port)
        },
      })
    } else {
      const original = (port as Readonly<Record<string, unknown>>)[key]
      if (typeof original === 'function') {
        wrapped[key] = function (this: unknown, ...args: unknown[]) {
          assertPortMethod(mode, capability)
          return Reflect.apply(original, port, args)
        }
      } else {
        wrapped[key] = original
      }
    }
  }
  return Object.freeze(wrapped) as T
}

function wrapChannelPort(port: HostChannelPort, mode: AdapterMode): HostChannelPort {
  const wrapped: Record<string, unknown> = {}
  for (const subName of Object.keys(port)) {
    const subPort = (port as unknown as Record<string, Record<string, unknown>>)[subName]
    if (subPort === undefined) continue
    const capabilities = CHANNEL_PORT_CAPABILITIES[subName]
    if (capabilities === undefined) {
      throw new Error(`dsh-tui: Host Channel sub-port "${subName}" is missing from the shadow-policy map`)
    }
    const subWrapped: Record<string, unknown> = {}
    for (const key of Object.keys(subPort)) {
      const capability = capabilities[key]
      if (capability === undefined) {
        throw new Error(`dsh-tui: Host Channel "${subName}" method "${key}" is missing from the shadow-policy map`)
      }
      const original = subPort[key]
      if (typeof original === 'function') {
        subWrapped[key] = function (this: unknown, ...args: unknown[]) {
          assertPortMethod(mode, capability)
          return Reflect.apply(original, subPort, args)
        }
      } else {
        subWrapped[key] = original
      }
    }
    wrapped[subName] = Object.freeze(subWrapped)
  }
  return Object.freeze(wrapped) as unknown as HostChannelPort
}

/** Build the immutable facade from already-composed slice implementations. */
export function createHostFacade(ports: HostFacadePorts): HostFacade {
  return Object.freeze({
    descriptor: ports.descriptor,
    ...(ports.presentation === undefined ? {} : { presentation: ports.presentation }),
    ...(ports.workspace === undefined ? {} : { workspace: ports.workspace }),
    ...(ports.scenes === undefined ? {} : { scenes: ports.scenes }),
    ...(ports.settings === undefined ? {} : { settings: ports.settings }),
    ...(ports.status === undefined ? {} : { status: ports.status }),
    ...(ports.shortcuts === undefined ? {} : { shortcuts: ports.shortcuts }),
    ...(ports.renderers === undefined ? {} : { renderers: ports.renderers }),
    ...(ports.themes === undefined ? {} : { themes: ports.themes }),
    ...(ports.toast === undefined ? {} : { toast: ports.toast }),
    ...(ports.commandTrees === undefined ? {} : { commandTrees: ports.commandTrees }),
    ...(ports.decisions === undefined ? {} : { decisions: ports.decisions }),
    ...(ports.channel === undefined ? {} : { channel: ports.channel }),
  })
}

/**
 * Build a HostFacade whose descriptor and every mounted Host Port method are
 * wrapped with the unified shadow-policy assertion. This is what the Kernel
 * exposes to internal TUI callers: no Port method can silently perform a
 * mutate/register/subscribe side effect in passive/replay production modes.
 */
export function createShadowGuardedHostFacade(ports: HostFacadePorts, mode: AdapterMode): HostFacade {
  const descriptor: HostDescriptorPort = Object.freeze({
    get generationId() {
      assertShadowPolicy('read-only', mode)
      return ports.descriptor.generationId
    },
    snapshot() {
      assertShadowPolicy('read-only', mode)
      return ports.descriptor.snapshot()
    },
  })
  const wrapped: HostFacadePorts = {
    descriptor,
    ...(ports.presentation === undefined ? {} : { presentation: wrapPort(ports.presentation, 'presentation', mode) }),
    ...(ports.workspace === undefined ? {} : { workspace: wrapPort(ports.workspace, 'workspace', mode) }),
    ...(ports.scenes === undefined ? {} : { scenes: wrapPort(ports.scenes, 'scenes', mode) }),
    ...(ports.settings === undefined ? {} : { settings: wrapPort(ports.settings, 'settings', mode) }),
    ...(ports.status === undefined ? {} : { status: wrapPort(ports.status, 'status', mode) }),
    ...(ports.shortcuts === undefined ? {} : { shortcuts: wrapPort(ports.shortcuts, 'shortcuts', mode) }),
    ...(ports.renderers === undefined ? {} : { renderers: wrapPort(ports.renderers, 'renderers', mode) }),
    ...(ports.themes === undefined ? {} : { themes: wrapPort(ports.themes, 'themes', mode) }),
    ...(ports.toast === undefined ? {} : { toast: wrapPort(ports.toast, 'toast', mode) }),
    ...(ports.commandTrees === undefined ? {} : { commandTrees: wrapPort(ports.commandTrees, 'commandTrees', mode) }),
    ...(ports.decisions === undefined ? {} : { decisions: wrapPort(ports.decisions, 'decisions', mode) }),
    ...(ports.channel === undefined ? {} : { channel: wrapChannelPort(ports.channel, mode) }),
  }
  return createHostFacade(wrapped)
}
