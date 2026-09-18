/**
 * Questionnaire fold regression through real Chat input routing and stores.
 * Covers approval/dialog priority, the full-screen interrupt lane, draft
 * preservation, and queued asks replacing an aborted folded request.
 * Run: node --import tsx/esm scripts/verify-question-fold.tsx
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough, Writable } from 'node:stream'
import type { ComponentProps } from 'react'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [React, { Terminal }, { render, ThemeProvider, AlternateScreen }, { Chat },
  { PageMargin }, { QuestionStore }, { ApprovalStore }, { TuiDialogStore },
  { setKeymapOverrides, resetKeymapOverrides }, { settled, sleep, viewportLines, findText },
] = await Promise.all([
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/components/PageMargin.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/dialogs.js'),
  import('../src/utils/keymap.js'),
  import('./lib/term-test.mjs'),
])

const ESC = '\x1b'
const CTRL_C = '\x03'
const FOLD = '\x0b'
const ENTER = '\r'
const question = {
  id: 'question', question: 'QUESTION-BODY',
  options: [{ label: 'OPTION-A' }, { label: 'OPTION-B' }],
}

function observe<T>(promise: Promise<T>) {
  const result: { done: boolean; value?: T; error?: unknown } = { done: false }
  void promise.then(
    value => { result.value = value; result.done = true },
    error => { result.error = error; result.done = true },
  )
  return result
}

async function mount(fullscreen: boolean) {
  const term = new Terminal({ cols: 72, rows: 28, scrollback: 1000, allowProposedApi: true })
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) { term.write(String(chunk), callback) },
  }), { columns: term.cols, rows: term.rows, isTTY: true })
  const stderr = Object.assign(new Writable({
    write(_chunk, _encoding, callback) { callback() },
  }), { isTTY: true })
  const questions = new QuestionStore()
  const approvals = new ApprovalStore()
  const dialogs = new TuiDialogStore()
  const approvalAbort = new AbortController()
  let approvalSeq = 0
  const channel = {
    version: 0,
    rows: Array.from({ length: 60 }, (_, id) => ({
      id, kind: 'assistant', text: `TRANSCRIPT-${String(id).padStart(3, '0')}`, fresh: false,
    })),
    status: 'idle', sessionTitle: 'fold-probe', agentId: 'fold-probe',
    model: 'deepseek-v4-flash', provider: 'deepseek',
    tokens: { input: 0, output: 0 }, cwd: process.cwd(), displayCwd: process.cwd(),
    working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0,
    activityEnabled: false, contextBarEnabled: false, statusBar: {},
    turnStart: 0, lastUserText: '', pending: [], notifications: [],
    mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
    commandList: [{ name: 'settings', description: 'open settings' }],
    commandCompletions: () => [], subscribe: () => () => {},
    submit() {}, cancel() {}, clear() {}, notify() {}, pushLocal() {},
    listModels: async () => [], listSessions: async () => [], setResumeTarget() {},
    settingsHost: () => undefined, settingsSections: () => [],
    subscribeSettingsSections: () => () => {}, runExternalCommand: async () => undefined,
  } as unknown as ComponentProps<typeof Chat>['channel']
  const chat = React.createElement(Chat, {
    channel, questionStore: questions, approvalStore: approvals,
    extensionDialogs: dialogs, fullscreen, trajectorySeen: true, onExit() {},
  })
  const page = React.createElement(PageMargin, null, chat)
  const app = await render(React.createElement(ThemeProvider, {
    children: fullscreen ? React.createElement(AlternateScreen, null, page) : page,
  }), {
    stdout: stdout as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
  })
  const has = (text: string) => viewportLines(term).some(line => line.includes(text))
  const folded = () => has('QUESTION-BODY') && !has('OPTION-A')
  const expanded = () => has('OPTION-A')
  const waitFor = async (predicate: () => boolean, label: string) => {
    assert.ok(await settled(predicate), `${label}\n${viewportLines(term).join('\n')}`)
  }
  const press = (key: string) => { stdin.write(key) }
  return {
    questions, approvals, dialogs, has, folded, expanded, waitFor, press,
    async openQuestion(signal?: AbortSignal) {
      const result = observe(questions.ask({ questions: [question], signal }))
      await waitFor(expanded, 'question opens expanded')
      return result
    },
    async fold() {
      press(FOLD)
      await waitFor(folded, 'question folds')
    },
    parkApproval() {
      const callId = `call-${++approvalSeq}`
      return observe(approvals.park({
        agent: { id: 'fold-probe', session: { events: [{
          type: 'tool/call', seq: 1, time: 0,
          data: { turn: 0, step: 0, callId, name: 'Bash', arguments: '{"command":"APPROVAL-COMMAND"}' },
        }] } },
        toolName: 'Bash', callId, reason: 'APPROVAL-REASON', signal: approvalAbort.signal,
      } as Parameters<InstanceType<typeof ApprovalStore>['park']>[0]))
    },
    clickHeader() {
      const point = findText(term, '▾')
      assert.ok(point, 'expanded fold header is visible')
      press(`\x1b[<0;${point.col + 1};${point.row + 1}M\x1b[<0;${point.col + 1};${point.row + 1}m`)
    },
    async dispose() {
      await app.unmount()
      questions.rejectAll()
      approvalAbort.abort()
      dialogs.settleAll()
      resetKeymapOverrides()
      term.dispose()
    },
  }
}

for (const fullscreen of [false, true]) {
  const mode = fullscreen ? 'fullscreen' : 'inline'
  await test(`${mode}: visible approval/dialog owns the first cancel and Enter`, async t => {
    const h = await mount(fullscreen)
    t.after(() => h.dispose())
    const ask = await h.openQuestion()
    await h.fold()
    for (const key of [ESC, CTRL_C, ENTER]) {
      const approval = h.parkApproval()
      await h.waitFor(() => h.has('APPROVAL-REASON'), 'approval visible')
      if (fullscreen && key === ENTER) {
        await h.waitFor(() => h.has('TRANSCRIPT-059'), 'transcript starts at bottom')
        h.press('\x1b[5~')
        await h.waitFor(() => !h.has('TRANSCRIPT-059'), 'transcript scrolled up')
      }
      h.press(key)
      await h.waitFor(() => approval.done, 'first approval key settles the visible request')
      assert.equal(approval.value, key === ENTER ? 'allowed-once' : 'rejected')
      await h.waitFor(h.folded, 'hidden questionnaire remains folded')
      assert.equal(ask.done, false)

      const dialog = observe(h.dialogs.ask({ kind: 'input', title: 'DIALOG-TITLE', initial: 'DIALOG-VALUE' }))
      await h.waitFor(() => h.has('DIALOG-TITLE'), 'plugin dialog visible')
      h.press(key)
      await h.waitFor(() => dialog.done, 'first dialog key settles the visible request')
      assert.equal(dialog.value, key === ENTER ? 'DIALOG-VALUE' : undefined)
      await h.waitFor(h.folded, 'dialog leaves questionnaire folded')
    }
  })

  await test(`${mode}: settings interrupt supports keyboard fold and recovery`, async t => {
    const h = await mount(fullscreen)
    t.after(() => h.dispose())
    await h.waitFor(() => h.has('TRANSCRIPT-059'), 'chat is ready')
    h.press('/settings')
    await h.waitFor(() => h.has('/settings'), 'settings command entered')
    h.press(ENTER)
    await h.waitFor(() => h.has('No configurable plugin settings'), 'settings opens')
    const ask = await h.openQuestion()
    for (const key of [FOLD, ESC, CTRL_C]) {
      await h.fold()
      h.press(key)
      await h.waitFor(h.expanded, 'interrupt questionnaire expands by keyboard')
      assert.equal(ask.done, false)
    }
    if (fullscreen) {
      h.clickHeader()
      await h.waitFor(h.folded, 'mouse folds interrupt questionnaire')
      h.press(ESC)
      await h.waitFor(h.expanded, 'keyboard restores mouse-folded interrupt questionnaire')
    }
    h.press(ESC)
    await h.waitFor(() => ask.done, 'second Esc cancels')
    await h.waitFor(() => h.has('No configurable plugin settings'), 'settings restored after cancel')
  })

  for (const plan of [false, true]) {
    await test(`${mode}: queued ${plan ? 'plan review' : 'question'} does not inherit fold`, async t => {
      const h = await mount(fullscreen)
      t.after(() => h.dispose())
      const abort = new AbortController()
      await h.openQuestion(abort.signal)
      await h.fold()
      const successor = observe(h.questions.ask({ questions: [plan ? {
        id: 'plan', question: 'PLAN-BODY',
        options: [{ label: 'APPROVE' }, { label: 'REVISE' }],
        intent: { kind: 'plan-review', approve: 'APPROVE' },
      } : { ...question, id: 'successor' }] }))
      const snapshots: Array<string | null> = []
      const unsubscribe = h.questions.subscribe(() => snapshots.push(h.questions.getSnapshot()?.key ?? null))
      t.after(unsubscribe)
      abort.abort()
      assert.ok(snapshots.length > 0)
      assert.ok(snapshots.every(key => key !== null), 'fixture must replace the request without an idle notification')
      await h.waitFor(plan ? () => h.has('PLAN-BODY') : h.expanded, 'successor opens expanded')
      h.press(ESC)
      await h.waitFor(() => successor.done, 'first Esc cancels the expanded successor')
      assert.equal((successor.error as { code?: string })?.code, 'ASK_CANCELLED')
    })
  }

  await test(`${mode}: remapped fold preserves the exact draft and pending ask`, async t => {
    const h = await mount(fullscreen)
    t.after(() => h.dispose())
    const ask = await h.openQuestion()
    h.press('DRAFT-TEXT')
    await h.waitFor(() => h.has('DRAFT-TEXT'), 'draft entered')
    setKeymapOverrides({ questionFold: 'alt+k' })
    h.press('\x1bk')
    await h.waitFor(h.folded, 'remapped fold works')
    h.press('UNWANTED\t/\r')
    // 固定窗:探针 folded input must neither submit nor append to the hidden draft.
    await sleep(100)
    assert.equal(ask.done, false)
    h.press(CTRL_C)
    await h.waitFor(h.expanded, 'Ctrl+C expands without cancelling')
    assert.equal(ask.done, false)
    h.press(ENTER)
    await h.waitFor(() => ask.done, 'expanded question can be submitted')
    assert.deepEqual(ask.value, { answers: [{ id: 'question', selected: ['OPTION-A'], custom: 'DRAFT-TEXT' }] })
  })
}
