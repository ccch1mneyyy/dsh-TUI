/**
 * P2 live-probe gate.
 *
 * Proves:
 * - the production driver's async verify path actually promotes Command /
 *   LocalStorage / MessageObserver to `live` when real reversible probes
 *   succeed (using an isolated replay/mock context, not a real host);
 * - every live capability carries `probe` evidence (not service/method only);
 * - Command probe evidence proves a real execute round-trip, not just a
 *   catalog read;
 * - malformed replay input fails closed.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-live-probes.ts`.
 */
import assert from 'node:assert/strict'
import { runReplayShadow, ReplayHarnessError } from '../src/adapter/kernel/replay.js'
import type { ReplayInput } from '../src/adapter/kernel/replay.js'

const input: ReplayInput = Object.freeze({
  schemaVersion: 'tui-adapter-replay/v1',
  generationId: 'live-probe-battery',
  commands: Object.freeze([Object.freeze({ name: 'replay-command', description: 'replay command' })]),
  storage: true,
  messages: true,
  decisionEvents: Object.freeze(['tui/input', 'tui/compact']),
  host: Object.freeze({
    legacyContracts: Object.freeze([
      Object.freeze({ apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' }),
      Object.freeze({ apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' }),
      Object.freeze({ apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver' }),
      Object.freeze({ apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' }),
    ]),
  }),
})

async function main(): Promise<void> {
  let checks = 0
  const report = await runReplayShadow(input)
  checks += 1
  assert.equal(report.ok, true)
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.extra, [])
  assert.ok(report.matched.includes('commands.dsh/v1alpha1#Command'))
  assert.ok(report.matched.includes('storage.dsh/v1alpha1#LocalStorage'))
  assert.ok(report.matched.includes('messages.dsh/v1alpha1#MessageObserver'))

  const command = report.lifecycles.find(lifecycle => lifecycle.capability.endsWith('#Command'))
  checks += 1
  assert.ok(command !== undefined)
  assert.equal(command.state, 'live')
  const commandProbe = command.detection.state === 'supported' || command.detection.state === 'degraded'
    ? command.detection.evidence.find(item => item.kind === 'probe')
    : undefined
  assert.ok(commandProbe !== undefined, 'Command must carry probe evidence')
  assert.ok(/(?:execute|invoke)/u.test(commandProbe!.id), `Command probe must verify execute, got ${commandProbe!.id}`)

  const storage = report.lifecycles.find(lifecycle => lifecycle.capability.endsWith('#LocalStorage'))
  checks += 1
  assert.ok(storage !== undefined)
  assert.equal(storage.state, 'live')
  const storageProbe = storage.detection.state === 'supported' || storage.detection.state === 'degraded'
    ? storage.detection.evidence.find(item => item.kind === 'probe' && !item.id.includes('probeDiagnostic'))
    : undefined
  assert.ok(storageProbe !== undefined, 'LocalStorage must carry a real storage probe, not just probeDiagnostic')

  const messages = report.lifecycles.find(lifecycle => lifecycle.capability.endsWith('#MessageObserver'))
  checks += 1
  assert.ok(messages !== undefined)
  assert.equal(messages.state, 'live')
  const messageProbe = messages.detection.state === 'supported' || messages.detection.state === 'degraded'
    ? messages.detection.evidence.find(item => item.kind === 'probe' && !item.id.includes('probeDiagnostic'))
    : undefined
  assert.ok(messageProbe !== undefined, 'MessageObserver must carry a real subscription probe, not just probeDiagnostic')

  checks += 1
  await assert.rejects(
    runReplayShadow({ schemaVersion: 'wrong', commands: [] } as never),
    (error: unknown) => error instanceof ReplayHarnessError,
  )

  // Real/minimal real service integration: instantiate the actual storage and
  // message observer services on an isolated Cordis context and run the same
  // driver refresh path used by production. This proves the probe succeeds
  // only when the real service can perform the operation and leaves no
  // persistent probe artifact behind.
  const { existsSync, mkdtempSync, readdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Context } = await import('@deepseek-ai/cordis')
  const { TuiPluginStorageRuntime } = await import('../src/dsh-adapter/plugin-storage.js')
  const { TuiMessageObserverRuntime } = await import('../src/dsh-adapter/message-observer.js')
  const { refreshHostCapabilityLifecycles } = await import('../src/adapter/upstream/host-descriptor-driver.js')
  const { verifyAndPromote } = await import('../src/adapter/kernel/lifecycle.js')
  const hostProbeAccess = await import('../src/adapter/kernel/host-probe-access.js')
  const { runStorageLiveProbe, runMessageLiveProbe } = hostProbeAccess

  const tempRoot = mkdtempSync(join(tmpdir(), 'adapter-live-probe-'))
  const storageDir = join(tempRoot, 'plugin-storage')
  const realCtx = new Context()
  realCtx.logger.warn = () => undefined
  new TuiPluginStorageRuntime(realCtx, { dir: storageDir })
  new TuiMessageObserverRuntime(realCtx)
  const realLifecycles = (await refreshHostCapabilityLifecycles(realCtx)).map(verifyAndPromote)

  const realStorage = realLifecycles.find(lifecycle => lifecycle.capability.endsWith('#LocalStorage'))
  checks += 1
  assert.ok(realStorage !== undefined)
  assert.equal(realStorage.state, 'live', 'real storage reversible probe should promote LocalStorage to live')
  const realStorageProbe = realStorage.detection.state === 'supported' || realStorage.detection.state === 'degraded'
    ? realStorage.detection.evidence.find(item => item.kind === 'probe' && !item.id.includes('probeDiagnostic'))
    : undefined
  assert.ok(realStorageProbe !== undefined, 'real LocalStorage must carry a non-diagnostic probe')

  const realStorageService = realCtx.get('tuiPluginStorage') as { probeReversible?: unknown } | undefined
  checks += 1
  assert.equal(typeof realStorageService?.probeReversible, 'undefined',
    'tuiPluginStorage must not expose probeReversible on the plugin-visible service')
  checks += 1
  await assert.rejects(
    runStorageLiveProbe(realStorageService, 'forged-token'),
    /host-only live probe access denied/u,
  )


  const realMessagesService = realCtx.get('tuiMessageObserver') as { probeReversible?: unknown } | undefined
  checks += 1
  assert.equal(typeof realMessagesService?.probeReversible, 'undefined',
    'tuiMessageObserver must not expose probeReversible on the plugin-visible service')
  checks += 1
  await assert.rejects(
    runMessageLiveProbe(realMessagesService, 'forged-token'),
    /host-only live probe access denied/u,
  )


  const realMessages = realLifecycles.find(lifecycle => lifecycle.capability.endsWith('#MessageObserver'))
  checks += 1
  assert.ok(realMessages !== undefined)
  assert.equal(realMessages.state, 'live', 'real message reversible probe should promote MessageObserver to live')
  const realMessageProbe = realMessages.detection.state === 'supported' || realMessages.detection.state === 'degraded'
    ? realMessages.detection.evidence.find(item => item.kind === 'probe' && !item.id.includes('probeDiagnostic'))
    : undefined
  assert.ok(realMessageProbe !== undefined, 'real MessageObserver must carry a delivery probe')

  checks += 1
  assert.ok(!existsSync(storageDir) || readdirSync(storageDir).length === 0,
    'storage live probe must not leave namespace files or a newly-created directory after success')

  // Real host-mediated command probe must remain reachable through the
  // host-only accessor while staying hidden from the plugin-visible service.
  {
    const { TuiPluginHostRuntime } = await import('../src/dsh-adapter/plugin-host.js')
    const { default: CommandRuntime } = await import('@deepseek-ai/dsh-commands')
    const { runCommandLiveProbe } = await import('../src/adapter/kernel/host-probe-access.js')
    const commandCtx = new Context()
    commandCtx.logger.warn = () => undefined
    commandCtx.plugin(CommandRuntime)
    await new Promise(resolve => setTimeout(resolve, 30))
    new TuiPluginHostRuntime(commandCtx)
    const hostService = commandCtx.get('tuiPluginHost') as { probeCommandReversible?: unknown } | undefined
    checks += 1
    assert.ok(hostService !== undefined)
    assert.equal(typeof hostService?.probeCommandReversible, 'undefined',
      'tuiPluginHost must not expose probeCommandReversible on the plugin-visible service')
    checks += 1
    await assert.rejects(
      runCommandLiveProbe(hostService, 'forged-token'),
      /host-only live probe access denied/u,
    )
    const realCommand = await runCommandLiveProbe(hostService)
    checks += 1
    assert.equal(realCommand.ok, true)
    assert.equal(realCommand.lifecycleAppends >= 1, true, 'real command probe should record in-memory lifecycle appends')
    // The host token is intentionally module-local. It must not be part of the
    // internal module's public export surface, so an absolute-path importer
    // cannot copy the token out of the module.
    checks += 1
    assert.equal('HOST_PROBE_TOKEN' in hostProbeAccess, false,
      'host probe token must not be exported from the internal access module')
    // Bootstrapped host runners cannot be replaced by a later in-process
    // importer: re-registering a forged runner is a no-op, and the real
    // host-mediated probe still runs the genuine private method.
    const { registerCommandLiveProbe } = await import('../src/adapter/kernel/host-probe-access.js')
    registerCommandLiveProbe(hostService, async () => Object.freeze({ ok: true, name: 'forged', lifecycleAppends: 0 }))
    const stillReal = await runCommandLiveProbe(hostService)
    checks += 1
    assert.equal(stillReal.name !== 'forged', true, 'host runner must not be overwritten by an in-process re-registration')
  }

  // Ordinary package deep imports are blocked by the exports map. This is the
  // documented public API boundary; the same-process absolute-path route is a
  // trusted-in-process boundary, not a security sandbox.
  {
    const packageJsonUrl = new URL('../package.json', import.meta.url)
    const packedManifest = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(packageJsonUrl, 'utf8')))
    checks += 1
    assert.ok(packedManifest.exports !== undefined)
    assert.equal(
      Object.keys(packedManifest.exports).some(key => key.includes('lib/') || key.includes('src/') || key.includes('*')),
      false,
      'package exports must not expose internal lib/src deep paths',
    )
    let deepResolutionError: unknown
    try {
      import.meta.resolve('@deepseek-harness-tui/dsh-tui/lib/adapter/kernel/host-probe-access.js')
    } catch (error) {
      deepResolutionError = error
    }
    checks += 1
    assert.ok(deepResolutionError !== undefined, 'ordinary deep import of host-probe-access must be rejected by package exports')
  }

  // Host-mediated command probe must also abort and clean up when execute
  // rejects before the timeout. This exercises TuiPluginHostRuntime's private
  // probe directly through the host accessor.
  {
    const { Service } = await import('@deepseek-ai/cordis')
    const { TuiPluginHostRuntime } = await import('../src/dsh-adapter/plugin-host.js')
    const { runCommandLiveProbe } = await import('../src/adapter/kernel/host-probe-access.js')
    const signals: AbortSignal[] = []
    const registeredNames = new Set<string>()
    let hostDisposeCalls = 0
    class EarlyRejectCommands extends Service {
      constructor(ctx: InstanceType<typeof Context>) {
        super(ctx, 'commands')
      }
      register(definition: { name: string }) {
        registeredNames.add(definition.name)
        return () => {
          registeredNames.delete(definition.name)
          hostDisposeCalls += 1
        }
      }
      find(_agent: unknown, name: string) {
        return registeredNames.has(name) ? {} : undefined
      }
      list() {
        return Object.freeze([...registeredNames].map(name => ({ name })))
      }
      execute(
        _agent: unknown,
        _line: string,
        _images: readonly unknown[],
        signal: AbortSignal,
      ) {
        signals.push(signal)
        return Promise.reject(new Error('host-mediated early rejection'))
      }
    }
    const earlyHostCtx = new Context()
    earlyHostCtx.logger.warn = () => undefined
    earlyHostCtx.plugin(EarlyRejectCommands)
    await new Promise(resolve => setTimeout(resolve, 30))
    new TuiPluginHostRuntime(earlyHostCtx)
    const earlyHost = earlyHostCtx.get('tuiPluginHost')
    checks += 1
    await assert.rejects(
      runCommandLiveProbe(earlyHost),
      /early rejection/u,
    )
    checks += 1
    assert.equal(hostDisposeCalls, 1, 'host-mediated early rejection must dispose the temporary command')
    checks += 1
    assert.equal(signals[0]?.aborted, true,
      'host-mediated early rejection must abort the underlying execute AbortSignal')
  }

  // Command fallback path must time out, clean up the temporary command, and
  // return failure evidence instead of leaking a registration forever.
  {
    const registered = new Map<string, unknown>()
    let disposeCalls = 0
    const commandSignals: AbortSignal[] = []
    const hangingCommands = Object.freeze({
      register(definition: { name: string }) {
        registered.set(definition.name, definition)
        return () => {
          disposeCalls += 1
          registered.delete(definition.name)
        }
      },
      list: () => Object.freeze([...registered.values()]),
      find: (_agent: unknown, name: string) => registered.get(name),
      execute: (_agent: unknown, _line: string, _images: readonly unknown[], signal: AbortSignal) => {
        commandSignals.push(signal)
        return new Promise<never>(() => undefined)
      },
    })
    const fallbackContext = Object.freeze({
      get(name: string) {
        if (name === 'commands') return hangingCommands
        if (name === 'tuiPluginHost') return Object.freeze({})
        return undefined
      },
    })
    const hungLifecycles = await refreshHostCapabilityLifecycles(fallbackContext)
    const hungCommand = hungLifecycles.find(lifecycle => lifecycle.capability.endsWith('#Command'))
    checks += 1
    assert.ok(hungCommand !== undefined)
    assert.equal(hungCommand.state, 'degraded', 'hanging command fallback must fail closed')
    assert.ok(hungCommand.detection.state === 'degraded'
      && (hungCommand.detection.missing ?? []).includes('commands.reversible-live-probe'),
      `hanging command fallback missing evidence: ${JSON.stringify(hungCommand.detection)}`)
    checks += 1
    assert.equal(disposeCalls, 1, 'fallback command timeout must dispose the temporary registration')
    assert.equal(registered.size, 0, 'fallback command timeout must remove the temporary command')
    checks += 1
    assert.equal(commandSignals[0]?.aborted, true,
      'command fallback timeout must abort the underlying execute AbortSignal')
  }

  // Command fallback must also clean up when execute rejects early: the timer is
  // cleared in `finally`, the temporary command is disposed, and the signal is
  // aborted so the underlying call cannot keep running.
  {
    const registered = new Map<string, unknown>()
    let disposeCalls = 0
    const earlySignals: AbortSignal[] = []
    const earlyCommands = Object.freeze({
      register(definition: { name: string }) {
        registered.set(definition.name, definition)
        return () => {
          disposeCalls += 1
          registered.delete(definition.name)
        }
      },
      list: () => Object.freeze([...registered.values()]),
      find: (_agent: unknown, name: string) => registered.get(name),
      execute: (_agent: unknown, _line: string, _images: readonly unknown[], signal: AbortSignal) => {
        earlySignals.push(signal)
        return Promise.reject(new Error('early execute rejection'))
      },
    })
    const earlyContext = Object.freeze({
      get(name: string) {
        if (name === 'commands') return earlyCommands
        if (name === 'tuiPluginHost') return Object.freeze({})
        return undefined
      },
    })
    const earlyLifecycles = await refreshHostCapabilityLifecycles(earlyContext)
    const earlyCommand = earlyLifecycles.find(lifecycle => lifecycle.capability.endsWith('#Command'))
    checks += 1
    assert.ok(earlyCommand !== undefined)
    assert.equal(earlyCommand.state, 'degraded', 'early-rejecting command fallback must fail closed')
    checks += 1
    assert.equal(disposeCalls, 1, 'early-rejecting command fallback must dispose the temporary registration')
    assert.equal(registered.size, 0, 'early-rejecting command fallback must remove the temporary command')
    checks += 1
    assert.equal(earlySignals[0]?.aborted, true,
      'early-rejecting command fallback must abort the underlying execute AbortSignal')
  }

  // P3: real read-only/register-class reversible live probes over the actual
  // host seam services. The probes use a unique temporary id, verify it is
  // visible, dispose it, and prove no residue remains. Publication is
  // feature-level: only the methods actually verified are promoted to live;
  // interactive/mutating methods stay degraded.
  {
    const { Context } = await import('@deepseek-ai/cordis')
    const { TuiSceneRuntime } = await import('../src/dsh-adapter/scenes.js')
    const { TuiSettingsSectionsRuntime } = await import('../src/dsh-adapter/settings-sections.js')
    const { TuiStatusRuntime } = await import('../src/dsh-adapter/status.js')
    const { TuiShortcutRuntime } = await import('../src/dsh-adapter/shortcuts.js')
    const { TuiRendererRuntime } = await import('../src/dsh-adapter/renderers.js')
    const { TuiThemeRuntime } = await import('../src/dsh-adapter/themes.js')
    const { TuiToastRuntime } = await import('../src/dsh-adapter/toast.js')
    const { TuiCommandTreeRuntime } = await import('../src/dsh-adapter/command-trees.js')
    const { TuiWorkspaceRuntime } = await import('../src/dsh-adapter/workspaces.js')
    const {
      workspaceDriver,
      scenesDriver,
      settingsDriver,
      presentationDriver,
      decisionsDriver,
    } = await import('../src/adapter/upstream/index.js')
    const {
      statusDriver,
      shortcutsDriver,
      renderersDriver,
      themesDriver,
      toastDriver,
      commandTreesDriver,
    } = await import('../src/adapter/upstream/extensions-driver.js')
    const { verifyAndPromote } = await import('../src/adapter/kernel/lifecycle.js')
    const { createShadowGuardedHostFacade } = await import('../src/adapter/kernel/host-facade.js')

    const p3Ctx = new Context()
    p3Ctx.logger.warn = () => undefined
    new TuiSceneRuntime(p3Ctx)
    new TuiSettingsSectionsRuntime(p3Ctx)
    new TuiStatusRuntime(p3Ctx)
    new TuiShortcutRuntime(p3Ctx)
    new TuiRendererRuntime(p3Ctx)
    new TuiThemeRuntime(p3Ctx)
    new TuiToastRuntime(p3Ctx)
    new TuiCommandTreeRuntime(p3Ctx)
    new TuiWorkspaceRuntime(p3Ctx)

    const driverCases: Array<[string, typeof workspaceDriver, readonly string[], readonly string[]]> = [
      ['workspace', workspaceDriver,
        ['host.workspaces.list', 'host.workspaces.resolve', 'host.workspaces.describe', 'host.workspaces.commands'],
        ['host.workspaces.commandShell', 'host.workspaces.rename', 'host.workspaces.runCommand']],
      ['scenes', scenesDriver, ['host.scenes.register', 'host.scenes.list'],
        ['host.scenes.open', 'host.scenes.close', 'host.scenes.active', 'host.scenes.subscribe']],
      ['settings', settingsDriver, ['host.settings.register', 'host.settings.list', 'host.settings.section'],
        ['host.settings.subscribe']],
      ['status', statusDriver, ['host.status.set', 'host.status.snapshot'],
        ['host.status.subscribe']],
      ['shortcuts', shortcutsDriver, ['host.shortcuts.register', 'host.shortcuts.list'],
        ['host.shortcuts.dispatch']],
      ['renderers', renderersDriver, ['host.renderers.register', 'host.renderers.render'], []],
      ['themes', themesDriver, ['host.themes.register', 'host.themes.snapshot', 'host.themes.resolver'],
        ['host.themes.subscribe']],
      ['toast', toastDriver, [], ['host.toast.show']],
      ['commandTrees', commandTreesDriver, ['host.command-trees.register', 'host.command-trees.children'],
        ['host.command-trees.descriptions']],
    ]
    for (const [name, driver, expectedLive, expectedDegraded] of driverCases) {
      const lifecycles = (await driver.verifyLive!(p3Ctx)).map(verifyAndPromote)
      const byFeature = new Map(lifecycles.map(lifecycle => [lifecycle.capability, lifecycle]))
      for (const feature of expectedLive) {
        const lifecycle = byFeature.get(feature)
        checks += 1
        assert.ok(lifecycle !== undefined, `${name} must return feature ${feature}`)
        assert.equal(lifecycle!.state, 'live', `${name} feature ${feature} must promote to live`)
        const detection = lifecycle!.detection
        if (detection.state === 'supported' || detection.state === 'degraded') {
          assert.ok(detection.evidence.some(item => item.kind === 'probe'), `${name} feature ${feature} must carry probe evidence`)
        }
      }
      for (const feature of expectedDegraded) {
        const lifecycle = byFeature.get(feature)
        checks += 1
        assert.ok(lifecycle !== undefined, `${name} must return degraded feature ${feature}`)
        assert.notEqual(lifecycle!.state, 'live', `${name} unverified feature ${feature} must not be live`)
      }
    }

    // M1 negative: if settings section lookup is not actually verified, the
    // section feature must not be promoted to live even when register/list
    // succeed. This prevents a name-only "section live" claim.
    {
      const { verifySettingsLiveForHost } = await import('../src/adapter/upstream/settings-driver.js')
      const registered: Array<{ ns: string }> = []
      const badSettingsHost = {
        register(section: { ns: string }) {
          registered.push(section)
          return () => {
            const index = registered.findIndex(entry => entry.ns === section.ns)
            if (index >= 0) registered.splice(index, 1)
          }
        },
        list: () => registered,
        section: () => undefined,
        subscribe: () => () => undefined,
      }
      const badSettings = (await verifySettingsLiveForHost(badSettingsHost)).map(verifyAndPromote)
      const badSection = badSettings.find(lifecycle => lifecycle.capability === 'host.settings.section')
      checks += 1
      assert.ok(badSection !== undefined, 'settings negative must still produce a section feature')
      assert.notEqual(badSection!.state, 'live', 'settings section must not be live when section() returns undefined')
      const badRegister = badSettings.find(lifecycle => lifecycle.capability === 'host.settings.register')
      assert.ok(badRegister !== undefined)
      assert.notEqual(badRegister!.state, 'live', 'settings register must not be live when the full reversible section probe fails')
    }

    // Interactive presentation: never fake live.
    const presentation = (await presentationDriver.verifyLive!(p3Ctx)).map(verifyAndPromote)
    checks += 1
    assert.ok(presentation[0] !== undefined)
    assert.notEqual(presentation[0]!.state, 'live', 'presentation must not be promoted to live without a reversible interaction probe')
    assert.ok(presentation[0]!.detection.state === 'degraded' || presentation[0]!.detection.state === 'unsupported')

    // M1: presentation.ask is bridged to the real QuestionStore (not a
    // throw-only empty shell); approval remains explicitly staged.
    {
      const { QuestionStore, bindQuestionStore } = await import('../src/dsh-adapter/questions.js')
      const { ApprovalStore, bindApprovalStore } = await import('../src/dsh-adapter/approvals.js')
      const questionStore = new QuestionStore()
      bindQuestionStore(p3Ctx, questionStore)
      bindApprovalStore(p3Ctx, new ApprovalStore())
      const mountedPresentation = await presentationDriver.mount(p3Ctx)
      const presentationPort = mountedPresentation.ports?.presentation as {
        ask(request: { title: string; questions: Array<{ id: string; question: string; options?: string[] }> }): Promise<{ answers: Array<{ selected: string[] }> }>
        approve(request: { toolName: string }): Promise<unknown>
      } | undefined
      assert.ok(presentationPort !== undefined)
      const askPromise = presentationPort.ask({
        title: 'probe',
        questions: [{ id: 'q1', question: 'ready?', options: ['yes', 'no'] }],
      })
      const snapshot = questionStore.getSnapshot()
      assert.ok(snapshot !== null, 'presentation.ask must park a real QuestionStore request')
      questionStore.answerCurrent({ selected: ['yes'] })
      const answer = await askPromise
      checks += 1
      assert.deepEqual(answer.answers[0]?.selected ?? [], ['yes'])
      await assert.rejects(
        presentationPort.approve({ toolName: 'x' }),
        /staged/u,
      )
      checks += 1
    }

    // H4: status clearIf failure must be reported as degraded, never live.
    {
      const statusService = p3Ctx.get('tuiStatus') as { [key: string]: unknown }
      const { getHostStatusStore } = await import('../src/dsh-adapter/status.js')
      const store = getHostStatusStore(statusService as never) as {
        clearIf(key: string, token: number): boolean
      } | undefined
      assert.ok(store !== undefined)
      const originalClearIf = store.clearIf.bind(store)
      store.clearIf = (() => false) as typeof store.clearIf
      try {
        const badStatus = (await statusDriver.verifyLive!(p3Ctx)).map(verifyAndPromote)
        const setFeature = badStatus.find(lifecycle => lifecycle.capability === 'host.status.set')
        checks += 1
        assert.ok(setFeature !== undefined)
        assert.notEqual(setFeature!.state, 'live', 'status live probe with clearIf failure must not be live')
        assert.equal(setFeature!.detection.state, 'degraded')
      } finally {
        store.clearIf = originalClearIf
      }
    }

    // M2: toast live probe uses an independent probe-only sink and never
    // replaces or swallows the production sink.
    {
      const { getHostToastStore } = await import('../src/dsh-adapter/toast.js')
      const toastService = p3Ctx.get('tuiToast') as { [key: string]: unknown }
      const store = getHostToastStore(toastService as never) as {
        setSink(sink: (delivery: unknown) => void): void
        deliver(delivery: unknown): boolean
        addProbeSink(sink: (delivery: unknown) => void): () => void
        deliverProbe(delivery: unknown): boolean
      } | undefined
      assert.ok(store !== undefined)
      let productionDeliveries = 0
      let probeDeliveries = 0
      store.setSink(() => { productionDeliveries += 1 })
      const removeProbe = store.addProbeSink(() => { probeDeliveries += 1 })
      checks += 1
      assert.equal(store.deliverProbe({ text: 'probe', timeoutMs: 500 }), true)
      assert.equal(probeDeliveries, 1)
      assert.equal(productionDeliveries, 0, 'probe-only delivery must not invoke the production sink')
      // A concurrent production toast while the probe is installed is not swallowed.
      checks += 1
      assert.equal(store.deliver({ text: 'production', timeoutMs: 500 }), true)
      assert.equal(productionDeliveries, 1)
      assert.equal(probeDeliveries, 1)
      removeProbe()
      checks += 1
      assert.equal(store.deliverProbe({ text: 'after-removal', timeoutMs: 500 }), false)
      assert.equal(probeDeliveries, 1, 'removed probe sink must not receive further delivery')

      // H2: per-method shadow guards on mounted Host Ports. Passive shadow
      // must deny mutate/register/subscribe methods even when a fake port is
      // handed to the facade wrapper; read-only methods may run.
      const calls: string[] = []
      const guarded = createShadowGuardedHostFacade({
        descriptor: {
          generationId: 'passive-port-battery',
          snapshot() {
            return {
              hostId: 'test',
              hostVersion: 'test',
              generationId: 'passive-port-battery',
              contracts: [],
              dropped: [],
              warnings: [],
            }
          },
        },
        workspace: {
          list: async () => { calls.push('workspace.list'); return [] },
          resolve: async () => { calls.push('workspace.resolve'); return undefined },
          describe: () => { calls.push('workspace.describe'); return undefined as never },
          commandShell: async () => { calls.push('workspace.commandShell'); return undefined },
          rename: async () => { calls.push('workspace.rename'); return undefined as never },
          commands: () => { calls.push('workspace.commands'); return [] },
          runCommand: async () => { calls.push('workspace.runCommand'); return undefined },
        } as never,
        scenes: {
          register: () => { calls.push('scenes.register'); return () => undefined },
          list: () => { calls.push('scenes.list'); return [] },
          open: () => { calls.push('scenes.open'); return false },
          close: () => { calls.push('scenes.close') },
          get active() { return undefined },
          subscribe: () => { calls.push('scenes.subscribe'); return () => undefined },
        } as never,
        settings: {
          register: () => { calls.push('settings.register'); return () => undefined },
          list: () => { calls.push('settings.list'); return [] },
          section: () => { calls.push('settings.section'); return undefined },
          subscribe: () => { calls.push('settings.subscribe'); return () => undefined },
        } as never,
        status: {
          set: () => { calls.push('status.set'); return () => undefined },
          snapshot: () => { calls.push('status.snapshot'); return [] },
          subscribe: () => { calls.push('status.subscribe'); return () => undefined },
        } as never,
        shortcuts: {
          register: () => { calls.push('shortcuts.register'); return () => undefined },
          list: () => { calls.push('shortcuts.list'); return [] },
          dispatch: () => { calls.push('shortcuts.dispatch'); return false },
        } as never,
        renderers: {
          register: () => { calls.push('renderers.register'); return () => undefined },
          render: () => { calls.push('renderers.render'); return undefined },
        } as never,
        themes: {
          register: () => { calls.push('themes.register'); return () => undefined },
          snapshot: () => { calls.push('themes.snapshot'); return [] },
          resolve: () => { calls.push('themes.resolve'); return undefined },
          subscribe: () => { calls.push('themes.subscribe'); return () => undefined },
        } as never,
        toast: {
          show: () => { calls.push('toast.show'); return false },
        } as never,
        commandTrees: {
          register: () => { calls.push('commandTrees.register'); return () => undefined },
          children: () => { calls.push('commandTrees.children'); return [] },
          descriptions: () => { calls.push('commandTrees.descriptions'); return undefined },
        } as never,
      }, 'passive-shadow')
      // Read-only methods are allowed in passive shadow.
      await guarded.workspace!.list(process.cwd())
      await guarded.workspace!.resolve(process.cwd())
      assert.equal(calls.includes('workspace.list'), true)
      assert.equal(calls.includes('workspace.resolve'), true)
      // Effectful methods are denied before the underlying implementation runs.
      assert.throws(() => { void guarded.workspace!.rename('x', 'y') }, /shadow policy denies/)
      assert.throws(() => { void guarded.workspace!.runCommand('x', 'y', 'z') }, /shadow policy denies/)
      assert.throws(() => { void guarded.workspace!.commandShell(process.cwd()) }, /shadow policy denies/)
      assert.throws(() => guarded.scenes!.open('x'), /shadow policy denies/)
      assert.throws(() => guarded.scenes!.subscribe(() => undefined), /shadow policy denies/)
      assert.throws(() => guarded.settings!.subscribe(() => undefined), /shadow policy denies/)
      assert.throws(() => guarded.shortcuts!.register('a', { description: 'x', handler: () => undefined }), /shadow policy denies/)
      assert.throws(() => guarded.renderers!.register('x', () => undefined), /shadow policy denies/)
      assert.throws(() => guarded.themes!.register({ name: 'x', base: 'dark' }), /shadow policy denies/)
      assert.throws(() => guarded.toast!.show({ text: 'x', timeoutMs: 500 }), /shadow policy denies/)
      assert.throws(() => guarded.commandTrees!.register({ root: 'x', children: () => [] }), /shadow policy denies/)
      assert.equal(calls.includes('workspace.rename'), false)
      assert.equal(calls.includes('workspace.runCommand'), false)
      assert.equal(calls.includes('workspace.commandShell'), false)
      assert.equal(calls.includes('scenes.open'), false)
      assert.equal(calls.includes('settings.subscribe'), false)
      assert.equal(calls.includes('shortcuts.register'), false)
      checks += 1
    }

    // M6: DecisionEvents real host composition (plugin-host row + real
    // dispatch topology marker), not a fake object-only battery.
    {
      const { TuiPluginHostRuntime } = await import('../src/dsh-adapter/plugin-host.js')
      const { markDecisionDispatchTopology, unmarkDecisionDispatchTopology } = await import('../src/dsh-adapter/decision-guard.js')
      const decisionCtx = new Context()
      decisionCtx.logger.warn = () => undefined
      decisionCtx.plugin({ name: 'dsh-tui-plugin-host', apply: (c: InstanceType<typeof Context>) => {
        new TuiPluginHostRuntime(c)
      } })
      await new Promise(resolve => setTimeout(resolve, 30))
      const decisionHost = decisionCtx.get('tuiPluginHost')
      assert.ok(decisionHost !== undefined)
      const unmark = markDecisionDispatchTopology(decisionCtx, ['tui/input'])
      const decisionLive = (await decisionsDriver.verifyLive!(decisionCtx)).map(verifyAndPromote)
      checks += 1
      assert.equal(decisionLive[0]?.state, 'live', 'real host + channel topology decision probe should promote to live')
      unmark()
      const decisionAfter = (await decisionsDriver.verifyLive!(decisionCtx)).map(verifyAndPromote)
      checks += 1
      assert.notEqual(decisionAfter[0]?.state, 'live', 'real host without topology must not promote decision to live')
      unmarkDecisionDispatchTopology(decisionCtx, ['tui/input'])
    }

    // DecisionEvents fake-host negative is retained for fail-closed behavior,
    // but it is now clearly a contract-level supplement, not real-live proof.
    {
      const decisionGood = {
        get(name: string) {
          if (name === 'tuiPluginHost') {
            return {
              probeDecisionEvents: () => ['tui/input'],
              subscribeDecision: () => () => undefined,
            }
          }
          return undefined
        },
      }
      const decisionLive = (await decisionsDriver.verifyLive!(decisionGood)).map(verifyAndPromote)
      checks += 1
      assert.equal(decisionLive[0]?.state, 'live', 'contract-level decision read-only dispatch probe should promote to live when topology exists')
      const decisionBad = {
        get(name: string) {
          if (name === 'tuiPluginHost') {
            return {
              probeDecisionEvents: () => [],
              subscribeDecision: () => () => undefined,
            }
          }
          return undefined
        },
      }
      const decisionDegraded = (await decisionsDriver.verifyLive!(decisionBad)).map(verifyAndPromote)
      checks += 1
      assert.notEqual(decisionDegraded[0]?.state, 'live', 'decision with no dispatch topology must not be live')
    }

    // Negative: without the service mounted, register/read-only drivers must
    // not claim live on an empty context.
    const emptyCtx = { get: () => undefined }
    for (const [name, driver] of [['scenes', scenesDriver], ['settings', settingsDriver], ['workspace', workspaceDriver]] as const) {
      const negative = (await driver.verifyLive!(emptyCtx)).map(verifyAndPromote)
      checks += 1
      assert.equal(negative.every(lifecycle => lifecycle.state !== 'live'), true,
        `${name} must not be live without a mounted service`)
    }
  }

  rmSync(tempRoot, { recursive: true, force: true })

  console.log(`verify:adapter-live-probes OK (${checks} runtime checks)`)
}

main().catch(error => {
  console.error('verify:adapter-live-probes FAILED')
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
