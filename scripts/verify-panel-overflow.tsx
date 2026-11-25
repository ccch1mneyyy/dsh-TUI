/**
 * verify-panel-overflow — issue #1664: the in-flow prompt panels (approval,
 * ask_user_question) sit in Chat's bottom chrome with `flexShrink: 0`, so
 * their height is their content height. Backend text rendered with an
 * unbounded `wrap` grew the panel past the viewport and the renderer clipped
 * the rows below the screen — which is exactly where the option rows and the
 * key hint live. The user saw a wall of command/question text and no button.
 *
 * This mounts the real Chat screen (fake channel + real ApprovalStore /
 * QuestionStore) in a 100×40 alternate screen — clipping, not scrollback —
 * and drives both panels with long payloads:
 *
 *   1. a short command: unchanged, no fold marker;
 *   2. a 300-line command: folded with a "N more lines" marker, and the
 *      question / option rows / key hint still on screen;
 *   3. a 40-line question: same invariant for the questionnaire panel;
 *   4. the same long command on a 24-row terminal: the panel shrinks its
 *      preview instead of pushing the tail off screen — asserted through the
 *      omitted count itself, so the frame really was laid out at 24 rows;
 *   5. a spent preview budget: the asker's reason keeps its marker instead of
 *      being dropped (long command + long reason on that 24-row terminal);
 *   6. a short question plus a six-row detail on the same terminal: the
 *      question's unused rows reach the detail, so nothing folds.
 *   7. multiline and CJK-wrapped descriptions remain windowed after detail clipping;
 *   8. failed OAuth copying retains keyboard access to the whole URL in
 *      inline/fullscreen and narrow terminals, including remapped keys.
 *   9. question text can be paged with and without a detail;
 *  10. fullscreen multi-select reserves its submit row above the full footer;
 *  11. a 10-row approval keeps its controls and full preview accessible.
 *
 * Run: node --import tsx/esm scripts/verify-panel-overflow.tsx
 * Add --capture to print the rendered OAuth viewport for PR documentation.
 */
import './lib/fake-home.mjs' // must stay first: DATA_DIR resolves at import time
import './lib/default-lang-zh.mjs'
import type { PermissionPanelSource } from '../src/channel/permissions.js'
process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Chat },
  { QuestionStore },
  { ApprovalStore },
  { PermissionStore },
  { QuestionBridge },
  { setKeymapOverrides, resetKeymapOverrides },
  { default: instances },
  { settle, settled, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/channel/permissions.js'),
  import('../src/dsh-adapter/oauth/interaction.js'),
  import('../src/utils/keymap.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const stdout = new FakeStdout()
const stdin = new FakeStdin()

/** Chat's channel seam, minimal: the transcript, the model and the cwd. */
const channel = {
  version: 0,
  rows: [
    { id: 0, kind: 'user', text: 'hello' },
    { id: 1, kind: 'assistant', text: 'hi there', time: Date.parse('2026-01-02T03:04:05Z') },
  ],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  turnStart: 0,
  lastUserText: 'hello',
  pending: [],
  commandList: [{ name: 'settings', description: 'open settings' }],
  notifications: [],
  subscribe: () => () => {},
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  commandCompletions: () => [],
  pushLocal: () => {},
  settingsHost: () => undefined,
  settingsSections: () => [],
  subscribeSettingsSections: () => () => {},
  runExternalCommand: () => Promise.resolve(undefined),
  listSessions: () => [],
  setResumeTarget: () => {},
} as never

const fakeApprovalReq = (callId: string, command: string) => ({
  agent: {
    id: 'probe',
    session: {
      events: [{
        type: 'tool/call',
        seq: 1,
        time: 0,
        data: { turn: 0, step: 0, callId, name: 'Bash', arguments: JSON.stringify({ command }) },
      }],
    },
  },
  toolName: 'Bash',
  callId,
  reason: 'verify probe',
}) as never

const longCommand = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n')
const longQuestion = Array.from({ length: 40 }, (_, index) => `问题第 ${index + 1} 行`).join('\n')

const questionReq = (question: string, detail?: string) => ({
  questions: [{
    id: 'q1',
    header: 'Overflow probe',
    question,
    ...(detail === undefined ? {} : { detail }),
    options: [{ label: 'Option Alpha' }, { label: 'Option Beta' }],
  }],
}) as never

const rows = (): string[] => viewportLines(term, stdout.rows)
const screenText = (): string => rows().join('\n')
const visible = (text: string): boolean => rows().some(line => line.includes(text))

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failures++
    if (detail !== undefined) console.log(detail.split('\n').map(line => `  |${line}`).join('\n'))
  }
}

/** The panel's interaction tail: the decision question, both option rows and
 *  the key hint. Whatever the preview does, these must be painted. */
const approvePanelVisible = (): boolean =>
  visible('要允许这次操作吗？') && visible('1. 允许（仅本次）') && visible('2. 拒绝') && visible('↑/↓ 选择')
const questionPanelVisible = (): boolean =>
  visible('Option Alpha') && visible('Option Beta') && visible('↑/↓ 选择')

/** Rows the fold marker reports as hidden — undefined when no marker is up. */
const omittedCount = (text: string): number | undefined => {
  const match = /… 另有 (\d+) 行未显示/.exec(text)
  return match === null ? undefined : Number(match[1])
}
/** Marker count on the wide-terminal frame; the 24-row frame must exceed it. */
let wideOmitted: number | undefined

const approvals = new ApprovalStore()
let approvalSource: PermissionPanelSource = approvals
const questions = new QuestionStore()
// A real fullscreen session wraps Chat in <AlternateScreen>: its boxes are
// viewport-height, so the renderer clips instead of growing the frame into
// scrollback — exactly the layout the issue was reported in.
let fullscreen = true
const tree = (): React.ReactElement => {
  const chat = React.createElement(Chat, { channel, questionStore: questions, approvalStore: approvalSource, fullscreen })
  return fullscreen ? React.createElement(AlternateScreen, null, chat) : chat
}
const app = await render(tree(), { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false })
// AlternateScreen resolves the instance via instances.get(process.stdout);
// the fake stream registers under its own key, so alias it and repaint.
const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as {
  setAltScreenActive: (active: boolean, mouse: boolean) => void
}
instances.set(process.stdout, ink as never)
app.rerender(tree())
ink.setAltScreenActive(true, true)
await settle(() => visible('hello'), { timeoutMs: 5000 })

// 1) A short command renders as before: nothing folded, reason intact.
{
  const parked = approvals.park(fakeApprovalReq('short', 'rm -rf /tmp/x\nls -la'))
  await settle(() => visible('要允许这次操作吗？'), { timeoutMs: 3000 })
  check('short command: panel tail visible', approvePanelVisible(), screenText())
  check('short command: no fold marker', !visible('行未显示'), screenText())
  check('short command: the reason shows', visible('verify probe'), screenText())
  stdin.write('2')
  await parked
  await settle(() => !visible('要允许这次操作吗？'))
}

// 2) A 300-line command folds instead of flooding the screen.
{
  const parked = approvals.park(fakeApprovalReq('long', longCommand))
  await settle(() => visible('要允许这次操作吗？'), { timeoutMs: 3000 })
  const text = screenText()
  wideOmitted = omittedCount(text)
  check('long command: panel tail visible', approvePanelVisible(), text)
  check('long command: folded with a marker', wideOmitted !== undefined, text)
  check('long command: the tail is not painted', !text.includes('line 300'), text)
  check('long command: the reason still shows', visible('verify probe'), text)
  stdin.write('2')
  await parked
  await settle(() => !visible('要允许这次操作吗？'))
}

// 3) The questionnaire panel keeps the same invariant.
{
  const asked = questions.ask(questionReq(longQuestion)).catch(() => undefined)
  await settle(() => visible('Option Alpha'), { timeoutMs: 3000 })
  const text = screenText()
  check('long question: panel tail visible', questionPanelVisible(), text)
  check('long question: folded with a marker', /… (?:另有 )?\d+ 行未显示/.test(text), text)
  check('long question: the tail is not painted', !text.includes('问题第 40 行'), text)
  stdin.write('\x1b[1;3B'.repeat(20))
  check('long question: paging reaches the tail without changing answer focus',
    await settled(() => visible('问题第 40 行') && rows().some(line => line.includes('●') && line.includes('Option Alpha'))), screenText())
  stdin.write('\x1b[1;3A'.repeat(20))
  check('long question: paging returns to the head',
    await settled(() => visible('问题第 1 行')), screenText())
  stdin.write('\x1b')
  await asked
  await settle(() => !visible('Option Alpha'))
}

// 4) A short terminal shrinks the preview rather than the interaction tail.
{
  stdout.rows = 24
  term.resize(COLS, 24)
  stdout.emit('resize')
  const parked = approvals.park(fakeApprovalReq('small', longCommand))
  // The resize is observed through the panel itself: a 24-row budget folds
  // more of the command, so the omitted count must grow past the 40-row one.
  // Counting the viewport's rows cannot prove this — viewportLines always
  // returns `rows` lines — so the marker carries the layout evidence.
  const shrunk = await settled(
    () => wideOmitted !== undefined && (omittedCount(screenText()) ?? 0) > wideOmitted,
    { timeoutMs: 3000 },
  )
  check('24 rows: preview shrinks with the terminal', shrunk, screenText())
  check('24 rows: panel tail visible', approvePanelVisible(), screenText())
  stdin.write('2')
  await parked
  await settle(() => !visible('要允许这次操作吗？'))
}

// 5) A spent preview budget marks the asker's reason instead of dropping it:
//    the command takes every row (still the 24-row terminal), so the reason
//    can only be its omitted marker.
{
  const longReason = Array.from({ length: 10 }, (_, index) => `理由第 ${index + 1} 行`).join('\n')
  const parked = approvals.park({ ...fakeApprovalReq('reason', longCommand), reason: longReason })
  const marked = await settled(() => /… 另有 10 行未显示/.test(screenText()), { timeoutMs: 3000 })
  check('spent budget: reason is marked, not dropped', marked, screenText())
  check('spent budget: panel tail still visible', approvePanelVisible(), screenText())
  stdin.write('2')
  await parked
}

// 6) The question's unused allowance reaches the detail: on the same 24-row
//    terminal a one-line question plus a six-row detail still fits unfolded.
{
  const detail = Array.from({ length: 6 }, (_, index) => `说明第 ${index + 1} 行`).join('\n')
  const asked = questions.ask(questionReq('短问题', detail)).catch(() => undefined)
  await settle(() => visible('Option Alpha'), { timeoutMs: 3000 })
  const text = screenText()
  check('24 rows: short question keeps the detail unfolded', visible('说明第 6 行'), text)
  check('24 rows: no fold marker for a fitting detail', !visible('行未显示'), text)
  check('24 rows: question panel tail visible', questionPanelVisible(), text)
  stdin.write('\x1b')
  await asked
}

// 7) Shrinking a detail must not turn a bounded option list back into an
//    unbounded one. Cover both explicit newlines and a wide unbroken line.
for (const multiline of [true, false]) {
  stdout.rows = ROWS
  term.resize(COLS, ROWS)
  stdout.emit('resize')
  const labels = ['Choice Alpha', 'Choice Beta', 'Choice Gamma', 'Choice Delta']
  const asked = questions.ask({ questions: [{
    id: 'wrapped-options',
    question: 'Pick a choice',
    detail: Array.from({ length: 20 }, (_, index) => `Detail row ${index + 1}`).join('\n'),
    options: labels.map(label => ({
      label,
      description: multiline
        ? Array.from({ length: 8 }, (_, index) => `${label} description ${index + 1}`).join('\n')
        : '界'.repeat(400),
    })),
    hideCustomInput: true,
  }] }).catch(() => undefined)
  await settle(() => visible(labels[0]!))
  stdin.write('\x1b[B\x1b[B\x1b[B')
  let text = ''
  const tailVisible = await settled(() => {
    text = screenText()
    return rows().some(line => line.includes('●') && line.includes(labels[3]!))
      && visible('↑/↓ 选择')
  })
  check(`wrapped options (${multiline ? 'newlines' : 'CJK'}): last focus and hint stay visible`, tailVisible, text)
  stdin.write('\x1b')
  await asked
  await settle(() => !visible(labels[0]!) && !visible(labels[3]!))
}

// A long question with a short detail must page both parts of its body.
{
  const asked = questions.ask(questionReq(longQuestion, 'QUESTION_DETAIL_TAIL')).catch(() => undefined)
  await settle(() => visible('Option Alpha'))
  stdin.write('\x1b[1;3B'.repeat(40))
  check('question and detail: both tails remain reachable',
    await settled(() => visible('问题第 40 行') && visible('QUESTION_DETAIL_TAIL') && visible('↑/↓ 选择')), screenText())
  stdin.write('\x1b')
  await asked
  await settle(() => !visible('Option Alpha'))
}

// Multi-select mounts two more rows for submit. Keep the real three-row
// footer visible for both a checked choice and a typed answer.
Object.assign(channel, {
  contextBarEnabled: true,
  contextOccupancy: { usedTokens: 120, contextWindow: 1000, source: 'backend' },
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
})
const fullFooterVisible = (): boolean => {
  const statusRow = rows().findIndex(line => line.includes('deepseek-v4') && line.includes('ctx'))
  return statusRow >= 0 && statusRow < stdout.rows - 1 && visible('12.0%')
}
stdout.rows = 24
term.resize(COLS, 24)
stdout.emit('resize')
for (const typed of [false, true]) {
  const asked = questions.ask({ questions: [{
    id: 'multi-footer', question: longQuestion, detail: longQuestion,
    options: [{ label: 'Multi Alpha' }, { label: 'Multi Beta' }, { label: 'Multi Gamma' }],
    multiSelect: true,
  }] })
  await settle(() => visible('Multi Alpha'))
  stdin.write(typed ? '\tDRAFT_ANSWER' : ' ')
  check(`multi-select ${typed ? 'typed' : 'checked'}: submit, hints and full footer remain visible`,
    await settled(() => visible('提交选择') && visible(typed ? '输入回答' : '↑/↓ 选择') && fullFooterVisible()), screenText())
  stdin.write('\r')
  const answer = await asked
  check(`multi-select ${typed ? 'typed' : 'checked'}: answer is unchanged`,
    typed ? answer.answers[0]?.custom === 'DRAFT_ANSWER' : answer.answers[0]?.selected[0] === 'Multi Alpha')
  await settle(() => !visible('Multi Alpha'))
}

// Tiny approvals keep every preview in a scroll area instead of dropping
// its reason/title. The rejection reason still submits in full.
const permissionStore = new PermissionStore()
approvalSource = permissionStore
for (const mode of [true, false]) for (const columns of [100, 40]) for (const choiceCount of [2, 3]) {
  fullscreen = mode
  stdout.columns = columns
  stdout.rows = 10
  term.resize(columns, 10)
  stdout.emit('resize')
  app.rerender(tree())
  ink.setAltScreenActive(fullscreen, fullscreen)
  let rejectedReason: string | undefined
  const feedback = `${'r'.repeat(200)}FEEDBACK_TAIL`
  permissionStore.park({
    sessionId: 'probe',
    request: {
      requestId: `tiny-${mode}-${columns}-${choiceCount}`, toolName: 'Bash', callId: 'tiny', input: {}, feedback: true,
      title: 'APPROVAL_TITLE',
      command: Array.from({ length: 20 }, (_, index) => index === 19 ? 'APPROVAL_COMMAND_TAIL' : `command ${index + 1}`).join('\n'),
      reason: 'APPROVAL_REASON_TAIL',
      options: [
        { id: 'once', kind: 'allow-once' },
        ...(choiceCount === 3 ? [{ id: 'always', kind: 'allow-always' as const }] : []),
        { id: 'reject', kind: 'reject' },
      ],
    },
    settle(_outcome, decision) { if (decision?.kind === 'reject') rejectedReason = decision.message },
  })
  const label = `approval ${fullscreen ? 'fullscreen' : 'inline'} ${columns}x10 ${choiceCount} choices`
  const choicesVisible = (): boolean => visible('1. 允许') && visible(`${choiceCount}. 拒绝`) && visible('↑/↓ 选择')
  check(`${label}: decision rows, hints and footer fit`,
    await settled(() => choicesVisible() && fullFooterVisible()), screenText())
  stdin.write('\x1b[1;3B'.repeat(40))
  check(`${label}: reason remains readable`,
    await settled(() => visible('APPROVAL_REASON_TAIL') && choicesVisible()), screenText())
  stdin.write('\x1b[1;3A')
  check(`${label}: command tail remains readable`,
    await settled(() => visible('APPROVAL_COMMAND_TAIL') && choicesVisible()), screenText())
  stdin.write('\x1b[1;3A'.repeat(40))
  check(`${label}: title remains readable`,
    await settled(() => visible('APPROVAL_TITLE')), screenText())
  stdin.write('\x1b[B'.repeat(choiceCount - 1) + feedback)
  check(`${label}: feedback tail and controls fit`,
    await settled(() => visible('FEEDBACK_TAIL') && choicesVisible() && fullFooterVisible()), screenText())
  stdin.write('\r')
  await settle(() => permissionStore.getSnapshot() === null)
  check(`${label}: rejection sends the full reason`, rejectedReason === feedback)
}
approvalSource = approvals
Object.assign(channel, { contextBarEnabled: false, contextOccupancy: undefined })

// 8) The OAuth bridge's copy failure falls back to manual selection. Every
//    part of its URL must remain reachable inside the bounded detail area.
for (const mode of [true, false]) for (const [columns, height] of [[100, 40], [80, 24], [40, 24]]) {
  fullscreen = mode
  stdout.columns = columns!
  stdout.rows = height!
  term.resize(stdout.columns, stdout.rows)
  stdout.emit('resize')
  app.rerender(tree())
  ink.setAltScreenActive(fullscreen, fullscreen)
  const label = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}x${height}`
  const controller = new AbortController()
  const bridge = new QuestionBridge(request => questions.ask(request), controller, {
    openUrl: () => false,
    copyText: async () => false,
  })
  bridge.notify({
    type: 'auth_url',
    url: `https://auth.example/authorize?state=${'a'.repeat(500)}&end=AUTH_URL_TAIL`,
  })
  await settle(() => visible('复制授权链接'))
  stdin.write('\r')
  check(`OAuth ${label}: failed copy exposes the manual fallback`,
    await settled(() => visible('复制失败')), screenText())
  stdin.write('\x1b[1;3B'.repeat(20))
  check(`OAuth ${label}: keyboard scroll reaches the complete URL tail and keeps answer focus`,
    await settled(() => visible('AUTH_URL_TAIL') && rows().some(line => line.includes('●') && line.includes('复制授权链接')) && visible('↑/↓ 选择')), screenText())
  if (process.argv.includes('--capture') && fullscreen && columns === 100) console.log(`\n${screenText()}\n`)
  stdin.write('\x1b[1;3A'.repeat(20))
  check(`OAuth ${label}: keyboard scroll returns to the manual guidance`,
    await settled(() => visible('复制失败')), screenText())
  if (fullscreen && columns === 100) {
    const bodyRow = rows().findIndex(line => line.includes('https://auth.example'))
    stdin.write(`\x1b[<65;10;${bodyRow + 1}M`.repeat(20))
    check('OAuth: wheel over the detail reaches the URL tail',
      await settled(() => visible('AUTH_URL_TAIL') && visible('↑/↓ 选择')), screenText())
    setKeymapOverrides({ questionDetailUp: ['alt+p'], questionDetailDown: ['alt+n'] })
    app.rerender(tree())
    check('OAuth: hint shows remapped detail keys',
      await settled(() => visible('Alt+P/Alt+N')), screenText())
    stdin.write('\x1bp'.repeat(20))
    check('OAuth: remapped key scrolls to the guidance',
      await settled(() => visible('复制失败')), screenText())
    stdin.write('\x1bn'.repeat(20))
    check('OAuth: remapped key scrolls to the URL tail',
      await settled(() => visible('AUTH_URL_TAIL')), screenText())
    resetKeymapOverrides()
  }
  controller.abort()
  await bridge.settle()
  await settle(() => !visible('复制授权链接'))
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-panel-overflow: all checks passed')
process.exit(0)
