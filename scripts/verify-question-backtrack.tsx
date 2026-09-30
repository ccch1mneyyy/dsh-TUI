/**
 * Questionnaire back-navigation regression.
 *
 * Covers both halves of the flow:
 *   1. QuestionStore replaces answers by question index, preserves drafts,
 *      and emits the final answer list in request order.
 *   2. AskUserQuestionPanel restores a saved draft and routes Esc / ← to the
 *      previous-question callback while keeping first-question Esc as cancel.
 *   3. → peeks at the next question without submitting; answering the last
 *      question while an earlier one is still open returns to that gap
 *      instead of settling a partial batch.
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
  { buildQuestionRecord },
  { settle, settled, sleep },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel/question-record.js'),
  import('./lib/term-test.mjs'),
])

// ── Store state machine ────────────────────────────────────────────────
const questions = [
  { id: 'q1', question: '第一题', options: [{ label: 'A' }, { label: 'C' }] },
  { id: 'q2', question: '第二题', options: [{ label: 'B' }, { label: 'D' }] },
]
const store = new QuestionStore()
const answerPromise = store.ask({ questions } as never)

assert.equal(store.getSnapshot()?.position, 1)
assert.equal(store.getSnapshot()?.canGoBack, false)
assert.equal(store.getSnapshot()?.canGoForward, true)

store.forwardCurrent({ selected: [], custom: 'peek' })
assert.equal(store.getSnapshot()?.position, 2)
assert.equal(store.getSnapshot()?.canGoForward, false)
assert.equal(store.getSnapshot()?.draft, undefined)
store.backCurrent()
assert.deepEqual(store.getSnapshot()?.draft, { selected: [], custom: 'peek' })

store.answerCurrent({ selected: ['A'] })
assert.equal(store.getSnapshot()?.position, 2)
assert.equal(store.getSnapshot()?.draft, undefined)
assert.equal(store.getSnapshot()?.canGoBack, true)
assert.equal(store.getSnapshot()?.canGoForward, false)

// Leave an unsubmitted Q2 draft, go back, then edit Q1.
store.backCurrent({ selected: ['B'], custom: 'partial draft' })
assert.equal(store.getSnapshot()?.position, 1)
assert.deepEqual(store.getSnapshot()?.draft, { selected: ['A'] })

store.answerCurrent({ selected: ['C'] })
assert.equal(store.getSnapshot()?.position, 2)
assert.deepEqual(store.getSnapshot()?.draft, { selected: ['B'], custom: 'partial draft' })

store.answerCurrent({ selected: ['D'] })
const settledAnswers = await answerPromise
assert.deepEqual(settledAnswers, {
  answers: [
    { id: 'q1', selected: ['C'] },
    { id: 'q2', selected: ['D'] },
  ],
})
// 最终作答记录由持久化 tool/result 载荷里的 answers 折叠而来（#1009）：
// 同一批问题 + 同一份 answers 必须得到与旧 store 摘要相同的记录。
const record = buildQuestionRecord(questions, settledAnswers.answers)
assert.ok(record.lines.some(line => line.includes('第一题') && line.includes('C')))
assert.ok(record.lines.some(line => line.includes('第二题') && line.includes('D')))
assert.ok(!record.lines.some(line => line.includes('A') || line.includes('partial draft')))

// Peeking ahead and submitting the last question must not drop the gap.
const gapPromise = store.ask({
  questions: [
    { id: 'g1', question: '缺口题', options: [{ label: 'Keep' }] },
    { id: 'g2', question: '末题', options: [{ label: 'Skip' }] },
  ],
} as never)
store.forwardCurrent()
assert.equal(store.getSnapshot()?.position, 2)
store.answerCurrent({ selected: ['Skip'] })
assert.equal(store.getSnapshot()?.position, 1)
assert.equal(store.getSnapshot()?.question.question, '缺口题')
store.answerCurrent({ selected: ['Keep'] })
assert.deepEqual(await gapPromise, {
  answers: [
    { id: 'g1', selected: ['Keep'] },
    { id: 'g2', selected: ['Skip'] },
  ],
})

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
let forwardDraft: unknown
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
  onForward: (draft: unknown) => { forwardDraft = draft },
  onCancel: () => { cancelled = true },
}), { stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false })
assert.ok(await settled(() => screen().includes('draft text')))
assert.ok(await settled(() => screen().includes('● Beta')))

stdin.write('\x1b')
// onBack 回调同步整体赋值 backDraft；等回调触发后值即终态，深比较为同步派生断言。
assert.ok(await settled(() => backDraft !== undefined))
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
await settle(() => screen().includes('第一题'))
stdin.write('\x1b')
assert.equal(await settled(() => cancelled), true)
await app.unmount()

// Option-row → switches forward; ← switches back. Input-row arrows only
// switch at the text edge, so a mid-text ← must not leave the question.
const arrowApp = await render(React.createElement(AskUserQuestionPanel, {
  position: 1,
  total: 2,
  answered: 0,
  question: { question: '方向键换题', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
  onAnswer() {},
  onForward: (draft: unknown) => { forwardDraft = draft },
  onCancel() {},
}), { stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false })
assert.ok(await settled(() => screen().includes('←/→')))
forwardDraft = undefined
stdin.write('\x1b[C')
assert.ok(await settled(() => forwardDraft !== undefined))
assert.deepEqual(forwardDraft, { selected: ['Alpha'] })

arrowApp.rerender(React.createElement(AskUserQuestionPanel, {
  position: 2,
  total: 2,
  answered: 1,
  question: { question: '第二题方向键', options: [{ label: 'Gamma' }] },
  onAnswer() {},
  onBack: (draft: unknown) => { backDraft = draft },
  onCancel() {},
}))
await settle(() => screen().includes('第二题方向键'))
backDraft = undefined
stdin.write('\x1b[D')
assert.ok(await settled(() => backDraft !== undefined))
assert.deepEqual(backDraft, { selected: ['Gamma'] })

await arrowApp.unmount()
// A question change remounts in Chat (snapshot key includes the index).
// Rerender would keep the previous row's caret/text, which is not the
// contract under test.
const inputApp = await render(React.createElement(AskUserQuestionPanel, {
  position: 2,
  total: 2,
  answered: 1,
  initialDraft: { selected: [], custom: 'ab' },
  question: { question: '输入行边界', options: [] },
  onAnswer() {},
  onBack: (draft: unknown) => { backDraft = draft },
  onForward: (draft: unknown) => { forwardDraft = draft },
  onCancel() {},
}), { stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false })
await settle(() => screen().includes('输入行边界') && screen().includes('ab'))
backDraft = undefined
forwardDraft = undefined
stdin.write('\x1b[C') // caret already at the end → next question
assert.ok(await settled(() => forwardDraft !== undefined))
assert.deepEqual(forwardDraft, { selected: [], custom: 'ab' })
forwardDraft = undefined
stdin.write('\x1b[D') // end → between a and b
await sleep(80) // 固定窗:探针 光标左移没有屏幕锚点，过早断言会把「还没处理」当成「没有换题」
assert.equal(backDraft, undefined)
stdin.write('\x1b[D') // between → start; still editing
await sleep(80) // 固定窗:探针 同上，第二次左移仍不应触发换题
assert.equal(backDraft, undefined)
stdin.write('\x1b[D') // already at the start → previous question
assert.ok(await settled(() => backDraft !== undefined))
assert.deepEqual(backDraft, { selected: [], custom: 'ab' })
await inputApp.unmount()

// One stdin batch shares one React commit. Space / ↓ must already be in
// the draft → saves, and → then Enter must not record the old panel's
// selection against the question → just opened.
const batchApp = await render(React.createElement(AskUserQuestionPanel, {
  position: 1,
  total: 2,
  answered: 0,
  question: {
    question: '同批多选',
    multiSelect: true,
    options: [{ label: 'One' }, { label: 'Two' }],
  },
  onAnswer() {},
  onForward: (draft: unknown) => { forwardDraft = draft },
  onCancel() {},
}), { stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false })
await settle(() => screen().includes('同批多选'))
forwardDraft = undefined
stdin.write(' \x1b[C')
assert.ok(await settled(() => forwardDraft !== undefined))
assert.deepEqual(forwardDraft, { selected: ['One'] })
await batchApp.unmount()

const moveApp = await render(React.createElement(AskUserQuestionPanel, {
  position: 1,
  total: 2,
  answered: 0,
  question: {
    question: '同批移动',
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
  },
  onAnswer() {},
  onForward: (draft: unknown) => { forwardDraft = draft },
  onCancel() {},
}), { stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false })
await settle(() => screen().includes('同批移动'))
forwardDraft = undefined
stdin.write('\x1b[B\x1b[C')
assert.ok(await settled(() => forwardDraft !== undefined))
assert.deepEqual(forwardDraft, { selected: ['Beta'] })
await moveApp.unmount()

const staleStore = new QuestionStore()
const stalePromise = staleStore.ask({
  questions: [
    { id: 's1', question: '旧面板', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
    { id: 's2', question: '新面板', options: [{ label: 'Gamma' }] },
  ],
} as never)
const staleKey = staleStore.getSnapshot()?.key
assert.equal(typeof staleKey, 'string')
const staleApp = await render(React.createElement(AskUserQuestionPanel, {
  position: 1,
  total: 2,
  answered: 0,
  question: {
    question: '旧面板',
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
  },
  onAnswer(selection: { selected: string[] }) {
    if (!staleStore.stillCurrent(staleKey!)) return
    staleStore.answerCurrent(selection)
  },
  onForward(draft: { selected: string[] }) {
    if (!staleStore.stillCurrent(staleKey!)) return
    staleStore.forwardCurrent(draft)
  },
  onCancel() {},
}), { stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false })
await settle(() => screen().includes('旧面板'))
stdin.write('\x1b[C\r')
await settle(() => staleStore.getSnapshot()?.question.question === '新面板')
assert.equal(staleStore.getSnapshot()?.position, 2)
assert.equal(staleStore.getSnapshot()?.draft, undefined)
let staleSettled = false
void stalePromise.then(() => { staleSettled = true })
await sleep(40) // 固定窗:探针 半套答案不得在这一拍里结算
assert.equal(staleSettled, false)
staleStore.backCurrent()
staleStore.answerCurrent({ selected: ['Alpha'] })
staleStore.answerCurrent({ selected: ['Gamma'] })
assert.deepEqual(await stalePromise, {
  answers: [
    { id: 's1', selected: ['Alpha'] },
    { id: 's2', selected: ['Gamma'] },
  ],
})
await staleApp.unmount()

// Question 1 has no onBack, so a stale Esc would cancel the batch. → then
// Esc must follow the live question: back, not cancel. Ctrl+C still cancels.
const escStore = new QuestionStore()
let escCancelled = false
const escPromise = escStore.ask({
  questions: [
    { id: 'e1', question: '第一题取消', options: [{ label: 'Alpha' }] },
    { id: 'e2', question: '第二题', options: [{ label: 'Beta' }] },
  ],
} as never)
const escKey = escStore.getSnapshot()?.key ?? ''
const escapeLikeChat = (draft: { selected: string[] }): void => {
  const live = escStore.getSnapshot()
  if (live?.canGoBack) {
    escStore.backCurrent(escStore.stillCurrent(escKey) ? draft : undefined)
    return
  }
  if (live !== null && escStore.stillCurrent(escKey)) escStore.cancelCurrent()
}
const escApp = await render(React.createElement(AskUserQuestionPanel, {
  position: 1,
  total: 2,
  answered: 0,
  question: { question: '第一题取消', options: [{ label: 'Alpha' }] },
  onAnswer() {},
  onForward(draft: { selected: string[] }) {
    if (!escStore.stillCurrent(escKey)) return
    escStore.forwardCurrent(draft)
  },
  onEscape: escapeLikeChat,
  onCancel() {
    escCancelled = true
    escStore.cancelCurrent()
  },
}), { stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false })
await settle(() => screen().includes('第一题取消'))
stdin.write('hi\x1b[C\x1b')
assert.ok(await settled(() => {
  const snap = escStore.getSnapshot()
  return snap?.position === 1 && snap.draft?.custom === 'hi'
}))
assert.equal(escCancelled, false)
assert.deepEqual(escStore.getSnapshot()?.draft, { selected: ['Alpha'], custom: 'hi' })
escStore.forwardCurrent()
assert.equal(escStore.getSnapshot()?.position, 2)
assert.equal(escStore.getSnapshot()?.draft, undefined)
escStore.backCurrent()
let escRejected = false
void escPromise.catch(() => { escRejected = true })
await sleep(40) // 固定窗:探针 → 后的 Esc 不得把整批问券取消掉
assert.equal(escRejected, false)
await escApp.unmount()
terminal.dispose()
console.log('Question back-navigation regression passed')
