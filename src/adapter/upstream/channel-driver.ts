/**
 * Upstream driver for the TUI live Channel.
 *
 * The live Channel is a TUI host-internal stateful object, not a DSH service.
 * The driver mounts the five Channel Host Ports (projection/actions/state/
 * plugins/transcript) over the channel registered for the composition root.
 * It is deliberately read-only at mount time: the HostFacade shadow wrapper
 * gates every action method before a caller can mutate the Channel.
 *
 * Publication is feature-level and honest:
 * - read-only projection/state/transcript features become live after a real
 *   snapshot/row probe;
 * - action/plugin mutation methods stay degraded because they cannot be
 *   safely auto-reversed on a live TUI.
 */

import type { HostChannelPort, HostChannelProjectionPort, HostChannelStatePort, HostChannelActionsPort, HostChannelPluginsPort, HostChannelTranscriptPort } from '../ports/channel.js'
import type { CapabilityLifecycle } from '../kernel/lifecycle.js'
import { lifecycleFromDetection } from '../kernel/lifecycle.js'
import type { Detection, DetectionEvidence } from './detection.js'
import type { UpstreamDriver, UpstreamDriverMount } from './driver.js'
import type { Channel } from '../../dsh-adapter/channel.js'
import {
  createChannelPlugins,
  getRegisteredTuiChannel,
  projectChannelRows,
  projectChannelSnapshot,
  projectChannelState,
} from '../channel/index.js'

const CAPABILITY = 'host.channel'

const CHANNEL_FEATURES = Object.freeze([
  'host.channel.projection.snapshot',
  'host.channel.projection.subscribe',
  'host.channel.state.snapshot',
  'host.channel.transcript.rows',
  'host.channel.transcript.trace-events',
  'host.channel.actions.submit',
  'host.channel.actions.steer',
  'host.channel.actions.cancel',
  'host.channel.actions.clear',
  'host.channel.plugins.run-external-command',
  'host.channel.plugins.open-scene',
  'host.channel.plugins.settings-sections',
] as const)

function serviceEvidence(id: string): DetectionEvidence {
  return { kind: 'service', id }
}

function methodEvidence(service: string, method: string): DetectionEvidence {
  return { kind: 'method', id: `${service}:${method}` }
}

function probeEvidence(id: string, detail: string): DetectionEvidence {
  return { kind: 'probe', id, detail }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function channelFor(ctx: unknown): Channel | undefined {
  const candidate = getRegisteredTuiChannel(ctx)
  if (candidate === null || typeof candidate !== 'object') return undefined
  return candidate as Channel
}

export function detectChannelCapability(ctx: unknown): Detection {
  const channel = channelFor(ctx)
  if (channel === undefined) {
    return { state: 'unsupported', reason: 'live TUI Channel is not registered for this composition root' }
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiChannel')]
  if (typeof (channel as unknown as Record<string, unknown>).version !== 'number') {
    return { state: 'degraded', missing: ['channel.version'], evidence }
  }
  if (!Array.isArray((channel as unknown as { rows?: unknown }).rows)) {
    return { state: 'degraded', missing: ['channel.rows'], evidence }
  }
  const methods = ['submit', 'cancel', 'clear', 'notify', 'traceEvents'] as const
  const missing: string[] = []
  for (const method of methods) {
    if (typeof (channel as unknown as Record<string, unknown>)[method] === 'function') {
      evidence.push(methodEvidence('tuiChannel', method))
    } else {
      missing.push(`tuiChannel.${method}()`)
    }
  }
  if (missing.length > 0) return { state: 'degraded', missing, evidence }
  return { state: 'supported', evidence }
}

export function verifyChannelLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  return Promise.resolve(verifyChannelLiveSync(ctx))
}

function liveFeature(capability: string, evidence: DetectionEvidence[]): CapabilityLifecycle {
  return lifecycleFromDetection(capability, { state: 'supported', evidence })
}

function degradedFeature(capability: string, evidence: DetectionEvidence[], missing: string): CapabilityLifecycle {
  return lifecycleFromDetection(capability, { state: 'degraded', missing: [missing], evidence })
}

function verifyChannelLiveSync(ctx: unknown): CapabilityLifecycle[] {
  const channel = channelFor(ctx)
  const base: DetectionEvidence[] = [serviceEvidence('tuiChannel')]
  if (channel === undefined) {
    return CHANNEL_FEATURES.map(feature => degradedFeature(feature, base, 'channel-not-registered'))
  }
  const out: CapabilityLifecycle[] = []
  try {
    const snapshot = projectChannelSnapshot(channel)
    out.push(liveFeature('host.channel.projection.snapshot', [
      serviceEvidence('tuiChannel'),
      methodEvidence('tuiChannel', 'version'),
      probeEvidence('channel.projection.snapshot()', `projected ${snapshot.rows.length} row(s)`),
    ]))
  } catch (error) {
    out.push(degradedFeature('host.channel.projection.snapshot', base, errorText(error)))
  }
  try {
    const state = projectChannelState(channel)
    out.push(liveFeature('host.channel.state.snapshot', [
      serviceEvidence('tuiChannel'),
      methodEvidence('tuiChannel', 'version'),
      probeEvidence('channel.state.snapshot()', `state version ${state.version}`),
    ]))
  } catch (error) {
    out.push(degradedFeature('host.channel.state.snapshot', base, errorText(error)))
  }
  try {
    const rows = projectChannelRows(channel.rows)
    out.push(liveFeature('host.channel.transcript.rows', [
      serviceEvidence('tuiChannel'),
      methodEvidence('tuiChannel', 'rows'),
      probeEvidence('channel.transcript.rows()', `read ${rows.length} rendered row(s)`),
    ]))
    if (typeof channel.traceEvents === 'function') {
      out.push(liveFeature('host.channel.transcript.trace-events', [
        serviceEvidence('tuiChannel'),
        methodEvidence('tuiChannel', 'traceEvents'),
        probeEvidence('channel.transcript.trace-events()', 'raw DSH session event log is readable'),
      ]))
    } else {
      out.push(degradedFeature('host.channel.transcript.trace-events', base, 'tuiChannel.traceEvents()'))
    }
  } catch (error) {
    out.push(degradedFeature('host.channel.transcript.rows', base, errorText(error)))
  }
  // Subscribe is a real listener on the live Channel; it can be safely
  // registered and disposed by the Kernel wrapper, but the driver does not
  // auto-run it in verifyLive because the running TUI already owns it.
  out.push(degradedFeature('host.channel.projection.subscribe', base, 'host.channel.projection.subscribe.live-probe'))
  // Mutations and plugin invocations are not safely auto-reversible on a live
  // TUI; they remain degraded until a dedicated replay channel proves them.
  for (const feature of [
    'host.channel.actions.submit',
    'host.channel.actions.steer',
    'host.channel.actions.cancel',
    'host.channel.actions.clear',
    'host.channel.plugins.run-external-command',
    'host.channel.plugins.open-scene',
    'host.channel.plugins.settings-sections',
  ] as const) {
    out.push(degradedFeature(feature, base, `${feature}.live-probe`))
  }
  return out
}

function requireChannel(ctx: unknown): Channel {
  const channel = channelFor(ctx)
  if (channel === undefined) {
    throw new Error('dsh-tui: live TUI Channel is not registered for this composition root')
  }
  return channel
}

function createProjectionPort(ctx: unknown): HostChannelProjectionPort {
  return Object.freeze({
    snapshot() {
      return projectChannelSnapshot(requireChannel(ctx))
    },
    subscribe(listener) {
      return requireChannel(ctx).subscribe(listener)
    },
  })
}

function createStatePort(ctx: unknown): HostChannelStatePort {
  return Object.freeze({
    snapshot() {
      return projectChannelState(requireChannel(ctx))
    },
  })
}

function createActionsPort(ctx: unknown): HostChannelActionsPort {
  return Object.freeze({
    submit(text) {
      requireChannel(ctx).submit(text)
    },
    steer(text) {
      requireChannel(ctx).steer(text)
    },
    cancel() {
      requireChannel(ctx).cancel()
    },
    interruptAndDeliver(texts) {
      return requireChannel(ctx).interruptAndDeliver(texts)
    },
    clear() {
      requireChannel(ctx).clear()
    },
    loadOlder() {
      return requireChannel(ctx).loadOlder()
    },
    notify(text, options) {
      return requireChannel(ctx).notify(text, options)
    },
  })
}

function createPluginsPort(ctx: unknown): HostChannelPluginsPort {
  return Object.freeze({
    runExternalCommand(name, rawInput) {
      return requireChannel(ctx).runExternalCommand(name, rawInput)
    },
    openPluginScene(id) {
      return requireChannel(ctx).openPluginScene(id)
    },
    closePluginScene() {
      return requireChannel(ctx).closePluginScene()
    },
    settingsSections() {
      return createChannelPlugins(requireChannel(ctx)).settingsSections()
    },
    subscribeSettingsSections(listener) {
      return requireChannel(ctx).subscribeSettingsSections(listener)
    },
  })
}

function createTranscriptPort(ctx: unknown): HostChannelTranscriptPort {
  return Object.freeze({
    rows() {
      return projectChannelRows(requireChannel(ctx).rows)
    },
    traceEvents() {
      return requireChannel(ctx).traceEvents()
    },
    loadOlder() {
      return requireChannel(ctx).loadOlder()
    },
  })
}

function createChannelPort(ctx: unknown): HostChannelPort {
  return Object.freeze({
    projection: createProjectionPort(ctx),
    actions: createActionsPort(ctx),
    state: createStatePort(ctx),
    plugins: createPluginsPort(ctx),
    transcript: createTranscriptPort(ctx),
  })
}

export const channelDriver: UpstreamDriver = {
  id: 'dsh-tui-channel',
  upstreamFamily: 'dsh-tui',
  capability: CAPABILITY,
  mountEffectClass: 'read-only',
  detect: detectChannelCapability,
  verifyLive: verifyChannelLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    return {
      disposer: () => undefined,
      ports: { channel: createChannelPort(context) },
    }
  },
}
