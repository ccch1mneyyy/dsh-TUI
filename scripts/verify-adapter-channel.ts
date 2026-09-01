/**
 * P4 Channel split gate.
 *
 * Proves:
 * - the Channel is decomposed into projection/actions/state/plugins/transcript
 *   modules and those modules project the legacy Channel without leaking
 *   functions/secret values into snapshots;
 * - the production Channel driver is registered as a Kernel slice, mounted
 *   through KernelRuntime, and exposes a shadow-guarded HostChannelPort;
 * - passive-shadow allows read-only channel reads and denies channel
 *   mutations; new mode allows both;
 * - production TUI wiring actually calls `registerTuiChannel(ctx, channel)`.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-channel.ts`.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ADAPTER_KERNEL_SLICES } from '../src/adapter/kernel/slices/index.js'
import { KernelRuntime } from '../src/adapter/kernel/kernel-runtime.js'
import { registerTuiChannel } from '../src/adapter/channel/host-registry.js'
import {
  CHANNEL_FEATURES,
  CHANNEL_PORT_METHOD_CAPABILITIES,
  projectChannelRows,
  projectChannelSnapshot,
  projectChannelState,
  createChannelActions,
  createChannelPlugins,
  createChannelTranscript,
} from '../src/adapter/channel/index.js'
import { CHANNEL_SPLIT_TOKEN } from '../src/adapter/channel/internal-token.js'
import { verifyChannelLive } from '../src/adapter/upstream/channel-driver.js'
import { TuiPluginHostRuntime, getHostFacade } from '../src/dsh-adapter/plugin-host.js'

const ROOT = resolve(import.meta.dirname, '..')

function makeFakeChannel() {
  let notifyCount = 0
  return {
    version: 7,
    rows: [
      { id: 1, kind: 'user', text: 'hello' },
      { id: 2, kind: 'assistant', text: 'hi', streaming: false },
    ],
    status: 'idle',
    sessionTitle: 'workspace',
    sessionColor: '',
    agentId: 'session-1',
    agentBindingGeneration: 3,
    model: 'deepseek',
    provider: 'local',
    cwd: '/repo',
    displayCwd: '/repo',
    gitBranch: 'main',
    working: false,
    cancelPending: false,
    spinnerMode: 'idle',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 1,
    lastUserText: 'hello',
    notifications: [],
    contextWindow: 128_000,
    reasoningEffort: 'medium',
    effortLevels: ['low', 'medium'],
    lastUsage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    tps: 10,
    tpsSamples: [],
    workingActivity: undefined,
    activityFrames: 'claude',
    diffLayout: 'auto',
    thinkingFold: 'preview',
    toolBackground: 'none',
    scrollGutter: 'timeline',
    foldTerminalCommand: false,
    promptSessionLabel: false,
    expandEditor: true,
    statusBar: {},
    whale: true,
    minimal: false,
    activityEnabled: true,
    contextBarEnabled: true,
    goal: undefined,
    todos: [],
    loadedContext: undefined,
    pending: [],
    commandList: [{ name: 'help', description: 'show help' }],
    commandCompletions: () => [],
    runExternalCommand: async () => undefined,
    pluginScene: undefined,
    openPluginScene: () => false,
    closePluginScene: () => undefined,
    sideQuestion: async () => ({ answer: null }),
    contextSegments: { system: 1, prompt: 2, assistant: 3, thinking: 4, tools: 5 },
    subagents: [],
    subagentControl: { interrupt: () => false },
    subscribe: () => () => undefined,
    stageImage: async () => '',
    submit: () => undefined,
    steer: () => undefined,
    removePending: () => false,
    cancel: () => undefined,
    interruptAndDeliver: () => 0,
    rewindTo: async () => null,
    promptRewind: async () => null,
    buildSessionTree: async () => null,
    rewindToNode: async () => null,
    forkSession: async () => false,
    resumeTo: async () => ({ ok: true }),
    newSession: async () => false,
    listWorkspaces: async () => [],
    resolveWorkspace: async () => undefined,
    switchWorkspace: async () => false,
    renameWorkspace: async () => false,
    workspaceCommands: () => [],
    runWorkspaceCommand: async () => undefined,
    switchModel: async () => false,
    listEfforts: async () => ({ efforts: [], defaultEffort: undefined }),
    setEffort: async () => false,
    mode: { id: 'default' },
    modeIndex: 0,
    cycleMode: async () => undefined,
    permissionPresets: () => ({ availability: 'runtime', options: [] }),
    agentPreset: 'standard',
    listPresets: async () => [],
    switchPreset: async () => false,
    clear: () => undefined,
    loadOlder: () => 0,
    notify: () => {
      notifyCount += 1
      return () => undefined
    },
    setActivityFrames: () => false,
    listModels: async () => [],
    listProviders: async () => [],
    listSkills: async () => [],
    describeCredential: async () => undefined,
    balanceInfo: async () => ({ ok: true, balance: 0 }),
    providerSetup: () => undefined,
    oauthProviderStatuses: async () => undefined,
    settingsHost: () => undefined,
    settingsSections: () => [],
    subscribeSettingsSections: () => () => undefined,
    listFileCandidates: async () => [],
    listFiles: async () => [],
    listSessions: async () => [],
    previewSession: async () => [],
    setResumeTarget: () => undefined,
    renameSession: () => undefined,
    setSessionColor: () => undefined,
    recapRecent: async () => ({ summary: '' }),
    deleteSession: async () => false,
    renameSessionTo: async () => false,
    compact: () => undefined,
    pushLocal: () => undefined,
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    pluginsInfo: () => [],
    listSubagents: async () => [],
    releaseContributions: () => undefined,
    traceEvents: () => [],
    emit: () => undefined,
    emitStream: () => undefined,
  }
}

const ctx = new Context()
ctx.logger.warn = () => undefined
const childCtx = ctx.extend()
const channel = makeFakeChannel()
// Register through a child/plugin context on purpose: the registry must
// normalize to the composition root, otherwise the Kernel (which queries the
// root) would never see the Channel.
registerTuiChannel(childCtx, channel)

const projection = projectChannelSnapshot(channel as never)
assert.equal(projection.version, 7)
assert.equal(projection.rows.length, 2)
assert.equal(projection.rows[0]?.text, 'hello')
assert.equal(JSON.stringify(projection).includes('function'), false, 'projection must be JSON-safe')
const state = projectChannelState(channel as never)
assert.equal(state.agentId, 'session-1')
assert.equal(state.version, 7)

const actions = createChannelActions(channel as never, CHANNEL_SPLIT_TOKEN)
actions.submit('next')
const transcript = createChannelTranscript(channel as never, CHANNEL_SPLIT_TOKEN)
assert.equal(transcript.rows().length, 2)
assert.equal(transcript.traceEvents().length, 0)
const plugins = createChannelPlugins(channel as never, CHANNEL_SPLIT_TOKEN)
assert.equal(plugins.settingsSections().length, 0)
assert.equal(plugins.runExternalCommand('x', 'y') instanceof Promise, true)

// Channel slice/feature declarations must cover every HostChannelPort method.
const allChannelMethodCapabilities = new Set(
  Object.values(CHANNEL_PORT_METHOD_CAPABILITIES).flatMap(subPort => Object.values(subPort)),
)
assert.ok(CHANNEL_FEATURES.every(feature => allChannelMethodCapabilities.has(feature)),
  'channel feature list must be derived from the HostChannelPort method map')
assert.deepEqual(
  [...CHANNEL_FEATURES].sort(),
  [...allChannelMethodCapabilities].sort(),
  'channel feature list must not drift from the HostChannelPort method map',
)
const channelSlice = ADAPTER_KERNEL_SLICES.find(slice => slice.id === 'channel')!
assert.deepEqual(
  [...channelSlice.standardDeclarations].sort(),
  [...CHANNEL_FEATURES].sort(),
  'channel slice standardDeclarations must match CHANNEL_FEATURES',
)

// Kernel slice registration
assert.ok(ADAPTER_KERNEL_SLICES.some(slice => slice.id === 'channel'),
  'ADAPTER_KERNEL_SLICES must include the channel slice')

const kernel = new KernelRuntime({
  context: ctx,
  mode: 'new',
  generationId: 'channel-battery',
  kernelSlices: ADAPTER_KERNEL_SLICES,
  slices: ['channel'],
})
await kernel.refresh()
await kernel.mount()
const facade = kernel.facade()
assert.ok(facade.channel !== undefined, 'Kernel must mount the Channel Host Port')
assert.equal(facade.channel.projection.snapshot().rows.length, 2)
assert.equal(facade.channel.state.snapshot().agentId, 'session-1')
assert.equal(facade.channel.transcript.rows().length, 2)
facade.channel.actions.submit('guarded submit in new mode')
assert.equal(typeof facade.channel.plugins.runExternalCommand('name', 'raw').then, 'function')
kernel.dispose()

// Shadow policy: passive-shadow allows read-only channel reads, denies mutate.
const passive = new KernelRuntime({
  context: ctx,
  mode: 'passive-shadow',
  generationId: 'channel-passive-battery',
  kernelSlices: ADAPTER_KERNEL_SLICES,
  slices: ['channel'],
})
await passive.mount()
const passiveFacade = passive.facade()
assert.ok(passiveFacade.channel !== undefined)
assert.equal(passiveFacade.channel.projection.snapshot().rows.length, 2, 'read-only channel reads are allowed in passive-shadow')
assert.throws(
  () => passiveFacade.channel.actions.submit('must be denied'),
  /shadow policy denies/u,
  'channel mutations must be denied in passive-shadow',
)
passive.dispose()

// trace-events must be truly probed: a throwing traceEvents() must degrade,
// not be promoted live merely because the method exists.
{
  const badChannel = makeFakeChannel()
  badChannel.traceEvents = () => { throw new Error('trace-events probe failed') }
  const badCtx = new Context()
  badCtx.logger.warn = () => undefined
  registerTuiChannel(badCtx, badChannel)
  const lifecycles = await verifyChannelLive(badCtx)
  const traceLifecycle = lifecycles.find(lifecycle => lifecycle.capability === 'host.channel.transcript.trace-events')
  assert.ok(traceLifecycle !== undefined)
  assert.equal(traceLifecycle.state, 'degraded',
    'a throwing traceEvents() must not be promoted to live')
  assert.match(traceLifecycle.detection.missing?.[0] ?? '', /trace-events probe failed/u)
}

// Real production assembly: mount the actual TuiPluginHostRuntime, register
// the live Channel through a child context after the Kernel has started, and
// verify the production getHostFacade()/Kernel can read the Channel Port.
{
  const previousMode = process.env.DSH_TUI_ADAPTER_MODE
  process.env.DSH_TUI_ADAPTER_MODE = 'new'
  try {
    const integrationCtx = new Context()
    integrationCtx.logger.warn = () => undefined
    new TuiPluginHostRuntime(integrationCtx)
    await new Promise(resolve => setTimeout(resolve, 30))
    const integrationChild = integrationCtx.extend()
    registerTuiChannel(integrationChild, channel)
    await new Promise(resolve => setTimeout(resolve, 60))
    const host = integrationCtx.get('tuiPluginHost')
    assert.ok(host !== undefined, 'real TuiPluginHostRuntime must be mounted')
    const productionFacade = getHostFacade(host)
    assert.ok(productionFacade !== undefined, 'production getHostFacade must return a facade')
    assert.ok(productionFacade.channel !== undefined,
      'production Kernel must read the Channel registered through a child context')
    assert.equal(productionFacade.channel.projection.snapshot().rows.length, 2)
    assert.equal(productionFacade.channel.state.snapshot().agentId, 'session-1')
    assert.equal(productionFacade.channel.transcript.traceEvents().length, 0)
  } finally {
    if (previousMode === undefined) delete process.env.DSH_TUI_ADAPTER_MODE
    else process.env.DSH_TUI_ADAPTER_MODE = previousMode
  }
}

// Production wiring: the TUI plugin registers the live Channel normalized to
// the composition root for the adapter Kernel.
const pluginSource = readFileSync(resolve(ROOT, 'src/dsh-adapter/plugin.ts'), 'utf8')
assert.ok(pluginSource.includes('registerTuiChannel(compositionRoot(ctx), channel)'),
  'production plugin.ts must register the live Channel through the composition root')
const registrySource = readFileSync(resolve(ROOT, 'src/adapter/channel/host-registry.ts'), 'utf8')
assert.ok(registrySource.includes("compositionRoot(ctx as never)"),
  'host-registry must normalize callers to the composition root')
const hostFacadeSource = readFileSync(resolve(ROOT, 'src/adapter/kernel/host-facade.ts'), 'utf8')
assert.ok(hostFacadeSource.includes('channel?: HostChannelPort'),
  'HostFacade must expose the Channel Port')

console.log('verify:adapter-channel OK (channel split, Kernel mounting, real trace probe, production root wiring)')
