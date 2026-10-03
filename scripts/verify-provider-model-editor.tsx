/**
 * /provider model capability editor: parsing, real Chat keyboard ownership,
 * draft/cancel semantics, narrow inline/fullscreen layout, ordinary-question
 * Tab compatibility, and upstream consumption of the saved capability shape.
 * Run: node --import tsx/esm scripts/verify-provider-model-editor.tsx
 */
import './lib/fake-home.mjs'
import type { ComponentProps } from 'react'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [assertModule, streams, React, xterm, ui, chatModule, questionsModule, capabilities, termTest, upstream] = await Promise.all([
  import('node:assert/strict'), import('node:stream'), import('react'), import('@xterm/headless'),
  import('../src/ui.js'), import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/provider-model-capabilities.js'), import('./lib/term-test.mjs'),
  import('@deepseek-ai/dsh-llm-pi-ai'),
])
const assert = assertModule.default
const { PassThrough, Writable } = streams
const { Terminal } = xterm
const { render, ThemeProvider, AlternateScreen } = ui
const { Chat } = chatModule
const { QuestionStore } = questionsModule
const { createProviderModelEditor, parseModelCapacity, parseModelReasoning, formatModelReasoning } = capabilities
const { settled, viewportLines } = termTest

assert.equal(parseModelCapacity(''), undefined)
assert.equal(parseModelCapacity('200k'), 200000)
assert.equal(parseModelCapacity('1.5M'), 1500000)
for (const value of ['0', '-1', '1.5', '1e6', 'NaN', '9007199254740992']) assert.throws(() => parseModelCapacity(value))
const reasoning = { off: null, low: 'low', high: 'high', max: 'ultra' }
assert.deepEqual(parseModelReasoning('off,low,high,max=ultra'), reasoning)
assert.deepEqual(parseModelReasoning(formatModelReasoning(reasoning)), reasoning)
assert.equal(parseModelReasoning('none'), false)
assert.equal(parseModelReasoning(''), undefined)
for (const value of ['off', 'high,high', 'unknown', 'high=', 'off,', 'none,high']) assert.throws(() => parseModelReasoning(value))
console.log('PASS: capacity and reasoning parsing / invalid-value rejection')

const original = {
  id: 'model-a', contextWindow: 4000, maxTokens: 1000,
  reasoningEfforts: { high: 'gateway-high' }, input: ['text'] as const,
  compat: { supportsDeveloperRole: false }, customField: 'preserved',
}
{
  const staged = createProviderModelEditor(() => original, new Map())
  staged.editor.save('model-a', { ...staged.editor.read('model-a').values, contextWindow: 200000 })
  assert.equal(staged.entries.get('model-a')?.contextWindow, 200000)
  assert.equal(original.contextWindow, 4000)
  staged.editor.save('model-a', staged.editor.read('model-a').values)
  assert.equal(staged.entries.size, 1)
  staged.editor.save('model-a', { ...staged.editor.read('model-a').values, contextWindow: 4000 })
  assert.equal(staged.entries.size, 0)
  assert.throws(() => staged.editor.save('model-a', { reasoningEfforts: { high: null } }))
}
console.log('PASS: independent drafts, no-op saves, revert and invalid wire mapping')

async function exercise(fullscreen: boolean, columns: number, rows: number) {
  const terminal = new Terminal({ cols: columns, rows, scrollback: 1000, allowProposedApi: true })
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) { terminal.write(String(chunk), callback) },
  }), { columns, rows, isTTY: true })
  const stderr = Object.assign(new Writable({ write(_chunk, _encoding, callback) { callback() } }), { isTTY: true })
  const store = new QuestionStore()
  const staged = createProviderModelEditor(id => id === 'model-a' ? original : { id }, new Map([
    ['model-a', { id: 'model-a', contextWindow: 1000000 }], ['model-b', { id: 'model-b' }],
  ]))
  const question = {
    id: 'models', question: '选择模型', multiSelect: true,
    options: [{ label: 'model-a' }, { label: 'model-b' }],
    defaultSelected: ['model-a'], modelEditor: staged.editor,
  }
  let answered = false
  let cancelled = false
  let selection: { answers: readonly { selected: readonly string[]; custom?: string }[] } | undefined
  const pending = store.ask({ questions: [question] })
  void pending.then(value => { selection = value; answered = true }, () => { cancelled = true })
  let promptSubmissions = 0
  const channel = {
    version: 0, rows: [{ id: 1, kind: 'assistant', text: 'TRANSCRIPT', fresh: false }],
    status: 'idle', sessionTitle: 'capability-test', agentId: 'capability-test',
    provider: 'capability-test', model: 'model-a', cwd: process.cwd(), displayCwd: process.cwd(),
    tokens: { input: 0, output: 0 }, working: false, spinnerMode: 'requesting',
    responseChars: 0, activeToolCount: 0, turnStart: 0, lastUserText: '',
    pending: [], notifications: [], activityEnabled: false, contextBarEnabled: false, statusBar: {},
    mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
    commandList: [], commandCompletions: () => [], subscribe: () => () => {},
    submit() { promptSubmissions += 1 }, cancel() {}, clear() {}, notify() {}, pushLocal() {},
    listModels: async () => [], listSessions: async () => [], setResumeTarget() {},
    settingsHost: () => undefined, settingsSections: () => [], subscribeSettingsSections: () => () => {},
  } as unknown as ComponentProps<typeof Chat>['channel']
  const chat = React.createElement(Chat, { channel, questionStore: store, fullscreen, trajectorySeen: true, onExit() {} })
  const app = await render(React.createElement(ThemeProvider, {
    children: fullscreen ? React.createElement(AlternateScreen, null, chat) : chat,
  }), {
    stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
  })
  const screen = () => viewportLines(terminal).join('\n')
  const waitFor = async (predicate: () => boolean, label: string) => {
    assert.ok(await settled(predicate), `${fullscreen ? 'fullscreen' : 'inline'} ${columns}x${rows}: ${label}\n${screen()}`)
  }
  try {
    await waitFor(() => screen().includes('model-a'), 'model list appears')
    stdin.write('\t')
    await waitFor(() => screen().includes('编辑模型能力') && screen().includes('4000'), 'Tab opens focused model capabilities')
    assert.equal(answered, false)
    assert.equal(staged.entries.size, 0)
    if (!fullscreen && columns >= 80) {
      const snapshot = screen().split('\n').filter(line => line.trim() !== '')
      const start = snapshot.findIndex(line => line.includes('编辑模型能力'))
      console.log(`Provider capability editor screen:\n${snapshot.slice(start, start + 9).join('\n')}`)
    }

    // These edits share one stdin batch: refs must retain both field moves
    // and text replacements even before React has committed a new frame.
    stdin.write('\x15200k\x1b[B\x158192')
    if (staged.editor.reasoningEditable) stdin.write('\x1b[B\x15off,low,high,max=ultra')
    stdin.write('\x1b[B\x1b[C')
    await waitFor(() => screen().includes(columns < 64 ? 'image' : '文本+图片'), 'multimodal switch remains visible')
    stdin.write('\r')
    await waitFor(() => screen().includes('能力已编辑') && !screen().includes('上下文窗口'), 'editor save returns to the list')
    assert.equal(answered, false, 'nested Enter must not submit the surrounding model selection')
    assert.equal(promptSubmissions, 0, 'editing keys must never reach the composer')
    const saved = staged.entries.get('model-a')!
    assert.deepEqual(saved, {
      ...original, contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'],
      ...(staged.editor.reasoningEditable ? { reasoningEfforts: reasoning } : {}),
    })

    stdin.write('\t')
    await waitFor(() => screen().includes('编辑模型能力') && screen().includes('200000'), 'reopen restores the staged capabilities')
    stdin.write('\x151234')
    await waitFor(() => screen().includes(columns < 64 ? 'ctx' : '上下文窗口') && screen().includes('1234'), 'reopened field accepts replacement')
    assert.equal(staged.entries.get('model-a')!.contextWindow, 200000)
    assert.equal(answered, false)
    stdin.write('\x151234\x1b')
    await waitFor(() => screen().includes('选择模型') && !screen().includes('上下文窗口'), 'Esc discards only the nested edit')
    assert.equal(staged.entries.get('model-a')!.contextWindow, 200000)
    assert.equal(cancelled, false)

    // The list's own Enter finally commits the answer, without adding a
    // model merely because its capabilities were edited.
    stdin.write('\r')
    await waitFor(() => answered, 'outer Enter commits the selected models')
    assert.deepEqual(selection?.answers[0]?.selected, ['model-a'])
    assert.equal(selection?.answers[0]?.custom, undefined)

    // Ordinary model-facing questionnaires keep the original Tab-to-input
    // contract; the local provider editor must not leak into their asks.
    let ordinary: { answers: readonly { selected: readonly string[]; custom?: string }[] } | undefined
    void store.ask({ questions: [{ id: 'plain', question: '普通问卷', options: [{ label: '选项' }] }] }).then(value => { ordinary = value }, () => {})
    await waitFor(() => screen().includes('普通问卷'), 'ordinary questionnaire appears')
    stdin.write('\t')
    await waitFor(() => screen().includes('自定义回答'), 'ordinary Tab focuses the free-text row')
    stdin.write('plain-answer')
    await waitFor(() => screen().includes('plain-answer'), 'ordinary text reaches the free-text row')
    stdin.write('\r')
    await waitFor(() => ordinary !== undefined, 'ordinary Tab still focuses the free-text answer')
    assert.deepEqual(ordinary?.answers[0]?.selected, [])
    assert.equal(ordinary?.answers[0]?.custom, 'plain-answer')

    // A model id entered manually (the discovery-failure flow and the
    // question's custom input) can also be edited before the outer answer.
    let manual: { answers: readonly { selected: readonly string[]; custom?: string }[] } | undefined
    void store.ask({ questions: [{
      id: 'manual', question: '手动模型 id', modelEditor: staged.editor,
    }] }).then(value => { manual = value })
    await waitFor(() => screen().includes('手动模型 id'), 'manual model-id question appears')
    stdin.write('manual-model')
    await waitFor(() => screen().includes('manual-model'), 'manual model id is typed')
    stdin.write('\t')
    await waitFor(() => screen().includes('编辑模型能力'), 'Tab edits the last manual model id')
    stdin.write('\x154096')
    await waitFor(() => screen().includes('4096'), 'manual model capability is entered')
    stdin.write('\r')
    await waitFor(() => screen().includes('手动模型 id'), 'manual capability draft returns to its input')
    assert.equal(staged.entries.get('manual-model')?.contextWindow, 4096)
    stdin.write('\r')
    await waitFor(() => manual !== undefined, 'manual model id answer submits')
    assert.equal(manual?.answers[0]?.custom, 'manual-model')

    // Outer cancellation also tears down an open editor without committing
    // its local draft.
    let aborted = false
    void store.ask({ questions: [question] }).catch(() => { aborted = true })
    await waitFor(() => screen().includes('选择模型'), 'provider list reopens')
    stdin.write('\t')
    await waitFor(() => screen().includes('编辑模型能力'), 'editor opens before abort')
    stdin.write('\x1b')
    await waitFor(() => screen().includes('选择模型') && !screen().includes('上下文窗口'), 'Esc returns to the outer list')
    store.cancelCurrent()
    await waitFor(() => aborted, 'outer cancellation rejects the open ask')
    assert.equal(promptSubmissions, 0)
    console.log(`PASS: real Chat ${fullscreen ? 'fullscreen' : 'inline'} ${columns}x${rows} — Tab/edit/save/Esc/validation/key ownership`)
    return saved
  } finally {
    await app.unmount()
    store.rejectAll()
    terminal.dispose()
  }
}

let saved: Record<string, unknown> | undefined
for (const fullscreen of [false, true]) {
  for (const [columns, rows] of [[92, 34], [42, 24]]) saved = await exercise(fullscreen, columns, rows)
}

// Consume the exact edited entry through the installed upstream adapter,
// not through a local metadata guess. No credential or network is used.
let adapter: { resolveModel(provider: string, model: string): Promise<{
  context?: { contextWindow: number }; defaultMaxTokens?: number; inputModalities?: readonly string[];
  reasoning?: { efforts: readonly { id: string }[] };
}> } | undefined
upstream.apply({
  fiber: { entry: { options: { id: 'llm-pi-ai' } } }, inject() {}, on() {}, get() {},
  llm: {
    registerConfigurableProviders: () => ({ replace() {} }), registerModelDiscovery() {},
    registerAdapter(_routes: unknown, value: typeof adapter) { adapter = value; return { replace() {} } },
  },
} as never, { providers: { get: () => ({ 'capability-test': {
  api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', models: [saved],
} }) } } as never)
const info = await adapter!.resolveModel('capability-test', 'model-a')
assert.equal(info.context?.contextWindow, 200000)
assert.equal(info.defaultMaxTokens, 8192)
assert.deepEqual(info.inputModalities, ['text', 'image'])
assert.deepEqual(info.reasoning?.efforts.map(level => level.id), ['off', 'low', 'high', 'max'])
console.log('PASS: upstream resolves edited context, output limit, reasoning tiers and image input')
