/**
 * Upstream driver for the TUI DecisionEvents capability.
 *
 * The read-only dispatch-topology probe is real: it asks the host which
 * decision event names are actually dispatched in this composition. The
 * subscribe path is intentionally kept staged on the internal Host Port
 * because plugin-side subscriptions must go through the mediated
 * DecisionEvents API (which derives owner from the Cordis activation); the
 * driver never fabricates a live subscribe probe.
 */

import type { Context } from '../../dsh-adapter/types.js'
import type { HostDecisionsPort } from '../ports/decisions.js'
import type { CapabilityLifecycle } from '../kernel/lifecycle.js'
import { lifecycleFromDetection } from '../kernel/lifecycle.js'
import type { Detection, DetectionEvidence } from './detection.js'
import type { UpstreamDriver, UpstreamDriverMount } from './driver.js'
import { KERNEL_TUI_DECISION_EVENT_NAMES as TUI_DECISION_EVENT_NAMES } from '../kernel/contract-catalog.js'

const CAPABILITY = 'host.decisions'

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

function decisionHost(ctx: unknown): unknown {
  return (ctx as HostContext | undefined)?.get?.('tuiPluginHost')
}

export function detectDecisionsCapability(ctx: unknown): Detection {
  const host = decisionHost(ctx)
  if (host === undefined) {
    return { state: 'unsupported', reason: 'tuiPluginHost service is not mounted' }
  }
  const evidence: DetectionEvidence[] = [serviceEvidence('tuiPluginHost')]
  if (typeof (host as Record<string, unknown>).probeDecisionEvents === 'function') {
    evidence.push(methodEvidence('tuiPluginHost', 'probeDecisionEvents'))
  } else {
    return { state: 'degraded', missing: ['tuiPluginHost.probeDecisionEvents()'], evidence }
  }
  if (typeof (host as Record<string, unknown>).subscribeDecision === 'function') {
    evidence.push(methodEvidence('tuiPluginHost', 'subscribeDecision'))
  } else {
    return {
      state: 'degraded',
      missing: ['tuiPluginHost.subscribeDecision()'],
      evidence,
    }
  }
  try {
    const available = (host as { probeDecisionEvents(): readonly string[] }).probeDecisionEvents()
    if (!Array.isArray(available)) throw new Error('probeDecisionEvents() did not return an array')
    if (available.length === 0) {
      return {
        state: 'degraded',
        missing: ['decision-dispatch-topology'],
        evidence: [
          ...evidence,
          probeEvidence('tuiPluginHost.probeDecisionEvents()', 'no decision dispatch topology is currently mounted'),
        ],
      }
    }
    return {
      state: 'supported',
      evidence: [
        ...evidence,
        probeEvidence('tuiPluginHost.probeDecisionEvents()', `verified ${available.length}/${TUI_DECISION_EVENT_NAMES.length} decision events`),
      ],
    }
  } catch (error) {
    return {
      state: 'degraded',
      missing: ['tuiPluginHost.probeDecisionEvents()'],
      evidence: [...evidence, probeEvidence('tuiPluginHost.probeDecisionEvents()', errorText(error))],
    }
  }
}

async function verifyDecisionsLive(ctx: unknown): Promise<CapabilityLifecycle[]> {
  const detection = detectDecisionsCapability(ctx)
  if (detection.state !== 'supported') {
    return TUI_DECISION_EVENT_NAMES.map(event => lifecycleFromDetection(
      `host.decisions.event:${event}`,
      {
        state: 'degraded',
        missing: ['decision-dispatch-topology'],
        evidence: [serviceEvidence('tuiPluginHost')],
      },
    ))
  }
  const host = decisionHost(ctx)
  const available = (host as { probeDecisionEvents(): readonly string[] }).probeDecisionEvents()
  return TUI_DECISION_EVENT_NAMES.map(event => {
    const verified = Array.isArray(available) && available.includes(event)
    const feature = `host.decisions.event:${event}`
    return verified
      ? lifecycleFromDetection(feature, {
          state: 'supported',
          evidence: [
            serviceEvidence('tuiPluginHost'),
            probeEvidence(`decision:${event}`, `real dispatch topology verified for ${event}`),
          ],
        })
      : lifecycleFromDetection(feature, {
          state: 'degraded',
          missing: [`decision-event:${event}`],
          evidence: [serviceEvidence('tuiPluginHost')],
        })
  })
}

function createDecisionsPort(ctx: unknown): HostDecisionsPort {
  const host = decisionHost(ctx)
  return Object.freeze({
    probe() {
      if (host === undefined) return []
      try {
        return [...(host as { probeDecisionEvents(): readonly string[] }).probeDecisionEvents()]
      } catch {
        return []
      }
    },
    subscribe() {
      throw new Error('dsh-tui: host.decisions.subscribe is staged; plugin subscriptions must use the mediated DecisionEvents API')
    },
  })
}

export const decisionsDriver: UpstreamDriver = {
  id: 'dsh-tui-decisions',
  upstreamFamily: 'dsh-tui',
  capability: 'host.decisions',
  mountEffectClass: 'read-only',
  detect: detectDecisionsCapability,
  verifyLive: verifyDecisionsLive,
  async mount(context: unknown): Promise<UpstreamDriverMount> {
    return {
      disposer: () => undefined,
      ports: { decisions: createDecisionsPort(context) },
    }
  },
}
