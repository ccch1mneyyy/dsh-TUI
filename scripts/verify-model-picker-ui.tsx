/**
 * /model through the real Chat/channel/rendering path, with a fake LLM catalog:
 * recents-first tabs, forward/backward wrapping, independent model/effort drafts,
 * same-batch navigation/confirmation, cancellation, mouse picks and wheel,
 * focus windowing and resize in inline/fullscreen at 100 and 36 columns.
 * No credentials or model calls. Run after pnpm build:
 * node --import tsx/esm scripts/verify-model-picker-ui.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_THEME = 'dark'
process.env.TERM_PROGRAM = 'WezTerm'

const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const testHome = mkdtempSync(join(tmpdir(), 'dsh-model-picker-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome
const prefsDir = join(testHome, '.dsh-tui')
mkdirSync(prefsDir, { recursive: true })

const [
  { default: assert }, { PassThrough, Writable }, { default: React }, { Terminal },
  { render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel },
  { stringWidth }, { disposeChannelOwner }, { settled, sleep, viewportLines },
] = await Promise.all([
  import('node:assert/strict'), import('node:stream'), import('react'), import('@xterm/headless'),
  import('../src/ui.js'), import('../src/screens/Chat.js'), import('../src/channel/questions.js'),
  import('../src/dsh-adapter/channel.js'), import('../src/ink/stringWidth.js'),
  import('../src/dsh-adapter/channel/owner.js'), import('./lib/term-test.mjs'),
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

async function scenario(fullscreen: boolean, columns: number): Promise<void> {
  const label = `${fullscreen ? 'fullscreen' : 'inline'} ${columns} columns`
  writeFileSync(join(prefsDir, 'model-recents.json'), JSON.stringify({ models: [{ provider: 'alpha', id: 'a1' }, { provider: 'beta', id: 'b0' }] }))
  writeFileSync(join(prefsDir, 'effort.json'), JSON.stringify({ effort: 'medium' }))
  const term = new Terminal({ cols: columns, rows: 30, scrollback: 2000, allowProposedApi: true })
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
    await check('mixed-provider recents', () => hit('beta / Beta 00') !== undefined)
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

try {
  for (const fullscreen of [false, true]) for (const columns of [100, 36]) await scenario(fullscreen, columns)
} finally {
  rmSync(testHome, { recursive: true, force: true })
}
