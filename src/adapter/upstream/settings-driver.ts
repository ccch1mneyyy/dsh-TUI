/**
 * Upstream driver for the TUI settings-section capability.
 *
 * Settings sections are a register-class host extension. The driver performs
 * a reversible probe through the host-only settings facade: register a
 * uniquely named temporary section, list it, dispose it, then prove the same
 * namespace can be registered again (no residue).
 *
 * Publication is feature-level: register/list/section are live after the
 * reversible no-residue probe; subscribe stays degraded in P3 because the
 * probe does not own a real subscriber lifecycle.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '../../dsh-adapter/types.js'
import type { HostSettingsPort } from '../ports/settings.js'
import type { CapabilityLifecycle } from '../kernel/lifecycle.js'
import { lifecycleFromDetection } from '../kernel/lifecycle.js'
import type { Detection, DetectionEvidence } from './detection.js'
import type { UpstreamDriver, UpstreamDriverMount } from './driver.js'
import { getHostSettingsSections, type TuiSettingsSectionsHost } from '../../dsh-adapter/settings-sections.js'

const CAPABILITY = 'host.settings'
const SETTINGS_FEATURES = Object.freeze([
  'host.settings.register',
  'host.settings.list',
  'host.settings.section',
  'host.settings.subscribe',
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

type HostContext = Pick<Context, 'get'>

function settingsHost(ctx: unknown): TuiSettingsSectionsHost | undefined {
  const service = (ctx as HostContext | undefined)?.get?.('tuiSettingsSections')
  if (service === undefined) return undefined
  try {
    return getHostSettingsSections(service as never)
  } catch {
    return undefined
  }
}

function degradedFeature(capability: string, evidence: DetectionEvidence[], missing: string): CapabilityLifecycle {
  return lifecycleFromDetection(capability, {
    state: 'degraded',
    missing: [missing],
    evidence,
  })
}

function liveFeature(capability: string, evidence: DetectionEvidence[]): CapabilityLifecycle {
  return lifecycleFromDetection(capability, {
    state: 'supported',
    evidence,
  })
}

export function detectSettingsCapability(ctx: unknown): Detection {
  const service = (ctx as HostContext | undefined)?.get?.('tuiSettingsSections')
  if (service === undefined) {
    return { state: 'unsupported', reason: 'tuiSettingsSections service is not mounted' }
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiSettingsSections')]
  const host = settingsHost(ctx)
  if (host === undefined) {
    return { state: 'degraded', missing: ['tuiSettingsSections host facade'], evidence }
  }
  for (const method of ['register', 'list', 'subscribe'] as const) {
    if (typeof (host as unknown as Record<string, unknown>)[method] === 'function') {
      evidence.push(methodEvidence('tuiSettingsSections', method))
    } else {
      return { state: 'degraded', missing: [`tuiSettingsSections.${method}()`], evidence }
    }
  }
  return {
    state: 'supported',
    evidence: [...evidence, probeEvidence('tuiSettingsSections.host()', 'host settings facade is present')],
  }
}

export async function verifySettingsLiveForHost(
  host: TuiSettingsSectionsHost | undefined,
): Promise<CapabilityLifecycle[]> {
  const baseEvidence: DetectionEvidence[] = [serviceEvidence('tuiSettingsSections')]
  if (host === undefined) {
    return SETTINGS_FEATURES.map(feature => degradedFeature(feature, baseEvidence, `${feature}.live-probe`))
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiSettingsSections')]
  const missing: string[] = []
  const ns = `dsh_tui_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const section = {
    ns,
    title: 'dsh-tui reversible settings probe',
    fields: [],
  } as never
  let dispose: (() => void) | undefined
  let registerLive = false
  try {
    dispose = host.register(section)
    const listed = host.list()
    if (!Array.isArray(listed) || !listed.some(entry => (entry as { ns?: unknown }).ns === ns)) {
      missing.push('tuiSettingsSections.register/list()')
      throw new Error('temporary settings section was not visible through list()')
    }
    evidence.push(probeEvidence(`tuiSettingsSections.register+list(${ns})`, 'temporary settings section registered and listed'))
    const resolved = host.section(ns)
    if (resolved === undefined || (resolved as { ns?: unknown }).ns !== ns) {
      missing.push('tuiSettingsSections.section()')
      throw new Error('temporary settings section was not resolvable through section()')
    }
    evidence.push(probeEvidence(`tuiSettingsSections.section(${ns})`, 'temporary settings section resolvable by namespace'))
    dispose()
    dispose = undefined
    const second = host.register(section)
    second()
    evidence.push(probeEvidence(`tuiSettingsSections.dispose(${ns})`, 'temporary settings section removed; same ns re-register succeeded'))
    registerLive = true
  } catch (error) {
    missing.push('tuiSettingsSections.reversible-live-probe')
    evidence.push(probeEvidence('tuiSettingsSections.reversible-live-probe', errorText(error)))
  } finally {
    try {
      dispose?.()
    } catch {
      // Best-effort cleanup.
    }
  }

  const out: CapabilityLifecycle[] = []
  out.push(registerLive
    ? liveFeature('host.settings.register', evidence)
    : degradedFeature('host.settings.register', evidence, 'tuiSettingsSections.reversible-live-probe'))
  out.push(registerLive
    ? liveFeature('host.settings.list', [
        serviceEvidence('tuiSettingsSections'),
        methodEvidence('tuiSettingsSections', 'list'),
        probeEvidence('tuiSettingsSections.list()', 'temporary settings section visible through list()'),
      ])
    : degradedFeature('host.settings.list', [serviceEvidence('tuiSettingsSections'), methodEvidence('tuiSettingsSections', 'list')], 'tuiSettingsSections.list() live-probe'))
  out.push(registerLive
    ? liveFeature('host.settings.section', [
        serviceEvidence('tuiSettingsSections'),
        probeEvidence('tuiSettingsSections.section()', 'temporary settings section resolvable by namespace'),
      ])
    : degradedFeature('host.settings.section', [serviceEvidence('tuiSettingsSections')], 'tuiSettingsSections.section() live-probe'))
  out.push(degradedFeature('host.settings.subscribe', [serviceEvidence('tuiSettingsSections'), methodEvidence('tuiSettingsSections', 'subscribe')], 'host.settings.subscribe.live-probe'))
  return out
}

async function verifySettingsLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  return verifySettingsLiveForHost(settingsHost(ctx))
}

function createSettingsPort(host: TuiSettingsSectionsHost): HostSettingsPort {
  return Object.freeze({
    register: section => host.register(section as never),
    list: () => host.list() as never,
    section: ns => host.section(ns) as never,
    subscribe: listener => host.subscribe(listener),
  })
}

export const settingsDriver: UpstreamDriver = {
  id: 'dsh-tui-settings',
  upstreamFamily: 'dsh-tui',
  capability: 'host.settings',
  mountEffectClass: 'register',
  detect: detectSettingsCapability,
  verifyLive: verifySettingsLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    const host = settingsHost(context)
    const ports = host === undefined ? undefined : { settings: createSettingsPort(host) }
    return { disposer: () => undefined, ...(ports === undefined ? {} : { ports }) }
  },
}
