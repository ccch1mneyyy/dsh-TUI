/**
 * Passive / Replay shadow harness (P2 minimal).
 *
 * - Passive Shadow: `KernelRuntime.detect()` + `descriptorBuild()` already
 *   produce a read-only diagnostic snapshot without registering, subscribing,
 *   or writing. This module does not add a second passive path.
 * - Replay Shadow: this module defines a JSON-friendly replay input and a real
 *   runnable path that feeds isolated mock upstream services into the same
 *   KernelRuntime/driver used by production. It never connects to a real DSH
 *   host and never writes real plugin state.
 *
 * The replay input is intentionally small and line-protocol-free. It records
 * the minimal host facts needed to exercise the new driver: command catalog,
 * service availability, and DecisionEvents vocabulary.
 */

import type { HostDescriptorBuild } from '../standard/descriptor.js'
import type { CapabilityLifecycle } from './lifecycle.js'
import { KernelRuntime } from './kernel-runtime.js'
import { hostDescriptorDriver } from '../upstream/host-descriptor-driver.js'
import {
  registerCommandLiveProbe,
  registerMessageLiveProbe,
  registerStorageLiveProbe,
} from './host-probe-access.js'
import { withReplayIsolation } from './replay-isolation.js'

export const REPLAY_SCHEMA_VERSION = 'tui-adapter-replay/v1'

export interface ReplayContractRef {
  readonly apiVersion: string
  readonly kind: string
}

export interface ReplayCommand {
  readonly name: string
  readonly description: string
}

export interface ReplayInput {
  readonly schemaVersion: 'tui-adapter-replay/v1'
  readonly generationId?: string
  readonly host?: {
    readonly id?: string
    readonly version?: string
    readonly legacyContracts?: readonly ReplayContractRef[]
  }
  readonly commands?: readonly ReplayCommand[]
  readonly storage?: boolean
  readonly messages?: boolean
  readonly decisionEvents?: readonly string[]
}

export interface ReplayReport {
  readonly ok: boolean
  readonly schemaVersion: string
  readonly generationId: string
  readonly mode: 'replay-shadow'
  readonly kernelContracts: readonly string[]
  readonly legacyContracts: readonly string[]
  readonly missing: readonly string[]
  readonly extra: readonly string[]
  readonly matched: readonly string[]
  readonly lifecycles: readonly CapabilityLifecycle[]
  readonly dropped: readonly string[]
  readonly warnings: readonly string[]
}

export class ReplayHarnessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayHarnessError'
  }
}

/** Isolated host-context stub backed entirely by the replay input. */
export function createReplayContext(input: ReplayInput): unknown {
  const commandRegistry = new Map<string, { name: string; description: string; handler: () => unknown }>()

  const commands = Object.freeze({
    register(definition: { name: string; description: string; handler: () => unknown }) {
      if (commandRegistry.has(definition.name)) {
        throw new Error(`replay command already registered: ${definition.name}`)
      }
      commandRegistry.set(definition.name, {
        name: definition.name,
        description: definition.description,
        handler: definition.handler,
      })
      return () => {
        commandRegistry.delete(definition.name)
      }
    },
    list(): readonly { name: string; description: string }[] {
      return Object.freeze([...commandRegistry.values()].map(command => Object.freeze({
        name: command.name,
        description: command.description,
      })))
    },
    find(_agent: unknown, name: string): unknown {
      return commandRegistry.get(name)
    },
    async execute(
      _agent: unknown,
      line: string,
      _images: readonly unknown[],
      signal: AbortSignal,
    ): Promise<{ commandId: string; result: { kind: 'success'; text: string } } | undefined> {
      const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
      if (match === null) return undefined
      const command = commandRegistry.get(match[1]!)
      if (command === undefined) return undefined
      if (signal.aborted) throw new Error('replay command aborted')
      const result = await command.handler()
      if (result === null || typeof result !== 'object' || (result as { kind?: unknown }).kind !== 'success') {
        throw new Error('replay command handler did not return success')
      }
      return { commandId: 'replay', result: result as { kind: 'success'; text: string } }
    },
  })

  const storage = Object.freeze({
    open: () => Object.freeze({}),
    probeDiagnostic: () => Object.freeze({ service: 'tuiPluginStorage', ok: true as const, dir: 'replay' }),
  })
  registerStorageLiveProbe(storage, async () => Object.freeze({
    service: 'tuiPluginStorage' as const,
    ok: true as const,
    operations: Object.freeze(['write', 'read', 'delete']),
    tempNamespace: 'replay-temp',
  }))

  const messages = Object.freeze({
    subscribe: () => () => undefined,
    probeDiagnostic: () => Object.freeze({ service: 'tuiMessageObserver', ok: true as const, subscriptions: 0 }),
  })
  registerMessageLiveProbe(messages, async () => Object.freeze({
    service: 'tuiMessageObserver' as const,
    ok: true as const,
    before: 0,
    during: 1,
    after: 0,
    delivered: 1,
  }))

  const host = Object.freeze({
    hostDescriptor: () => Object.freeze({ descriptor: Object.freeze({ contracts: [] }), dropped: [], warnings: [] }),
    describe: () => Object.freeze({ descriptor: Object.freeze({ contracts: [] }), dropped: [], warnings: [] }),
    subscribeDecision: () => () => undefined,
    probeDecisionEvents: () => Object.freeze([...(input.decisionEvents ?? [])]),
  })
  registerCommandLiveProbe(host, async () => Object.freeze({
    ok: true as const,
    name: 'replay-command-probe',
    lifecycleAppends: 0,
  }))

  return Object.freeze({
    get(name: string): unknown {
      switch (name) {
        case 'commands': return input.commands === undefined ? undefined : commands
        case 'tuiPluginStorage': return input.storage === true ? storage : undefined
        case 'tuiMessageObserver': return input.messages === true ? messages : undefined
        case 'tuiPluginHost': return host
        default: return undefined
      }
    },
  })
}

/**
 * Run an isolated replay-shadow comparison through the production KernelRuntime
 * and host-descriptor driver.
 *
 * This is fail-closed: malformed replay input or an unavailable schema aborts
 * with `ReplayHarnessError` rather than silently falling back to a legacy view.
 */
export async function runReplayShadow(input: ReplayInput): Promise<ReplayReport> {
  if (input === null || typeof input !== 'object') {
    throw new ReplayHarnessError('replay input must be an object')
  }
  if (input.schemaVersion !== REPLAY_SCHEMA_VERSION) {
    throw new ReplayHarnessError(
      `unsupported replay schema ${String((input as { schemaVersion?: unknown }).schemaVersion)}; expected ${REPLAY_SCHEMA_VERSION}`,
    )
  }
  const generationId = input.generationId ?? 'replay-shadow'
  const context = createReplayContext(input)
  return await withReplayIsolation(async () => {
    const kernel = new KernelRuntime({
      context,
      mode: 'replay-shadow',
      generationId,
      hostId: input.host?.id,
      hostVersion: input.host?.version,
      drivers: [hostDescriptorDriver],
    })
    try {
      await kernel.refresh({ allowReplay: true })
      const build: HostDescriptorBuild = kernel.descriptorBuild()
      const kernelContracts = build.descriptor.contracts.map(contract => `${contract.apiVersion}#${contract.kind}`).sort()
      const legacyContracts = [...(input.host?.legacyContracts ?? [])]
        .map(contract => `${contract.apiVersion}#${contract.kind}`)
        .sort()
      const kernelSet = new Set(kernelContracts)
      const legacySet = new Set(legacyContracts)
      const matched = kernelContracts.filter(key => legacySet.has(key))
      const missing = legacyContracts.filter(key => !kernelSet.has(key))
      const extra = kernelContracts.filter(key => !legacySet.has(key))
      return Object.freeze({
        ok: missing.length === 0 && extra.length === 0,
        schemaVersion: REPLAY_SCHEMA_VERSION,
        generationId,
        mode: 'replay-shadow',
        kernelContracts: Object.freeze(kernelContracts),
        legacyContracts: Object.freeze(legacyContracts),
        missing: Object.freeze(missing),
        extra: Object.freeze(extra),
        matched: Object.freeze(matched),
        lifecycles: kernel.currentLifecycles(),
        dropped: Object.freeze([...build.dropped]),
        warnings: Object.freeze([...build.warnings]),
      })
    } finally {
      kernel.dispose()
    }
  })
}

/** Convenience for the production fail-closed check: a real host cannot run
 * replay-shadow without an explicit isolated replay input. */
export function assertReplayShadowProductionUnavailable(): never {
  throw new ReplayHarnessError(
    'replay-shadow on a real production host is not available without an isolated replay input; use scripts/verify-adapter-replay-harness.ts or the replay module',
  )
}
