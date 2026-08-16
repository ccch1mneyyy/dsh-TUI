/**
 * Channel-level regression for toggling the orthogonal Smart enhancement on
 * a started Standard-preset session. A real createChannel is wired to
 * recording session, agent-factory, Cordis-context, and preset-roster fakes.
 *
 * The verifier covers Smart on, Smart off, and a failed Smart-on replacement:
 * each requested transition forks the complete transcript, preserves the
 * Standard preset and model route, mounts the expected composition, and keeps
 * the old handle alive until replacement creation succeeds. A failed create
 * must leave the live agent, transcript, and Smart sidecar byte-for-byte
 * unchanged.
 *
 * The script creates its own throwaway HOME so it never reads or writes the
 * operator's real ~/.dsh-tui preferences.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 *   node scripts/verify-smart-fork.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalLang = process.env.DSH_TUI_LANG
const testHome = mkdtempSync(join(tmpdir(), 'dsh-tui-smart-fork-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome
process.env.DSH_TUI_LANG = 'zh'

let failed = 0

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function withTimeout(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function transcriptOf(channel) {
  return channel.rows.map(row => ({
    kind: row.kind,
    text: row.text,
    seq: row.seq,
    streaming: row.streaming,
  }))
}

function pluginName(plugin) {
  return plugin?.name ?? plugin?.default?.name ?? 'anonymous'
}

function makeScopedContext(label) {
  const listeners = new Map()
  const pluginCalls = []
  const ctx = {
    label,
    agent: {},
    pluginCalls,
    tools: {
      get() { return undefined },
    },
    isolate() {
      return ctx
    },
    on(event, handler) {
      let handlers = listeners.get(event)
      if (handlers === undefined) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    async plugin(plugin, config) {
      pluginCalls.push({ plugin, config, name: pluginName(plugin) })
    },
  }
  return ctx
}

function makeHostContext(services) {
  const listeners = new Map()
  const warnings = []
  const hostPluginCalls = []
  const root = {
    agents: { get() { return undefined } },
    on(event, handler) {
      let handlers = listeners.get(event)
      if (handlers === undefined) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    async plugin(plugin, config) {
      hostPluginCalls.push({ plugin, config, name: pluginName(plugin) })
    },
  }
  const ctx = {
    root,
    effect(register) {
      return register()
    },
    on(event, handler) {
      let handlers = listeners.get(event)
      if (handlers === undefined) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    get(name) {
      return services[name]
    },
    logger: {
      warn(message) {
        warnings.push(message)
      },
      info() {},
    },
  }
  return {
    ctx,
    warnings,
    hostPluginCalls,
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args)
    },
  }
}

const CWD = '/work/smart-fork'
const PROVIDER = 'test-provider'
// A V4-family route: the channel's model gate (2026-08-16) refuses Smart on
// anything else, and this suite exercises its fork machinery.
const MODEL = 'deepseek-v4-flash'
const START = 1_800_000_000_000
const STANDARD = { id: 'standard', trust: 'system', name: 'Standard' }
const LIANGSHEN = { id: 'liangshen', trust: 'system', name: 'Liangshen' }

function startedEvents() {
  return [
    { type: 'turn/start', seq: 0, time: START, data: { turn: 0 } },
    {
      type: 'user/message',
      seq: 1,
      time: START + 1,
      data: {
        id: 'message-user-1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Keep this question across Smart forks.' }],
      },
    },
    { type: 'step/start', seq: 2, time: START + 2, data: { turn: 0, step: 0 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: START + 3,
      data: {
        turn: 0,
        step: 0,
        message: {
          id: 'message-assistant-1',
          role: 'assistant',
          source: { kind: 'model', provider: PROVIDER, model: MODEL },
          content: [{ type: 'text', text: 'This answer must remain visible.' }],
        },
        usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
    { type: 'step/end', seq: 4, time: START + 4, data: { turn: 0, step: 0 } },
    { type: 'turn/end', seq: 5, time: START + 5, data: { turn: 0, reason: { kind: 'completed' } } },
  ]
}

try {
  const [
    { createChannel },
    { composePreset },
  ] = await Promise.all([
    import('../lib/types/dsh-adapter/channel.js'),
    import('../lib/types/dsh-adapter/presets.js'),
  ])

  const services = {}
  const host = makeHostContext(services)
  const timeline = []
  const mountCalls = []
  const recomposeCalls = []
  const resolveCalls = []

  // Smart is deliberately absent: it is an overlay over this one official
  // preset, never another roster entry.
  services.agentPresets = {
    defaultId: 'standard',
    async list() {
      return [STANDARD, LIANGSHEN]
    },
    async resolve(id = 'standard') {
      resolveCalls.push(id)
      if (id === 'standard') return STANDARD
      if (id === 'liangshen') return LIANGSHEN
      throw new Error(`unknown preset: ${id}`)
    },
    async mount(agentCtx, id = 'standard') {
      if (id !== 'standard' && id !== 'liangshen') throw new Error(`unknown preset: ${id}`)
      agentCtx.mountedPreset = id
      mountCalls.push({ agentCtx, id })
      timeline.push(`mount:${id}:${agentCtx.label}`)
      return id === 'standard' ? STANDARD : LIANGSHEN
    },
    async recompose(agentCtx, id) {
      recomposeCalls.push({ agentCtx, id })
      if (id === 'standard') return STANDARD
      if (id === 'liangshen') return LIANGSHEN
      throw new Error(`unknown preset: ${id}`)
    },
  }

  function makeSession(id, agentPreset, events, meta = {}) {
    let log = [...events]
    const session = {
      id,
      header: {
        version: 0,
        id,
        createdAt: START,
        ...meta,
        agentPreset,
      },
      get seq() {
        return log.at(-1)?.seq ?? -1
      },
      get events() {
        return log
      },
      append(type, data) {
        const event = { type, seq: (log.at(-1)?.seq ?? -1) + 1, time: Date.now(), data }
        log = [...log, event]
        host.emit('session/event', session, event)
        return event
      },
      requestHeader() {
        return undefined
      },
      deriveMessages() {
        return []
      },
    }
    return session
  }

  function makeAgent(session, agentCtx, options = { provider: PROVIDER, model: MODEL }) {
    return {
      id: session.id,
      status: 'idle',
      session,
      ctx: agentCtx,
      options,
      followup() {},
      steer() {},
      inbox: { remove: () => false },
    }
  }

  function makeHandle(agent) {
    const marker = `dispose:${agent.session.id}`
    return {
      agent,
      disposed: false,
      disposeCalls: 0,
      marker,
      async dispose() {
        this.disposeCalls += 1
        this.disposed = true
        timeline.push(marker)
      },
    }
  }

  const forkCalls = []
  services.sessions = {
    fork(...args) {
      const [source, boundary] = args
      const seed = [...source.events]
      forkCalls.push({ source, boundary, argCount: args.length, seed })
      timeline.push(`fork:${source.id}`)
      return { events: seed }
    },
  }

  const createCalls = []
  const createGates = []
  let rejectNextCreate = false

  function gateNextCreate() {
    const entered = deferred()
    const release = deferred()
    createGates.push({ entered, release })
    return {
      entered: entered.promise,
      release: () => release.resolve(),
    }
  }

  services.agents = {
    async create(options) {
      const gate = createGates.shift()
      const shouldReject = rejectNextCreate
      rejectNextCreate = false
      const agentCtx = makeScopedContext(`child-${createCalls.length + 1}`)
      const call = {
        options,
        agentCtx,
        startMarker: `create:start:${options.sessionId}`,
        resolvedMarker: `create:resolved:${options.sessionId}`,
        rejectedMarker: `create:rejected:${options.sessionId}`,
      }
      createCalls.push(call)
      timeline.push(call.startMarker)

      try {
        const commit = await options.setup?.(agentCtx)
        commit?.commit?.()
        call.setupCompleted = true
      } catch (error) {
        call.setupError = error
        gate?.entered.resolve(call)
        throw error
      }
      gate?.entered.resolve(call)
      if (gate !== undefined) await gate.release.promise

      if (shouldReject) {
        call.rejected = true
        timeline.push(call.rejectedMarker)
        throw new Error('create failed for test')
      }

      const session = makeSession(
        options.sessionId,
        options.meta?.agentPreset,
        options.seed ?? [],
        options.meta ?? {},
      )
      call.handle = makeHandle(makeAgent(session, agentCtx, options.agentOptions))
      timeline.push(call.resolvedMarker)
      return call.handle
    },
  }

  function assertForkRequest(label, index, sourceSession) {
    const fork = forkCalls[index]
    const creation = createCalls[index]
    check(
      `${label}: sessions.fork receives the live session with no boundary`,
      fork?.source === sourceSession && fork?.argCount === 1 && fork?.boundary === undefined,
    )
    check(
      `${label}: fork seed is the complete source log`,
      fork !== undefined && fork.seed.length === sourceSession.events.length && same(fork.seed, sourceSession.events),
      `${fork?.seed.length ?? 0}/${sourceSession.events.length} events`,
    )
    check(`${label}: agents.create receives the exact fork seed`, creation?.options.seed === fork?.seed)
    check(
      `${label}: agents.create uses a new child session id`,
      typeof creation?.options.sessionId === 'string' &&
        creation.options.sessionId.length > 0 &&
        creation.options.sessionId !== sourceSession.id,
      String(creation?.options.sessionId),
    )
    check(
      `${label}: child metadata preserves cwd, lineage, seed length, and Standard preset`,
      creation?.options.meta?.cwd === CWD &&
        creation.options.meta.parentSession === sourceSession.id &&
        creation.options.meta.seedLength === fork?.seed.length &&
        creation.options.meta.agentPreset === 'standard',
      JSON.stringify(creation?.options.meta),
    )
    check(
      `${label}: child keeps the provider/model route`,
      same(creation?.options.agentOptions, { provider: PROVIDER, model: MODEL }),
      JSON.stringify(creation?.options.agentOptions),
    )
    const mount = mountCalls.find(item => item.agentCtx === creation?.agentCtx)
    check(
      `${label}: create setup mounts Standard in the unpublished child context`,
      typeof creation?.options.setup === 'function' &&
        creation.setupCompleted === true &&
        mount?.id === 'standard' &&
        creation.agentCtx.mountedPreset === 'standard',
      mount?.id,
    )
  }

  function assertSuccessfulSwap(label, index, oldHandle, expectedRows, smart) {
    const creation = createCalls[index]
    const resolvedAt = timeline.indexOf(creation.resolvedMarker)
    const disposedAt = timeline.indexOf(oldHandle.marker)
    check(
      `${label}: old handle is disposed once and only after create resolves`,
      oldHandle.disposeCalls === 1 && resolvedAt >= 0 && disposedAt > resolvedAt,
      `${resolvedAt} -> ${disposedAt}`,
    )
    check(
      `${label}: channel adopts the child while retaining Standard`,
      channel.agentId === creation.handle?.agent.id &&
        channel.agentPreset === 'standard' &&
        creation.handle?.agent.session.header.agentPreset === 'standard' &&
        channel.smart === smart,
      `${channel.agentId}/${channel.agentPreset}/smart=${channel.smart}`,
    )
    check(
      `${label}: replay retains every visible transcript row`,
      same(transcriptOf(channel), expectedRows),
      JSON.stringify(transcriptOf(channel)),
    )
  }

  const smartFile = join(testHome, '.dsh-tui', 'smart.json')
  const sidecarText = () => readFileSync(smartFile, 'utf8')
  const sidecar = () => JSON.parse(sidecarText())

  const initialSession = makeSession('session-standard-0', 'standard', startedEvents(), { cwd: CWD })
  const initialAgent = makeAgent(initialSession, makeScopedContext('initial-standard'))
  const initialHandle = makeHandle(initialAgent)
  const channel = createChannel(host.ctx, initialAgent, {
    model: MODEL,
    cwd: CWD,
    provider: PROVIDER,
    activity: false,
    agentPreset: 'standard',
    smart: false,
    handle: initialHandle,
  })
  const originalRows = transcriptOf(channel)
  const listed = await channel.listPresets()

  check(
    'fixture is a started, non-Smart Standard session',
    channel.agentPreset === 'standard' &&
      channel.smart === false &&
      initialSession.events.some(event => event.type === 'turn/start') &&
      originalRows.some(row => row.kind === 'user') &&
      originalRows.some(row => row.kind === 'assistant'),
    JSON.stringify(originalRows),
  )
  check(
    'fake roster exposes Standard and standalone Liangshen (Smart is not a preset)',
    listed.length === 2 && listed[0]?.id === 'standard' && listed[1]?.id === 'liangshen',
    JSON.stringify(listed),
  )

  // Smart on over Standard.
  const onGate = gateNextCreate()
  const switchOn = channel.switchSmart(true)
  const onCreation = await withTimeout(onGate.entered, 'switchSmart(true) agents.create')
  check(
    'Smart on: Standard handle stays active while create is pending',
    initialHandle.disposeCalls === 0 && channel.agentId === initialAgent.id && channel.smart === false,
  )
  host.emit('agent/status', { agent: initialAgent, status: 'running' })
  check('Smart on: old agent subscription remains active while pending', channel.status === 'running')
  onGate.release()
  const onResult = await switchOn

  check('Smart on: switchSmart(true) returns true', onResult === true)
  assertForkRequest('Smart on', 0, initialSession)
  assertSuccessfulSwap('Smart on', 0, initialHandle, originalRows, true)
  check(
    'Smart on: setup adds the router after mounting Standard',
    same(onCreation.agentCtx.pluginCalls.map(call => call.name), ['tool-str-replace-editor', 'router-bootstrap']),
    JSON.stringify(onCreation.agentCtx.pluginCalls.map(call => call.name)),
  )
  check(
    'Smart on: router receives a one-creation Anchored reset',
    onCreation.agentCtx.pluginCalls.find(call => call.name === 'router-bootstrap')?.config?.resetAnchored === true,
  )
  check(
    'Smart on: host runtime is initialized once',
    same(host.hostPluginCalls.map(call => call.name), ['dsh-tui-smart-runtime']),
    JSON.stringify(host.hostPluginCalls.map(call => call.name)),
  )
  const onSidecar = sidecar()
  check(
    'Smart on: sidecar saves the new child and default as enabled',
    onSidecar.enabled === true && onSidecar.sessions?.[onCreation.options.sessionId]?.enabled === true,
    JSON.stringify(onSidecar),
  )
  check(
    'Smart on: a V4-family model switches cleanly with no scope warning',
    channel.notifications.some(notification => notification.text.includes('已切换为 on'))
      && !channel.notifications.some(notification => notification.text.includes(MODEL)),
    JSON.stringify(channel.notifications.map(notification => notification.text)),
  )
  const onHandle = onCreation.handle
  const onSession = onHandle.agent.session

  // Smart off, still Standard.
  const offGate = gateNextCreate()
  const switchOff = channel.switchSmart(false)
  const offCreation = await withTimeout(offGate.entered, 'switchSmart(false) agents.create')
  check(
    'Smart off: Smart handle stays active while create is pending',
    onHandle.disposeCalls === 0 &&
      channel.agentId === onHandle.agent.id &&
      channel.smart === true,
  )
  offGate.release()
  const offResult = await switchOff

  check('Smart off: switchSmart(false) returns true', offResult === true)
  assertForkRequest('Smart off', 1, onSession)
  assertSuccessfulSwap('Smart off', 1, onHandle, originalRows, false)
  check(
    'Smart off: setup mounts Standard without Smart overlay plugins',
    offCreation.agentCtx.pluginCalls.length === 0 && host.hostPluginCalls.length === 1,
    JSON.stringify(offCreation.agentCtx.pluginCalls.map(call => call.name)),
  )
  check(
    'Smart off: child id is distinct from all earlier sessions',
    offCreation.options.sessionId !== initialSession.id && offCreation.options.sessionId !== onSession.id,
    String(offCreation.options.sessionId),
  )
  const offSidecar = sidecar()
  check(
    'Smart off: sidecar saves disabled child/default and retains prior Smart child',
    offSidecar.enabled === false &&
      offSidecar.sessions?.[offCreation.options.sessionId]?.enabled === false &&
      offSidecar.sessions?.[onCreation.options.sessionId]?.enabled === true,
    JSON.stringify(offSidecar),
  )

  // Failure after Standard + Smart setup: no swap and no sidecar write.
  const currentHandle = offCreation.handle
  const currentSession = currentHandle.agent.session
  const rowsBeforeFailure = transcriptOf(channel)
  const sidecarBeforeFailure = sidecarText()
  rejectNextCreate = true
  const failureGate = gateNextCreate()
  const failedSwitch = channel.switchSmart(true)
  const failedCreation = await withTimeout(failureGate.entered, 'failed switchSmart(true) agents.create')

  check(
    'create failure: current Standard handle stays active while replacement is pending',
    currentHandle.disposeCalls === 0 &&
      channel.agentId === currentHandle.agent.id &&
      channel.agentPreset === 'standard' &&
      channel.smart === false,
  )
  failureGate.release()
  const failureResult = await failedSwitch

  check('create failure: switchSmart(true) returns false', failureResult === false)
  assertForkRequest('create failure', 2, currentSession)
  check(
    'create failure: factory rejected after Standard and Smart setup',
    failedCreation.setupCompleted === true &&
      failedCreation.rejected === true &&
      failedCreation.handle === undefined &&
      same(failedCreation.agentCtx.pluginCalls.map(call => call.name), ['tool-str-replace-editor', 'router-bootstrap']),
    JSON.stringify(failedCreation.agentCtx.pluginCalls.map(call => call.name)),
  )
  check(
    'create failure: old handle is not disposed and channel keeps agent/preset/Smart state',
    currentHandle.disposeCalls === 0 &&
      currentHandle.disposed === false &&
      channel.agentId === currentHandle.agent.id &&
      channel.agentPreset === 'standard' &&
      channel.smart === false,
    `${currentHandle.disposeCalls}/${channel.agentId}/${channel.agentPreset}/smart=${channel.smart}`,
  )
  check(
    'create failure: transcript and trace remain attached to the old session',
    same(transcriptOf(channel), rowsBeforeFailure) && channel.traceEvents() === currentSession.events,
  )
  host.emit('agent/status', { agent: currentHandle.agent, status: 'running' })
  check('create failure: old agent status subscription remains live', channel.status === 'running')
  check(
    'create failure: Smart sidecar is unchanged and contains no failed child',
    sidecarText() === sidecarBeforeFailure &&
      sidecar().sessions?.[failedCreation.options.sessionId] === undefined,
  )
  check(
    'create failure: successful predecessors were each disposed exactly once',
    initialHandle.disposeCalls === 1 &&
      onHandle.disposeCalls === 1,
    `${initialHandle.disposeCalls}/${onHandle.disposeCalls}`,
  )
  check(
    'create failure: error is reported without swapping',
    channel.notifications.some(notification => notification.text.includes('create failed for test')),
    JSON.stringify(channel.notifications.map(notification => notification.text)),
  )
  check(
    'all fork compositions resolved and mounted Standard without in-place recompose',
    same(resolveCalls, ['standard', 'standard', 'standard']) &&
      same(mountCalls.map(call => call.id), ['standard', 'standard', 'standard']) &&
      recomposeCalls.length === 0,
    JSON.stringify({ resolveCalls, mounts: mountCalls.map(call => call.id), recomposes: recomposeCalls.length }),
  )

  const smartLiangshen = await composePreset(host.ctx, 'liangshen', true)
  const smartLiangshenCtx = makeScopedContext('liangshen-smart-normalized')
  await smartLiangshen.setup?.(smartLiangshenCtx)
  check(
    'Liangshen composition normalizes Smart off and mounts no overlay',
    smartLiangshen.agentPreset === 'liangshen' &&
      smartLiangshen.smart === false &&
      smartLiangshenCtx.mountedPreset === 'liangshen' &&
      smartLiangshenCtx.pluginCalls.length === 0,
    JSON.stringify(smartLiangshenCtx.pluginCalls.map(call => call.name)),
  )
  const conflictForkCount = forkCalls.length
  const conflictCreateCount = createCalls.length
  const liangshenSession = makeSession('session-liangshen', 'liangshen', startedEvents(), { cwd: CWD })
  const liangshenChannel = createChannel(
    host.ctx,
    makeAgent(liangshenSession, makeScopedContext('liangshen-live')),
    {
      model: MODEL,
      cwd: CWD,
      provider: PROVIDER,
      activity: false,
      agentPreset: 'liangshen',
      smart: false,
    },
  )
  const liangshenSmart = await liangshenChannel.switchSmart(true)
  check(
    'Liangshen rejects Smart before any fork or create',
    liangshenSmart === false &&
      forkCalls.length === conflictForkCount && createCalls.length === conflictCreateCount &&
      liangshenChannel.notifications.some(item => item.text.includes('不能叠加 Smart')),
    JSON.stringify(liangshenChannel.notifications.map(item => item.text)),
  )

  const recomposeCount = recomposeCalls.length
  const blankSmartSession = makeSession('session-blank-smart', 'standard', [], { cwd: CWD })
  const blankSmartChannel = createChannel(
    host.ctx,
    makeAgent(blankSmartSession, makeScopedContext('blank-smart-live')),
    {
      model: MODEL,
      cwd: CWD,
      provider: PROVIDER,
      activity: false,
      agentPreset: 'standard',
      smart: true,
    },
  )
  const liangshenPresetSwitch = await blankSmartChannel.switchPreset('liangshen')
  check(
    'A blank enhanced session rejects /preset liangshen before recompose',
    liangshenPresetSwitch === false &&
      blankSmartChannel.agentPreset === 'standard' &&
      recomposeCalls.length === recomposeCount &&
      blankSmartChannel.notifications.some(item => item.text.includes('独立 preset')),
    JSON.stringify(blankSmartChannel.notifications.map(item => item.text)),
  )
} finally {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalLang === undefined) delete process.env.DSH_TUI_LANG
  else process.env.DSH_TUI_LANG = originalLang
  rmSync(testHome, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} Smart-fork check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll Smart-fork checks passed')
process.exit(0)
