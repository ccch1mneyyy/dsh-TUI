/**
 * Upstream driver for the TUI side-panel capability (ctx.tuiPanels).
 *
 * Panels are a register-class capability. The driver performs a real
 * reversible probe through the host-only panels facade: register a uniquely
 * named temporary panel, list it, dispose it, then prove the same id can be
 * registered again (no residue). It never opens the panel during the probe,
 * so no visible UI mutation is caused.
 *
 * Publication is feature-level: register/list are live only after the
 * reversible no-residue probe; open/close/badge/subscribe are not safely
 * auto-verifiable and stay degraded.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '../../dsh-adapter/types.js'
import type { HostPanelsPort } from '../ports/panels.js'
import type { CapabilityLifecycle } from '../kernel/lifecycle.js'
import { lifecycleFromDetection } from '../kernel/lifecycle.js'
import type { Detection, DetectionEvidence } from './detection.js'
import type { UpstreamDriver, UpstreamDriverMount } from './driver.js'
import { getHostPanelRuntime, type TuiPanelHost } from '../../dsh-adapter/panels.js'

const CAPABILITY = 'host.panels'
const PANEL_FEATURES = Object.freeze([
  'host.panels.register',
  'host.panels.list',
  'host.panels.open',
  'host.panels.close',
  'host.panels.badge',
  'host.panels.subscribe',
] as const)

function serviceEvidence(id: string): DetectionEvidence {
  return { kind: 'service', id }
}

function methodEvidence(service: string, method: string): DetectionEvidence {
  return { kind: 'method', id: service + ':' + method }
}

function probeEvidence(id: string, detail: string): DetectionEvidence {
  return { kind: 'probe', id, detail }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type HostContext = Pick<Context, 'get'>

function panelHost(ctx: unknown): TuiPanelHost | undefined {
  const service = (ctx as HostContext | undefined)?.get?.('tuiPanels')
  if (service === undefined) return undefined
  try {
    return getHostPanelRuntime(service as never)
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

export function detectPanelsCapability(ctx: unknown): Detection {
  const service = (ctx as HostContext | undefined)?.get?.('tuiPanels')
  if (service === undefined) {
    return { state: 'unsupported', reason: 'tuiPanels service is not mounted' }
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiPanels')]
  const host = panelHost(ctx)
  if (host === undefined) {
    return { state: 'degraded', missing: ['tuiPanels host facade'], evidence }
  }
  const methods = ['register', 'list', 'open', 'close', 'subscribe'] as const
  for (const method of methods) {
    if (typeof (host as unknown as Record<string, unknown>)[method] === 'function') {
      evidence.push(methodEvidence('tuiPanels', method))
    } else {
      return { state: 'degraded', missing: ['tuiPanels.' + method + '()'], evidence }
    }
  }
  return { state: 'supported', evidence }
}

async function verifyPanelsLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const host = panelHost(ctx)
  const baseEvidence: DetectionEvidence[] = [serviceEvidence('tuiPanels')]
  if (host === undefined) {
    return PANEL_FEATURES.map(feature => degradedFeature(feature, baseEvidence, feature + '.live-probe'))
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiPanels')]
  const id = 'dsh_tui_probe:' + randomUUID().replace(/-/g, '').slice(0, 12)
  let dispose: (() => void) | undefined
  let registerLive = false
  try {
    dispose = host.register({ id, title: 'dsh-tui reversible panel probe' })
    const listed = host.list()
    if (!Array.isArray(listed) || !listed.some(panel => panel.id === id)) {
      throw new Error('temporary panel was not visible through list()')
    }
    evidence.push(probeEvidence('tuiPanels.register+dispose(' + id + ')', 'temporary panel registered and listed'))
    dispose()
    dispose = undefined
    // No-residue proof: the same id must be registrable again.
    const second = host.register({ id, title: 'dsh-tui reversible panel probe' })
    second()
    evidence.push(probeEvidence('tuiPanels.dispose(' + id + ')', 'temporary panel removed; same id re-register succeeded'))
    registerLive = true
  } catch (error) {
    evidence.push(probeEvidence('tuiPanels.reversible-live-probe', errorText(error)))
  } finally {
    try {
      dispose?.()
    } catch {
      // Best-effort cleanup.
    }
  }

  const out: CapabilityLifecycle[] = []
  out.push(registerLive
    ? liveFeature('host.panels.register', evidence)
    : degradedFeature('host.panels.register', evidence, 'tuiPanels.reversible-live-probe'))
  if (registerLive) {
    out.push(liveFeature('host.panels.list', [
      serviceEvidence('tuiPanels'),
      methodEvidence('tuiPanels', 'list'),
      probeEvidence('tuiPanels.list()', 'temporary panel visible through list()'),
    ]))
  } else {
    out.push(degradedFeature('host.panels.list', [serviceEvidence('tuiPanels'), methodEvidence('tuiPanels', 'list')], 'tuiPanels.list() live-probe'))
  }
  for (const feature of ['host.panels.open', 'host.panels.close', 'host.panels.badge', 'host.panels.subscribe'] as const) {
    out.push(degradedFeature(feature, [serviceEvidence('tuiPanels')], feature + '.live-probe'))
  }
  return out
}

function createPanelsPort(host: TuiPanelHost): HostPanelsPort {
  return Object.freeze({
    register: descriptor => host.register(descriptor),
    list: () => host.list(),
    open: id => host.open(id),
    close: id => host.close(id),
    subscribe: listener => host.subscribe(listener),
  })
}

export const panelsDriver: UpstreamDriver = {
  id: 'dsh-tui-panels',
  upstreamFamily: 'dsh-tui',
  capability: 'host.panels',
  mountEffectClass: 'register',
  detect: detectPanelsCapability,
  verifyLive: verifyPanelsLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    const host = panelHost(context)
    const ports = host === undefined ? undefined : { panels: createPanelsPort(host) }
    return { disposer: () => undefined, ...(ports === undefined ? {} : { ports }) }
  },
}
