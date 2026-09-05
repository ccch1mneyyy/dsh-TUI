/** L4 in-process UI boundary: real Channel + production mount, no live credentials.
 * Run: node --import tsx/esm scripts/verify-channel-ui.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { bindChannelCommands } from '../src/dsh-adapter/channel/commands.js'
import { mountChannelUi } from '../src/dsh-adapter/channel-ui.js'
import { registerTuiChannel } from '../src/adapter/channel/host-registry.js'
import { CHANNEL_UI_EFFECTS } from '../src/adapter/channel/ui-policy.js'
import { channelDriver } from '../src/adapter/upstream/channel-driver.js'
import type { HostChannelPort } from '../src/adapter/ports/channel.js'
import { TuiPluginHostRuntime, getHostFacade } from '../src/dsh-adapter/plugin-host.js'
import { createChannelEmitter } from '../src/dsh-adapter/channel/emitter.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 40))
function fixture() {
  const writes: string[] = []
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const services: Record<string, unknown> = {
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: {}, value: {} }],
      get: () => ({}),
      mutate: async () => { writes.push('settings') },
    },
    credentials: {
      resolve: async () => undefined,
      set: async () => { writes.push('credential') },
      unset: async () => { writes.push('credential-remove') },
    },
    llm: { listConfigurableProviders: () => [], discoverModels: async () => [] },
    dshAuth: { api: {
      providers: async () => [], login: async () => { writes.push('login') },
      logout: async () => { writes.push('logout'); return true },
    } },
  }
  const ctx = {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    get(name: string) { return services[name] },
    logger: { warn() {} },
  }
  const agent = {
    id: 'ui-agent', status: 'idle',
    session: { id: 'ui-session', seq: 0, events: [] },
    ctx: { on: () => () => undefined },
    followup: () => { writes.push('submit') },
    steer: () => { writes.push('steer') },
    cancel: () => { writes.push('cancel') },
    inbox: { remove: () => true },
  }
  const raw = createChannel(ctx as never, agent as never, { model: 'model', provider: 'provider', cwd: '/tmp', activity: false })
  return { ctx, raw, writes, services, agent }
}

// Real bare production startup, not raw createChannel passed to a renderer.
{
  const { ctx, raw, writes } = fixture()
  const unregister = registerTuiChannel(ctx, raw)
  const mount = mountChannelUi(ctx, raw, undefined, 'new')
  bindChannelCommands(raw, mount.channel)
  mount.channel.setWhale(false)
  assert.equal(raw.whale, false)
  mount.channel.submit('hello')
  await tick()
  assert.ok(writes.includes('submit'))
  const settings = mount.channel.settingsHost()!
  const provider = mount.channel.providerSetup()!
  await settings.write('x', [])
  await provider.writeProfile('x', {})
  const retained = mount.channel.submit
  const dismiss = mount.channel.notify('sticky', { timeoutMs: 0 })
  assert.equal(raw.notifications.length, 1)
  mount.dispose()
  assert.equal(raw.notifications.length, 0)
  dismiss()
  assert.throws(() => retained('late'), /lifetime/)
  assert.throws(() => settings.write('x', []), /lifetime/)
  assert.throws(() => provider.oauth!.logout('x'), /lifetime/)
  await assert.rejects(raw.switchWorkspace({ cwd: '/other', label: 'other' } as never), /lifetime/)
  unregister()
  raw.releaseContributions()
}

// All explicit effectful UI commands and nested handles refuse in both shadows.
for (const mode of ['passive-shadow', 'replay-shadow'] as const) {
  const { ctx, raw, writes } = fixture()
  const unregister = registerTuiChannel(ctx, raw)
  const mount = mountChannelUi(ctx, raw, undefined, mode)
  for (const [name, effect] of Object.entries(CHANNEL_UI_EFFECTS)) {
    if (effect !== 'mutate' || name === 'commandCompletions' || name === 'listEfforts') continue
    assert.throws(() => Reflect.apply(mount.channel[name as keyof typeof CHANNEL_UI_EFFECTS], mount.channel, []), /shadow policy/, name)
  }
  assert.ok(Array.isArray(mount.channel.commandCompletions('/')))
  assert.deepEqual(await mount.channel.listEfforts(), { efforts: [], defaultEffort: undefined })
  assert.equal(mount.channel.model, 'model')
  const settings = mount.channel.settingsHost()!
  const provider = mount.channel.providerSetup()!
  assert.throws(() => settings.write('x', []), /shadow policy/)
  assert.throws(() => settings.writeCredential('x', 'secret'), /shadow policy/)
  assert.throws(() => provider.writeProfile('x', {}), /shadow policy/)
  assert.throws(() => provider.readCredential('x'), /shadow policy/)
  assert.throws(() => provider.oauth!.login(), /shadow policy/)
  assert.throws(() => mount.channel.subagentControl.interrupt('child'), /shadow policy/)
  assert.equal(writes.length, 0)
  unregister()
  mount.dispose()
  raw.releaseContributions()
}

// Driver caches one view per channel; retained handles cannot borrow replacements.
{
  const { raw } = fixture()
  const ctx = new Context()
  const unregister = registerTuiChannel(ctx, raw)
  const driver = await channelDriver.mount(ctx, {})
  const port = driver.ports!.channel as HostChannelPort
  const first = port.projection.ui!()
  assert.equal(port.projection.ui!(), first)
  const settings = first.settingsHost()!
  const secondFixture = fixture()
  const removeSecond = registerTuiChannel(ctx, secondFixture.raw)
  assert.throws(() => first.submit('stale'), /lifetime/)
  assert.throws(() => settings.write('x', []), /lifetime/)
  const second = port.projection.ui!()
  assert.notEqual(first, second)
  driver.disposer()
  assert.throws(() => second.submit('disposed'), /lifetime/)
  assert.throws(() => port.projection.ui!(), /disposed/)
  unregister(); removeSecond()
  raw.releaseContributions(); secondFixture.raw.releaseContributions()
}

// Actual kernel production assembly: settings can arrive before async mount.
{
  const oldMode = process.env.DSH_TUI_ADAPTER_MODE
  const oldSlices = process.env.DSH_TUI_ADAPTER_SLICES
  process.env.DSH_TUI_ADAPTER_MODE = 'new'
  process.env.DSH_TUI_ADAPTER_SLICES = 'channel'
  try {
    const ctx = new Context()
    ctx.logger.warn = () => undefined
    const fiber = ctx.plugin({ name: 'channel-ui-host', apply(child: Context) { new TuiPluginHostRuntime(child) } })
    const { raw } = fixture()
    const unregister = registerTuiChannel(ctx, raw)
    await tick()
    const host = ctx.get('tuiPluginHost')
    const mount = mountChannelUi(ctx, raw, host, 'new')
    mount.channel.setWhale(false)
    const earlySettings = mount.channel.settingsHost()!
    await tick(); await tick()
    assert.ok(getHostFacade(host)?.channel?.projection.ui)
    mount.channel.setWhale(true)
    assert.equal(raw.whale, true)
    const settings = mount.channel.settingsHost()!
    let nestedCalls = 0
    const continuation = () => { nestedCalls += 1; return { kind: 'clear' as const } }
    raw.runWorkspaceCommand = async () => ({
      kind: 'choices' as const, title: 'outer lifetime',
      choices: [{ id: 'x', label: 'x', choose: continuation, input: { submit: continuation } }],
    })
    raw.settingsSections = () => [{
      ns: 'outer-lifetime', title: 'outer lifetime', fields: [{
        path: ['x'], kind: 'text', label: 'x', format: () => 'formatted', parse: continuation,
      }],
    }]
    raw.buildSessionTree = async () => ({
      roots: [], activePath: new Set(['tip']), activeLeafId: 'tip',
      sessions: new Map([['session', { title: 'hello', createdAt: 0, live: true, unreadable: false, unloaded: false }]]),
      rewindFacts: new Map(), truncated: false, sessionCount: 1,
    })
    // This crosses the real Kernel projection and the production mount. Map
    // and Set must retain their whole Readonly collection contract after both
    // capability layers, not merely get()/has().
    const tree = await mount.channel.buildSessionTree()
    assert.equal(tree?.sessions.get('session')?.title, 'hello')
    assert.equal(tree?.activePath.has('tip'), true)
    assert.deepEqual([...tree!.sessions], [['session', tree!.sessions.get('session')]])
    assert.deepEqual([...tree!.sessions.entries()], [['session', tree!.sessions.get('session')]])
    assert.deepEqual([...tree!.sessions.keys()], ['session'])
    assert.deepEqual([...tree!.sessions.values()].map(item => item.title), ['hello'])
    assert.deepEqual([...tree!.activePath], ['tip'])
    assert.deepEqual([...tree!.activePath.entries()], [['tip', 'tip']])
    assert.deepEqual([...tree!.activePath.keys()], ['tip'])
    assert.deepEqual([...tree!.activePath.values()], ['tip'])
    const seen: string[] = []
    tree!.sessions.forEach((value, key, receiver) => { assert.equal(receiver, tree!.sessions); seen.push(`${key}:${value.title}`) })
    tree!.activePath.forEach((value, key, receiver) => { assert.equal(receiver, tree!.activePath); seen.push(`${key}:${value}`) })
    assert.deepEqual(seen, ['session:hello', 'tip:tip'])
    // Retain nested callbacks from the real kernel + production composition,
    // then dispose only the outer mount. The kernel remains live: each leaf
    // must nevertheless retain the outer lease, including read-only settings
    // conversions as well as workspace executable choices/input.
    const choices = await mount.channel.runWorkspaceCommand('outer-lifetime', '')
    const field = mount.channel.settingsSections()[0]!.fields[0]!
    assert.equal(field.format?.('x'), 'formatted')
    assert.equal(field.parse?.('x')?.kind, 'clear')
    assert.equal(nestedCalls, 1)
    // A production subscriber may read the ingress revision before the
    // deferred frame fold. Once the real 601-row tool transcript folds, it
    // must receive one complete new revision: no full tool payload survives,
    // while the already-read immutable snapshot stays intact.
    for (let index = 0; index < 601; index++) {
      raw.rows.push({
        id: 10_000 + index, kind: 'tool', text: `tool ${index}`,
        tool: {
          callId: `fold-${index}`, name: 'Read', argsText: '{}', argsFull: 'FULL', status: 'ok',
          resultText: 'RESULT', resultFull: 'RESULT-FULL', resultView: { card: 'terminal', output: 'RESULT-VIEW' }, startedAt: 0,
        },
      })
    }
    raw.emitStream()
    const beforeFold = mount.channel.rows
    const beforeTool = beforeFold[0]!.tool!
    let notifiedRows: readonly typeof beforeFold[number][] | undefined
    const stopFoldRead = mount.channel.subscribe(() => { notifiedRows = mount.channel.rows })
    await tick()
    stopFoldRead()
    const afterFold = mount.channel.rows
    assert.equal(raw.rows[0]!.folded, true)
    assert.equal(raw.rows[0]!.tool!.argsFull, undefined)
    assert.notEqual(afterFold, beforeFold, 'completed fold publishes a distinct revision')
    assert.equal(notifiedRows, afterFold, 'subscriber reads the completed fold revision')
    assert.equal(afterFold[0]!.folded, true)
    assert.equal(afterFold[0]!.tool!.argsFull, undefined)
    assert.equal(afterFold[0]!.tool!.resultFull, undefined)
    assert.equal(afterFold[0]!.tool!.resultView, undefined)
    assert.equal(beforeTool.argsFull, 'FULL', 'old snapshot retains its complete immutable tool payload')
    assert.equal(beforeTool.resultFull, 'RESULT-FULL')
    assert.equal(beforeTool.resultView?.card, 'terminal')
    assert.throws(() => { (beforeTool as { argsFull?: string }).argsFull = 'mutate' }, TypeError)
    mount.dispose()
    assert.throws(() => mount.channel.version, /lifetime/)
    if (choices?.kind === 'choices') {
      assert.throws(() => choices.choices[0]!.choose(), /lifetime/)
      assert.throws(() => choices.choices[0]!.input!.submit('x'), /lifetime/)
    }
    assert.throws(() => field.format?.('x'), /lifetime/)
    assert.throws(() => field.parse?.('x'), /lifetime/)
    assert.equal(nestedCalls, 1, 'outer disposal prevents all retained nested callbacks')
    await fiber.dispose()
    assert.throws(() => mount.channel.setWhale(false), /lost Channel UI|disposed|lifetime/)
    assert.equal(raw.whale, true, 'kernel loss must not downgrade to the local writer')
    assert.throws(() => settings.write('x', []), /lifetime/)
    assert.throws(() => earlySettings.write('x', []), /lost Channel UI|disposed|lifetime/)
    mount.dispose()
    unregister(); raw.releaseContributions()
  } finally {
    if (oldMode === undefined) delete process.env.DSH_TUI_ADAPTER_MODE
    else process.env.DSH_TUI_ADAPTER_MODE = oldMode
    if (oldSlices === undefined) delete process.env.DSH_TUI_ADAPTER_SLICES
    else process.env.DSH_TUI_ADAPTER_SLICES = oldSlices
  }
}

// A legacy host stays descriptor-only: local guarded composition is intentional.
{
  const oldMode = process.env.DSH_TUI_ADAPTER_MODE
  process.env.DSH_TUI_ADAPTER_MODE = 'legacy'
  try {
    const ctx = new Context()
    ctx.logger.warn = () => undefined
    const fiber = ctx.plugin({ name: 'legacy-ui-host', apply(child: Context) { new TuiPluginHostRuntime(child) } })
    const { raw } = fixture()
    const unregister = registerTuiChannel(ctx, raw)
    await tick()
    const host = ctx.get('tuiPluginHost')
    const mount = mountChannelUi(ctx, raw, host, 'legacy')
    await tick()
    assert.equal(getHostFacade(host)?.channel, undefined)
    mount.channel.setWhale(false)
    assert.equal(raw.whale, false)
    await tick()
    mount.channel.setWhale(true)
    assert.equal(raw.whale, true)
    mount.dispose(); unregister(); raw.releaseContributions()
    await fiber.dispose()
  } finally {
    if (oldMode === undefined) delete process.env.DSH_TUI_ADAPTER_MODE
    else process.env.DSH_TUI_ADAPTER_MODE = oldMode
  }
}

// Stream version remains synchronous; wakeups coalesce and teardown cancels.
{
  const state = { version: 0, rows: [] }
  let wakeups = 0
  let flushes = 0
  const emitter = createChannelEmitter(() => state, () => { flushes += 1 })
  emitter.subscribe(() => { wakeups += 1 })
  emitter.emitStream(); emitter.emitStream()
  assert.equal(state.version, 2)
  assert.equal(wakeups, 0)
  await tick()
  assert.equal(wakeups, 1)
  assert.equal(flushes, 1)
  emitter.emitStream(); emitter.dispose(); emitter.dispose()
  await tick()
  assert.equal(wakeups, 1)
}

// Queued and deferred deliveries are owned by their enqueue-time binding.
for (const deferred of [false, true]) {
  const { ctx, raw, writes, services } = fixture()
  let finish!: (value: string) => void
  let reading = false
  services.fs = {
    resolve: async (path: string) => path,
    stat: async () => ({ type: 'file' }),
    readText: () => { reading = true; return new Promise<string>(resolve => { finish = resolve }) },
  }
  const unregister = registerTuiChannel(ctx, raw)
  const mount = mountChannelUi(ctx, raw, undefined, 'new')
  bindChannelCommands(raw, mount.channel)
  mount.channel.submit(deferred ? '@review.txt' : 'queued')
  if (deferred) { await tick(); assert.equal(reading, true) }
  mount.dispose(); unregister(); raw.releaseContributions()
  if (deferred) finish('attachment')
  await tick()
  assert.equal(writes.includes('submit'), false)
  assert.equal(raw.pending.length, 0)
}

// A binding generation change during mention/image I/O cannot publish into its successor.
{
  const { ctx, raw, writes, services } = fixture()
  let finish!: (value: string) => void
  services.fs = {
    resolve: async (path: string) => path,
    stat: async () => ({ type: 'file' }),
    readText: () => new Promise<string>(resolve => { finish = resolve }),
  }
  const unregister = registerTuiChannel(ctx, raw)
  const mount = mountChannelUi(ctx, raw, undefined, 'new')
  mount.channel.submit('@review.txt')
  await tick()
  raw.agentBindingGeneration += 1
  finish('attachment')
  await tick()
  assert.equal(writes.includes('submit'), false)
  let save!: (value: unknown) => void
  services.attachments = {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1000 },
    saveImage: () => new Promise(resolve => { save = resolve }),
  }
  const pending = mount.channel.stageImage({ data: new Uint8Array([1]), mediaType: 'image/png' })
  raw.agentBindingGeneration += 1
  save({ id: 'saved', mediaType: 'image/png' })
  await assert.rejects(pending, /stale image/)
  mount.dispose(); unregister(); raw.releaseContributions()
}

// A conflict can complete an existing request, but cannot start a new retry after revoke.
for (const method of ['writeProfile', 'mutateProfile', 'removeProfile'] as const) {
  const { ctx, raw, services } = fixture()
  let reject!: (error: Error) => void
  let mutations = 0
  const settings = services.settings as { mutate: () => Promise<void> }
  settings.mutate = () => { mutations += 1; return new Promise((_, no) => { reject = no }) }
  const unregister = registerTuiChannel(ctx, raw)
  const mount = mountChannelUi(ctx, raw, undefined, 'new')
  const provider = mount.channel.providerSetup()!
  const pending = method === 'writeProfile' ? provider.writeProfile('x', {})
    : method === 'mutateProfile' ? provider.mutateProfile('x', []) : provider.removeProfile('x')
  mount.dispose()
  reject(Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' }))
  await assert.rejects(pending, /lifetime/)
  assert.equal(mutations, 1)
  unregister(); raw.releaseContributions()
}

// Data and recursive executable leaves do not escape the capability boundary.
{
  const { ctx, raw, services } = fixture()
  const backend = { nested: { value: 1 } }
  ;(services.settings as { describe: () => unknown[] }).describe = () => [{ ns: 'x', revision: 1, user: backend, value: backend }]
  raw.rows.push({ id: 1, kind: 'user', text: 'original' })
  let calls = 0
  const leaf = () => { calls += 1; return { kind: 'target' as const, target: { kind: 'local' as const, id: 'x', cwd: '/x', label: 'x', badge: 'local' } } }
  raw.runWorkspaceCommand = async () => ({ kind: 'choices', title: 'choices', choices: [{ id: 'x', label: 'x', choose: leaf, input: { submit: leaf } }] })
  raw.settingsSections = () => [{ ns: 'x', title: 'x', fields: [{ path: ['x'], kind: 'text', label: 'x', format: () => 'x', parse: () => ({ kind: 'clear' }) }] }]
  const unregister = registerTuiChannel(ctx, raw)
  const mount = mountChannelUi(ctx, raw, undefined, 'new')
  const rows = mount.channel.rows
  assert.notEqual(rows, raw.rows)
  assert.equal(rows, mount.channel.rows, 'unchanged version keeps the same projection identity')
  assert.throws(() => { (rows[0] as { text: string }).text = 'bad' }, TypeError)
  const namespaces = mount.channel.settingsHost()!.listNamespaces()
  assert.throws(() => { (namespaces[0].value as typeof backend).nested.value = 2 }, TypeError)
  const choices = await mount.channel.runWorkspaceCommand('x', '')
  assert.equal(choices?.kind, 'choices')
  const field = mount.channel.settingsSections()[0].fields[0]
  assert.equal(field.format?.('x'), 'x')
  mount.dispose()
  if (choices?.kind === 'choices') {
    assert.throws(() => choices.choices[0].choose(), /lifetime/)
    assert.throws(() => choices.choices[0].input!.submit('x'), /lifetime/)
  }
  assert.throws(() => field.parse?.('x'), /lifetime/)
  assert.equal(calls, 0)
  assert.equal(backend.nested.value, 1)
  unregister(); raw.releaseContributions()
}

// Long transcript reads retain detached historical row identities. Activity-only
// stream wakeups must not revisit history; a tail update may touch at most its
// newly-crossed fold boundary, never clone the whole transcript again.
{
  const { ctx, raw } = fixture()
  let historicalReads = 0
  for (let i = 0; i < 3_200; i++) {
    let text = `history ${i}`
    const row = { id: i + 1, kind: 'assistant' as const, get text() { historicalReads += 1; return text }, set text(value: string) { text = value } }
    raw.rows.push(row)
  }
  const unregister = registerTuiChannel(ctx, raw)
  const mount = mountChannelUi(ctx, raw, undefined, 'new')
  raw.emit() // folds once before the first detached snapshot
  const initial = mount.channel.rows
  const first = initial[0]!
  historicalReads = 0
  for (let i = 0; i < 8; i++) {
    raw.workingActivity = { phase: 'thinking', text: `activity ${i}` } as never
    raw.emitStream()
    await tick()
    assert.equal(mount.channel.rows[0], first, 'activity stream retains unchanged historical row')
  }
  assert.equal(historicalReads, 0, 'activity versions allocate/read no historical rows')
  raw.rows.push({ id: 3_201, kind: 'assistant', text: 'tail' })
  raw.emitStream()
  await tick()
  const tailed = mount.channel.rows
  assert.equal(tailed[0], first, 'tail stream retains unchanged historical row')
  assert.ok(historicalReads <= 3, `tail stream read ${historicalReads} fold-boundary fields, not the full history`)
  assert.throws(() => { (initial[0] as { text: string }).text = 'mutate old snapshot' }, TypeError)
  assert.equal(initial[0]?.text, 'history 0', 'old detached snapshot remains immutable after later versions')
  mount.dispose(); unregister(); raw.releaseContributions()
}

// Actual Chat mounts against the production shadow capability, with resumed rows.
{
  const [{ Writable, PassThrough }, React, { render }, { Chat }, { QuestionStore }] = await Promise.all([
    import('node:stream'), import('react'), import('../src/ui.js'), import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'),
  ])
  for (const mode of ['passive-shadow', 'replay-shadow'] as const) {
    const { ctx, raw, writes } = fixture()
    raw.rows.push({ id: 1, kind: 'user', text: 'resumed conversation' })
    assert.equal(raw.autoRecapOnOpen, true)
    const unregister = registerTuiChannel(ctx, raw)
    const mount = mountChannelUi(ctx, raw, undefined, mode)
    let wakeups = 0
    const stop = mount.channel.subscribe(() => { wakeups += 1 })
    raw.emit()
    assert.equal(wakeups, 1)
    assert.equal(mount.channel.autoRecapOnOpen, false)
    const frames: string[] = []
    const stdout = Object.assign(new Writable({ write(chunk, _enc, done) { frames.push(String(chunk)); done() } }), { columns: 80, rows: 24, isTTY: true })
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this }, ref() { return this }, unref() { return this } })
    const app = await render(React.createElement(Chat, { channel: mount.channel, questionStore: new QuestionStore(), onExit() {}, trajectorySeen: true }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    await tick(); await tick()
    assert.ok(frames.join('').includes('resumed'), frames.join(''))
    assert.equal(writes.length, 0)
    await app.unmount()
    stop(); mount.dispose(); unregister(); raw.releaseContributions()
  }
}

// Notification expiry releases owner registrations rather than retaining one per toast.
{
  const { createChannelOwner } = await import('../src/dsh-adapter/channel/owner.js')
  const { createChannelNotifications } = await import('../src/dsh-adapter/channel/notifications.js')
  const owner = createChannelOwner()
  const state = { notifications: [] as import('../src/adapter/ports/channel-view.js').NotificationItem[], emit() {} }
  const notify = createChannelNotifications(() => state, owner)
  for (let i = 0; i < 50; i++) notify('expires', { timeoutMs: 5 })
  assert.equal(owner.cleanupCount, 50)
  await tick()
  assert.equal(owner.cleanupCount, 0)
  assert.equal(state.notifications.length, 0)
  owner.dispose()
}

// Prepared handles and old subscriptions have one binding owner.
{
  const { createChannelOwner } = await import('../src/dsh-adapter/channel/owner.js')
  const { createChannelBinding } = await import('../src/dsh-adapter/channel/binding.js')
  const owner = createChannelOwner()
  const { agent } = fixture()
  const binding = createChannelBinding(agent as never, undefined, owner)
  let disposed = 0
  let finish!: (value: unknown) => void
  const pending = binding.prepare(() => new Promise(resolve => { finish = resolve }))
  owner.dispose()
  finish({ agent, dispose: async () => { disposed += 1 } })
  await assert.rejects(pending, /binding changed/)
  assert.equal(disposed, 1)
  const active = createChannelOwner()
  const next = createChannelBinding(agent as never, undefined, active)
  let subscriptions = 0
  next.subscribe(() => { subscriptions += 1 })
  next.replace({ ...agent, id: 'replacement' } as never, undefined)
  next.bind()
  assert.equal(subscriptions, 1)
  active.dispose()
  assert.equal(subscriptions, 1)
}

// A slow decision's timer is cancelled before its threshold; resolving late is inert.
{
  const ctx = new Context()
  ctx.logger.warn = () => undefined
  let finish!: (value: unknown) => void
  const { createInputDelivery } = await import('../src/dsh-adapter/channel/input-delivery.js')
  const { createChannelOwner } = await import('../src/dsh-adapter/channel/owner.js')
  const owner = createChannelOwner()
  const { agent, writes } = fixture()
  const raw = createChannel(ctx, agent as never, { model: 'model', provider: 'provider', cwd: '/tmp', activity: false })
  const unregister = registerTuiChannel(ctx, raw)
  const mount = mountChannelUi(ctx, raw, undefined, 'new')
  bindChannelCommands(raw, mount.channel)
  const errors: unknown[] = []
  const onError = (error: unknown) => { errors.push(error) }
  process.on('unhandledRejection', onError)
  const delivery = createInputDelivery(ctx, owner, { agent: agent as never }, () => raw, mount.channel.notify, () => undefined, () => undefined)
  const parked = delivery.withDecisionPending('tui/input', new Promise(resolve => { finish = resolve }))
  await tick()
  owner.dispose(); mount.dispose(); unregister(); raw.releaseContributions()
  await new Promise(resolve => setTimeout(resolve, 450))
  finish(undefined)
  await parked
  await tick()
  process.off('unhandledRejection', onError)
  assert.equal(raw.notifications.length, 0)
  assert.equal(writes.includes('submit'), false)
  assert.deepEqual(errors, [])
}

// Scene outlet retains the registry component identity and passes only guarded UI.
{
  const { createChannelSceneOutlet } = await import('../src/dsh-adapter/channel-scene-outlet.js')
  const React = await import('react')
  const { ctx, raw } = fixture()
  const unregister = registerTuiChannel(ctx, raw)
  const mount = mountChannelUi(ctx, raw, undefined, 'new')
  const component = () => null
  const outlet = createChannelSceneOutlet(() => ({ id: 'demo', component }))
  const first = outlet('demo', mount.channel)
  const second = outlet('demo', mount.channel)
  assert.ok(React.isValidElement<{ channel: unknown }>(first))
  assert.ok(React.isValidElement(second))
  assert.equal(first.type, second.type)
  assert.equal(first.props.channel, mount.channel)
  assert.equal('releaseContributions' in first.props.channel!, false)
  mount.dispose(); unregister(); raw.releaseContributions()
}

// Production source fence includes lifecycle exceptions explicitly, not raw UI.
const plugin = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
assert.match(plugin, /const channel = uiMount\.channel/)
assert.match(plugin, /bindChannelCommands\(rawChannel, channel\)/)
assert.ok(!plugin.includes('ViaChannelFacade('), 'bootstrap must not use legacy raw-fallback helpers')
const rawCalls = [...plugin.matchAll(/rawChannel\.([A-Za-z]+)\s*\(/g)].map(match => match[1])
assert.deepEqual(rawCalls.sort(), ['bindApprovalStore', 'releaseContributions'])
const impl = readFileSync(new URL('../src/dsh-adapter/channel.ts', import.meta.url), 'utf8')
for (const [name, effect] of Object.entries(CHANNEL_UI_EFFECTS)) {
  if (effect === 'mutate') assert.ok(!new RegExp(`\\bstate\\.${name}\\s*\\(`).test(impl), `internal raw mutation: ${name}`)
}
console.log('verify:channel-ui OK (real Channel/root, explicit effects, nested handles, shadow, replacement, emitter)')
