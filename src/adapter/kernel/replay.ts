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
import {
  createReplayChannelProvider,
  createChannelConsumer,
} from '../channel/index.js'
import {
  TUI_CHANNEL_FEATURES,
  TUI_CHANNEL_WIRE_REVISION,
} from '../standard/tui-extension.js'
import {
  validateTuiChannelRequirement,
  validateTuiChannelSupport,
} from '../spec/index.js'
import type { TuiChannelSnapshot } from '../spec/index.js'
import {
  projectDshSessionEventsToSnapshots,
  type DshSessionProjectionMeta,
} from '../channel/session-projection.js'

export const REPLAY_SCHEMA_VERSION = 'tui-adapter-replay/v1'
export const REPLAY_CHANNEL_SCHEMA_VERSION = 'tui-adapter-channel-replay/v1'

/**
 * Replay method → feature mapping used by the conformance harness.
 *
 * The DSH Channel RFC requires `invoke.method` to correspond to a feature
 * the provider declared. This is the harness-side recognized map for the live
 * channel methods; unknown method names are rejected instead of pretending
 * success.
 */
export const CHANNEL_METHOD_FEATURES: Readonly<Record<string, string>> = Object.freeze({
  commandCompletions: 'commands',
  runExternalCommand: 'commands',
  runWorkspaceCommand: 'workspaces',
  listWorkspaces: 'workspaces',
  resolveWorkspace: 'workspaces',
  switchWorkspace: 'workspaces',
  workspaceCommands: 'workspaces',
  listModels: 'models',
  switchModel: 'models',
  listEfforts: 'models',
  setEffort: 'models',
  listProviders: 'provider-setup',
  providerSetup: 'provider-setup',
  describeCredential: 'credentials',
  oauthProviderStatuses: 'credentials',
  listPresets: 'presets',
  switchPreset: 'presets',
  listSkills: 'skills',
  listSessions: 'session-history',
  previewSession: 'session-history',
  deleteSession: 'session-history',
  renameSession: 'session-history',
  forkSession: 'session-history',
  resumeTo: 'session-history',
  newSession: 'session-lifecycle',
  compact: 'session-lifecycle',
  submit: 'session-input',
  steer: 'session-input',
  cancel: 'session-input',
  interruptAndDeliver: 'session-input',
  clear: 'session-input',
  loadOlder: 'session-input',
  rewindTo: 'session-input',
  promptRewind: 'session-input',
  openPluginScene: 'scenes',
  closePluginScene: 'scenes',
  settingsSections: 'settings',
  subscribeSettingsSections: 'settings',
  traceEvents: 'trace',
  notify: 'presentation',
  doctorInfo: 'diagnostics',
  mcpStatus: 'diagnostics',
  pluginsInfo: 'diagnostics',
  listFileCandidates: 'files',
  listFiles: 'files',
  listSubagents: 'subagents',
  balanceInfo: 'credentials',
})

/**
 * Per-feature state evidence keys.
 *
 * A declared Channel feature must be backed by an observable state field or
 * a declared method handler; otherwise the replay is only an empty protocol
 * envelope and must not be reported `ok`.
 */
const CHANNEL_FEATURE_STATE_EVIDENCE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'session-state': ['status', 'sessionTitle', 'homeDir', 'pathCaseInsensitive', 'model', 'mode', 'agentId'],
  'session-input': ['transcript', 'pending', 'lastUserText'],
  'commands': ['commandCatalog'],
  'models': ['model'],
  'modes': ['mode'],
  'presets': ['agentPreset'],
  'presentation': ['notification', 'toast'],
  'provider-setup': ['provider'],
  'credentials': ['credential', 'credentials', 'oauthProviderStatuses'],
  'diagnostics': ['diagnostic', 'diagnostics'],
  'files': ['files', 'fileCandidates'],
  'scenes': ['pluginScene', 'scene'],
  'settings': ['settingsSections'],
  'skills': ['skills'],
  'subagents': ['subagents'],
  'workspaces': ['workspace', 'workspaces'],
  'session-history': ['sessions', 'sessionHistory'],
  'session-lifecycle': ['sessionLifecycle'],
  'trace': ['traceEvents', 'traceData'],
})

function hasMeaningfulEvidenceValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
  if (typeof value === 'string') return value.trim() !== ''
  return value !== undefined
}

function featureHasEvidence(
  feature: string,
  snapshots: readonly TuiChannelSnapshot[],
  verifiedMethods: ReadonlySet<string>,
): boolean {
  const state = snapshots.at(-1)?.state ?? {}
  const keys = CHANNEL_FEATURE_STATE_EVIDENCE_KEYS[feature] ?? []
  for (const key of keys) {
    if (hasMeaningfulEvidenceValue((state as Record<string, unknown>)[key])) return true
  }
  // A declared method handler is NOT evidence by itself: the method must have
  // been successfully invoked through `invokeMethod` during this replay.
  return [...verifiedMethods].some(method => CHANNEL_METHOD_FEATURES[method] === feature)
}

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
  /** P5: optional real DSH Channel snapshot/transcript replay. */
  readonly channel?: ReplayChannelInput
}

/** P5 Channel replay input: recorded `tui.dsh/v1alpha1#Channel` snapshots
 * (a real DSH session projection) and optional transcript/event provenance. */
export interface ReplayChannelInput {
  /** Recorded channel snapshots. If omitted, `sessionEvents` must be given. */
  readonly snapshots?: readonly TuiChannelSnapshot[]
  readonly transcript?: readonly unknown[]
  /** Feature set advertised by this recorded Channel provider. */
  readonly features?: readonly string[]
  /** Optional method handlers, for example `commandCompletions` or
   * `runWorkspaceCommand`, exercised during replay. */
  readonly methods?: Readonly<Record<string, (args: readonly unknown[]) => unknown | Promise<unknown>>>
  /** Optional real DSH session-event source, projected by the harness. */
  readonly sessionEvents?: readonly unknown[]
  readonly sessionMeta?: DshSessionProjectionMeta
  /** Which declared method to invoke, if any. */
  readonly invokeMethod?: string
}

export interface ReplayChannelReport {
  readonly ok: boolean
  readonly schemaVersion: string
  readonly channelId: string
  readonly wireRevision: number
  readonly versions: readonly number[]
  readonly features: readonly string[]
  readonly transcriptCount: number
  readonly continuityErrors: readonly string[]
  readonly openVersion: number
  readonly invokeValueDefined: boolean
  readonly closed: boolean
  /** 'dsh-session-events' when snapshots were projected from real DSH events. */
  readonly source: 'snapshots' | 'dsh-session-events'
  readonly sessionEventCount: number
  readonly featureErrors: readonly string[]
  readonly methodErrors: readonly string[]
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
  readonly channel?: ReplayChannelReport
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
 * Run a real DSH session snapshot/transcript Channel replay through the
 * protocol Provider/Consumer pair.
 *
 * This path validates the full `tui.dsh/v1alpha1#Channel` envelope:
 * - `open` returns a validated complete snapshot;
 * - `subscribe` streams every recorded snapshot (> afterVersion) in order;
 * - `invoke` accepts JSON arguments, returns a JSON result and always
 *   includes the latest validated snapshot;
 * - `close` acknowledges closure;
 * - monotonic version/wire-revision continuity is checked by the consumer.
 */
export async function runChannelReplay(input: ReplayChannelInput): Promise<ReplayChannelReport> {
  if (input === null || typeof input !== 'object') {
    throw new ReplayHarnessError('channel replay input must be an object')
  }
  const hasSessionEvents = Array.isArray(input.sessionEvents)
  const snapshots = input.snapshots ?? (
    hasSessionEvents
      ? projectDshSessionEventsToSnapshots(input.sessionEvents!, input.sessionMeta ?? {
          channelId: 'dsh-session-replay',
        })
      : []
  )
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new ReplayHarnessError('channel replay input must contain snapshots or DSH sessionEvents')
  }
  const source: ReplayChannelReport['source'] = input.snapshots !== undefined ? 'snapshots' : 'dsh-session-events'
  return await withReplayIsolation(async () => {
    const replaySource = { ...input, snapshots }
    const provider = createReplayChannelProvider(replaySource)
    const versions: number[] = []
    const subscriptionSnapshots: TuiChannelSnapshot[] = []
    const subscriptionConsumer = createChannelConsumer(provider, { failClosed: false })
    const first = snapshots[0]!
    // Subscribe first on an independent consumer so version continuity is
    // observed over the recorded stream without conflating it with `open`
    // returning the latest current snapshot.
    await subscriptionConsumer.subscribe(first.channelId, 0, snapshot => {
      subscriptionSnapshots.push(snapshot)
      versions.push(snapshot.version)
    })

    const featureErrors: string[] = []
    const rawFeatures = input.features
    if (rawFeatures === undefined) {
      featureErrors.push('features must be explicitly declared by the replay input')
    }
    const seenFeatures = new Set<string>()
    for (const feature of rawFeatures ?? []) {
      if (seenFeatures.has(feature)) {
        featureErrors.push(`duplicate Channel feature: ${feature}`)
      }
      seenFeatures.add(feature)
    }
    const features = [...new Set(rawFeatures ?? [])]
    const allowedFeatures = new Set(TUI_CHANNEL_FEATURES)
    for (const feature of features) {
      if (!allowedFeatures.has(feature)) featureErrors.push(`unknown Channel feature: ${feature}`)
    }
    try {
      validateTuiChannelRequirement({ wireRevision: TUI_CHANNEL_WIRE_REVISION, features })
      validateTuiChannelSupport({ wireRevision: TUI_CHANNEL_WIRE_REVISION, features })
    } catch (error) {
      featureErrors.push(error instanceof Error ? error.message : String(error))
    }

    const verifiedMethods = new Set<string>()
    const methodErrors: string[] = []
    for (const [method, feature] of Object.entries(CHANNEL_METHOD_FEATURES)) {
      if (input.methods?.[method] === undefined) continue
      if (!features.includes(feature)) {
        methodErrors.push(`method ${method} requires feature ${feature}, which is not declared`)
      }
    }
    if (input.methods !== undefined) {
      for (const method of Object.keys(input.methods)) {
        if (CHANNEL_METHOD_FEATURES[method] === undefined) {
          methodErrors.push(`method ${method} is not in the recognized method->feature map`)
        }
      }
    }

    const consumer = createChannelConsumer(provider, { failClosed: false })
    const opened = await consumer.open({})
    let invokeValueDefined = false
    if (input.invokeMethod !== undefined) {
      if (input.methods?.[input.invokeMethod] === undefined) {
        methodErrors.push(`invokeMethod ${input.invokeMethod} is not provided by replay methods`)
      } else {
        try {
          const invoke = await consumer.invoke(opened.channelId, input.invokeMethod, [])
          invokeValueDefined = invoke.valueDefined === true
          // Only a method that actually executed successfully can back a
          // method-backed feature claim.
          verifiedMethods.add(input.invokeMethod)
        } catch (error) {
          methodErrors.push(error instanceof Error ? error.message : String(error))
        }
      }
    }
    for (const feature of features) {
      if (!featureHasEvidence(feature, snapshots, verifiedMethods)) {
        featureErrors.push(`Channel feature ${feature} has no observable evidence in state or successfully invoked methods`)
      }
    }
    const closed = await consumer.close(opened.channelId)
    const continuityErrors = [
      ...subscriptionConsumer.continuityErrors(),
      ...consumer.continuityErrors(),
    ]
    const ok = continuityErrors.length === 0
      && featureErrors.length === 0
      && methodErrors.length === 0
      && opened.wireRevision === TUI_CHANNEL_WIRE_REVISION
      && opened.channelId === first.channelId
      && closed.closed === true
    return Object.freeze({
      ok,
      schemaVersion: REPLAY_CHANNEL_SCHEMA_VERSION,
      channelId: opened.channelId,
      wireRevision: opened.wireRevision,
      versions: Object.freeze(versions),
      features: Object.freeze(features),
      transcriptCount: input.transcript?.length ?? 0,
      continuityErrors: Object.freeze(continuityErrors),
      openVersion: opened.version,
      invokeValueDefined,
      closed: closed.closed,
      source,
      sessionEventCount: input.sessionEvents?.length ?? 0,
      featureErrors: Object.freeze(featureErrors),
      methodErrors: Object.freeze(methodErrors),
    })
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
      const channel = input.channel === undefined
        ? undefined
        : await runChannelReplay(input.channel)
      return Object.freeze({
        ok: missing.length === 0 && extra.length === 0 && (channel?.ok ?? true),
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
        ...(channel === undefined ? {} : { channel }),
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
