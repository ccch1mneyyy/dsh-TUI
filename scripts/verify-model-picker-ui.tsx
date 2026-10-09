/**
 * /model through the real Chat/channel/rendering path, with a fake LLM catalog:
 * recents-first tabs, current-model promotion, forward/backward wrapping, independent model/effort drafts,
 * same-batch navigation/confirmation, cancellation, mouse picks and wheel,
 * focus windowing and resize in inline/fullscreen at 100 and 36 columns;
 * header shortcuts, readable effort colors and an opaque panel surface.
 * Claude/Codex capability fixtures check the same surface in both modes.
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
    assert.deepEqual(effortPicks, ['medium'])
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
  const session: AgentSession = {
    ref: { backendId, sessionId: 'surface-fixture' }, cwd: '/tmp', status: 'idle',
    capabilities: {
      native: {},
      models: {
        list: async () => [{ id: 'm0', label: 'Model 00' }, { id: 'm1', label: 'Model 01' }],
        current: () => ({ model: 'm0' }), set: async ref => { picks.push(ref.model); return { kind: 'switched' } },
      },
      effort: {
        levels: () => levels, forModel: () => ({ levels, defaultEffort: 'medium' }),
        current: () => 'medium', set: async () => {},
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
  const screen = <Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen={fullscreen} onExit={() => {}} />
  const app = await render(fullscreen ? <AlternateScreen>{screen}</AlternateScreen> : screen, { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false })
  const text = () => viewportLines(term).join('\n')
  try {
    assert.ok(await settled(() => text().includes('Backend history 19')), `${label}: boot`)
    stdin.write('/model')
    assert.ok(await settled(() => text().includes('/model')), `${label}: composer`)
    stdin.write('\r')
    assert.ok(await settled(() => text().includes('最近使用') && opaquePanel(term)), `${label}: opaque recent tab`)
    assert.deepEqual(JSON.parse(readFileSync(recentFile, 'utf8')).models, [
      { provider: backendId, id: 'm0' }, { provider: backendId, id: 'm1' },
    ], `${label}: current model becomes the first recent`)
    await sleep(90) // 固定窗:墙钟 Chat's 80ms modal-Enter debounce.
    stdin.write('\r')
    assert.ok(await settled(() => !text().includes('最近使用') && picks.length === 1), `${label}: Enter confirms the current model`)
    assert.deepEqual(picks, ['m0'])
    stdin.write('/model')
    assert.ok(await settled(() => text().includes('/model')), `${label}: reopen composer`)
    stdin.write('\r')
    assert.ok(await settled(() => text().includes('最近使用') && opaquePanel(term)), `${label}: reopen recent tab`)
    stdin.write('\t')
    assert.ok(await settled(() => text().includes('Model 01') && opaquePanel(term)), `${label}: opaque backend tab`)
    stdin.write('\x1b')
    assert.ok(await settled(() => !text().includes('最近使用') && text().includes('Backend history 19')), `${label}: cancel restores transcript`)
    console.log(`PASS /model opaque ${label}`)
  } finally {
    app.unmount()
    disposeChannelOwner(channel)
    term.dispose()
  }
}

try {
  for (const fullscreen of [false, true]) for (const columns of [100, 36]) await scenario(fullscreen, columns)
  for (const backend of ['claude', 'codex'] as const) {
    for (const fullscreen of [false, true]) for (const columns of [100, 36]) await backendSurface(backend, fullscreen, columns)
  }
} finally {
  rmSync(testHome, { recursive: true, force: true })
}
