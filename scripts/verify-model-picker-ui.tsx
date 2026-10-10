/**
 * /model through the real Chat/channel/rendering path, with a fake LLM catalog:
 * recents-first tabs, current-model promotion, forward/backward wrapping, independent model/effort drafts,
 * same-batch navigation/confirmation, cancellation, mouse picks and wheel,
 * focus windowing and resize in inline/fullscreen at 100 and 36 columns;
 * header shortcuts, readable effort colors and an opaque panel surface.
 * Claude/Codex use a flat catalog, focus the current model after loading,
 * omit provider/recents tabs and leave existing recents untouched.
 * Short 2/3/4-row overlays keep the focused model and confirmation visible,
 * with and without descriptions, at the first/middle/last model.
 * No credentials or model calls. Run after pnpm build:
 * node --import tsx/esm scripts/verify-model-picker-ui.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_THEME = 'dark'
process.env.TERM_PROGRAM = 'WezTerm'

import type { AgentEvent } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'

const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join, dirname } = await import('node:path')
const testHome = mkdtempSync(join(tmpdir(), 'dsh-model-picker-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome
const prefsDir = join(testHome, '.dsh-tui')
mkdirSync(prefsDir, { recursive: true })

const [
  { default: assert }, { PassThrough, Writable }, { default: React }, { Terminal },
  { render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel },
  { stringWidth }, { disposeChannelOwner }, { settled, sleep, viewportLines }, { activateModernEmojiWidths }, { modelRecentsFile },
] = await Promise.all([
  import('node:assert/strict'), import('node:stream'), import('react'), import('@xterm/headless'),
  import('../src/ui.js'), import('../src/screens/Chat.js'), import('../src/channel/questions.js'),
  import('../src/dsh-adapter/channel.js'), import('../src/ink/stringWidth.js'),
  import('../src/dsh-adapter/channel/owner.js'), import('./lib/term-test.mjs'),
  import('./lib/modern-widths.mjs'),
  import('../src/modelRecents.js'),
])

const MODELS = [
  ...Array.from({ length: 30 }, (_, index) => ({
    provider: 'alpha', id: `a${index}`, name: `Alpha ${String(index).padStart(2, '0')}`,
    description: `Description ${index}`,
  })),
  { provider: 'beta', id: 'b0', name: 'Beta 00' },
  { provider: 'beta', id: 'b1', name: 'Beta 01' },
  { provider: 'gamma', id: 'g0', name: 'Gamma 00' },
]
const PROVIDERS = [
  { id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' },
  { id: 'gamma', name: '供应商名称🙂很长的供应商标签' },
]
const levels = (ids: readonly string[]) => ids.map(id => ({ id, name: id.toUpperCase() }))
const modelInfo = (provider: string, model: string) => ({
  context: { contextWindow: 64000 },
  ...(provider === 'gamma' || model === 'a2' ? {} : {
    reasoning: provider === 'beta'
      ? { efforts: levels(['off', 'max']), defaultEffort: 'off' }
      : { efforts: levels(['low', 'medium', 'high']), defaultEffort: 'medium' },
  }),
})

function terminalHarness(columns: number) {
  const term = new Terminal({ cols: columns, rows: 30, scrollback: 2000, allowProposedApi: true })
  activateModernEmojiWidths(term)
  class Output extends Writable {
    columns = columns
    rows = 30
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) { term.write(String(chunk), done) }
  }
  class Input extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdout = new Output()
  const stdin = new Input()
  const stderr = new Writable({ write(_chunk, _encoding, done) { done() } })
  return { term, stdout, stdin, stderr }
}

function opaquePanel(term: InstanceType<typeof Terminal>): boolean {
  const lines = viewportLines(term)
  const title = lines.findIndex(line => line.trim() === '模型')
  const levels = lines.findIndex(line => line.includes('LOW'))
  if (title < 2 || levels <= title) return false
  const divider = lines[title - 1]!
  const left = divider.indexOf('─')
  if (left < 0) return false
  for (let row = title - 2; row <= levels; row++) {
    const line = term.buffer.active.getLine(term.buffer.active.baseY + row)!
    for (let col = left; col < stringWidth(divider); col++) {
      if (line.getCell(col)?.isBgDefault() !== false) return false
    }
  }
  return true
}

async function scenario(fullscreen: boolean, columns: number): Promise<void> {
  const label = `${fullscreen ? 'fullscreen' : 'inline'} ${columns} columns`
  writeFileSync(join(prefsDir, 'model-recents.json'), JSON.stringify({ models: [{ provider: 'alpha', id: 'a1' }, { provider: 'alpha', id: 'a0' }, { provider: 'beta', id: 'b0' }] }))
  writeFileSync(join(prefsDir, 'effort.json'), JSON.stringify({ effort: 'medium' }))
  const { term, stdout, stdin, stderr } = terminalHarness(columns)
  const events = Array.from({ length: 20 }, (_, index) => ({
    seq: index, time: Date.now(), type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Fixture history ${index}` }] },
  }))
  const ctx = {
    on: () => () => {}, logger: { warn() {} },
    get: (name: string) => name === 'llm' ? {
      listProviders: () => PROVIDERS,
      listModels: async (provider: string) => MODELS.filter(model => model.provider === provider),
      resolveModelInfo: async (provider: string, model: string) => modelInfo(provider, model),
    } : undefined,
  }
  const agent = { id: 'picker-fixture', status: 'idle', ctx, session: { id: 'fixture-session', seq: events.length, events, header: {} }, inbox: { remove: () => true } }
  const channel = createChannel(ctx as never, agent as never, { provider: 'alpha', model: 'a0', cwd: '/tmp', activity: false, whaleIdle: false, effort: 'medium' })
  const switches: string[] = []
  const effortPicks: string[] = []
  channel.switchModel = async (provider, model) => {
    switches.push(`${provider}/${model}`)
    if (channel.provider === provider && channel.model === model) return true
    channel.provider = provider
    channel.model = model
    channel.reasoningEffort = undefined
    channel.emit()
    return true
  }
  const setEffort = channel.setEffort
  channel.setEffort = id => { effortPicks.push(id); return setEffort(id) }
  const screen = <Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen={fullscreen} onExit={() => {}} />
  const app = await render(fullscreen ? <AlternateScreen>{screen}</AlternateScreen> : screen, { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false })

  const hit = (text: string) => {
    const lines = viewportLines(term)
    for (let row = 0; row < lines.length; row++) {
      const index = lines[row].indexOf(text)
      if (index >= 0) return { col: stringWidth(lines[row].slice(0, index)), row }
    }
    return undefined
  }
  const inverse = (text: string) => {
    const point = hit(text)
    return point !== undefined && Boolean(term.buffer.active.getLine(term.buffer.active.baseY + point.row)?.getCell(point.col)?.isInverse())
  }
  const focused = (text: string) => viewportLines(term).some(line => line.includes('❯') && line.includes(text))
  const cell = (text: string) => {
    const point = hit(text)
    return point === undefined ? undefined : term.buffer.active.getLine(term.buffer.active.baseY + point.row)?.getCell(point.col)
  }
  const check = async (name: string, condition: () => boolean) => {
    const ok = await settled(condition)
    if (!ok) console.error(viewportLines(term).join('\n'))
    assert.ok(ok, `${label}: ${name}`)
  }
  const open = async (model = 'Alpha 00', effort = 'MEDIUM') => {
    stdin.write('/model')
    await check('command reaches composer', () => hit('/model') !== undefined)
    stdin.write('\r')
    await check('recent tab and focused model', () => inverse('最近使用') && focused(model) && inverse(effort))
  }
  const click = async (text: string) => {
    const point = hit(text)
    assert.ok(point, `${label}: mouse target ${text}`)
    stdin.write(`\x1b[<0;${point.col + 1};${point.row + 1}M\x1b[<0;${point.col + 1};${point.row + 1}m`)
  }
  try {
    await check('boot', () => hit('Fixture history 19') !== undefined)
    await open()
    assert.ok(hit('Alpha') && hit('最近使用'))
    await check('all effort levels remain visible when the strip fits', () => hit('LOW') !== undefined && hit('MEDIUM') !== undefined && hit('HIGH') !== undefined)
    await check('shortcuts sit above provider tabs and models', () => {
      const tabs = hit('最近使用')?.row ?? -1
      return ['Tab', 'Shift+Tab', '↑/↓', 'Enter', 'Esc'].every(text => {
        const row = hit(text)?.row ?? -1
        return row >= 0 && row < tabs
      }) && tabs < (hit('alpha / Alpha 00')?.row ?? -1)
    })
    await check('effort has its own heading and full-width strip', () => {
      const heading = hit('推理强度')?.row ?? -1
      return heading > (hit('beta / Beta 00')?.row ?? -1)
        && hit('←/→')?.row === heading && hit('LOW')?.row === heading + 1
    })
    assert.notEqual(cell('LOW')?.getFgColor(), cell('Tab')?.getFgColor(), `${label}: selectable effort must be brighter than hints`)
    assert.notEqual(cell('推理强度')?.getFgColor(), cell('Tab')?.getFgColor(), `${label}: effort heading must stand out from hints`)
    await check('every panel cell, including gaps and padding, has an opaque background', () => opaquePanel(term))
    await check('mixed-provider recents', () => hit('beta / Beta 00') !== undefined)
    assert.deepEqual(JSON.parse(readFileSync(join(prefsDir, 'model-recents.json'), 'utf8')).models, [
      { provider: 'alpha', id: 'a0' }, { provider: 'alpha', id: 'a1' }, { provider: 'beta', id: 'b0' },
    ], `${label}: opening promotes the already-listed current model without duplicates`)
    await sleep(90) // 固定窗:墙钟 Chat's 80ms modal-Enter debounce.
    stdin.write('\r')
    await check('Enter without navigation keeps the current model and effort', () => channel.model === 'a0' && channel.reasoningEffort === 'medium' && hit('最近使用') === undefined)
    assert.deepEqual(switches, ['alpha/a0'])
    assert.deepEqual(effortPicks, [], 'confirming without an effort draft must not persist a derived default')
    switches.length = 0
    effortPicks.length = 0
    await open()
    const beforePreference = readFileSync(join(prefsDir, 'effort.json'), 'utf8')
    stdin.write('\t\x1b[B')
    await check('Tab and Down in one batch select a provider model', () => inverse('Alpha') && focused('Alpha 01') && inverse('MEDIUM'))
    stdin.write('\x1b[C')
    await check('Right adjusts the model draft', () => inverse('HIGH'))
    stdin.write('\t')
    await check('next provider has its own levels', () => inverse('Beta') && focused('Beta 00') && inverse('OFF'))
    stdin.write('\x1b[C')
    await check('two-level model adjusts right', () => inverse('MAX'))
    stdin.write('\x1b[Z')
    await check('Shift+Tab preserves model and effort draft', () => inverse('Alpha') && focused('Alpha 01') && inverse('HIGH'))
    assert.deepEqual(switches, [], 'browsing must not switch the live model')
    assert.deepEqual(effortPicks, [], 'browsing must not set the live effort')
    stdin.write('\x1b')
    await check('Esc closes immediately', () => hit('最近使用') === undefined)
    assert.equal(channel.model, 'a0')
    assert.equal(channel.reasoningEffort, 'medium')
    assert.equal(readFileSync(join(prefsDir, 'effort.json'), 'utf8'), beforePreference)

    await open()
    stdin.write('\x1b[Z')
    await check('previous provider wraps to last and is visible', () => focused('Gamma 00') && inverse('供应商') && hit('不支持') !== undefined)
    stdin.write('\t')
    await check('next provider wraps to recents', () => inverse('最近使用') && focused('Alpha 00'))
    stdin.write('\t\x1b[B')
    await check('cancelled draft was discarded', () => focused('Alpha 01') && inverse('MEDIUM'))
    await sleep(90) // 固定窗:墙钟 Chat's 80ms modal-Enter debounce.
    stdin.write('\x1b[C\r')
    await check('Right and Enter apply the new model and effort', () => channel.model === 'a1' && channel.reasoningEffort === 'high' && hit('最近使用') === undefined)
    assert.deepEqual(switches, ['alpha/a1'])
    assert.deepEqual(effortPicks, ['high'])
    assert.equal(JSON.parse(readFileSync(join(prefsDir, 'effort.json'), 'utf8')).effort, 'high', 'an explicit effort draft is persisted')

    await open('Alpha 01', 'HIGH')
    stdin.write('\t')
    await check('provider ready for long-list navigation', () => inverse('Alpha') && focused('Alpha 01'))
    for (let index = 0; index < 19; index++) stdin.write('\x1b[B')
    await check('focused model remains visible deep in a described list', () => focused('Alpha 20'))
    stdout.columns = 28
    term.resize(28, 30)
    stdout.emit('resize')
    await check('focus survives narrow resize', () => focused('Alpha 20'))
    stdin.write('\t')
    await check('active provider remains visible after resize', () => inverse('Beta') && focused('Beta 00'))
    stdout.columns = columns
    term.resize(columns, 30)
    stdout.emit('resize')
    await check('resize restored', () => inverse('Beta') && focused('Beta 00') && inverse('OFF'))
    if (fullscreen) {
      await click('Beta 01')
      await check('mouse focuses a model', () => focused('Beta 01') && inverse('OFF'))
      await click('MAX')
      await check('mouse selects effort draft', () => inverse('MAX'))
      await click('选择')
      await check('mouse applies model and effort', () => channel.model === 'b1' && channel.reasoningEffort === 'max' && hit('最近使用') === undefined)
      stdin.write('/model')
      await check('mouse follow-up command', () => hit('/model') !== undefined)
      stdin.write('\r')
      await check('mouse provider tabs ready', () => inverse('最近使用') && focused('Beta 01'))
      await click('Alpha')
      await check('mouse selects provider', () => inverse('Alpha') && focused('Alpha 00'))
      const point = hit('Alpha 00')!
      stdin.write(`\x1b[<65;${point.col + 1};${point.row + 1}M`)
      await check('wheel moves model focus', () => focused('Alpha 01'))
      await click('取消')
      await check('mouse cancels', () => hit('最近使用') === undefined)
      assert.equal(channel.model, 'b1')
    } else {
      stdin.write('\x1b')
      await check('inline closes cleanly', () => hit('最近使用') === undefined)
    }
    console.log(`PASS /model ${label}`)
  } finally {
    app.unmount()
    disposeChannelOwner(channel)
    term.dispose()
  }
}

async function backendSurface(backendId: 'claude' | 'codex', fullscreen: boolean, columns: number): Promise<void> {
  const label = `${backendId} ${fullscreen ? 'fullscreen' : 'inline'} ${columns} columns`
  const { term, stdout, stdin, stderr } = terminalHarness(columns)
  const events: AgentEvent[] = Array.from({ length: 20 }, (_, seq) => ({
    type: 'user.message', seq, anchor: `history-${seq}`, id: `message-${seq}`, time: Date.now(),
    source: 'user', text: `Backend history ${seq}`, blocks: [{ type: 'text', text: `Backend history ${seq}` }],
  }))
  const levels = ['low', 'medium', 'high'].map(id => ({ id, label: id.toUpperCase() }))
  const picks: string[] = []
  const effortPicks: (string | null)[] = []
  const session: AgentSession = {
    ref: { backendId, sessionId: 'surface-fixture' }, cwd: '/tmp', status: 'idle',
    capabilities: {
      native: {},
      models: {
        list: async () => [{ id: 'm1', label: 'Model 01' }, { id: 'm0', label: 'Model 00' }],
        current: () => ({ model: 'm0' }), set: async ref => { picks.push(ref.model); return { kind: 'switched' } },
      },
      effort: {
        levels: () => levels, forModel: () => ({ levels, defaultEffort: 'medium' }),
        current: () => 'medium', set: async id => { effortPicks.push(id) },
      },
    },
    history: async () => events, subscribe: () => () => {}, submit: async () => ({ accepted: true }),
    cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }), dispose: async () => {},
  }
  const ctx = { on: () => () => {}, get: () => undefined, logger: { warn() {} } }
  const channel = createChannel(ctx as never, session, {
    provider: backendId, model: 'm0', backendLabel: backendId, cwd: '/tmp', activity: false, whaleIdle: false, effort: 'medium',
  })
  const recentFile = join(prefsDir, modelRecentsFile(backendId))
  mkdirSync(dirname(recentFile), { recursive: true })
  writeFileSync(recentFile, JSON.stringify({ models: [{ provider: backendId, id: 'm1' }, { provider: backendId, id: 'm0' }] }))
  const previousRecents = readFileSync(recentFile, 'utf8')
  const screen = <Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen={fullscreen} onExit={() => {}} />
  const app = await render(fullscreen ? <AlternateScreen>{screen}</AlternateScreen> : screen, { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false })
  const text = () => viewportLines(term).join('\n')
  const focused = (name: string) => viewportLines(term).some(line => line.includes('❯') && line.includes(name))
  try {
    assert.ok(await settled(() => text().includes('Backend history 19')), `${label}: boot`)
    stdin.write('/model')
    assert.ok(await settled(() => text().includes('/model')), `${label}: composer`)
    stdin.write('\r')
    assert.ok(await settled(() => text().includes('Model 01') && focused('Model 00') && opaquePanel(term)), `${label}: flat opaque catalog focuses the current model after loading`)
    assert.equal(text().includes('最近使用'), false, `${label}: no recents tab`)
    assert.equal(text().includes('Shift+Tab 提供商'), false, `${label}: no provider navigation hint`)
    const lines = viewportLines(term)
    const titleRow = lines.findIndex(line => line.trim() === '模型')
    const firstModelRow = lines.findIndex(line => line.includes('Model 01'))
    assert.deepEqual(lines.slice(titleRow + 1, firstModelRow).map(line => line.trim()).filter(Boolean),
      ['↑/↓ 模型 · Enter 选择 · Esc 取消'], `${label}: header contains only model/action shortcuts`)
    assert.equal(readFileSync(recentFile, 'utf8'), previousRecents, `${label}: opening does not update recents`)
    stdin.write('\t\x1b[Z')
    await sleep(90) // 固定窗:探针 Tab/Shift+Tab must not move flat-catalog focus or cycle the session mode.
    assert.ok(focused('Model 00') && opaquePanel(term), `${label}: Tab/Shift+Tab keep the current model focused`)
    await sleep(90) // 固定窗:墙钟 Chat's 80ms modal-Enter debounce.
    stdin.write('\r')
    assert.ok(await settled(() => !text().includes('推理强度') && picks.length === 1), `${label}: Enter confirms the current model`)
    assert.deepEqual(picks, ['m0'])
    assert.deepEqual(effortPicks, [], `${label}: a derived default is not an explicit effort choice`)
    stdin.write('/model')
    assert.ok(await settled(() => text().includes('/model')), `${label}: reopen composer`)
    stdin.write('\r')
    assert.ok(await settled(() => focused('Model 00') && opaquePanel(term)), `${label}: reopen flat catalog`)
    stdin.write('\x1b[A')
    assert.ok(await settled(() => focused('Model 01') && opaquePanel(term)), `${label}: Up selects another model`)
    stdin.write('\x1b')
    assert.ok(await settled(() => !text().includes('推理强度') && text().includes('Backend history 19')), `${label}: cancel restores transcript`)
    assert.deepEqual(picks, ['m0'], `${label}: cancellation discards the model draft`)
    if (fullscreen) {
      stdin.write('/model')
      assert.ok(await settled(() => text().includes('/model')), `${label}: mouse composer`)
      stdin.write('\r')
      assert.ok(await settled(() => focused('Model 00') && opaquePanel(term)), `${label}: mouse catalog`)
      const click = async (needle: string) => {
        const lines = viewportLines(term)
        const row = lines.findIndex(line => line.includes(needle))
        assert.ok(row >= 0, `${label}: mouse target ${needle}`)
        const col = stringWidth(lines[row]!.slice(0, lines[row]!.indexOf(needle)))
        stdin.write(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`)
      }
      await click('Model 01')
      assert.ok(await settled(() => focused('Model 01') && opaquePanel(term)), `${label}: mouse selects a model`)
      await click('HIGH')
      await click('选择')
      assert.ok(await settled(() => !text().includes('推理强度') && picks.length === 2 && effortPicks.at(-1) === 'high'), `${label}: mouse applies model and reasoning`)
      assert.deepEqual(picks, ['m0', 'm1'])
    } else {
      assert.deepEqual(effortPicks, [], `${label}: no reasoning changes without an explicit draft`)
    }
    assert.equal(readFileSync(recentFile, 'utf8'), previousRecents, `${label}: confirmation and cancellation do not update recents`)
    console.log(`PASS /model flat opaque ${label}`)
  } finally {
    app.unmount()
    disposeChannelOwner(channel)
    term.dispose()
  }
}

async function shortTerminal(backendId: 'dsh' | 'claude' | 'codex', fullscreen: boolean, described: boolean, columns: number): Promise<void> {
  const label = `${backendId} ${fullscreen ? 'fullscreen' : 'inline'} ${described ? 'described' : 'plain'} short terminal ${columns} columns`
  const models = Array.from({ length: 3 }, (_, index) => ({
    provider: backendId === 'dsh' ? 'alpha' : backendId, id: `a${index}`, name: `Short model ${index}`,
    ...(described ? { description: `Short description ${index}` } : {}),
  }))
  const events: AgentEvent[] = Array.from({ length: 20 }, (_, seq) => ({
    type: 'user.message', seq, anchor: `short-${seq}`, id: `short-${seq}`, time: Date.now(),
    source: 'user', text: `Short history ${seq}`, blocks: [{ type: 'text', text: `Short history ${seq}` }],
  }))
  const options = levels(['low', 'medium', 'high'])
  const ctx = {
    on: () => () => {}, logger: { warn() {} },
    get: (name: string) => name === 'llm' ? {
      listProviders: () => [PROVIDERS[0]!], listModels: async () => models,
      resolveModelInfo: async () => ({ reasoning: { efforts: options, defaultEffort: 'medium' } }),
    } : undefined,
  }
  const session: AgentSession = {
    ref: { backendId, sessionId: 'short-fixture' }, cwd: '/tmp', status: 'idle',
    capabilities: {
      native: {},
      models: {
        list: async () => models.map(model => ({ ...model, label: model.name })),
        current: () => ({ model: 'a0' }), set: async () => ({ kind: 'switched' }),
      },
      effort: {
        levels: () => options.map(option => ({ id: option.id, label: option.name })),
        current: () => 'medium', set: async () => {},
      },
    },
    history: async () => events, subscribe: () => () => {}, submit: async () => ({ accepted: true }),
    cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }), dispose: async () => {},
  }
  const agent = {
    id: 'short-fixture', status: 'idle', ctx,
    session: { id: 'short-session', seq: events.length, header: {}, events: events.map(event => ({
      seq: event.seq, time: event.time, type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Short history ${event.seq}` }] },
    })) }, inbox: { remove: () => true },
  }
  writeFileSync(join(prefsDir, 'model-recents.json'), JSON.stringify({ models: models.map(({ provider, id }) => ({ provider, id })) }))
  const channel = createChannel(ctx as never, backendId === 'dsh' ? agent as never : session, {
    provider: models[0]!.provider, model: 'a0', cwd: '/tmp', effort: 'medium', activity: false, whaleIdle: false,
  })
  const picks: string[] = []
  channel.switchModel = async (_provider, model) => { picks.push(model); return true }
  const { term, stdout, stdin, stderr } = terminalHarness(columns)
  const screen = <Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen={fullscreen} onExit={() => {}} />
  const app = await render(fullscreen ? <AlternateScreen>{screen}</AlternateScreen> : screen, { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false })
  const text = () => viewportLines(term).join('\n')
  const check = async (name: string, condition: () => boolean) => {
    const ok = await settled(condition)
    if (!ok) console.error(text())
    assert.ok(ok, `${label}: ${name}`)
  }
  try {
    await check('boot', () => text().includes('Short history 19'))
    stdin.write('/model')
    await check('composer', () => text().includes('/model'))
    stdin.write('\r')
    await check('catalog ready', () => text().includes('Short model 2') && text().includes('MEDIUM'))
    for (const rows of [11, 12, 10]) {
      stdout.rows = rows
      term.resize(columns, rows)
      stdout.emit('resize')
      for (let index = 0; index < models.length; index++) {
        await check(`${rows - 8}-row overlay, focused model ${index} and actions`, () => {
          const lines = viewportLines(term)
          return lines.some(line => line.includes('❯') && line.includes(models[index]!.name))
            && text().includes('Enter 选择') && text().includes('Esc 取消')
            && models.filter(model => text().includes(model.name)).length === 1
            && !text().includes('Short description')
            && (rows > 10 ? text().includes('推理强度') : !text().includes('推理强度'))
        })
        if (index < models.length - 1 || rows !== 10) stdin.write('\x1b[B')
      }
    }
    if (fullscreen) {
      const lines = viewportLines(term)
      const row = lines.findIndex(line => line.includes('选择'))
      const col = stringWidth(lines[row]!.slice(0, lines[row]!.indexOf('选择')))
      stdin.write(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`)
    } else {
      await sleep(90) // 固定窗:墙钟 Chat's 80ms modal-Enter debounce.
      stdin.write('\r')
    }
    await check('visible confirmation applies the last focused model', () => picks.length === 1 && !text().includes('Enter 选择'))
    assert.deepEqual(picks, ['a2'])
    console.log(`PASS /model ${label}`)
  } finally {
    app.unmount()
    disposeChannelOwner(channel)
    term.dispose()
  }
}

/** Actual DSH route adoption and preference application, plus modal/global key priority. */
async function reviewRegression(fullscreen: boolean): Promise<void> {
  const label = fullscreen ? 'fullscreen sidebar' : 'inline preference'
  const prefs = await import('../src/tuiDisplayPrefs.js')
  const previousPanel = { split: prefs.getSidePanelSplitEnabled(), open: prefs.getSidePanelOpen(), panels: prefs.getSidePanelPanels() }
  prefs.applySidePanelSplitEnabled(fullscreen)
  prefs.applySidePanelOpen(false)
  prefs.applySidePanelPanels('info')
  const preferenceFile = join(prefsDir, 'effort.json')
  writeFileSync(preferenceFile, '{"effort":"high"}')
  const beforePreference = readFileSync(preferenceFile, 'utf8')
  writeFileSync(join(prefsDir, 'model-recents.json'), JSON.stringify({ models: [{ provider: 'alpha', id: 'a0' }] }))
  const { term, stdout, stdin, stderr } = terminalHarness(fullscreen ? 150 : 100)
  const events = Array.from({ length: 20 }, (_, seq) => ({
    seq, time: Date.now(), type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Review history ${seq}` }] },
  }))
  const makeAgent = (id: string, seed: readonly unknown[]) => ({
    id, status: 'idle', ctx: { on: () => () => {} },
    session: { id: `session-${id}`, seq: seed.length, events: seed, header: {} },
    inbox: { remove: () => true }, followup() {}, steer() {},
  })
  let agentCount = 0
  const ctx = {
    on: () => () => {}, logger: { warn() {} },
    get: (name: string) => name === 'llm' ? {
      listProviders: () => [PROVIDERS[0]!],
      listModels: async () => MODELS.slice(0, 2),
      resolveModelInfo: async (provider: string, model: string) => modelInfo(provider, model),
    } : name === 'agents' ? {
      create: async (options: { seed: readonly unknown[] }) => ({ agent: makeAgent(`fork-${++agentCount}`, options.seed), dispose: async () => {} }),
    } : undefined,
  }
  const channel = createChannel(ctx as never, makeAgent('initial', events) as never, { provider: 'alpha', model: 'a0', cwd: '/tmp', effort: 'high', activity: false, whaleIdle: false })
  const effortPicks: string[] = []
  const setEffort = channel.setEffort
  channel.setEffort = id => { effortPicks.push(id); return setEffort(id) }
  const screen = <Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen={fullscreen} onExit={() => {}} />
  const app = await render(fullscreen ? <AlternateScreen>{screen}</AlternateScreen> : screen, { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false })
  const lines = () => viewportLines(term)
  const text = () => lines().join('\n')
  const focused = (name: string) => lines().some(line => line.includes('❯') && line.includes(name))
  const inverse = (needle: string) => {
    const view = lines()
    const row = view.findIndex(line => line.includes(needle))
    if (row < 0) return false
    const col = stringWidth(view[row]!.slice(0, view[row]!.indexOf(needle)))
    return Boolean(term.buffer.active.getLine(term.buffer.active.baseY + row)?.getCell(col)?.isInverse())
  }
  const check = async (name: string, condition: () => boolean) => {
    const ok = await settled(condition)
    if (!ok) console.error(text(), channel.notifications)
    assert.ok(ok, `${label}: ${name}`)
  }
  const pickerWidth = () => {
    const view = lines()
    const hint = view.findIndex(line => line.includes('↑/↓ 模型'))
    return view[hint - 2]?.match(/─+/u)?.[0].length ?? 0
  }
  try {
    await check('boot', () => text().includes('Review history 19'))
    stdin.write('/model')
    await check('composer', () => text().includes('/model'))
    stdin.write('\r')
    await check('picker', () => focused('Alpha 00') && text().includes('最近使用'))
    if (fullscreen) {
      const wide = pickerWidth()
      stdin.write('\x02')
      await check('Ctrl+B opens the sidebar without dismissing the picker', () => prefs.getSidePanelOpen() && focused('Alpha 00') && pickerWidth() < wide)
      stdin.write('\x02')
      await check('Ctrl+B closes the sidebar while the picker stays open', () => !prefs.getSidePanelOpen() && focused('Alpha 00') && pickerWidth() === wide)
      stdin.write('\x02')
      await check('Ctrl+B reopens and focuses the sidebar', () => prefs.getSidePanelOpen() && pickerWidth() < wide)
      const splitWidth = pickerWidth()
      stdin.write('\x1bz')
      await check('Alt+Z zooms the sidebar while the picker stays open', () => pickerWidth() > 0 && pickerWidth() < splitWidth && text().includes('最近使用'))
      stdin.write('\x1bz')
      await check('Alt+Z restores the split', () => pickerWidth() === splitWidth)
      stdin.write('\t\x1b[B')
      await check('Tab/Down belong to the picker while the sidebar owns focus', () => focused('Alpha 01'))
      stdin.write('\x1b[C')
      await check('Right changes the effort draft instead of the active panel', () => inverse('HIGH') && focused('Alpha 01'))
      stdin.write('\x1b')
      await check('Esc closes the picker before the sidebar', () => !text().includes('最近使用') && prefs.getSidePanelOpen())
      assert.deepEqual(effortPicks, [])
      stdin.write('\x02')
      await check('Ctrl+B closes the focused sidebar', () => !prefs.getSidePanelOpen())
      stdin.write('/model')
      await check('reopen composer', () => text().includes('/model'))
      stdin.write('\r')
      await check('reopened picker', () => focused('Alpha 00'))
    }
    stdin.write('\t\x1b[B')
    await check('target with a medium default', () => focused('Alpha 01') && text().includes('MEDIUM'))
    await sleep(90) // 固定窗:墙钟 Chat's 80ms modal-Enter debounce.
    stdin.write('\r')
    await check('the saved high preference is applied by actual route binding', () => channel.model === 'a1' && channel.reasoningEffort === 'high' && !text().includes('最近使用'))
    assert.deepEqual(effortPicks, [], 'model-only confirmation must not call setEffort')
    assert.equal(readFileSync(preferenceFile, 'utf8'), beforePreference, 'model-only confirmation preserves effort.json byte-for-byte')
    assert.equal(channel.notifications.some(note => note.text.includes('推理强度 →')), false, 'no effort-switched notification without a draft')
    console.log(`PASS /model review regressions ${label}`)
  } finally {
    app.unmount()
    disposeChannelOwner(channel)
    term.dispose()
    prefs.applySidePanelSplitEnabled(previousPanel.split)
    prefs.applySidePanelOpen(previousPanel.open)
    prefs.applySidePanelPanels(previousPanel.panels)
  }
}

try {
  for (const backend of ['dsh', 'claude', 'codex'] as const) {
    for (const fullscreen of [false, true]) for (const described of [true, false]) {
      for (const columns of [100, 36]) await shortTerminal(backend, fullscreen, described, columns)
    }
  }
  for (const fullscreen of [false, true]) for (const columns of [100, 36]) await scenario(fullscreen, columns)
  for (const backend of ['claude', 'codex'] as const) {
    for (const fullscreen of [false, true]) for (const columns of [100, 36]) await backendSurface(backend, fullscreen, columns)
  }
  for (const fullscreen of [false, true]) await reviewRegression(fullscreen)
} finally {
  rmSync(testHome, { recursive: true, force: true })
}
