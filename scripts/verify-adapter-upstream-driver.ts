/**
 * Runtime verification for the real upstream host-descriptor driver.
 *
 * Proves:
 * - detect() returns structured Detection, not a boolean;
 * - service existence and method availability are distinguished from a real
 *   read-only probe;
 * - Host Descriptor lifecycles from the driver start as `staged`;
 * - only probe-verified lifecycles cross `verifyAndPromote` to `live`;
 * - DecisionEvents are feature-split according to the probed event set and
 *   never fall back to the full vocab;
 * - a real guard-only host (no channel/dispatch topology) publishes no
 *   DecisionEvents at all.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-upstream-driver.ts`.
 */
import assert from 'node:assert/strict'
import {
  buildHostCapabilityLifecycles,
  detectHostDescriptorCapability,
  hostDescriptorDriver,
} from '../src/adapter/upstream/host-descriptor-driver.js'
import { verifyAndPromote } from '../src/adapter/kernel/lifecycle.js'
import { buildHostDescriptorFromLifecycles } from '../src/adapter/standard/descriptor.js'
import { TUI_DECISION_EVENT_NAMES } from '../src/adapter/standard/tui-extension.js'

const describeResult = {
  descriptor: { contracts: [] },
  dropped: [],
  warnings: [],
}

const noHost = { get: () => undefined }

const serviceOnlyHost = {
  get(name: string) {
    if (name === 'tuiPluginHost') return { hostDescriptor: () => describeResult }
    if (name === 'commands') return { register: () => () => undefined }
    if (name === 'tuiPluginStorage') return { open: () => undefined }
    if (name === 'tuiMessageObserver') return { subscribe: () => () => undefined }
    return undefined
  },
}

const fullHost = {
  get(name: string) {
    if (name === 'tuiPluginHost') {
      return {
        hostDescriptor: () => describeResult,
        describe: () => describeResult,
        subscribeDecision: () => () => undefined,
        probeDecisionEvents: () => [...TUI_DECISION_EVENT_NAMES],
      }
    }
    if (name === 'commands') {
      return {
        register: () => () => undefined,
        list: () => Object.freeze([]),
      }
    }
    if (name === 'tuiPluginStorage') {
      return {
        open: () => undefined,
        probeDiagnostic: () => ({ service: 'tuiPluginStorage', ok: true, dir: '' }),
      }
    }
    if (name === 'tuiMessageObserver') {
      return {
        subscribe: () => () => undefined,
        probeDiagnostic: () => ({ service: 'tuiMessageObserver', ok: true, subscriptions: 0 }),
      }
    }
    return undefined
  },
}

let checks = 0
const ok = (name: string, fn: () => void) => {
  checks += 1
  try {
    fn()
  } catch (error) {
    console.error(`verify:adapter-upstream-driver FAILED: ${name}`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

ok('detect returns unsupported with reason when host service is absent', () => {
  const detection = detectHostDescriptorCapability(noHost)
  assert.equal(detection.state, 'unsupported')
  assert.equal(typeof detection.reason, 'string')
})

ok('detect distinguishes service presence from method availability', () => {
  const detection = detectHostDescriptorCapability(serviceOnlyHost)
  assert.equal(detection.state, 'degraded')
  assert.equal(detection.missing.includes('describe()'), true)
  assert.ok(detection.evidence?.some(evidence => evidence.kind === 'service'))
})

ok('detect returns supported only after a read-only probe succeeds', () => {
  const detection = detectHostDescriptorCapability(fullHost)
  assert.equal(detection.state, 'supported')
  assert.ok(detection.evidence.some(evidence => evidence.kind === 'method'))
  assert.ok(detection.evidence.some(evidence => evidence.kind === 'probe'))
})

ok('driver object has a stable id/capability', () => {
  assert.equal(hostDescriptorDriver.id, 'dsh-tui-host-descriptor')
  assert.equal(hostDescriptorDriver.capability, 'host.descriptor')
})

ok('buildHostCapabilityLifecycles keeps Command/Storage/Message non-live without real operational probes', () => {
  const lifecycles = buildHostCapabilityLifecycles(fullHost)
  assert.ok(lifecycles.length > 0)
  const command = lifecycles.find(lifecycle => lifecycle.capability.endsWith('#Command'))
  const storage = lifecycles.find(lifecycle => lifecycle.capability.endsWith('#LocalStorage'))
  const messages = lifecycles.find(lifecycle => lifecycle.capability.endsWith('#MessageObserver'))
  assert.ok(command !== undefined && command.state === 'degraded', `Command should be degraded, got ${command?.state}`)
  assert.ok(storage !== undefined && storage.state === 'degraded', `Storage should be degraded, got ${storage?.state}`)
  assert.ok(messages !== undefined && messages.state === 'degraded', `MessageObserver should be degraded, got ${messages?.state}`)
  assert.equal(lifecycles.some(lifecycle =>
    lifecycle.detection.state === 'supported' && lifecycle.detection.evidence.some(evidence => evidence.kind === 'probe')),
    true)
  const promoted = lifecycles.map(verifyAndPromote)
  // Only DecisionEvents has a real per-feature read-only probe in this driver.
  assert.equal(promoted.filter(lifecycle => lifecycle.state === 'live').length, 1)
  assert.equal(promoted.filter(lifecycle => lifecycle.capability.endsWith('#Command')).every(lifecycle => lifecycle.state !== 'live'), true)
})

ok('service-only lifecycle cannot be verified to live', () => {
  const lifecycles = buildHostCapabilityLifecycles(serviceOnlyHost)
  const promoted = lifecycles.map(verifyAndPromote)
  assert.equal(promoted.some(lifecycle => lifecycle.state === 'live'), false)
})

ok('DecisionEvents are split into liveFeatures from the probe', () => {
  const partialHost = {
    get(name: string) {
      const wrapped = fullHost.get(name)
      if (name === 'tuiPluginHost' && wrapped) {
        return {
          ...wrapped,
          probeDecisionEvents: () => ['tui/input'],
        }
      }
      return wrapped
    },
  }
  const lifecycles = buildHostCapabilityLifecycles(partialHost)
  const decision = lifecycles.find(lifecycle => lifecycle.capability.endsWith('#DecisionEvents'))
  assert.ok(decision !== undefined)
  assert.equal(decision.state, 'degraded')
  assert.deepEqual([...decision.liveFeatures ?? []], ['tui/input'])
})

ok('DecisionEvents never fall back to the full event vocabulary', () => {
  const decision = buildHostCapabilityLifecycles(fullHost)
    .find(lifecycle => lifecycle.capability.endsWith('#DecisionEvents'))
  assert.ok(decision !== undefined)
  assert.deepEqual([...decision.liveFeatures ?? []].sort(), [...TUI_DECISION_EVENT_NAMES].sort())
})

ok('DecisionEvents with real channel/probe but no subscribeDecision is not published', () => {
  const missingSubscribeHost = {
    get(name: string) {
      if (name === 'tuiPluginHost') {
        return {
          hostDescriptor: () => describeResult,
          describe: () => describeResult,
          probeDecisionEvents: () => [...TUI_DECISION_EVENT_NAMES],
        }
      }
      return fullHost.get(name)
    },
  }
  const lifecycles = buildHostCapabilityLifecycles(missingSubscribeHost)
  const decision = lifecycles.find(lifecycle => lifecycle.capability.endsWith('#DecisionEvents'))
  assert.ok(decision !== undefined)
  assert.equal(decision.state, 'degraded')
  assert.equal(decision.liveFeatures?.length ?? 0, 0, 'no live features when subscribeDecision is missing')
  const promoted = lifecycles.map(verifyAndPromote)
  const build = buildHostDescriptorFromLifecycles(promoted, { generationId: 'missing-subscribe-driver-battery' })
  assert.equal(build.descriptor.contracts.some(contract => contract.kind === 'DecisionEvents'), false,
    `public descriptor must not publish DecisionEvents without subscribeDecision, got ${JSON.stringify(build.descriptor.contracts.map(contract => contract.kind))}`)
})

// Real production negative: mounting the plugin-host row installs the
// DecisionEvents guard, but without a channel/dispatch topology the public
// Host Descriptor must not publish any DecisionEvents feature.
await (async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
  const root = new Context()
  root.logger.warn = () => undefined
  root.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
  await new Promise(resolve => setTimeout(resolve, 30))
  const host = root.get('tuiPluginHost')
  assert.ok(host !== undefined)
  const descriptor = host.hostDescriptor()
  assert.equal(descriptor.contracts.some(contract => contract.kind === 'DecisionEvents'), false,
    `guard-only composition must not publish DecisionEvents, got ${JSON.stringify(descriptor.contracts.map(contract => contract.kind))}`)
})()

console.log(`verify:adapter-upstream-driver OK (${checks + 1} runtime checks)`)
