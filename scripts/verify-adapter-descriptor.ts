/**
 * Host Descriptor live-publication gate.
 *
 * Proves the hard rule from the design:
 * - only probe-verified `live` lifecycle evidence is published;
 * - `method`/`service` evidence alone cannot cross the publication barrier;
 * - a `degraded` capability is never published as a whole supported contract;
 * - DecisionEvents live features come only from explicit feature-level
 *   evidence with a real dispatch/channel topology, never from a default
 *   full event vocabulary or guard installation alone.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-descriptor.ts`.
 */
import assert from 'node:assert/strict'
import {
  canPublishAsLive,
  lifecycleFromDetection,
  promoteToLive,
  verifyAndPromote,
} from '../src/adapter/kernel/lifecycle.js'
import { buildHostDescriptor, buildHostDescriptorFromLifecycles } from '../src/adapter/standard/descriptor.js'

const COMMAND = { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' }
const STORAGE = { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' }
const DECISION = { apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' }

const commandKey = `${COMMAND.apiVersion}#${COMMAND.kind}`
const storageKey = `${STORAGE.apiVersion}#${STORAGE.kind}`
const decisionKey = `${DECISION.apiVersion}#${DECISION.kind}`

const liveCommand = promoteToLive(lifecycleFromDetection(
  commandKey,
  {
    state: 'supported',
    evidence: [
      { kind: 'service', id: 'commands' },
      { kind: 'method', id: 'commands.execute' },
      { kind: 'probe', id: 'commands.execute(undefined)', detail: 'real command execution probe' },
    ],
  },
  COMMAND,
))

const catalogOnlyCommand = promoteToLive(lifecycleFromDetection(
  commandKey,
  {
    state: 'supported',
    evidence: [
      { kind: 'service', id: 'commands' },
      { kind: 'method', id: 'commands.list' },
      { kind: 'probe', id: 'commands.list(undefined)', detail: 'read-only command catalog probe' },
    ],
  },
  COMMAND,
))

const degradedStorage = lifecycleFromDetection(
  storageKey,
  { state: 'degraded', missing: ['write'] },
  STORAGE,
)

const liveDecision = {
  ...promoteToLive(lifecycleFromDetection(
    decisionKey,
    {
      state: 'supported',
      evidence: [
        { kind: 'service', id: 'tuiPluginHost' },
        { kind: 'method', id: 'tuiPluginHost.subscribeDecision' },
        { kind: 'probe', id: 'tuiPluginHost.probeDecisionEvents', detail: 'verified all decision events' },
      ],
    },
    DECISION,
  )),
  liveFeatures: Object.freeze(['tui/compact', 'tui/input', 'tui/rewind-done', 'tui/rewind-prompt', 'tui/session-switch', 'tui/session-switched']),
}

const splitDecision = {
  ...lifecycleFromDetection(
    decisionKey,
    {
      state: 'degraded',
      missing: ['tui/session-switch'],
      evidence: [
        { kind: 'method', id: 'tuiPluginHost.subscribeDecision' },
        { kind: 'probe', id: 'tuiPluginHost.probeDecisionEvents' },
      ],
    },
    DECISION,
  ),
  liveFeatures: Object.freeze(['tui/input', 'tui/compact']),
}

const missingSubscribeSplit = {
  ...lifecycleFromDetection(
    decisionKey,
    {
      state: 'degraded',
      missing: ['tuiPluginHost.subscribeDecision()', 'tui/session-switch'],
      evidence: [
        { kind: 'service', id: 'tuiPluginHost' },
        { kind: 'probe', id: 'tuiPluginHost.probeDecisionEvents', detail: 'real channel/probe exists but subscription entry is missing' },
      ],
    },
    DECISION,
  ),
  liveFeatures: Object.freeze(['tui/input', 'tui/compact']),
}

const methodOnlyCommand = lifecycleFromDetection(
  commandKey,
  { state: 'supported', evidence: [{ kind: 'service', id: 'commands' }, { kind: 'method', id: 'commands.list' }] },
  COMMAND,
)

let checks = 0
const ok = (name: string, fn: () => void) => {
  checks += 1
  try {
    fn()
  } catch (error) {
    console.error(`verify:adapter-descriptor FAILED: ${name}`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

ok('degraded cannot be published as live', () => {
  assert.equal(canPublishAsLive(liveCommand), true)
  assert.equal(canPublishAsLive(degradedStorage), false)
})

ok('descriptor publishes only probe-verified live lifecycles; degraded is dropped whole', () => {
  const build = buildHostDescriptorFromLifecycles(
    [liveCommand, degradedStorage, liveDecision],
    { generationId: 'descriptor-live-battery', headless: true },
  )
  const keys = build.descriptor.contracts.map(contract => `${contract.apiVersion}#${contract.kind}`)
  assert.ok(keys.includes(commandKey), `live Command should be published, got ${keys.join(',')}`)
  assert.ok(keys.includes(decisionKey), 'live DecisionEvents should be published')
  assert.ok(!keys.includes(storageKey), 'degraded LocalStorage must NOT be published as whole supported')
  assert.ok(build.dropped.includes(storageKey), `degraded should be recorded in dropped, got ${build.dropped.join(',')}`)
  assert.ok(build.warnings.some(warning => warning.includes('degraded')), 'degraded publication should warn')
})

ok('method-only and catalog-only live lifecycles are refused by the descriptor', () => {
  const methodBuild = buildHostDescriptorFromLifecycles(
    [promoteToLive(methodOnlyCommand)],
    { generationId: 'descriptor-methodonly-battery' },
  )
  assert.equal(methodBuild.descriptor.contracts.length, 0)
  assert.ok(methodBuild.dropped.includes(commandKey), 'method-only contract should be dropped')
  const catalogBuild = buildHostDescriptorFromLifecycles(
    [catalogOnlyCommand],
    { generationId: 'descriptor-catalogonly-battery' },
  )
  assert.equal(catalogBuild.descriptor.contracts.length, 0)
  assert.ok(catalogBuild.dropped.includes(commandKey), 'catalog-only Command must not be published as full support')
  assert.ok(catalogBuild.warnings.some(warning => warning.includes('publishable real capability probe')), catalogBuild.warnings.join(' | '))
})

ok('degraded DecisionEvents can be published as feature-level split evidence', () => {
  const build = buildHostDescriptorFromLifecycles(
    [splitDecision],
    { generationId: 'descriptor-split-battery' },
  )
  const decision = build.descriptor.contracts.find(contract => contract.kind === 'DecisionEvents')
  assert.ok(decision !== undefined, 'split DecisionEvents should publish feature-level contract')
  const spec = decision?.spec as { features?: readonly string[] } | undefined
  assert.deepEqual(spec?.features, ['tui/compact', 'tui/input'])
  assert.ok(!build.dropped.includes(decisionKey))
  assert.ok(build.warnings.some(warning => warning.includes('split into live feature-level')))
})

ok('degraded DecisionEvents with features but no probe evidence is not published', () => {
  const noProbeSplit = {
    ...lifecycleFromDetection(
      decisionKey,
      { state: 'degraded', missing: ['tui/session-switch'], evidence: [{ kind: 'method', id: 'tuiPluginHost.probeDecisionEvents' }] },
      DECISION,
    ),
    liveFeatures: Object.freeze(['tui/input', 'tui/compact']),
  }
  const build = buildHostDescriptorFromLifecycles(
    [noProbeSplit],
    { generationId: 'descriptor-no-probe-split-battery' },
  )
  assert.equal(build.descriptor.contracts.length, 0)
  assert.ok(build.dropped.includes(decisionKey), 'feature split without real probe must be dropped')
  assert.ok(build.warnings.some(warning => warning.includes('without a real probe')), build.warnings.join(' | '))
})

ok('degraded DecisionEvents with real probe but missing subscribeDecision is not published', () => {
  const build = buildHostDescriptorFromLifecycles(
    [missingSubscribeSplit],
    { generationId: 'descriptor-missing-subscribe-battery' },
  )
  assert.equal(build.descriptor.contracts.length, 0)
  assert.ok(build.dropped.includes(decisionKey), 'DecisionEvents with channel/probe but no subscribeDecision must be dropped')
  assert.ok(build.warnings.some(warning => warning.includes('subscribeDecision')), build.warnings.join(' | '))
})

ok('live DecisionEvents without verified features is not published', () => {
  const noFeatureLive = promoteToLive(lifecycleFromDetection(
    decisionKey,
    { state: 'supported', evidence: [{ kind: 'probe', id: 'probe' }] },
    DECISION,
  ))
  const build = buildHostDescriptorFromLifecycles([noFeatureLive], { generationId: 'descriptor-no-feature-battery' })
  assert.equal(build.descriptor.contracts.length, 0)
  assert.ok(build.dropped.includes(decisionKey))
})

ok('a build without lifecycles/legacy mode does not fall back to full support', () => {
  const build = buildHostDescriptor({ generationId: 'no-fallback-battery' })
  assert.equal(build.descriptor.contracts.length, 0)
  assert.ok(build.warnings.some(warning => warning.includes('no live lifecycle evidence')), build.warnings.join(' | '))
})

ok('verifyAndPromote refuses service/method-only staged evidence', () => {
  const serviceStaged = lifecycleFromDetection(
    'commands.dsh/v1alpha1#Command',
    { state: 'supported', evidence: [{ kind: 'service', id: 'commands' }] },
    COMMAND,
  )
  assert.equal(verifyAndPromote(serviceStaged).state, 'staged')
  assert.equal(verifyAndPromote(methodOnlyCommand).state, 'staged')
  assert.equal(verifyAndPromote(liveCommand).state, 'live')
})

// Real negative: a composition with only the plugin-host row (guard installed,
// but no channel/dispatch topology) must not publish DecisionEvents in the
// public Host Descriptor.
await (async () => {
  checks += 1
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
    const root = new Context()
    root.logger.warn = () => undefined
    root.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
    await new Promise(resolve => setTimeout(resolve, 30))
    const descriptor = root.get('tuiPluginHost')?.hostDescriptor()
    assert.ok(descriptor !== undefined)
    assert.ok(!descriptor.contracts.some(contract => contract.kind === 'DecisionEvents'),
      `guard-only host should not publish DecisionEvents: ${JSON.stringify(descriptor.contracts.map(contract => contract.kind))}`)
  } catch (error) {
    console.error('verify:adapter-descriptor FAILED: guard-only real host publishes no DecisionEvents')
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})()

// Default-legacy real regression: with all real services mounted, the legacy
// compatibility path must describe Command / LocalStorage / MessageObserver
// and admit a plugin requiring them, without starting the new Kernel or running
// reversible probes.
await (async () => {
  checks += 1
  try {
    const previousMode = process.env.DSH_TUI_ADAPTER_MODE
    process.env.DSH_TUI_ADAPTER_MODE = 'legacy'
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: CommandRuntime } = await import('@deepseek-ai/dsh-commands')
    const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
    const { mountAdmitted, testManifest, COMMAND_COORDINATE, STORAGE_COORDINATE, MESSAGE_COORDINATE } = await import('../scripts/lib/plugin-test-utils.js')

    const legacyRoot = new Context()
    legacyRoot.logger.warn = () => undefined
    legacyRoot.plugin(CommandRuntime)
    await new Promise(resolve => setTimeout(resolve, 30))
    legacyRoot.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
    await new Promise(resolve => setTimeout(resolve, 50))

    const legacyHost = legacyRoot.get('tuiPluginHost')
    assert.ok(legacyHost !== undefined, 'legacy full host must mount tuiPluginHost')
    const legacyBuild = legacyHost.describe()
    const legacyKinds = legacyBuild.descriptor.contracts.map(contract => contract.kind)
    assert.ok(legacyKinds.includes('Command'), `legacy descriptor must publish Command, got ${legacyKinds.join(',')}`)
    assert.ok(legacyKinds.includes('LocalStorage'), `legacy descriptor must publish LocalStorage, got ${legacyKinds.join(',')}`)
    assert.ok(legacyKinds.includes('MessageObserver'), `legacy descriptor must publish MessageObserver, got ${legacyKinds.join(',')}`)
    assert.ok(legacyBuild.warnings.some(warning => warning.includes('legacy compatibility descriptor')),
      'legacy descriptor must be explicitly marked as a legacy compatibility declaration')

    const admitted = await mountAdmitted(
      legacyRoot,
      'legacy-full-plugin',
      testManifest({
        id: 'com.example.legacy-full',
        requires: [COMMAND_COORDINATE, STORAGE_COORDINATE, MESSAGE_COORDINATE],
      }),
      'test:legacy-full/dsh-plugin.json',
      { activationId: 'legacy-full-act' },
    )
    assert.ok(admitted.context !== undefined)
    await Promise.resolve(admitted.fiber.dispose())

    if (previousMode === undefined) delete process.env.DSH_TUI_ADAPTER_MODE
    else process.env.DSH_TUI_ADAPTER_MODE = previousMode
  } catch (error) {
    console.error('verify:adapter-descriptor FAILED: default legacy full-service regression')
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})()

// Full production composition must not publish legacy contracts in a shadow
// mode, or while a new-mode refresh is pending/failed. Inject only the refresh
// boundary for the two new-mode failure scenarios; all services are real.
{
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: CommandRuntime } = await import('@deepseek-ai/dsh-commands')
  const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
  const { KernelRuntime } = await import('../src/adapter/kernel/kernel-runtime.js')
  const { hostDescriptorDriver } = await import('../src/adapter/upstream/host-descriptor-driver.js')
  const previousMode = process.env.DSH_TUI_ADAPTER_MODE
  const originalRefresh = KernelRuntime.prototype.refresh
  const originalVerifier = hostDescriptorDriver.verifyLive
  for (const scenario of ['passive-shadow', 'replay-shadow', 'new-pending', 'new-failed', 'new-completed']) {
    const root = new Context()
    root.logger.warn = () => undefined
    let releaseRefresh: (() => void) | undefined
    let kernel: InstanceType<typeof KernelRuntime> | undefined
    const fibers: { dispose(): unknown }[] = []
    try {
      process.env.DSH_TUI_ADAPTER_MODE = scenario.startsWith('new-') ? 'new' : scenario
      const pending = scenario === 'new-pending'
        ? new Promise<void>(resolve => { releaseRefresh = resolve })
        : Promise.resolve()
      KernelRuntime.prototype.refresh = async function (options) {
        kernel = this
        await pending
        return originalRefresh.call(this, options)
      }
      if (scenario === 'new-failed') {
        hostDescriptorDriver.verifyLive = async () => { throw new Error('injected verifier failure') }
      }
      fibers.push(root.plugin(CommandRuntime))
      await new Promise(resolve => setTimeout(resolve, 30))
      const fiber = root.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
      fibers.push(fiber)
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(root.get('commands') && root.get('tuiPluginStorage') && root.get('tuiMessageObserver'),
        `${scenario}: full legacy-capable topology must be mounted`)
      const host = root.get('tuiPluginHost')!
      const assertNoLegacy = () => {
        const build = host.describe()
        assert.deepEqual(build.descriptor.contracts, [], `${scenario}: no unprobed contracts`)
        assert.deepEqual(host.hostDescriptor().contracts, [])
        assert.ok(!build.warnings.some(warning => warning.includes('legacy compatibility descriptor')),
          `${scenario}: must not enter the legacy publication path`)
      }
      if (scenario === 'new-failed' || scenario === 'new-completed') {
        const expected = scenario === 'new-failed' ? 'failed' : 'completed'
        const deadline = Date.now() + 5000
        while (kernel?.refreshStatus() !== expected && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.equal(kernel?.refreshStatus(), expected, `${scenario}: exercise real refresh state`)
      }
      if (scenario === 'new-completed') {
        assert.ok(host.describe().descriptor.contracts.some(contract => contract.kind === 'LocalStorage'),
          'completed live verification must publish before disposal')
      } else {
        assertNoLegacy()
        // Changing process env later cannot relax the captured composition mode.
        process.env.DSH_TUI_ADAPTER_MODE = 'legacy'
        assertNoLegacy()
      }
      await Promise.resolve(fiber.dispose())
      // A retained service reference after Kernel disposal stays fail-closed,
      // even if it previously published or an in-flight refresh later resumes.
      assertNoLegacy()
      releaseRefresh?.()
      await new Promise(resolve => setTimeout(resolve, 10))
      assertNoLegacy()
      checks += 1
    } finally {
      releaseRefresh?.()
      KernelRuntime.prototype.refresh = originalRefresh
      hostDescriptorDriver.verifyLive = originalVerifier
      for (const fiber of fibers.reverse()) await Promise.resolve(fiber.dispose())
      if (previousMode === undefined) delete process.env.DSH_TUI_ADAPTER_MODE
      else process.env.DSH_TUI_ADAPTER_MODE = previousMode
    }
  }
}

console.log(`verify:adapter-descriptor OK (${checks} runtime checks)`)
