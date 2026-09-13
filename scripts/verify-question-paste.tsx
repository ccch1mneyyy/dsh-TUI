/**
 * Questionnaire-panel paste regression: both free-text surfaces of the
 * ask_user_question seam (AskUserQuestionPanel's custom input row and
 * PlanReviewPanel's feedback row) must paste like the composer —
 *
 *  - a bracketed paste (terminal Ctrl+Shift+V / right-click / terminals
 *    that intercept Ctrl+V) inserts its chunk verbatim after flattening
 *    newlines/control chars to spaces; a chunk that is all line breaks is
 *    TEXT, never an Enter press, so it must not submit the panel;
 *  - Ctrl+V (0x16) / Alt+V (ESC v) — the keymap `paste` binding — reads the
 *    clipboard ASYNCHRONOUSLY (fake reader injected through
 *    readClipboardOverride) and lands at the live caret: typing during the
 *    read is not clobbered, and repeat keys while a read is in flight are
 *    ignored;
 *  - where the text lands mirrors plain typing: at the caret on the input
 *    row, appended at the tail on an option row (+ label attach,
 *    single-select);
 *  - pasted content never PICKS an option: plan-review's digit quick-pick
 *    is keypress-only, and a pasted "1" must not approve on the default
 *    focus;
 *  - editing is batch-safe (several keys of one stdin chunk edit in order —
 *    typing + Enter in the SAME chunk still submits the typed text) and
 *    code-point-safe (an emoji is one ←/⌫ step, never a split surrogate).
 *
 * Drives the real useInput path with fake stdin; output is captured raw
 * and ANSI-stripped (no xterm dependency).
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { AskUserQuestionPanel }, { render }, { settle, settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
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
/** The real terminal screen, line by line. */
function screen(): string {
  return viewportLines(term, ROWS).join('\n')
}

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean, extra?: string) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failures++
    if (extra !== undefined) results.push(`      actual: ${extra.slice(0, 300)}`)
  }
}

let lastAnswer: unknown = undefined
let cancelCount = 0
let mountSeq = 0
type AppLike = { rerender(el: unknown): unknown; unmount(): void }
let app: AppLike | null = null
/** (Re)mount a fresh panel (new key → fresh instance + fresh editing state). */
async function mount(question: unknown, reader?: () => Promise<unknown>): Promise<void> {
  mountSeq++
  const element = React.createElement(AskUserQuestionPanel, {
    key: `paste-q${mountSeq}`,
    question,
    position: 1,
    total: 1,
    answered: 0,
    onAnswer: (selection: unknown) => { lastAnswer = selection },
    onCancel: () => { cancelCount++ },
    ...(reader === undefined ? {} : { readClipboardOverride: reader }),
  })
  if (app === null) {
    app = await render(element, { stdout, stdin, stderr: new FakeStdout(), debug: true, exitOnCtrlC: false }) as unknown as AppLike
  } else {
    await app.rerender(element)
  }
}
/** A fake clipboard reader resolving after a short delay (real async gap). */
function clipboard(content: unknown, delayMs = 30): () => Promise<unknown> {
  return () => new Promise(resolve => setTimeout(() => resolve(content), delayMs))
}
const CHUNK = (text: string): string => `\x1b[200~${text}\x1b[201~`
const answerCustom = (): string | undefined => {
  const a = lastAnswer as { selected?: string[]; custom?: string } | undefined
  return a?.custom
}
const answerSelected = (): string[] => {
  const a = lastAnswer as { selected?: string[] } | undefined
  return a?.selected ?? []
}
const textQuestion = { question: '还有别的要说吗？' }
const optionQuestion = {
  question: '你有 API Key 吗？',
  options: [{ label: '我有' }, { label: '我没有' }],
}
const planReviewQuestion = {
  question: '按计划执行？',
  detail: '计划：改三处文件。',
  options: [{ label: '批准' }, { label: '继续计划' }],
  intent: { kind: 'plan-review', approve: '批准' },
}

// ── 1. Bracketed paste into the input row: flattened to one line. ─────
lastAnswer = undefined
await mount(optionQuestion)
await settle(() => screen().includes('你有 API Key 吗？'))
stdin.write('\t') // focus the custom input row
await sleep(120) // 固定窗:pacing 等焦点落到输入行再发粘贴块，焦点态无可轮询锚点
stdin.write(CHUNK('地址：\n第二行\x07带\t制表符'))
check('1a: chunk paste flattens newlines/tabs/control chars to spaces',
  await settled(() => screen().includes('地址： 第二行 带 制表符')), screen())
check('1b: chunk paste alone never submits', lastAnswer === undefined)
stdin.write('\r')
check('1c: Enter carries the flattened text as a pure custom answer',
  await settled(() => answerCustom() === '地址： 第二行 带 制表符' && answerSelected().length === 0),
  JSON.stringify(lastAnswer))

// ── 1d. Paste with COMPLETE ANSI/OSC sequences: stripped entirely, no
//       `[31m` residue and no surviving control char. ──────────────────
lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write(CHUNK('红\x1b[31m色\x1b[0m灯\x1b]0;标题\x07亮'))
stdin.write('\r')
check('1d: ANSI/OSC sequences are stripped, text survives verbatim',
  await settled(() => answerCustom() === '红色灯亮'), JSON.stringify(answerCustom()))

// ── 2. A chunk that is ALL line breaks is text: no submit, no text. ────
lastAnswer = undefined
cancelCount = 0
await mount(optionQuestion)
await settle(() => screen().includes('你有 API Key 吗？'))
stdin.write('\t')
await sleep(120) // 固定窗:pacing 等焦点落到输入行再发粘贴块，焦点态无可轮询锚点
stdin.write(CHUNK('\r\n\r\n'))
// 固定窗:探针 纯换行粘贴不得提交——没有任何可观察的变化可等。
await sleep(250)
check('2a: pure-newline paste does NOT submit the question', lastAnswer === undefined)
stdin.write('\r')
check('2b: Enter on the empty answer shows the validation error (no phantom text)',
  await settled(() => screen().includes('先输入回答内容再提交')), screen())

// ── 3. Ctrl+V reads the clipboard asynchronously and lands at the LIVE
//       caret. Two arms: (a) idle — paste lands mid-text at the caret;
//       (b) RACE — typing continues while the read is in flight (reader
//       delayed 400ms), so the paste must resolve AFTER that typing and
//       land at the caret the user actually sees (never clobber it, never
//       fall back to the keypress-time position). ───────────────────────
lastAnswer = undefined
await mount(textQuestion, clipboard({ kind: 'text', text: 'B' }, 80))
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('ac') // text-only question: input row focused from the start
await settle(() => screen().includes('ac'))
stdin.write('\x1b[D') // ← caret between a and c
await sleep(120) // 固定窗:pacing 光标移动不可观测，仅为按键排序
stdin.write('\x16') // Ctrl+V → async read of 'B'
check('3a: idle paste lands at the caret',
  await settled(() => screen().includes('aBc'), { timeoutMs: 3000 }), screen())
stdin.write('\r')
check('3b: idle-paste answer is in order',
  await settled(() => answerCustom() === 'aBc'), JSON.stringify(lastAnswer))

lastAnswer = undefined
await mount(textQuestion, clipboard({ kind: 'text', text: 'B' }, 400))
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('ac')
await settle(() => screen().includes('ac'))
stdin.write('\x1b[D')
await sleep(120) // 固定窗:pacing 光标移动不可观测，仅为按键排序
stdin.write('\x16') // read starts; resolves ~400ms later
stdin.write('tail') // typed BEFORE the read resolves (a|tail|c → 'atailc')
check('3c: typing during the read lands first, paste follows at the LIVE caret',
  await settled(() => screen().includes('atailBc'), { timeoutMs: 3000 }), screen())
stdin.write('\r')
check('3d: raced answer keeps the order (paste after the typed tail)',
  await settled(() => answerCustom() === 'atailBc'), JSON.stringify(lastAnswer))

// ── 4. Ctrl+V on an option row: append at the tail + attach the label. ─
lastAnswer = undefined
await mount(optionQuestion, clipboard({ kind: 'text', text: '我的密钥 sk-x' }))
await settle(() => screen().includes('我有'))
stdin.write('\x16')
await settled(() => screen().includes('我的密钥 sk-x'))
check('4a: option-row paste appends and attaches the focused label',
  await settled(() => screen().includes('（附加：我有）')), screen())
stdin.write('\r')
check('4b: Enter on the option row carries BOTH the label and the pasted text',
  await settled(() => answerSelected().join() === '我有' && answerCustom() === '我的密钥 sk-x'),
  JSON.stringify(lastAnswer))

// ── 5. Alt+V alias (ESC v) reaches the same clipboard arm. ────────────
lastAnswer = undefined
await mount(textQuestion, clipboard({ kind: 'text', text: 'alt-ok' }))
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('\x1bv')
await settled(() => screen().includes('alt-ok'))
stdin.write('\r')
check('5a: Alt+V pastes like Ctrl+V', await settled(() => answerCustom() === 'alt-ok'), JSON.stringify(lastAnswer))

// ── 6. Clipboard content that is not text → inline error, no crash. ────
lastAnswer = undefined
await mount(textQuestion, clipboard({ kind: 'image', path: 'C:/shots/paste-x.png' }))
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('\x16')
check('6a: image clipboard shows the not-text error',
  await settled(() => screen().includes('剪贴板内容是图片或文件，无法作为文字粘贴')), screen())
lastAnswer = undefined
await mount(textQuestion, clipboard({ kind: 'files', paths: ['C:/a.txt'] }))
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('\x16')
check('6b: file clipboard shows the same error',
  await settled(() => screen().includes('剪贴板内容是图片或文件，无法作为文字粘贴')), screen())
lastAnswer = undefined
await mount(textQuestion, clipboard(null))
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('\x16')
check('6c: empty clipboard shows the empty error', await settled(() => screen().includes('剪贴板为空')), screen())
lastAnswer = undefined
await mount(textQuestion, () => Promise.reject(new Error('boom')))
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('\x16')
check('6d: clipboard read failure shows the failure error',
  await settled(() => screen().includes('读取剪贴板失败')), screen())

// ── 6e/6f. Over-cap paste is refused with an inline error — never
//       truncated silently, on either transport. ────────────────────────
const overLong = '长'.repeat(8001)
lastAnswer = undefined
await mount(textQuestion, clipboard({ kind: 'text', text: overLong }))
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('\x16')
check('6e: Ctrl+V past the cap shows the too-long error, inserts nothing',
  await settled(() => screen().includes('粘贴内容过长')), screen())
stdin.write('ok')
await settle(() => screen().includes('ok'))
stdin.write('\r')
check('6f: …and the field still accepts typing afterwards',
  await settled(() => answerCustom() === 'ok'), JSON.stringify(lastAnswer))
lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write(CHUNK(overLong))
check('6g: bracketed paste past the cap shows the same error',
  await settled(() => screen().includes('粘贴内容过长')), screen())

// ── 7. Batched keys in ONE stdin chunk edit through synchronous refs:
//       a terminal delivers one chunk as several key events inside a
//       single React batch, so the second event must see the first's
//       result (stale closure state would misplace the insert). ─────────
lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('ab') // settle the base text first
await settle(() => screen().includes('ab'))
stdin.write('\x1b[Dx') // ← moves the caret, x types AFTER it — one chunk
check('7a: batched ←+x inserts at the MOVED caret',
  await settled(() => screen().includes('axb')), screen())
stdin.write('\r')
check('7b: batched edit answer is in order',
  await settled(() => answerCustom() === 'axb'), JSON.stringify(lastAnswer))

// One chunk can also carry a text run followed by a bracketed-paste chunk
// (unbracketed paste with an embedded terminal paste): both land in order.
lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write(`ab${CHUNK('X')}`)
await settled(() => screen().includes('abX'))
stdin.write('\r')
check('7c: text run + paste chunk in one stdin chunk land in order',
  await settled(() => answerCustom() === 'abX'), JSON.stringify(lastAnswer))

// ── 8. Plan review: pasted content never quick-picks or approves. ──────
// The feedback row is the screen line holding the ✎ glyph; the option rows
// always show "1. 批准" / "2. 继续计划", so a whole-screen includes('1')
// would be vacuous — probe the feedback LINE itself.
const feedbackRow = (): string =>
  screen().split('\n').find(line => line.includes('✎')) ?? ''
lastAnswer = undefined
cancelCount = 0
await mount(planReviewQuestion)
await settle(() => screen().includes('批准'))
stdin.write(CHUNK('1')) // a pasted digit must NOT pick option 1 (批准)
await sleep(250) // 固定窗:探针 粘贴的数字不得选中选项/提交
check('8a: pasted digit does NOT approve the plan', lastAnswer === undefined, JSON.stringify(lastAnswer))
check('8b: pasted digit lands in the feedback row (focused)',
  await settled(() => feedbackRow().trimEnd().endsWith('1')), feedbackRow())
stdin.write('\r')
check('8c: Enter routes it to keep-planning-with-feedback',
  await settled(() => answerSelected().join() === '继续计划' && answerCustom() === '1'),
  JSON.stringify(lastAnswer))
lastAnswer = undefined
await mount(planReviewQuestion, clipboard({ kind: 'text', text: '改成这样行吗' }))
await settle(() => screen().includes('批准'))
stdin.write('\x16') // Ctrl+V while Approve is focused
await settled(() => screen().includes('改成这样行吗'))
stdin.write('\r')
check('8d: Ctrl+V feedback then Enter = keep-planning, never approve',
  await settled(() => answerSelected().join() === '继续计划' && answerCustom() === '改成这样行吗'),
  JSON.stringify(lastAnswer))

// ── 9. Pure-option questions (hideCustomInput): paste is inert. ────────
lastAnswer = undefined
await mount({ ...optionQuestion, hideCustomInput: true }, clipboard({ kind: 'text', text: 'X' }))
await settle(() => screen().includes('我有'))
stdin.write(CHUNK('X'))
await sleep(150) // 固定窗:探针 hideCustomInput 下粘贴必须无效，屏上不得出现 X
stdin.write('\x16')
await sleep(150) // 固定窗:探针 Ctrl+V 同样必须无效，屏上不得出现 X
check('9a: paste into a hideCustomInput question types nothing', !screen().includes('X'), screen())
check('9b: …and never submits', lastAnswer === undefined)

// ── 10. Repeat Ctrl+V while a read is in flight: only one insert. ──────
lastAnswer = undefined
await mount(textQuestion, clipboard({ kind: 'text', text: 'X' }, 150))
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('\x16\x16') // two keys, one chunk — the busy guard drops the second
// 固定窗:探针 第二次读取不得再插一份：settled 会在第一次插入（X 上屏）时
// 就返回，错过随后可能到达的 XX（reader 延迟 150ms，窗口覆盖两轮）。
await sleep(350)
check('10a: double Ctrl+V inserts exactly once', screen().includes('X') && !screen().includes('XX'), screen())
stdin.write('\r')
check('10b: …and the answer holds the single insert',
  await settled(() => answerCustom() === 'X'), JSON.stringify(lastAnswer))

// ── 11. Code-point caret: an emoji is one ⌫ step (never a split pair). ─
lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write(CHUNK('a😀b'))
await settled(() => screen().includes('a😀b'))
stdin.write('\x1b[D') // ← (one code-point step)
await sleep(120) // 固定窗:pacing 光标移动不可观测，仅为按键排序
stdin.write('\x7f') // backspace removes the WHOLE emoji
await sleep(120) // 固定窗:pacing 退格与回车分批送达，避免并入同一 stdin chunk
stdin.write('\r')
check('11a: backspace deletes the full emoji as one step (no lone surrogate)',
  await settled(() => answerCustom() === 'ab'), JSON.stringify(answerCustom()))

// ── 12. Esc still cancels after all the pasting (no swallowed keys). ───
cancelCount = 0
await mount(optionQuestion)
await settle(() => screen().includes('我有'))
stdin.write('\x1b')
check('12a: Esc cancels a fresh panel', await settled(() => cancelCount === 1))

app?.unmount()
await sleep(100) // 固定窗:pacing 等卸载收尾写完，无可观测完成条件
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
