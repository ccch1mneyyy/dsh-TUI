/**
 * Paste-payload integrity regression (ADR-0008 payload-integrity-first).
 *
 * The win32-input-mode paste family carried three paste-only hazards. All
 * three are pinned here, one section each:
 *
 *  (a) ORDER / ANCHOR — `sanitizePastedText` ran the ESC-less tail strip
 *      BEFORE the complete-record strip, and that tail pattern did not require
 *      the absence of a preceding ESC. A COMPLETE record was sliced open from
 *      its middle, and the orphan ESC left behind was eaten by `stripAnsi`
 *      TOGETHER WITH the payload character after it
 *      (`ESC[13;28;13;1;0;1_ravo` → `avo`). Minimum trigger: 9 characters.
 *  (b) PREMISE WIDTH — the tail strip fired on any payload that carried a
 *      complete record, so a record-shaped run belonging to the payload's OWN
 *      text lost its bytes (16 characters in the minimum case). ADR-0008: a
 *      deletion needs evidence that the shape CANNOT be a payload character.
 *  (c) RESTORATION — a leaked record stream arrives as record TEXT. Only
 *      decoding its `Uc` field brings the payload's own characters and
 *      newlines back (measurement: even a strip-free ingress still loses 5
 *      payload characters), so the decode lives at the ONE paste choke point
 *      (`createPasteKey`) and the ingress never has to guess.
 *  (f) ADJACENT BREAK — the seam T08's independent review found (X1): when ONE
 *      half of a CRLF break leaked as record TEXT and the other half still
 *      arrived as a REAL newline, that break decoded into two `\n` (a 4-line
 *      source became 7 lines). The bytes between two records are payload text,
 *      but an LF among them is the LF HALF of a break, so it goes through the
 *      same `foldNewline` the record lane uses.
 *  (g) The same shape on the PRODUCT: a real `Chat` mount delivers the
 *      half-leaked record stream through stdin, and the fold chip must report
 *      the SOURCE line count while Enter submits the source byte-for-byte
 *      (L-012: symptom gone AND the function still fires, in one round).
 *  (h) EITHER LANE — T08's X1d, the mirror of (f): the CR half of the break
 *      arrived as a TRANSLATED Return while the LF half leaked as record text.
 *      The newline that Return emitted IS a CR half, and only the assembler
 *      knows it (the payload text alone cannot say), so the assembler hands
 *      that provenance over and the leaked LF record folds into it instead of
 *      printing the break's second `\n`.
 *  (i) X1d on the PRODUCT: a 2-line source must chip 2 lines and submit
 *      byte-for-byte — at one boundary, and at three.
 *
 * Run with: node --import tsx/esm scripts/verify-paste-integrity.tsx
 * Exits 1 when any assertion failed (CI gate).
 */
process.env.FORCE_COLOR = '3'
// (g) reads the fold chip's stats row off the screen; pin the copy it matches.
process.env.DSH_TUI_LANG = 'en'
// HOME/USERPROFILE must be redirected BEFORE any src module is imported —
// DATA_DIR-derived paths resolve at import time and (g)'s Enter press submits
// through the real history path. Repo helper, the same isolation its sibling
// Chat-mounted probes use.
const { default: dataDir } = await import('./lib/fake-home.mjs')

const [
  { sanitizeEditableText, sanitizePastedText },
  { INITIAL_STATE, parseMultipleKeypresses },
  { rmSync },
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Chat },
  { QuestionStore },
  termTest,
] = await Promise.all([
  import('../src/components/PromptInput.js'),
  import('../src/ink/parse-keypress.js'),
  import('node:fs'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('./lib/term-test.mjs'),
])

let failures = 0

function check(label: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.log(
      `FAIL ${label}\n     expected ${JSON.stringify(expected)}\n     actual   ${JSON.stringify(actual)}`,
    )
  }
}

function checkNum(label: string, actual: number, expected: number): void {
  if (actual === expected) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label}\n     expected ${expected}\n     actual   ${actual}`)
  }
}

const ESC = '\u001b'

// ── record shapes (mirrors scripts/repro-paste-loss.tsx encoders) ───────────

const CSI = `${ESC}[`
/** One `CSI Vk;Sc;Uc;Kd;Cs;Rc _` record as its down+up pair — the field shape
 *  `scripts/verify-win32-input.tsx` §8 builds (`\r` = `13;28;13`, capital
 *  letters carry SHIFT_PRESSED; issue #827 observation). */
const fieldsFor = (ch: string): readonly [number, number, number, number] => {
  if (ch === '\r') return [13, 28, 13, 0]
  if (ch === '\n') return [0, 0, 10, 0]
  const upper = ch.toUpperCase()
  const scan: Record<string, number> = { A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36, K: 37, L: 38, M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44 }
  if (scan[upper] !== undefined && /[A-Za-z]/u.test(ch)) {
    return [upper.charCodeAt(0), scan[upper]!, ch.codePointAt(0)!, /[A-Z]/u.test(ch) ? 48 : 0]
  }
  return [0, 0, ch.codePointAt(0)!, 0]
}
const rec = (vk: number, sc: number, uc: number, cs = 0): string =>
  `${CSI}${vk};${sc};${uc};1;${cs};1_${CSI}${vk};${sc};${uc};0;${cs};1_`
/** Every char synthesized (Vk=0/Sc=0) — what classic conhost emits for a
 *  pasted char it does not translate to a virtual key. */
const synthRec = (ch: string): string => rec(0, 0, ch.codePointAt(0)!)
/** An ESC carried as a leaked payload character (`CSI 27;1;27;1;0;1_`). */
const ESC_CHAR_REC = rec(27, 1, 27)
const markerRecs = (text: string): string => [...text].map(synthRec).join('')
/** A record as TEXT: the down record without its ESC — the shape a leaked
 *  record stream spells (and the ESC-less tail form of ADR-0002). */
const tailOf = (ch: string): string => {
  const [vk, sc, uc, cs] = fieldsFor(ch)
  return `${CSI}${vk};${sc};${uc};1;${cs};1_`.slice(1)
}
const CR = tailOf('\r')
const CR_RECORD = `${ESC}${CR}`
/** The LF half of a break as its own record: RAW it is a TRANSLATED key, the
 *  same bytes spelled as text are what LEAKS into the payload (X1d). */
const LF_RECORD = `${ESC}[0;0;10;1;0;1_`

/** Every character of `text` as its OWN synthesized key record — what classic
 *  conhost emits for a character it does not translate to a virtual key, and
 *  equally the spelling of a LEAKED record stream: its characters arrive as
 *  payload characters, so the paste matcher copies the record into the buffer
 *  instead of the tokenizer translating it into one key. */
const perCharRecords = (text: string): string =>
  [...text].map(ch => (ch === ESC ? ESC_CHAR_REC : synthRec(ch))).join('')
/** The decomposed-paste stream (classic conhost under win32-input-mode): the
 *  marker strings plus a body built from parts, so ONE break can put its two
 *  halves in different lanes. A part is either per-character records
 *  (`perCharRecords` — payload text, or a leaked record stream) or RAW record
 *  bytes, which reach the matcher as one TRANSLATED key. */
const pasteStream = (...parts: readonly string[]): string =>
  markerRecs(`${ESC}[200~`) + parts.join('') + markerRecs(`${ESC}[201~`)
/** The decomposed-paste stream of a payload whose every byte is a character. */
const decomposedStream = (text: string): string => pasteStream(perCharRecords(text))

/** The payload one parse of `input` hands over as a paste, or '' when the
 *  stream produced no paste key at all. */
function pastePayload(input: string): string {
  const [keys] = parseMultipleKeypresses(INITIAL_STATE, input)
  const paste = keys.find(k => k.kind === 'key' && k.isPasted)
  return paste && paste.kind === 'key' ? paste.sequence : ''
}

/** PromptInput.tsx bracketed-paste ingress: CRLF/CR fold, then the sanitizer. */
const pasteIngress = (text: string): string =>
  sanitizePastedText(text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n'))

// ── (a) order / anchor: a payload character after a record must survive ─────

console.log('# (a) order / anchor: the record is consumed whole, never sliced')
check('a1: realistic minimum keeps every payload character', sanitizePastedText(`${CR_RECORD}ravo`), 'ravo')
check('a2: grammar minimum (empty fields) keeps its character', sanitizePastedText(`${ESC}[;;;;;_r`), 'r')
check('a3: two records back to back keep both characters', sanitizePastedText(`${CR_RECORD}r${CR_RECORD}s`), 'rs')
check('a4: the typed-text ingress agrees', sanitizeEditableText(`${CR_RECORD}ravo`), 'ravo')

// ── (b) premise width: the payload's own record-shaped text survives ────────

console.log('# (b) premise width: no payload byte is deleted without evidence')
const WIDTH_MINIMUM = `${CR_RECORD}x${CR}y`
check('b1: the 16 record-shaped payload characters survive', sanitizePastedText(WIDTH_MINIMUM), `x${CR}y`)
check('b2: the paste ingress deletes nothing the typed ingress keeps', sanitizePastedText(WIDTH_MINIMUM), sanitizeEditableText(WIDTH_MINIMUM))
checkNum('b3: the surviving tail is 16 characters', sanitizePastedText(WIDTH_MINIMUM).length - 2, CR.length)

// ── (c) Uc decoding at the ONE paste choke point ────────────────────────────

console.log('# (c) Uc decoding: the leaked stream is decoded, not discarded')
check('c1: a leaked CR record + the next line character', pastePayload(decomposedStream(`${CR_RECORD}${tailOf('B')}`)), '\nB')
check('c2: a leaked CR record alone', pastePayload(decomposedStream(CR_RECORD)), '\n')
check('c3: an ESC-less tail alone carries no frame evidence and stays literal', pastePayload(decomposedStream(CR)), CR)
check('c3b: but it IS decoded once a complete record sits in the same payload', pastePayload(decomposedStream(`${CR_RECORD}x${CR}`)), '\nx\n')
check('c4: a decoded CR+LF pair folds to ONE newline', pastePayload(decomposedStream(`${CR_RECORD}[0;0;10;1;0;1_`)), '\n')
check('c5: a Uc=0 record carries no character and is stripped', pastePayload(decomposedStream(`${CR_RECORD}[0;0;0;1;0;1_`)), '\n')
check('c6: a keyup record carries no character and is stripped', pastePayload(decomposedStream(`${CR_RECORD}[13;28;13;0;0;1_`)), '\n')
check('c7: without a complete record the shapes are payload text (evidence gate)', pastePayload(decomposedStream(`${CR}x`)), `${CR}x`)

// ── (d) zero-harm controls: every untouched contract stays byte-identical ───

console.log('# (d) zero-harm controls: byte-identical')
check('d1: genuine underscores', sanitizePastedText('_ __ a_b ___'), '_ __ a_b ___')
check('d2: record-shaped text with no record present', sanitizePastedText(`${CR}y`), `${CR}y`)
check('d3: bracket text with four separators', sanitizePastedText('[1;2;3;4;5_] [x] [] [200~'), '[1;2;3;4;5_] [x] [] [200~')
check('d4: bracket text with six separators', sanitizePastedText('[13;28;13;1;0;1;9_'), '[13;28;13;1;0;1;9_')
check('d5: ordinary bracketed-paste content', sanitizePastedText('line 1\nline 2\nline 3'), 'line 1\nline 2\nline 3')
check('d6: ANSI styling is still stripped', sanitizePastedText(`${ESC}[31mred${ESC}[0m`), 'red')
check('d7: CRLF and tabs still normalize after residue stripping', sanitizePastedText(`${CR_RECORD}a\r\nb\tc`), 'a\nb        c')
check('d8: a VT bracketed paste is literal data and is never decoded', pastePayload(`${ESC}[200~${CR_RECORD}x${ESC}[201~`), `${CR_RECORD}x`)
// d9 pins the DECLARED RESIDUAL of the narrowing: a record-shaped run that
// stands alone as its own token, in a payload that also carries a complete
// record, is still stripped (the #1097 premise). Closing it means changing the
// premise assertions in scripts/verify-paste-residue.tsx — outside T06.
check('d9/residual: a standalone record-shaped token is still stripped', sanitizePastedText(`a${CR_RECORD}b ${CR}c`), 'ab c')

// ── (e) end-to-end: the leaked P2c shape through parser + real ingress ──────

console.log('# (e) end-to-end: the leaked record stream restores the payload')
const LINES = [
  'Alpha-L1-SENTINEL-A1 first-1-----.',
  'Bravo-L2-SENTINEL-B2 second-2-----.',
  'Charlie-L3-SENTINEL-C3 third-3-----.',
  'Delta-L4-SENTINEL-D4 fourth-4-----.',
  'Echo-L5-SENTINEL-E5 fifth-5-----.',
]
const SOURCE = LINES.join('\n')
/**
 * The #827 form the transport hands over: the intended text, except that at
 * three line boundaries the record stream leaked as TEXT — one ESC-bearing CR
 * record (plus the next line's first character) and two ESC-less CR tails (one
 * of them also eating the next line's first character).
 */
const leaked = LINES.reduce((acc, line, i) => {
  if (i === 0) return line
  if (i === 1) return `${acc}${CR_RECORD}${tailOf(line[0]!)}${line.slice(1)}`
  if (i === 2) return `${acc}${CR}${line}`
  if (i === 3) return `${acc}${CR}${tailOf(line[0]!)}${line.slice(1)}`
  return `${acc}\n${line}`
}, '')

const payload = pastePayload(decomposedStream(leaked))
const value = pasteIngress(payload)
check('e1: the parser restores the payload text from the record stream', payload, SOURCE)
check('e2: the real ingress keeps the restored payload byte-identical', value, SOURCE)
checkNum('e3: value line count equals the payload line count', value.split('\n').length, LINES.length)
checkNum('e4: no payload character is missing', value.length, SOURCE.length)

// ── (f) X1: a record next to a real newline is still ONE break ──────────────

console.log('# (f) X1: record text adjacent to a real newline is ONE break')
const X1_LINES = ['alfa', 'bravo', 'charlie', 'delta']
/**
 * The half-leaked #827 shape T08's review reproduced (X1a minimum / X1b at
 * three boundaries): the CR half of each break leaked as record TEXT — one
 * ESC-bearing record and two ESC-less tails — while the LF half still arrived
 * as a real newline. `foldNewline` is the ONE newline rule, so each such LF
 * must fold into the newline its CR half already emitted.
 */
const HALF_LEAKED = `${X1_LINES[0]!}${CR}\n${X1_LINES[1]!}${CR_RECORD}\n${X1_LINES[2]!}${CR}\n${X1_LINES[3]!}`
const HALF_LEAKED_SOURCE = X1_LINES.join('\n')
const halfLeakedPayload = pastePayload(decomposedStream(HALF_LEAKED))
check('f1: a CR record text + a real newline fold to ONE break (minimum)', pastePayload(decomposedStream(`alfa${CR_RECORD}\nbravo`)), 'alfa\nbravo')
check('f2: three half-leaked boundaries restore the source bytes', halfLeakedPayload, HALF_LEAKED_SOURCE)
checkNum('f3: and the restored payload keeps the source line count', halfLeakedPayload.split('\n').length, X1_LINES.length)
check('f4: the real ingress keeps that payload byte-identical', pasteIngress(halfLeakedPayload), HALF_LEAKED_SOURCE)
check('f5: the LF half of the LAST break folds at the tail too', pastePayload(decomposedStream(`alfa${CR_RECORD}\n`)), 'alfa\n')
// Function side + zero harm in the same run (L-012): the shapes that must
// change do change, and the widening may not swallow a genuine break.
check('f6: both halves as records still fold to ONE newline (X1c control)', pastePayload(decomposedStream(`alfa${CR_RECORD}[0;0;10;1;0;1_bravo`)), 'alfa\nbravo')
check('f7: a genuine newline after the fold survives (blank line)', pastePayload(decomposedStream(`alfa${CR_RECORD}\n\nbravo`)), 'alfa\n\nbravo')
check('f8: an LF after a non-newline character never folds', pastePayload(decomposedStream(`alfa${CR_RECORD}x\nbravo`)), 'alfa\nx\nbravo')

// ── (h) X1d: a LEAKED LF record after a TRANSLATED Return is ONE break ──────

console.log('# (h) X1d: a translated Return + a leaked LF record is the same break')
/**
 * The MIRROR of (f), and T08's X1d: here the CR half of each break arrived as
 * a TRANSLATED Return — raw record bytes, so the matcher itself emitted the
 * newline — while the LF half of that SAME break leaked into the payload as
 * record text. Decoding that record then prints the LF half a second time.
 * Byte provenance cannot be recovered inside the decoder (T-FIX-02 决策与偏离
 * 1): `alfa\nbravo` and `alfa\n\nbravo` spell the identical payload text, so
 * only the assembler knows which `\n` its own Return opened.
 */
const X1D_LINES = ['alfa', 'bravo', 'charlie', 'delta']
/** Every break as X1d spells it: translated Return, then the leaked LF record
 *  and the next line's characters (all payload text to the matcher). */
const x1dStream = (lines: readonly string[]): string =>
  pasteStream(
    ...lines.map((line, i) =>
      i === 0 ? perCharRecords(line) : CR_RECORD + perCharRecords(`${LF_RECORD}${line}`),
    ),
  )
const x1dMinimum = pastePayload(
  pasteStream(perCharRecords(X1D_LINES[0]!), CR_RECORD, perCharRecords(`${LF_RECORD}${X1D_LINES[1]!}`)),
)
check('h1: a translated Return + a leaked LF record fold to ONE break (minimum)', x1dMinimum, 'alfa\nbravo')
checkNum('h2: and the payload keeps the source line count', x1dMinimum.split('\n').length, 2)
check('h3: the real ingress keeps it byte-identical', pasteIngress(x1dMinimum), 'alfa\nbravo')
const x1dPayload = pastePayload(x1dStream(X1D_LINES))
check('h4: three boundaries restore the source bytes', x1dPayload, X1D_LINES.join('\n'))
checkNum('h5: and the restored payload keeps the source line count', x1dPayload.split('\n').length, X1D_LINES.length)
// Function side + zero harm in the same run (L-012): the breaks that arrive
// entirely in the translated lane must still fold exactly once, and a genuine
// newline after such a break may not be swallowed by a stale CR half.
check(
  'h6: control — both halves as translated keys still fold to ONE newline',
  pastePayload(pasteStream(perCharRecords('alfa'), CR_RECORD, LF_RECORD, perCharRecords('bravo'))),
  'alfa\nbravo',
)
check(
  'h7: control — a genuine newline after a translated break survives',
  pastePayload(pasteStream(perCharRecords('alfa'), CR_RECORD, LF_RECORD, LF_RECORD, perCharRecords('bravo'))),
  'alfa\n\nbravo',
)

// ── (g) on the product: chip lines == source lines, Enter sends the source ──

console.log('# (g) on the product: the fold chip reports the SOURCE lines, Enter sends them')

const COLS = 110
const ROWS = 48
const LAND_MS = 4000
const SUBMIT_MS = 4000
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 50, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdinObj = new FakeStdin()

const listeners = new Set<() => void>()
let submittedCount = 0
let lastSubmitted = ''
const channel: any = {
  whale: false, whaleIdle: false, version: 0, rows: [] as unknown[],
  status: 'idle', sessionTitle: 'paste-integrity', agentId: 'paste-integrity', model: 'deepseek-v4-flash',
  mode: { plan: false }, reasoningEffort: 'max', tokens: { input: 1, output: 1 },
  cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main', working: false,
  spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: Date.now(),
  lastUserText: '', pending: [], commandList: [], notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit(text: string) { lastSubmitted = text; submittedCount += 1; bump() },
  cancel: () => {}, clear: () => {},
  notify(msg: string) { channel.notifications.push(msg); bump() },
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [], stagedImage: () => undefined, discardStagedImage: () => {},
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

/** Chat exposes its PromptController slot here (repro-paste-loss.tsx seam). */
const composerRef: { current: { text(): string; clear(): void } | null } = { current: null }
const composerText = (): string => composerRef.current?.text() ?? ''
const { settled } = termTest
/** `▸ 4 lines・671 chars` (en) or `▸ 4 行・671 字` (zh), as PromptInput paints it. */
function chipOnScreen(): { lines: number; chars: number } | null {
  for (const row of termTest.viewportLines(term)) {
    const m = /[▸▾] (\d+) (?:lines|行)・(\d+) (?:chars|字)/u.exec(row)
    if (m) return { lines: Number(m[1]), chars: Number(m[2]) }
  }
  return null
}

type Round = {
  readonly value: string
  readonly submitted: string
  readonly chip: { lines: number; chars: number } | null
  readonly landed: boolean
}

/** One delivery round: paste -> read value + chip -> Enter -> read submit.
 *  `stream` is the decomposed win32-paste byte stream itself, so a round can
 *  use the mixed lanes a half-leaked break needs (`pasteStream`). */
async function deliver(stream: string): Promise<Round> {
  composerRef.current?.clear()
  await settled(() => composerText() === '' && chipOnScreen() === null, { timeoutMs: 3000 })
  submittedCount = 0
  lastSubmitted = ''
  stdinObj.write(stream)
  // "Landed" means PAINTED: a 10-char prefix of the first row is what the
  // folded chip's preview shows, so this never slices across a newline.
  const landed = await settled(() => {
    const current = composerText()
    if (current === '') return false
    const probe = current.split('\n')[0]!.slice(0, 10)
    return probe !== '' && termTest.screenHas(term, probe)
  }, { timeoutMs: LAND_MS })
  const value = composerText()
  const chip = chipOnScreen()
  stdinObj.write('\r')
  let sent = await settled(() => submittedCount > 0, { timeoutMs: 900 })
  if (!sent) {
    stdinObj.write('\r')
    sent = await settled(() => submittedCount > 0, { timeoutMs: SUBMIT_MS })
  }
  return { value, submitted: submittedCount > 0 ? lastSubmitted : '', chip, landed }
}

// 4 rows, each over 160 characters: the fold gate is ≥6 lines OR ≥600 chars
// (FOLD_MIN_CHARS), so a 4-line source still folds — which is what lets the
// chip's line count be read on BOTH sides of the fix (7 lines before it).
const R_ROWS = ['quebec|R1|romeo.', 'sierra|R2|tango.', 'uniform|R3|victor.', 'whiskey|R4|xray.']
  .map(row => `${row} ${'-'.repeat(150)}`)
const R_SOURCE = R_ROWS.join('\n')
/** The same half-leak at three boundaries, on the product's own delivery path. */
const R_HALF_LEAKED = `${R_ROWS[0]!}${CR}\n${R_ROWS[1]!}${CR_RECORD}\n${R_ROWS[2]!}${CR}\n${R_ROWS[3]!}`

// (i) X1d on the product. 2 rows, each over 300 characters: the fold gate is
// ≥600 chars, so a 2-LINE source still folds — which is what lets the chip's
// line count be read on BOTH sides of the fix (3 lines before it).
const X1D_ROWS = ['november|X1|oscar.', 'papa|X2|quebec.'].map(row => `${row} ${'-'.repeat(330)}`)
const X1D_SOURCE = X1D_ROWS.join('\n')
const X1D_STREAM = x1dStream(X1D_ROWS)

let instance: { unmount: () => Promise<void> } | null = null
try {
  instance = await render(
    <AlternateScreen>
      <Chat channel={channel} questionStore={new QuestionStore()} promptControllerRef={composerRef as never} onExit={() => {}} />
    </AlternateScreen>,
    { stdout: new FakeStdout(), stdin: stdinObj, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await settled(() => composerRef.current !== null, { timeoutMs: 5000 })

  const halfLeak = await deliver(decomposedStream(R_HALF_LEAKED))
  console.log(`     half-leaked: landed=${halfLeak.landed} valueLines=${halfLeak.value.split('\n').length} chip=${halfLeak.chip === null ? 'none' : `${halfLeak.chip.lines} lines/${halfLeak.chip.chars} chars`} submittedLines=${halfLeak.submitted.split('\n').length}`)
  check('g1: the composer holds the source bytes', halfLeak.value, R_SOURCE)
  checkNum('g2: chip lines == source lines', halfLeak.chip?.lines ?? -1, R_ROWS.length)
  checkNum('g3: chip chars == source chars', halfLeak.chip?.chars ?? -1, R_SOURCE.length)
  check('g4: Enter submits the source byte-for-byte', halfLeak.submitted, R_SOURCE)

  // Function side, same run: a CLEAN 4-row paste must still fold into a chip
  // and still submit in full — the widening may not disturb either.
  const clean = await deliver(decomposedStream(R_SOURCE))
  checkNum('g5: control — a clean 4-row paste still folds', clean.chip?.lines ?? -1, R_ROWS.length)
  check('g6: control — and still submits byte-for-byte', clean.submitted, R_SOURCE)

  // (i) X1d on the product: the mirror leak (translated Return, leaked LF
  // record) must satisfy the same contract — 2 rows first, then the same
  // three boundaries (g) uses.
  const x1dSmall = await deliver(X1D_STREAM)
  console.log(`     x1d 2-row: landed=${x1dSmall.landed} valueLines=${x1dSmall.value.split('\n').length} chip=${x1dSmall.chip === null ? 'none' : `${x1dSmall.chip.lines} lines/${x1dSmall.chip.chars} chars`} submittedLines=${x1dSmall.submitted.split('\n').length}`)
  check('i1: the composer holds the source bytes', x1dSmall.value, X1D_SOURCE)
  checkNum('i2: chip lines == source lines', x1dSmall.chip?.lines ?? -1, X1D_ROWS.length)
  checkNum('i3: chip chars == source chars', x1dSmall.chip?.chars ?? -1, X1D_SOURCE.length)
  check('i4: Enter submits the source byte-for-byte', x1dSmall.submitted, X1D_SOURCE)

  const x1dFour = await deliver(x1dStream(R_ROWS))
  checkNum('i5: three boundaries still report the source lines', x1dFour.chip?.lines ?? -1, R_ROWS.length)
  check('i6: and Enter still submits the source byte-for-byte', x1dFour.submitted, R_SOURCE)
} finally {
  await instance?.unmount()
  rmSync(dataDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall paste-integrity assertions passed')
