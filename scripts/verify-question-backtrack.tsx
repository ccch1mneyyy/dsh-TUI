/**
 * Questionnaire back-navigation regression.
 *
 * Covers both halves of the flow:
 *   1. QuestionStore replaces answers by question index, preserves drafts,
 *      and emits the final answer list in request order.
 *   2. AskUserQuestionPanel restores a saved draft and routes Esc to the
 *      previous-question callback while keeping first-question Esc as cancel.
 *
 * Run: node --import tsx/esm scripts/verify-question-backtrack.tsx
 */

import assert from 'node:assert/strict'

process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal },
  { render },
  { AskUserQuestionPanel },
  { QuestionStore },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('../src/dsh-adapter/questions.js'),
])

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ── Store state machine ────────────────────────────────────────────────
const store = new QuestionStore()
const answerPromise = store.ask({
  questions: [
    { id: 'q1', question: '第一题', options: [{ label: 'A' }, { label: 'C' }] },
    { id: 'q2', question: '第二题', options: [{ label: 'B' }, { label: 'D' }] },
  ],
} as never)

assert.equal(store.getSnapshot()?.position, 1)
assert.equal(store.getSnapshot()?.canGoBack, false)

store.answerCurrent({ selected: ['A'] })
assert.equal(store.getSnapshot()?.position, 2)
assert.equal(store.getSnapshot()?.draft, undefined)
assert.equal(store.getSnapshot()?.canGoBack, true)

// Leave an unsubmitted Q2 draft, go back, then edit Q1.
store.backCurrent({ selected: ['B'], custom: 'partial draft' })
assert.equal(store.getSnapshot()?.position, 1)
assert.deepEqual(store.getSnapshot()?.draft, { selected: ['A'] })

store.answerCurrent({ selected: ['C'] })
assert.equal(store.getSnapshot()?.position, 2)
assert.deepEqual(store.getSnapshot()?.draft, { selected: ['B'], custom: 'partial draft' })

store.answerCurrent({ selected: ['D'] })
assert.deepEqual(await answerPromise, {
  answers: [
    { id: 'q1', selected: ['C'] },
    { id: 'q2', selected: ['D'] },
  ],
})
const [summary] = store.takeSummaries()
assert.ok(summary?.lines.some(line => line.includes('第一题') && line.includes('C')))
assert.ok(summary?.lines.some(line => line.includes('第二题') && line.includes('D')))
assert.ok(!summary?.lines.some(line => line.includes('A') || line.includes('partial draft')))

// ── Panel restoration and Esc routing ──────────────────────────────────
const terminal = new Terminal({ cols: 90, rows: 30, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = 90
  rows = 30
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    terminal.write(String(chunk), callback)
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin()
const stdout = new FakeStdout()
const screen = (): string => Array.from({ length: 30 }, (_, y) =>
  terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')

let backDraft: unknown
let cancelled = false
const app = await render(React.createElement(AskUserQuestionPanel, {
  position: 2,
  total: 2,
  answered: 1,
  initialDraft: { selected: ['Beta'], custom: 'draft text' },
  question: {
    question: '恢复上一题的草稿',
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
  },
  onAnswer() {},
  onBack: (draft: unknown) => { backDraft = draft },
  onCancel: () => { cancelled = true },
}), { stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false })
await sleep(300)
assert.ok(screen().includes('draft text'))
assert.ok(screen().includes('● Beta'))

stdin.write('\x1b')
await sleep(200)
assert.deepEqual(backDraft, { selected: ['Beta'], custom: 'draft text' })
assert.equal(cancelled, false)

app.rerender(React.createElement(AskUserQuestionPanel, {
  position: 1,
  total: 2,
  answered: 0,
  question: { question: '第一题', options: [{ label: 'Alpha' }] },
  onAnswer() {},
  onCancel: () => { cancelled = true },
}))
await sleep(200)
stdin.write('\x1b')
await sleep(200)
assert.equal(cancelled, true)

await app.unmount()
terminal.dispose()
console.log('Question back-navigation regression passed')
