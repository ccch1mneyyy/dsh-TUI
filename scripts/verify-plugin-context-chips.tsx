/**
 * Verification of the plugin context-chips seam (ctx.tuiContextChips): host-side
 * plugins stage keyed context chips on the chat composer through the SAME
 * attached-context registry the side-panel "Send to Chat" uses.
 *
 * Four layers, one file:
 *  A. Store + bridge units (cordis-free): sink-less calls drop (false); the
 *     channel bridge stages `source: 'plugin'` chips, replaces on sourceId
 *     alone (a new title is still the same chip) and never touches panel
 *     chips; `clearSink` only clears its own sink.
 *  B. Runtime units over a REAL cordis context: caller validation (warn,
 *     never throw), key/title/content validation, title folding + 80-cell
 *     cap, host-derived `<plugin id>:<key>` sourceIds (no cross-plugin
 *     detach), 4 live keys per activation, 20 attaches/min per activation,
 *     dispose peeling, and the `context-chips.attach` grant (root switch +
 *     verified Component) read live from the grants file.
 *  C. Real channel: a plugin chip rides the next submission as an
 *     `<attached-context source="plugin" …>` block exactly once.
 *  D. Real PromptInput (headless xterm): the chip renders as the usual
 *     `⧉ title` strip above the input and Esc peels it before the draft.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-context-chips.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'

// Home isolation: DATA_DIR (and with it the grants file) is resolved at
// import time, so switch HOME before importing anything from src/.
const nodeFs = await import('node:fs')
const nodeOs = await import('node:os')
const nodePath = await import('node:path')
const isolatedHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dshtui-plugin-context-chips-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
const dataDir = nodePath.join(isolatedHome, '.dsh-tui')
nodeFs.mkdirSync(dataDir, { recursive: true })
const grantsFile = nodePath.join(dataDir, 'extension-grants.json')
const writeGrants = (value: unknown): void => { nodeFs.writeFileSync(grantsFile, JSON.stringify(value)) }
const clearGrants = (): void => { nodeFs.rmSync(grantsFile, { force: true }) }

const { Context } = await import('@deepseek-ai/cordis')
const {
  TuiContextChipsRuntime, TuiContextChipsStore, createChannelContextChipsSink, getHostContextChipsStore, CONTEXT_CHIPS_PERMISSION,
} = await import('../src/dsh-adapter/context-chips.js')
const { createAttachedContextRegistry } = await import('../src/dsh-adapter/channel/attached-context.js')
const { bindComponentIdentity } = await import('../src/dsh-adapter/component-identity.js')
const { createChannel } = await import('../src/dsh-adapter/channel.js')
const { stringWidth } = await import('../src/ink/stringWidth.js')
const { settle, settled, sleep, screenHas, findText } = await import('./lib/term-test.mjs')
const React = (await import('react')).default
const { Writable, PassThrough } = await import('node:stream')
const { Terminal: XTerm } = await import('@xterm/headless')
const { render, AlternateScreen } = await import('../src/ui.js')
const { PromptInput } = await import('../src/components/PromptInput.js')
const { LOCAL_COMMANDS } = await import('../src/commands.js')

type Context = InstanceType<typeof Context>
type AttachedContext = import('../src/adapter/ports/channel-view.js').AttachedContext

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

/** A holder-backed channel stand-in: the real registry behind the same three
 *  members the bridge reads, so replace/consume semantics are production's. */
function registryChannel() {
  const holder: { attachedContexts: readonly AttachedContext[] } = { attachedContexts: [] }
  const registry = createAttachedContextRegistry(() => holder, () => undefined)
  return {
    holder,
    registry,
    channel: {
      get attachedContexts() { return holder.attachedContexts },
      attachContext: (input: { source: 'panel' | 'plugin'; sourceId: string; title: string; content: string }) => registry.attach(input),
      detachContext: (id: string) => registry.detach(id),
    },
  }
}

// ── A. store + bridge units ──────────────────────────────────────────────
{
  const store = new TuiContextChipsStore()
  check('A1 store: sink-less attach/detach return false, staged() is empty',
    store.attach({ sourceId: 'p:k', title: 't', content: 'c' }) === false
    && store.detach('p:k') === false && store.staged().length === 0)

  const { holder, registry, channel } = registryChannel()
  const sink = createChannelContextChipsSink(channel)
  store.setSink(sink)
  check('A2 bridge: attach stages a source=plugin chip',
    store.attach({ sourceId: 'p:sel', title: 'Selection · 3', content: 'a, b, c' }) === true
    && holder.attachedContexts.length === 1 && holder.attachedContexts[0]!.source === 'plugin'
    && holder.attachedContexts[0]!.sourceId === 'p:sel', JSON.stringify(holder.attachedContexts))
  const firstId = holder.attachedContexts[0]!.id
  check('A3 bridge: same sourceId with a NEW title replaces in place (same id, one chip)',
    store.attach({ sourceId: 'p:sel', title: 'Selection · 5', content: 'a, b, c, d, e' }) === true
    && holder.attachedContexts.length === 1 && holder.attachedContexts[0]!.id === firstId
    && holder.attachedContexts[0]!.title === 'Selection · 5', JSON.stringify(holder.attachedContexts))

  // A panel row with the same sourceId string stays a separate chip, and a
  // plugin detach never peels it.
  registry.attach({ source: 'panel', sourceId: 'p:sel', title: 'Selection · 5', content: 'panel' })
  check('A4 bridge: a panel chip with the same sourceId is a separate chip', holder.attachedContexts.length === 2)
  check('A4 bridge: staged() lists plugin chips only',
    JSON.stringify(store.staged()) === JSON.stringify(['p:sel']), JSON.stringify(store.staged()))
  check('A5 bridge: detach drops the plugin chip and keeps the panel chip',
    store.detach('p:sel') === true && holder.attachedContexts.length === 1 && holder.attachedContexts[0]!.source === 'panel')
  check('A5 bridge: detaching a missing chip is false', store.detach('p:sel') === false)

  let writable = false
  const gated = createChannelContextChipsSink(channel, () => writable)
  check('A6 bridge: a non-writable (shadow) host stages nothing',
    gated.attach({ sourceId: 'p:x', title: 'x', content: 'x' }) === false && holder.attachedContexts.length === 1)
  writable = true
  check('A6 bridge: …and stages once writable', gated.attach({ sourceId: 'p:x', title: 'x', content: 'x' }) === true)

  const other = createChannelContextChipsSink(channel)
  store.clearSink(other)
  check('A7 store: clearSink ignores a sink that is not the registered one', store.hasSink())
  store.clearSink(sink)
  check('A7 store: clearSink drops its own sink', !store.hasSink())

  const throwing = new TuiContextChipsStore()
  throwing.setSink({ attach: () => { throw new Error('boom') }, detach: () => { throw new Error('boom') }, staged: () => { throw new Error('boom') } })
  check('A8 store: a throwing sink degrades to false/[] (never throws)',
    throwing.attach({ sourceId: 'p:k', title: 't', content: 'c' }) === false
    && throwing.detach('p:k') === false && throwing.staged().length === 0)
}

// ── B. runtime units over real cordis ────────────────────────────────────
const ctx = new Context()
const warnings: string[] = []
ctx.logger.warn = (format: unknown, ...params: unknown[]) => {
  warnings.push([format, ...params].map(String).join(' '))
}
const warnCount = (fragment: string): number => warnings.filter(line => line.includes(fragment)).length

ctx.plugin(TuiContextChipsRuntime)
await settle(() => ctx.get('tuiContextChips') !== undefined)
check('B1 runtime: service mounts on the cordis root', ctx.get('tuiContextChips') !== undefined)
const store = getHostContextChipsStore(ctx.tuiContextChips)
if (store === undefined) throw new Error('context-chips host store was not initialized')
const bench = registryChannel()
store.setSink(createChannelContextChipsSink(bench.channel))
const chips = (): readonly AttachedContext[] => bench.holder.attachedContexts

check('B1 runtime: root-context attach is refused',
  ctx.tuiContextChips.attachContext({ key: 'x', title: 'x', content: 'x' }) === false
  && warnCount('requires a live non-root plugin activation') >= 1)

async function activation(name: string, identity?: string): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  let captured: Context | undefined
  const fiber = ctx.plugin({
    name,
    inject: ['tuiContextChips'],
    apply: (candidate: Context) => {
      if (identity !== undefined) {
        bindComponentIdentity(candidate, { permissions: [], contributes: { commands: [] }, subscriptions: [] } as never,
          { metadata: { name: identity, version: '1.0.0' } } as never)
      }
      captured = candidate
    },
  })
  await settle(() => captured !== undefined)
  if (captured === undefined) throw new Error(`${name} did not start`)
  return { ctx: captured, dispose: async () => { await Promise.resolve(fiber.dispose()) } }
}

const blender = await activation('chips-probe-verified', 'blender-bridge')
const attach = (input: unknown, who: Context = blender.ctx): boolean => who.tuiContextChips.attachContext(input as never)

check('B2 runtime: a verified plugin stages its chip',
  attach({ key: 'selection', title: 'Blender 选中 · 3', content: 'Cube, Wheel_FL, Axle' }) === true
  && chips().length === 1 && chips()[0]!.source === 'plugin', JSON.stringify(chips()))
check('B2 runtime: sourceId is host-derived <componentId>:<key>',
  chips()[0]!.sourceId === 'blender-bridge:selection', chips()[0]?.sourceId)
const selectionId = chips()[0]!.id
check('B3 runtime: re-staging the key with a new title replaces in place',
  attach({ key: 'selection', title: 'Blender 选中 · 5', content: 'Cube, Wheel_FL, Wheel_FR, Axle, Body' }) === true
  && chips().length === 1 && chips()[0]!.id === selectionId && chips()[0]!.title === 'Blender 选中 · 5')

// Refusals (warn, never throw).
check('B4 runtime: invalid keys are refused',
  attach({ key: 'Selection', title: 't', content: 'c' }) === false
  && attach({ key: '1abc', title: 't', content: 'c' }) === false
  && attach({ key: 'a'.repeat(65), title: 't', content: 'c' }) === false
  && attach({ key: 42, title: 't', content: 'c' }) === false
  && warnCount('rejected an invalid key') === 4)
check('B4 runtime: a 64-character key is accepted', attach({ key: 'a'.repeat(64), title: 't', content: 'c' }) === true)
blender.ctx.tuiContextChips.detachContext('a'.repeat(64))
check('B5 runtime: non-string title/content is refused',
  attach({ key: 'k', title: 3, content: 'c' }) === false && attach({ key: 'k', title: 't', content: { x: 1 } }) === false
  && warnCount('must be strings') === 2)
check('B5 runtime: empty title or blank content is refused',
  attach({ key: 'k', title: '  ', content: 'c' }) === false && attach({ key: 'k', title: 't', content: ' \n ' }) === false
  && warnCount('empty title or content') === 2)
const throwingInput = { key: 'k', title: 't', get content(): string { throw new Error('getter') } }
check('B5 runtime: a throwing input getter is refused, not thrown',
  attach(throwingInput) === false && warnCount('rejected unreadable input') === 1)
check('B5 runtime: refused calls staged nothing', chips().length === 1)

// Title sanitization: control characters and newlines fold to one line, the
// label is capped at 80 cells with an ellipsis; content stays verbatim.
check('B6 runtime: title folds to one line',
  attach({ key: 'title', title: 'a\nb\x1b[31mc\td', content: 'line 1\nline 2' }) === true
  && chips().find(item => item.sourceId === 'blender-bridge:title')?.title === 'a bc d'
  && chips().find(item => item.sourceId === 'blender-bridge:title')?.content === 'line 1\nline 2',
  JSON.stringify(chips().find(item => item.sourceId === 'blender-bridge:title')))
attach({ key: 'title', title: '鲸'.repeat(60), content: 'x' })
const capped = chips().find(item => item.sourceId === 'blender-bridge:title')?.title ?? ''
check('B6 runtime: title is capped at 80 cells with an ellipsis',
  stringWidth(capped) <= 80 && capped.endsWith('…'), `${stringWidth(capped)} cells`)

// Four live keys per activation; replacing an existing key stays allowed.
attach({ key: 'k3', title: 'three', content: '3' })
attach({ key: 'k4', title: 'four', content: '4' })
check('B7 runtime: four live chips per activation', chips().filter(item => item.sourceId.startsWith('blender-bridge:')).length === 4)
check('B7 runtime: a fifth key is refused',
  attach({ key: 'k5', title: 'five', content: '5' }) === false && warnCount('4 chips already staged') === 1)
check('B7 runtime: replacing an existing key at the cap still works', attach({ key: 'k4', title: 'four!', content: '4' }) === true)

// Cross-plugin isolation: another activation derives its own prefix, so it
// can neither replace nor detach the verified plugin's chips.
const anonymous = await activation('chips-probe-anonymous')
check('B8 runtime: an anonymous activation gets a session-only sourceId',
  attach({ key: 'selection', title: 'other', content: 'o' }, anonymous.ctx) === true
  && chips().some(item => /^session:act\d+:selection$/u.test(item.sourceId)),
  JSON.stringify(chips().map(item => item.sourceId)))
check('B8 runtime: same key from another plugin is a separate chip',
  chips().find(item => item.sourceId === 'blender-bridge:selection')?.title === 'Blender 选中 · 5')
check('B8 runtime: another plugin cannot detach my chip',
  anonymous.ctx.tuiContextChips.detachContext('k3') === false && chips().some(item => item.sourceId === 'blender-bridge:k3'))

check('B9 runtime: detach removes the chip and reports true', blender.ctx.tuiContextChips.detachContext('k3') === true
  && !chips().some(item => item.sourceId === 'blender-bridge:k3'))
check('B9 runtime: detaching a missing chip reports false', blender.ctx.tuiContextChips.detachContext('k3') === false)
check('B9 runtime: detach rejects an invalid key', blender.ctx.tuiContextChips.detachContext('Bad Key') === false
  && warnCount('detachContext rejected an invalid key') === 1)

// Dispose peels exactly that activation's chips.
const verifiedBefore = chips().filter(item => item.sourceId.startsWith('blender-bridge:')).length
await anonymous.dispose()
check('B10 runtime: disposing an activation peels its chips',
  !chips().some(item => item.sourceId.startsWith('session:act'))
  && chips().filter(item => item.sourceId.startsWith('blender-bridge:')).length === verifiedBefore)

// Grants: read live from the grants file on every attach.
writeGrants({ denies: { root: [{ name: CONTEXT_CHIPS_PERMISSION, scope: 'root' }] } })
check('B11 grants: a root deny refuses every plugin',
  attach({ key: 'selection', title: 'denied', content: 'x' }) === false && warnCount('revoked in the grants file') === 1)
writeGrants({ denies: { 'blender-bridge': [{ name: CONTEXT_CHIPS_PERMISSION, scope: 'blender-bridge' }] } })
const scoped = await activation('chips-probe-anonymous-2')
check('B11 grants: a component deny refuses that plugin…',
  attach({ key: 'selection', title: 'denied', content: 'x' }) === false)
check('B11 grants: …but not an unrelated activation',
  attach({ key: 'selection', title: 'fine', content: 'x' }, scoped.ctx) === true)
writeGrants({ denies: { 'blender-bridge': [{ name: CONTEXT_CHIPS_PERMISSION, scope: 'other-plugin' }] } })
check('B11 grants: a deny scoped to another id does not apply', attach({ key: 'selection', title: 'Blender 选中 · 5', content: 'x' }) === true)
nodeFs.writeFileSync(grantsFile, '{not json')
check('B11 grants: a corrupt grants file fails closed', attach({ key: 'selection', title: 'x', content: 'x' }) === false)
clearGrants()
check('B11 grants: no grants file = default allow', attach({ key: 'selection', title: 'Blender 选中 · 5', content: 'x' }) === true)
await scoped.dispose()

// Rate limit: 20 attaches per minute per activation (replacements count),
// sticky single warning; a fresh activation has its own budget.
const burst = await activation('chips-probe-burst')
let burstOk = 0
for (let index = 0; index < 20; index += 1) {
  if (!attach({ key: 'burst', title: `burst ${index}`, content: String(index) }, burst.ctx)) break
  burstOk += 1
}
check('B12 rate: 20 attaches per minute are allowed', burstOk === 20, `${burstOk}`)
check('B12 rate: the 21st attach is dropped', attach({ key: 'burst', title: 'over', content: 'x' }, burst.ctx) === false)
check('B12 rate: the drop warns exactly once',
  warnCount('rate-limited') === 1 && attach({ key: 'burst', title: 'over', content: 'x' }, burst.ctx) === false && warnCount('rate-limited') === 1)
const fresh = await activation('chips-probe-fresh')
check('B12 rate: a fresh activation has its own budget', attach({ key: 'burst', title: 'fresh', content: 'x' }, fresh.ctx) === true)
await burst.dispose()
await fresh.dispose()

store.setSink(undefined)
check('B13 runtime: no bound channel → attach returns false',
  attach({ key: 'selection', title: 'x', content: 'x' }) === false)
check('B14 host-only: the store and sink are absent from the plugin service',
  !('store' in (blender.ctx.tuiContextChips as object)) && !('setSink' in (blender.ctx.tuiContextChips as object)))
const publicSurface = await import('../src/extensions.js')
check('B14 public surface: extensions shim exports TuiContextChipsRuntime',
  (publicSurface as Record<string, unknown>).TuiContextChipsRuntime === TuiContextChipsRuntime)

// ── C. real channel: submit carries the plugin block once ───────────────
const delivered: Array<{ content: Array<{ type: string; text: string }> }> = []
{
  const makeAgent = (id: string, sessionId: string) => ({
    id,
    status: 'idle',
    options: {},
    ctx: { on: () => () => {} },
    session: { id: sessionId, seq: 0, events: [], header: {} },
    followup(message: { content: Array<{ type: string; text: string }> }) { delivered.push(message) },
    steer(message: { content: Array<{ type: string; text: string }> }) { delivered.push(message) },
    inbox: { remove: () => true },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  })
  const channelCtx = new Context()
  channelCtx.provide('agents' as never, { get: () => undefined, create: () => Promise.reject(new Error('unused')) } as never)
  const channel = createChannel(channelCtx, makeAgent('agent-a', 'sess-a') as never,
    { model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false } as never)
  store.setSink(createChannelContextChipsSink(channel))
  check('C1 channel: the plugin chip lands on the real channel projection',
    attach({ key: 'selection', title: 'Blender 选中 · 3', content: 'Cube, Wheel_FL, Axle' }) === true
    && channel.attachedContexts.length === 1 && channel.attachedContexts[0]!.source === 'plugin')
  channel.submit('把这些改成红色')
  const expected = '<attached-context source="plugin" sourceId="blender-bridge:selection" title="Blender 选中 · 3">\nCube, Wheel_FL, Axle\n</attached-context>'
  check('C2 channel: the next submission carries the plugin block after the typed text',
    await settled(() => delivered.length === 1
      && delivered[0]!.content[0]!.text === '把这些改成红色' && delivered[0]!.content[1]!.text === expected),
    delivered.length === 1 ? JSON.stringify(delivered[0]!.content) : 'no delivery')
  check('C2 channel: the chip is consumed by that submission', channel.attachedContexts.length === 0)
  check('C2 runtime: detach after the chip was sent reports false', blender.ctx.tuiContextChips.detachContext('selection') === false)
  channel.submit('第二条')
  check('C3 channel: the following submission carries no block',
    await settled(() => delivered.length === 2 && delivered[1]!.content.length === 1))
  store.setSink(undefined)
  channel.releaseContributions()
}

// ── D. real PromptInput: chip strip + Esc peeling ────────────────────────
{
  const COLS = 80
  const ROWS = 20
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    override _write(chunk: unknown, _encoding: unknown, callback: () => void): void { term.write(String(chunk), callback) }
  }
  class FakeStderr extends Writable {
    isTTY = true
    override _write(_chunk: unknown, _encoding: unknown, callback: () => void): void { callback() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }

  const { holder, registry } = registryChannel()
  const listeners = new Set<() => void>()
  let version = 0
  const bump = (): void => { version += 1; for (const listener of [...listeners]) listener() }
  const promptChannel = {
    staged: new Map(), rows: [], status: 'idle', sessionTitle: 'probe', agentId: 'probe', agentBindingGeneration: 0,
    model: 'model-00', provider: 'fake-provider', tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo',
    gitBranch: 'main', working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0,
    mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {}, turnStart: 0, lastUserText: '', pending: [],
    commandList: LOCAL_COMMANDS, commandCompletions: () => [], notifications: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    submit() {}, steer() {}, cancel() {}, clear() {}, notify() {},
    stagedImageGeneration: () => 0, stageImage: async () => '[Image #1]', async stageComposerImage() { return { stageId: 'stage-1' } },
    discardStagedImage() {}, hasStagedImage: () => false, stagedImage: () => undefined, stagedImageLimits: () => undefined,
    get version() { return version },
    get attachedContexts() { return holder.attachedContexts },
    attachContext(input: { source: 'panel' | 'plugin'; sourceId: string; title: string; content: string }) { registry.attach(input); bump() },
    detachContext(id: string) { registry.detach(id); bump() },
  }
  store.setSink(createChannelContextChipsSink(promptChannel))

  function Host(): React.ReactElement {
    React.useSyncExternalStore(listener => promptChannel.subscribe(listener), () => promptChannel.version)
    return React.createElement(PromptInput as never, {
      channel: promptChannel, helpOpen: false, onToggleHelp: () => {}, onRunCommand: () => false, selectionActive: false,
    })
  }
  const stdin = new FakeStdin()
  const app = await render(React.createElement(AlternateScreen, null, React.createElement(Host)), {
    stdin: stdin as never, stdout: new FakeStdout() as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false,
  })
  // 固定窗:pacing 等首帧挂载与 useInput 监听注册，无单一可观测锚点。
  await sleep(400)
  check('D1 render: no chip before the plugin stages one', !screenHas(term, '⧉'))
  stdin.write('把这些改成红色')
  check('D1 render: the draft is on screen', await settled(() => screenHas(term, '把这些改成红色')))
  attach({ key: 'selection', title: 'Blender 选中 · 3', content: 'Cube, Wheel_FL, Axle' })
  check('D2 render: the plugin chip renders as ⧉ title', await settled(() => screenHas(term, '⧉ Blender 选中 · 3')))
  const chipAt = findText(term, '⧉ Blender 选中 · 3')
  const draftAt = findText(term, '把这些改成红色')
  check('D2 render: the chip sits above the input row', chipAt !== null && draftAt !== null && chipAt.row < draftAt.row,
    JSON.stringify({ chipAt, draftAt }))
  attach({ key: 'selection', title: 'Blender 选中 · 5', content: 'Cube, Wheel_FL, Wheel_FR, Axle, Body' })
  check('D3 render: a re-staged chip updates in place (one chip, new title)', await settled(() =>
    screenHas(term, '⧉ Blender 选中 · 5') && !screenHas(term, '⧉ Blender 选中 · 3')))
  stdin.write('\x1b')
  check('D4 render: the first Esc peels the plugin chip', await settled(() => !screenHas(term, '⧉') && holder.attachedContexts.length === 0))
  check('D4 render: …and keeps the draft', screenHas(term, '把这些改成红色'))
  await app.unmount()
  store.setSink(undefined)
}

await blender.dispose()
nodeFs.rmSync(isolatedHome, { recursive: true, force: true })

if (failures > 0) {
  console.error(`verify-plugin-context-chips: ${failures} failure(s)`)
  process.exit(1)
}
console.log('verify-plugin-context-chips: ALL PASS')
process.exit(0)
