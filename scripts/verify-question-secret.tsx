/**
 * Secret questions (`QuestionItemView.secret`, N3):
 *
 *  - the questionnaire panel paints one `•` per typed code point on the
 *    free-text row (typing on the input row, typing on an option row,
 *    bracketed paste, CJK, caret editing) and never the text itself; the
 *    submitted answer is the real text;
 *  - an ordinary question still shows what is typed (default unchanged);
 *  - the channel's interaction bridge carries `secret` into the store's
 *    question (and nothing when absent);
 *  - the answered-questionnaire record masks a secret answer as `••••`
 *    (option labels and typed text alike), keeps an ordinary answer and the
 *    wizard `redact` mask unchanged, also through the shared projector;
 *  - zh and en panels both mask.
 *
 * Run: node --import tsx/esm scripts/verify-question-secret.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render },
  { AskUserQuestionPanel },
  { buildQuestionRecord, SECRET_ANSWER },
  { attachInteraction },
  { PermissionStore },
  { createChannelProjection },
  { createInitialChannelView },
  { setLang, t },
  { settle, settled, sleep, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('../src/channel/question-record.js'),
  import('../src/channel/interaction.js'),
  import('../src/channel/permissions.js'),
  import('../src/channel/projection.js'),
  import('../src/dsh-adapter/channel/state.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])
type AgentEvent = import('../src/agent/events.js').AgentEvent
type QuestionRequest = import('../src/channel/questions.js').QuestionRequest

const COLS = 80
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdout = new FakeStdout()
const stdin = new FakeStdin()
const screen = (): string => viewportLines(term, ROWS).join('\n')

let failures = 0
let passed = 0
// Collected, printed after the render unmounts: console output during the
// render would land in the fake terminal and pollute the screen probes.
const results: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

let answer: unknown
const panel = (key: string, question: Record<string, unknown>) => React.createElement(AskUserQuestionPanel, {
  key,
  position: 1, total: 1, answered: 0,
  onAnswer: (selection: unknown) => { answer = selection },
  onCancel: () => undefined,
  question,
})
const app = await render(panel('boot', { question: '启动', options: [{ label: 'x' }] }), { stdout, stdin, stderr: new FakeStdout(), debug: true, exitOnCtrlC: false, patchConsole: false })
await settle(() => screen().includes('启动'))
async function mount(key: string, question: Record<string, unknown>, ready: () => boolean): Promise<void> {
  answer = undefined
  app.rerender(panel(key, question))
  await settle(ready)
}
const bullets = (n: number): string => '•'.repeat(n)

// ── 1. text-only secret: masked while typing, real answer submitted ─────
await mount('s1', { question: '请输入访问令牌', secret: true }, () => screen().includes('请输入访问令牌'))
stdin.write('hunter2')
check('1 typed secret paints one • per code point', await settled(() => screen().includes(bullets(7))), screen().split('\n').filter(line => line.includes('•')).join(' | '))
check('1 the typed text never reaches the screen', !screen().includes('hunter2') && !screen().includes('hunter'))
stdin.write('\x1b[D') // ← caret one step back
await sleep(60) // 固定窗:pacing 键间节奏——光标移动不改变掩码文本
stdin.write('X')
check('1 caret editing keeps the mask', await settled(() => screen().includes(bullets(8))) && !screen().includes('X'))
stdin.write('\r')
check('1 the real (edited) text is submitted', await settled(() => eq(answer, { selected: [], custom: 'hunterX2' })), JSON.stringify(answer))

// ── 2. secret with options: option-row typing, paste and CJK masked ─────
await mount('s2', { question: '选择或输入密钥', secret: true, options: [{ label: '使用环境变量' }] }, () => screen().includes('选择或输入密钥'))
stdin.write('ab') // typing on the focused option row appends into the input row
check('2 option-row typing is masked', await settled(() => screen().includes(bullets(2))) && !/\bab\b/u.test(screen()))
stdin.write('\t') // focus the input row
await sleep(60) // 固定窗:pacing 键间节奏——Tab 只移焦点
stdin.write('\x1b[200~sk-口令\x1b[201~') // bracketed paste with CJK
check('2 a bracketed paste (CJK included) is masked', await settled(() => screen().includes(bullets(7))) && !screen().includes('sk-') && !screen().includes('口令'), screen().split('\n').filter(line => line.includes('•')).join(' | '))
stdin.write('\r')
check('2 the submitted answer is the real text (label attached)', await settled(() => eq(answer, { selected: ['使用环境变量'], custom: 'absk-口令' })), JSON.stringify(answer))

// ── 3. default unchanged: an ordinary question shows what is typed ──────
await mount('s3', { question: '普通问题' }, () => screen().includes('普通问题'))
stdin.write('visible')
check('3 an ordinary question shows the typed text', await settled(() => screen().includes('visible')) && !screen().includes(bullets(7)))
stdin.write('\r')
check('3 … and submits it', await settled(() => eq(answer, { selected: [], custom: 'visible' })))

// ── 4. en panel masks too ───────────────────────────────────────────────
setLang('en')
await mount('s4', { question: 'Paste your API key', secret: true }, () => screen().includes('Paste your API key'))
stdin.write('topsecret')
check('4 en: masked', await settled(() => screen().includes(bullets(9))) && !screen().includes('topsecret'))
setLang('zh')
await app.unmount()

// ── 5. interaction bridge: secret reaches the store's question ──────────
{
  const asked: QuestionRequest[] = []
  const store = { ask: (request: QuestionRequest) => { asked.push(request); return new Promise<never>(() => undefined) } }
  const bridge = attachInteraction({ permissions: new PermissionStore(), questions: store, debug: () => undefined }, {
    sessionId: 's',
    capabilities: { questions: { respond: () => undefined, cancel: () => undefined } },
  })
  bridge.apply([{ type: 'question.request', request: { requestId: 'q1', questions: [{ question: 'Token?', options: [], secret: true }, { question: 'Name?', options: [] }] } }])
  check('5 the bridge marks the secret question', asked[0]?.questions[0]?.secret === true)
  check('5 … and nothing on an ordinary one', asked[0]?.questions[1] !== undefined && !('secret' in asked[0]!.questions[1]!))
  bridge.release()
}

// ── 6. the answered record ──────────────────────────────────────────────
{
  const record = buildQuestionRecord(
    [{ question: 'Token?', secret: true }, { question: 'Region?', secret: true }, { question: 'Name?' }],
    [{ selected: [], custom: 'sk-live-123' }, { selected: ['eu-west'] }, { selected: [], custom: 'Ada' }],
  )
  check('6 a typed secret is recorded as ••••', record.lines[0] === `· Token? → ${SECRET_ANSWER}` && SECRET_ANSWER === '••••', record.lines[0])
  check('6 a secret option pick is masked too', record.lines[1] === `· Region? → ${SECRET_ANSWER}`)
  check('6 an ordinary answer is unchanged', record.lines[2] === '· Name? → Ada')
  check('6 the wizard redact mask is unchanged', buildQuestionRecord([{ question: 'Key?' }], [{ selected: [], custom: 'x' }], { redact: true }).lines[0] === '· Key? → ••••••')
}

// ── 7. through the shared projector (question-presented call + result) ──
{
  const view = createInitialChannelView(
    { model: 'm', provider: 'p', cwd: '/fixture' },
    { agentId: 'a', sessionId: 's', mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: '/fixture' },
  )
  const state = { ...view, emit: () => undefined } as Parameters<typeof createChannelProjection>[0]
  const projector = createChannelProjection(state, {
    rowIds: { value: 0 },
    resetContextWarning: () => undefined,
    checkContextWarning: () => undefined,
    notify: () => () => undefined,
    jobs: { onOutputSeen: () => undefined, onStarted: () => undefined },
    inputConvergence: { cancelInFlight: false },
    selectionAttached: () => undefined,
  })
  const events: AgentEvent[] = [
    { type: 'tool.call', seq: 1, turn: 1, step: 1, callId: 'ask-1', name: 'request_user_input', argsJson: JSON.stringify({ questions: [{ question: 'Token?', secret: true }, { question: 'Name?' }] }), presentation: { card: 'question' }, time: 1 },
    { type: 'tool.result', seq: 2, turn: 1, step: 1, callId: 'ask-1', isError: false, time: 2, content: [], text: JSON.stringify({ answers: [{ selected: [], custom: 'sk-live-123' }, { selected: [], custom: 'Ada' }] }) },
  ]
  projector.apply(events, { replay: false })
  const texts = state.rows.map(row => row.text)
  check('7 the projected record masks the secret', texts.includes(`· Token? → ${SECRET_ANSWER}`) && texts.includes('· Name? → Ada'), texts.join(' | '))
  check('7 no row carries the secret', texts.every(text => !text.includes('sk-live-123')))
  check('7 the record title is the usual one', texts[0] === t('questionnaire-answered', { total: 2 }))
}

for (const line of results) console.log(line)
console.log(`\nverify-question-secret ${failures === 0 ? 'OK' : 'FAILED'} (${passed} passed, ${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
