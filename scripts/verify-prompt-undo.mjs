#!/usr/bin/env node
/**
 * Prompt-draft undo regression (compiled lib): `Ctrl+Z` is a WORD-LEVEL undo
 * of the composer draft, on every platform key encoding, and it is explicitly
 * NOT the message/conversation rewind (`Esc Esc` → onRewindRequest).
 *
 * Drives the real PromptInput through fake stdin and an injected clock (the
 * `now` prop): the 700ms idle rule is exercised by advancing the clock, never
 * by sleeping — a wall-clock wait would be flaky under load.
 *
 * Checks:
 * - `\x1a` (raw) and `\x1b[122;5u` (kitty CSI-u) agree
 * - UAX #29 word grouping: 今天天气很好 → 3 steps, 研究生 → 1 step (fast)
 * - idle > 700ms breaks the run (slow typing is per-character)
 * - CJK punctuation and script transitions (Han/Latin/digit) break
 * - `1` + `3.14` is not fused into one step (the ±32 context window)
 * - a direction flip (typing → Backspace) and a caret jump break
 * - repeated characters keep the actual insertion/deletion caret as the anchor
 * - a deletion run stays ONE step inside the word it began in — including the
 *   word's left edge, the text head, and a re-segmented CJK suffix; crossing
 *   the edge (or the other deletion direction) starts a new step
 * - a bracketed paste is one step, never fused into the typing run
 * - undoing a whole-block deletion restores its fold range and caret
 * - Enter/submit ends the history; `Esc` clear is undoable
 * - recalling a pending message (Alt+Up) is NOT undoable
 * - an undo stack holding an image keeps its capability alive
 * - an empty stack is a no-op: no rewind request, no clear
 * - `suspended` (a panel owns the keyboard) leaves Ctrl+Z inert
 *
 * Run after build: `node scripts/verify-prompt-undo.mjs`
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { settled, sleep } from './lib/term-test.mjs'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-prompt-undo-'))
process.env.HOME = home
process.env.USERPROFILE = home

const [
  { default: React },
  { render },
  { PromptInput },
] = await Promise.all([
  import('react'),
  import('../lib/types/ui.js'),
  import('../lib/types/components/PromptInput.js'),
])

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---- injected clock --------------------------------------------------------
// Handed to the component as the `now` prop; never a wall-clock sleep.
let clock = 0
const now = () => clock
const advance = ms => {
  clock += ms
}

function makeStreams() {
  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

// ---- fake channel ----------------------------------------------------------
const submitted = []
const discardedImages = []
let rewindCalls = 0
const staged = new Map([['stage-1', { id: 'stage-1', name: 'shot.png' }]])
const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [],
  commandCompletions: () => [],
  notifications: [],
  pending: [],
  working: false,
  notify() {},
  submit(text) { submitted.push(text) },
  steer() {},
  interruptAndDeliver() { return 0 },
  removePending(id) {
    const index = channel.pending.findIndex(item => item.id === id)
    if (index < 0) return false
    channel.pending.splice(index, 1)
    return true
  },
  stageImage() {},
  listFiles: async () => [],
  stagedImageGeneration: () => 0,
  hasStagedImage: id => staged.has(id),
  stagedImage: id => staged.get(id),
  discardStagedImage(id) {
    discardedImages.push(id)
    staged.delete(id)
  },
}

const controllerRef = { current: null }
const baseProps = {
  channel,
  helpOpen: false,
  onToggleHelp() {},
  onRunCommand: () => false,
  selectionActive: false,
  controllerRef,
  onRewindRequest() { rewindCalls += 1 },
  now,
}
const mount = extra => React.createElement(PromptInput, { ...baseProps, ...extra })

const { stdout, stderr, stdin } = makeStreams()
const instance = await render(mount(), { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false })

// ---- helpers ---------------------------------------------------------------
const text = () => controllerRef.current?.text() ?? ''

/** Ctrl+C idle clear: ends the draft AND its undo history (a known baseline). */
const clearAll = async () => {
  controllerRef.current?.clear()
  await settled(() => text() === '', { timeoutMs: 2000 })
}

/** Type one code point per stdin read, waiting for each to land. */
const typeInto = async (str, idleMs = 10) => {
  for (const char of str) {
    const want = text() + char
    advance(idleMs)
    stdin.write(char)
    const ok = await settled(() => text() === want, { timeoutMs: 2000 })
    if (!ok) throw new Error(`typing stalled: want ${JSON.stringify(want)} got ${JSON.stringify(text())}`)
  }
}

const RAW_CTRL_Z = '\x1a'
const CSI_U_CTRL_Z = '\x1b[122;5u'
/** CSI with modifier 3 (Alt) — the encoding `meta + upArrow` arrives as. */
const ALT_UP = '\x1b[1;3A'
const ctrlZ = async (sequence = RAW_CTRL_Z) => {
  advance(10)
  stdin.write(sequence)
}
/** Ctrl+Z, then wait for `want` (or for "nothing changed" when want === text). */
const ctrlZTo = async want => {
  await ctrlZ()
  return settled(() => text() === want, { timeoutMs: 2000 })
}
/** Ctrl+Z with no expected change, then a settle window to catch a late move. */
const ctrlZNoop = async () => {
  const before = text()
  await ctrlZ()
  await sleep(150) // 固定窗:探针 断言「空栈不得改动 draft」：对已成立条件轮询等于没测，等一个观察窗再断言不变量
  return text() === before
}

try {
  await sleep(300) // 固定窗:pacing 等启动首帧（假 stdout 丢弃全部帧，无可 settle 的锚点）

  // ── 1. both Ctrl+Z key encodings ────────────────────────
  await clearAll()
  await typeInto('hello')
  check('raw \\x1a undoes the typed word', await ctrlZTo(''))
  await clearAll()
  await typeInto('world')
  check('kitty CSI-u \\x1b[122;5u agrees with \\x1a', await ctrlZTo(''))

  // ── 2. word grouping (fast typing) ──────────────────────
  await clearAll()
  await typeInto('今天天气很好')
  const cjk1 = await ctrlZTo('今天天气')
  const cjk2 = await ctrlZTo('今天')
  const cjk3 = await ctrlZTo('')
  check('今天天气很好 → 3 word-level steps', cjk1 && cjk2 && cjk3,
    `${JSON.stringify(cjk1)}${JSON.stringify(cjk2)}${JSON.stringify(cjk3)}`)
  check('empty stack: Ctrl+Z neither clears nor rewinds', (await ctrlZNoop()) && rewindCalls === 0,
    `rewind=${rewindCalls}`)

  // ── 3/4. ICU keeps a proper noun whole; idle splits it ──
  await clearAll()
  await typeInto('研究生')
  check('ICU 研究生 is one word when typed fast', await ctrlZTo(''))
  await clearAll()
  await typeInto('研', 10)
  await typeInto('究', 800)
  check('idle > 700ms starts a new step (layer 3)', await ctrlZTo('研'))

  // ── 5. CJK punctuation always breaks ────────────────────
  await clearAll()
  await typeInto('你好，世界！')
  const p1 = await ctrlZTo('你好，世界')
  const p2 = await ctrlZTo('你好，')
  const p3 = await ctrlZTo('你好')
  const p4 = await ctrlZTo('')
  check('CJK punctuation breaks every time', p1 && p2 && p3 && p4,
    `${JSON.stringify(p1)}${JSON.stringify(p2)}${JSON.stringify(p3)}${JSON.stringify(p4)}`)

  // ── 6. script transitions (Han / Latin / digit) ─────────
  await clearAll()
  await typeInto('abc中文123')
  const s1 = await ctrlZTo('abc中文')
  const s2 = await ctrlZTo('abc')
  const s3 = await ctrlZTo('')
  check('abc中文123 → 3 script-level steps', s1 && s2 && s3,
    `${JSON.stringify(s1)}${JSON.stringify(s2)}${JSON.stringify(s3)}`)

  // ── 7. numeric seam: the context window must not fuse it ─
  // "1" then "3.14": ICU keeps the integer run "13" together, the '.' is a
  // script jump (digit → other) that severs it, and "14" starts a new word.
  // The point of the check is the step COUNT: a bare window would read the
  // whole thing as one token and fuse every keystroke into one step.
  await clearAll()
  await typeInto('1')
  await typeInto('3.14')
  const n1 = await ctrlZTo('13.')
  const n2 = await ctrlZTo('13')
  const n3 = await ctrlZTo('')
  check('1 + 3.14 is not fused into one step (windowed ICU)', n1 && n2 && n3,
    `${JSON.stringify(n1)}${JSON.stringify(n2)}${JSON.stringify(n3)}`)

  // ── 8. direction flip + delete runs ─────────────────────
  await clearAll()
  await typeInto('abc')
  stdin.write('\x7f') // Backspace
  await settled(() => text() === 'ab', { timeoutMs: 2000 })
  check('typing then Backspace starts a new step', await ctrlZTo('abc'))

  // A held Backspace stays inside one word, so the whole run is ONE step again
  // (three keys in one stdin read also exercises the batched path).
  await clearAll()
  await typeInto('abcdef')
  stdin.write('\x7f\x7f\x7f')
  await settled(() => text() === 'abc', { timeoutMs: 2000 })
  check('a Backspace run inside one word is a single step', await ctrlZTo('abcdef'))

  // Forward Delete at a caret inside the word merges the same way.
  await clearAll()
  await typeInto('abcdef')
  stdin.write('\x1b[D\x1b[D\x1b[D') // caret before 'd'
  await settled(() => text() === 'abcdef', { timeoutMs: 2000 })
  stdin.write('\x1b[3~\x1b[3~') // Delete Delete
  await settled(() => text() === 'abef', { timeoutMs: 2000 })
  check('a forward-Delete run is one step too', await ctrlZTo('abcdef'))

  // ── external injection is a new baseline, not an undoable edit ──
  await clearAll()
  await typeInto('myt')
  controllerRef.current?.append('-injected')
  await settled(() => text() === 'myt-injected', { timeoutMs: 2000 })
  check('an external injection cannot be undone back over the user typing',
    await ctrlZNoop(), JSON.stringify(text()))

  // ── 9. caret jump ───────────────────────────────────────
  await clearAll()
  await typeInto('ab')
  stdin.write('\x1b[D') // ←
  await sleep(80) // 固定窗:pacing 等方向键被消费后再打下一个键（光标位置无可轮询锚点）
  stdin.write('X')
  await settled(() => text() === 'aXb', { timeoutMs: 2000 })
  check('typing after a caret jump starts a new step', await ctrlZTo('ab'))

  await clearAll()
  await typeInto('aaa')
  stdin.write('\x1b[H' + 'a') // Home, then insert the same character at index 0
  await settled(() => text() === 'aaaa', { timeoutMs: 2000 })
  check('repeated-character insertion after Home does not merge with tail typing',
    await ctrlZTo('aaa'), JSON.stringify(text()))
  stdin.write('X')
  check('undo restores the insertion caret, not the inferred tail position',
    await settled(() => text() === 'Xaaa', { timeoutMs: 2000 }), JSON.stringify(text()))

  await clearAll()
  await typeInto('aaaa')
  stdin.write('\x1b[H\x1b[3~\x1b[3~') // Home, Delete, Delete
  await settled(() => text() === 'aa', { timeoutMs: 2000 })
  check('forward Delete inside a repeated-character word is one undo step',
    await ctrlZTo('aaaa'), JSON.stringify(text()))

  // ── 11. a bracketed paste is ONE step ───────────────────
  await clearAll()
  await typeInto('ab')
  stdin.write('\x1b[200~cd\x1b[201~')
  await settled(() => text() === 'abcd', { timeoutMs: 2000 })
  check('paste is its own step, never fused with typing', await ctrlZTo('ab'))

  // ── 13. Enter ends the undo history ─────────────────────
  await clearAll()
  await typeInto('hello')
  stdin.write('\r')
  await settled(() => submitted.length === 1, { timeoutMs: 2000 })
  check('after Enter the draft is not undoable', await ctrlZNoop(), JSON.stringify(text()))

  // ── 14. Esc clearing the draft is undoable ──────────────
  await clearAll()
  await typeInto('你好世界')
  stdin.write('\x1b')
  await settled(() => text() === '', { timeoutMs: 2000 })
  check('Esc clears the draft', text() === '')
  check('Ctrl+Z restores the Esc-cleared draft', await ctrlZTo('你好世界'))

  // ── 15. a recall (Alt+Up) is NOT undoable ───────────────
  await clearAll()
  await typeInto('kept')
  channel.pending.push({ id: 'pull-1', text: 'recalled' })
  stdin.write(ALT_UP) // Alt+Up
  const pulled = await settled(() => text() === 'recalled', { timeoutMs: 2000 })
  check('Alt+Up pulled the pending message', pulled, JSON.stringify(text()))
  check('a recall is not undoable (stack was cleared)', await ctrlZNoop(), JSON.stringify(text()))

  // ── 12. an undo entry keeps a staged image alive ────────
  await clearAll()
  channel.pending.push({
    id: 'img-1',
    text: '[Image #1]',
    images: [{ token: '[Image #1]', stageId: 'stage-1' }],
  })
  stdin.write(ALT_UP) // Alt+Up
  const imagePulled = await settled(() => text() === '[Image #1]', { timeoutMs: 2000 })
  check('Alt+Up pulled a draft carrying an image', imagePulled, JSON.stringify(text()))
  stdin.write('\x15') // Ctrl+U: delete the whole line in ONE edit
  await settled(() => text() === '', { timeoutMs: 2000 })
  check('deleting the token does not revoke the capability the undo stack holds',
    !discardedImages.includes('stage-1'), JSON.stringify(discardedImages))
  const imageBack = await ctrlZTo('[Image #1]')
  check('Ctrl+Z restores the image token', imageBack, JSON.stringify(text()))
  check('the restored image binding is live', controllerRef.current?.previewImages?.().length === 1,
    JSON.stringify(controllerRef.current?.previewImages?.().length))

  // ── 17. a deletion run is ONE step while it stays inside its word ──
  // P0 regression: the old rule asked `isDraftWordBoundary` at the removed
  // character's LEFT neighbour, so it stopped one keystroke early at a word's
  // left edge, at the text head, and on a re-segmented CJK suffix.

  // [A] Backspace to the text head, one key per stdin read.
  await clearAll()
  await typeInto('abc')
  stdin.write('\x7f')
  await settled(() => text() === 'ab', { timeoutMs: 2000 })
  stdin.write('\x7f')
  await settled(() => text() === 'a', { timeoutMs: 2000 })
  stdin.write('\x7f')
  await settled(() => text() === '', { timeoutMs: 2000 })
  check('abc + Backspace×3 (per key) is ONE step', await ctrlZTo('abc'), JSON.stringify(text()))

  // The same run fed as ONE stdin chunk must reach the same conclusion.
  await clearAll()
  await typeInto('abc')
  stdin.write('\x7f\x7f\x7f')
  await settled(() => text() === '', { timeoutMs: 2000 })
  check('abc + Backspace×3 (one chunk) is ONE step too', await ctrlZTo('abc'), JSON.stringify(text()))

  // [B] Forward Delete from the text head.
  await clearAll()
  await typeInto('abc')
  for (let i = 0; i < 3; i++) {
    stdin.write('\x1b[D') // ← one at a time: the caret lands on index 0
    await sleep(30) // 固定窗:pacing 等方向键被消费（光标位置无可轮询锚点）
  }
  stdin.write('\x1b[3~')
  await settled(() => text() === 'bc', { timeoutMs: 2000 })
  stdin.write('\x1b[3~')
  await settled(() => text() === 'c', { timeoutMs: 2000 })
  stdin.write('\x1b[3~')
  await settled(() => text() === '', { timeoutMs: 2000 })
  check('|abc + Delete×3 is ONE step', await ctrlZTo('abc'), JSON.stringify(text()))

  // [C] A CJK word deleted from its right edge: the interval comes from the
  // full pre-run text, so the truncated suffix is never re-segmented.
  await clearAll()
  await typeInto('今天天气')
  stdin.write('\x7f')
  await settled(() => text() === '今天天', { timeoutMs: 2000 })
  stdin.write('\x7f')
  await settled(() => text() === '今天', { timeoutMs: 2000 })
  check('今天天气 + Backspace×2 (word 天气) is ONE step', await ctrlZTo('今天天气'), JSON.stringify(text()))

  // [D] Baseline that must NOT regress: an interior Backspace run is one step.
  await clearAll()
  await typeInto('abcdef')
  stdin.write('\x7f')
  await settled(() => text() === 'abcde', { timeoutMs: 2000 })
  stdin.write('\x7f')
  await settled(() => text() === 'abcd', { timeoutMs: 2000 })
  stdin.write('\x7f')
  await settled(() => text() === 'abc', { timeoutMs: 2000 })
  check('abcdef + Backspace×3 is ONE step (baseline)', await ctrlZTo('abcdef'), JSON.stringify(text()))

  // [E] The word's LEFT edge: "def" is one step, and the space beyond it is a
  // new one — prove it by deleting the space too, then undoing twice.
  await clearAll()
  await typeInto('abc def')
  stdin.write('\x7f\x7f\x7f')
  await settled(() => text() === 'abc ', { timeoutMs: 2000 })
  check('abc def + Backspace×3 (word "def") is ONE step', await ctrlZTo('abc def'), JSON.stringify(text()))
  await clearAll()
  await typeInto('abc def')
  stdin.write('\x7f\x7f\x7f')
  await settled(() => text() === 'abc ', { timeoutMs: 2000 })
  stdin.write('\x7f') // the space: outside "def", so its own step
  await settled(() => text() === 'abc', { timeoutMs: 2000 })
  const edge1 = await ctrlZTo('abc ')
  const edge2 = await ctrlZTo('abc def')
  check("crossing the word's left edge starts a new step", edge1 && edge2,
    `${JSON.stringify(edge1)}${JSON.stringify(edge2)}`)

  // ── 20. suspended: a panel owns the keyboard ────────────
  await clearAll()
  await typeInto('abc')
  instance.rerender(mount({ suspended: true }))
  await sleep(120) // 固定窗:pacing 等 rerender 落地到 useInput 的 isActive（无锚点）
  stdin.write(RAW_CTRL_Z)
  await sleep(150) // 固定窗:探针 断言 suspended 时 Ctrl+Z 不得改动 draft：只能等观察窗
  instance.rerender(mount())
  await settled(() => text() === 'abc', { timeoutMs: 2000 })
  check('suspended: Ctrl+Z leaves the draft alone', text() === 'abc', JSON.stringify(text()))
  check('the stack survived: Ctrl+Z works again once active', await ctrlZTo(''))

  // Capture through the real draft handoff rather than inspecting a rendered
  // label: the restored text, caret and fold range must describe the same draft.
  for (const direction of ['backspace', 'delete']) {
    const foldedText = 'one\ntwo\nthree\nfour\nfive\nsix'
    const draftCache = { current: null }
    const foldedController = { current: null }
    const streams = makeStreams()
    const foldedInstance = await render(mount({ draftCache, controllerRef: foldedController }), {
      ...streams, exitOnCtrlC: false, patchConsole: false,
    })
    const foldedValue = () => foldedController.current?.text()
    try {
      await settled(() => foldedController.current !== null, { timeoutMs: 2000 })
      streams.stdin.write(`\x1b[200~${foldedText}\x1b[201~`)
      check(`${direction}: paste creates the block draft`,
        await settled(() => foldedValue() === foldedText, { timeoutMs: 2000 }))
      // Left jumps from the folded block's tail to its head atomically.
      streams.stdin.write(direction === 'backspace' ? '\x7f' : '\x1b[D\x1b[3~')
      check(`${direction}: one key deletes the whole fold block`,
        await settled(() => foldedValue() === '', { timeoutMs: 2000 }))
      streams.stdin.write(RAW_CTRL_Z)
      check(`${direction}: undo restores the whole block text`,
        await settled(() => foldedValue() === foldedText, { timeoutMs: 2000 }))
    } finally {
      foldedInstance.unmount()
    }
    const restored = draftCache.current
    check(`${direction}: undo restores the fold range and original caret`,
      restored?.value === foldedText &&
      restored?.cursor === (direction === 'backspace' ? foldedText.length : 0) &&
      restored?.foldBlock?.start === 0 && restored?.foldBlock?.end === foldedText.length,
      JSON.stringify(restored))
  }

  if (failed > 0) {
    console.error(`\n${failed} prompt-undo check(s) failed`)
    process.exitCode = 1
  } else {
    console.log('\nverify-prompt-undo OK')
  }
} finally {
  instance.unmount()
  rmSync(home, { recursive: true, force: true })
}
