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
 *  (j) EVERY BOUNDARY — the reported symptom's own form, folded in as CI: the
 *      10-line / 760-char payload with all 9 line boundaries replaced by record
 *      text (one ESC-bearing complete record plus eight ESC-less tails), so the
 *      delivered text carries no literal newline at all. The uat2 A/B case
 *      (origin/main: valueLines=1, chip `1 lines・745 chars`, deleted=15; HEAD:
 *      valueLines=10, chip `10 lines・760 chars`, deleted=0), asserted
 *      in-process AND on the rendered chip / submitted bytes.
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

/** The same paste payload, but with the READ BOUNDARIES of a capture: one
 *  parser write per chunk (`pastePayload` writes the whole stream at once), so
 *  a case can pin the exact stdin segmentation the terminal produced. */
function pastePayloadChunks(chunks: readonly string[]): string {
  let state = INITIAL_STATE
  const keys: ReturnType<typeof parseMultipleKeypresses>[0] = []
  for (const chunk of chunks) {
    const [out, next] = parseMultipleKeypresses(state, chunk)
    state = next
    keys.push(...out)
  }
  const paste = keys.find(k => k.kind === 'key' && k.isPasted)
  return paste && paste.kind === 'key' ? paste.sequence : ''
}

/**
 * Exact insert/delete accounting between two strings via the longest common
 * subsequence: `deleted` counts the SOURCE characters no longer there,
 * `inserted` the characters that came from nowhere. Ported verbatim from the
 * uat2 fixture's own `align` (`repro-paste-loss.probe.tsx`) so (j) reads the
 * payload with the SAME measurement the pinned A/B evidence quotes
 * (`deleted=15` on origin/main, `deleted=0` on HEAD) — a greedy scan would read
 * "the first character is missing" as "everything after it is missing too".
 * Iterated by code point over an ASCII payload, so it is also a byte reading.
 */
function align(source: string, actual: string): { inserted: number; deleted: number } {
  const sourceChars = [...source]
  const actualChars = [...actual]
  let previous = new Int32Array(actualChars.length + 1)
  let current = new Int32Array(actualChars.length + 1)
  for (let i = 1; i <= sourceChars.length; i += 1) {
    for (let j = 1; j <= actualChars.length; j += 1) {
      current[j] = sourceChars[i - 1] === actualChars[j - 1]
        ? previous[j - 1]! + 1
        : Math.max(previous[j]!, current[j - 1]!)
    }
    const spent = previous
    previous = current
    current = spent
    current.fill(0)
  }
  const common = previous[actualChars.length]!
  return { inserted: actualChars.length - common, deleted: sourceChars.length - common }
}

/** Record residue left VISIBLE: the `_` every record shape terminates with, and
 *  the ESC byte a half-consumed record leaves behind. A restored payload must
 *  read zero on both. */
const residueCount = (text: string): number => [...text].filter(ch => ch === '_' || ch === ESC).length

/** A record-shaped run as painted text (`[Vk;Sc;Uc;Kd;Cs;Rc_`) — the
 *  underscore residue the #1090 report saw scroll past. */
const RECORD_SHAPE = /\[\d+;\d+;\d+;\d+;\d+;\d+_/u

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

// ── (j) EVERY line boundary replaced by record text: all 10 lines survive ───

console.log('# (j) every line boundary as record text: all 10 lines survive')

/**
 * The uat2 A/B case in its CI form — and the shape the user reported. The T01
 * `big` payload (scripts/repro-paste-loss.tsx `WORDS` / `bigLine`: 760 chars
 * over 10 lines, so the >=600-char fold gate trips) with EVERY one of its 9
 * line boundaries replaced by record-shaped text, exactly as the fixture's
 * `leakedPayloadFull` builds it: ONE ESC-bearing complete record (the
 * `hasRecordStream` arming evidence AND the frame evidence the decode gate
 * needs) plus eight ESC-less CR tails, four of which also spell the next line's
 * first character as a tail. The delivered text therefore carries ZERO literal
 * newlines — the reported ">=600 chars + every break leaked → the chip says
 * `1 line`" form, and the only shape here where EVERY boundary is record text.
 *
 * Reading the red side: reverting ONLY `src/ink/parse-keypress.ts` to
 * origin/main makes this group read valueLines=1 / chip `1 lines・746 chars` /
 * deleted=14, where the fixture's FULL origin/main baseline read 745 / 15. The
 * one extra lost character is defect (a) — the ingress side of that baseline
 * still carried it, and this regression's ingress is the delivered one.
 */
const ALL_BOUNDARY_WORDS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett']
/** `Alpha-L1-SENTINEL-A1 … tail-1-----.` — line-start sentinel, uppercase head,
 *  `.` tail; >=74 chars each, so 10 lines clear the 600-char fold gate. */
const allBoundaryRow = (i: number): string => {
  const n = i + 1
  const head = `${ALL_BOUNDARY_WORDS[i]}-L${n}-SENTINEL-${String.fromCharCode(64 + n)}${n}`
  const filler = `${String(n).padStart(2, '0')}${'0123456789'.repeat(4)}`
  return `${`${head} ${filler} tail-${n}`.padEnd(74, '-')}.`
}
const ALL_BOUNDARY_ROWS = Array.from({ length: 10 }, (_, i) => allBoundaryRow(i))
const ALL_BOUNDARY_SOURCE = ALL_BOUNDARY_ROWS.join('\n')
const ALL_BOUNDARY_LEAKED = ALL_BOUNDARY_ROWS.reduce((acc, line, i) => {
  if (i === 0) return line
  if (i === 1) return `${acc}${CR_RECORD}${tailOf(line[0]!)}${line.slice(1)}`
  if (i % 2 === 0) return `${acc}${CR}${tailOf(line[0]!)}${line.slice(1)}`
  return `${acc}${CR}${line}`
}, '')
/** Every `[13;28;13;1;0;1_` in the delivered form, the ESC-bearing one included
 *  — the fixture's `crShapedRuns=9 / escBearingCrRecords=1 / escLessCrTails=8`. */
const allBoundaryCrRuns = ALL_BOUNDARY_LEAKED.split(CR).length - 1
const ALL_BOUNDARY_STREAM = decomposedStream(ALL_BOUNDARY_LEAKED)
const allBoundaryValue = pasteIngress(pastePayload(ALL_BOUNDARY_STREAM))
const allBoundaryLoss = align(ALL_BOUNDARY_SOURCE, allBoundaryValue)
console.log(`     all-boundary (in-process): deliveredLines=${ALL_BOUNDARY_LEAKED.split('\n').length} valueLines=${allBoundaryValue.split('\n').length} chars=${allBoundaryValue.length}/${ALL_BOUNDARY_SOURCE.length} deleted=${allBoundaryLoss.deleted} inserted=${allBoundaryLoss.inserted}`)

check('j1: all 9 boundaries as record text restore the source byte-for-byte', allBoundaryValue, ALL_BOUNDARY_SOURCE)
checkNum('j2: and the restored value keeps the source line count (10)', allBoundaryValue.split('\n').length, ALL_BOUNDARY_ROWS.length)
// Premise guards: without these the case could silently stop being the reported
// form (a literal newline left in it, or a missing arming record, changes it).
checkNum('j3: the delivered form carries 0 literal newline characters', [...ALL_BOUNDARY_LEAKED].filter(ch => ch === '\n').length, 0)
checkNum('j4: the delivered form spells 9 record-shaped runs, ONE per boundary', allBoundaryCrRuns, ALL_BOUNDARY_ROWS.length - 1)
checkNum('j5: …of which exactly ONE keeps its ESC (the arming evidence)', ALL_BOUNDARY_LEAKED.split(CR_RECORD).length - 1, 1)
checkNum('j6: the LCS alignment reads deleted == 0 (no source character lost)', allBoundaryLoss.deleted, 0)
checkNum('j7: the restored value carries no record residue (`_` / ESC)', residueCount(allBoundaryValue), 0)

// ── (k) VK_PACKET (231): the character rides in Uc (T-FIX-02) ───────────────

console.log('# (k) VK_PACKET records: a pasted break is a Return, not a swallow')

/**
 * T-FIX-01's convicted forms, replayed on the reported payload. VK_PACKET is
 * the "the character is in Uc" virtual key: Unicode-injected input, and the
 * spelling Windows Terminal re-encodes a paste into under win32-input-mode.
 * V10 spells every character as `231;0;<cp>` and every break as a CR record
 * plus its LF record; V11 keeps only the CR record; V17 keeps the real Vk/Sc
 * char lane and the VK_PACKET break lane. All three folded to
 * `1 line・751 chars` on BOTH legs before the fix — the break records were
 * swallowed whole, so the assembled payload carried no newline at all.
 */
const packetRec = (ch: string): string => rec(231, 0, ch.codePointAt(0)!)
const PACKET_CR = rec(231, 0, 13)
const PACKET_CRLF = `${PACKET_CR}${rec(231, 0, 10)}`
/** The file's own "real Vk/Sc" char records (the lane `tailOf` spells). */
const realRec = (ch: string): string => {
  const [vk, sc, uc, cs] = fieldsFor(ch)
  return rec(vk, sc, uc, cs)
}
/** One payload body: every `\n` spelled as `breakRecs`, every other character
 *  as its own record through `charRec`. */
const packetBody = (text: string, breakRecs: string, charRec: (ch: string) => string): string =>
  [...text].map(ch => (ch === '\n' ? breakRecs : charRec(ch))).join('')

const PACKET_V10_BODY = packetBody(ALL_BOUNDARY_SOURCE, PACKET_CRLF, packetRec)
const PACKET_V10 = pasteStream(PACKET_V10_BODY)
const PACKET_V11 = pasteStream(packetBody(ALL_BOUNDARY_SOURCE, PACKET_CR, packetRec))
const PACKET_V17 = pasteStream(packetBody(ALL_BOUNDARY_SOURCE, PACKET_CRLF, realRec))
/** The payload these streams hand the composer, through the real ingress. */
const packetValue = (stream: string): string => pasteIngress(pastePayload(stream))
const v10Value = packetValue(PACKET_V10)

check('k1: V10 (VK_PACKET chars + 231;0;13/10 breaks) restores the source', v10Value, ALL_BOUNDARY_SOURCE)
checkNum('k2: ...and the 10 source lines', v10Value.split('\n').length, ALL_BOUNDARY_ROWS.length)
checkNum('k3: ...and all 760 characters', v10Value.length, ALL_BOUNDARY_SOURCE.length)
checkNum('k4: ...with no source character lost (LCS deleted == 0)', align(ALL_BOUNDARY_SOURCE, v10Value).deleted, 0)
checkNum('k5: ...and no record residue (`_` / ESC)', residueCount(v10Value), 0)
check('k6: V11 (only the CR record) restores the source too', packetValue(PACKET_V11), ALL_BOUNDARY_SOURCE)
check('k7: V17 (real Vk/Sc chars + VK_PACKET breaks) restores the source', packetValue(PACKET_V17), ALL_BOUNDARY_SOURCE)
// Premise guards: without these the case could silently stop being the
// convicted shape (a literal newline left in it, or a missing break record).
checkNum('k8: the delivered V10 form carries 0 literal newline characters', [...PACKET_V10_BODY].filter(ch => ch === '\n').length, 0)
checkNum('k9: ...and spells 9 VK_PACKET CR records, ONE per boundary', PACKET_V10_BODY.split(PACKET_CR).length - 1, ALL_BOUNDARY_ROWS.length - 1)
// The zero-information record stays swallowed (V9): a Uc=0 VK_PACKET record
// may not be invented into a character OR a break.
check(
  'k10: a Uc=0 VK_PACKET record adds no character and no newline',
  pastePayload(pasteStream(perCharRecords('a'), rec(231, 0, 0), perCharRecords('b'))),
  'ab',
)

// ── (l) the user's OWN capture: a bracketed paste that carries real records ──

console.log('# (l) the user capture: VT bracketed paste with real break records')

/**
 * T-FIX-05's ground truth — `probe/capture/capture-2026-10-02T18-33-49-825Z.txt`
 * (Windows Terminal + PowerShell, `Ctrl+V` on this very 10-line / 760-char
 * payload). It is rebuilt here BYTE FOR BYTE and pinned by the capture's own
 * chunk sizes (12 Ctrl records, chunk#13 = 1024 bytes, chunk#14 = 45, the `V`
 * and Ctrl keyups; 1308 bytes in total), so the CI case is the captured stream
 * without reading the out-of-tree file. What makes it a new form: the payload
 * is inside the bracketed-paste markers AND every line boundary is a REAL
 * ESC-bearing down+up record pair (`Uc=13`), with no literal newline anywhere
 * in the delivered bytes — the bracketed-paste lane and the record lane in the
 * same payload. The pairs are the terminal's own character spelling, so the
 * literal lane decodes them back into the breaks they encode; a lone record
 * (no transition evidence) still keeps its bytes (ADR-0008 d3/d4/d9).
 */
const CAPTURE_CR_PAIR = rec(13, 28, 13)
const CAPTURE_PASTE = `${ESC}[200~${ALL_BOUNDARY_ROWS.join(CAPTURE_CR_PAIR)}${ESC}[201~`
const CAPTURE_CHUNKS: readonly string[] = [
  ...Array.from({ length: 12 }, () => `${ESC}[17;29;0;1;40;1_`),
  CAPTURE_PASTE.slice(0, 1024),
  CAPTURE_PASTE.slice(1024),
  `${ESC}[86;47;22;0;40;1_`,
  `${ESC}[17;29;0;0;32;1_`,
]
const CAPTURE_STREAM = CAPTURE_CHUNKS.join('')
// Premise guards: the rebuilt stream must stay the capture's own bytes/read
// boundaries, or the case silently stops being the reported form.
checkNum('l1: the rebuilt stream is the capture\'s 1308 bytes in 16 chunks', CAPTURE_STREAM.length, 1308)
checkNum('l2: ...and keeps its chunk count', CAPTURE_CHUNKS.length, 16)
checkNum('l3: ...including the 1024-byte read boundary of chunk#13', CAPTURE_CHUNKS[12]!.length, 1024)
checkNum('l4: ...and chunk#14\'s 45 remaining bytes', CAPTURE_CHUNKS[13]!.length, 45)
checkNum('l5: the delivered payload carries 0 literal newlines', [...CAPTURE_PASTE].filter(ch => ch === '\n').length, 0)
checkNum('l6: ...and spells 9 ESC-bearing break pairs, ONE per boundary', CAPTURE_PASTE.split(CAPTURE_CR_PAIR).length - 1, ALL_BOUNDARY_ROWS.length - 1)

const capturePayload = pastePayloadChunks(CAPTURE_CHUNKS)
check('l7: the parser decodes the capture\'s break pairs to the source bytes', capturePayload, ALL_BOUNDARY_SOURCE)
checkNum('l8: ...and the source line count (10)', capturePayload.split('\n').length, ALL_BOUNDARY_ROWS.length)
check('l9: the real ingress keeps the decoded capture byte-identical', pasteIngress(capturePayload), ALL_BOUNDARY_SOURCE)
checkNum('l10: ...with no record residue (`_` / ESC)', residueCount(pasteIngress(capturePayload)), 0)
checkNum('l11: ...and no source character lost (LCS deleted == 0)', align(ALL_BOUNDARY_SOURCE, pasteIngress(capturePayload)).deleted, 0)

// ── (m) T-FIX-06: near-miss transitions decode; surrogate halves come back ──

console.log('# (m) T-FIX-06: near-miss transitions decode, surrogate halves come back')

/** ONE half of a transition (`rec()` above spells the whole down+up pair). */
const half = (vk: number, sc: number, uc: number, kd: number, cs = 0): string =>
  `${CSI}${vk};${sc};${uc};${kd};${cs};1_`
/** The literal lane's payload for `a` <records> `b` — a VT bracketed paste. */
const literalPayload = (...parts: readonly string[]): string =>
  pastePayload(`${ESC}[200~a${parts.join('')}b${ESC}[201~`)
/** ...and the same payload through the real ingress. */
const literalValue = (...parts: readonly string[]): string => pasteIngress(literalPayload(...parts))
/** A supplementary character's half, spelled as its own down+up pair. */
const surrogatePair = (uc: number): string => half(65, 30, uc, 1) + half(65, 30, uc, 0)

/**
 * F-2 (`probe/review/minimal-counterexamples.txt` R1/R2/R3/R3b/R3c, promoted
 * to assertions by T-FIX-06). The transition PAIR is what proves a record
 * stream — and a near miss is still a pair: the same `Uc` (which IS the
 * character), one press + one release, in EITHER order, with payload text
 * allowed between them (the release half is the next RECORD, not the next
 * byte). `Vk;Sc;Cs` belong to the release's own spelling, not to the identity:
 * conhost's synthesized keyup may carry a different `Vk`/`Sc`, and `Cs` can
 * change while a modifier is released before the keyup.
 *
 * Before T-FIX-06 every near miss failed the exact-identity gate and fell
 * through the decode into the ingress's residue strip, which deletes complete
 * ESC-bearing records whole — `ab`, with no reading left that could prove a
 * break had ever been there.
 */
check('m1: a NON-ADJACENT pair (payload text between the halves) decodes',
  literalValue(half(13, 28, 13, 1), 'X', half(13, 28, 13, 0)), 'a\nXb')
check('m2: a pair spelled UP-then-DOWN decodes',
  literalValue(half(13, 28, 13, 0), half(13, 28, 13, 1)), 'a\nb')
check('m3: ...a differing Cs does not unmake the pair',
  literalValue(half(13, 28, 13, 1, 0), half(13, 28, 13, 0, 1)), 'a\nb')
check('m4: ...nor a differing Sc (a synthesized release carries 0)',
  literalValue(half(13, 28, 13, 1), half(13, 0, 13, 0)), 'a\nb')
check('m5: ...nor a differing Vk',
  literalValue(half(13, 28, 13, 1), half(0, 28, 13, 0)), 'a\nb')
check('m6: control — the exact adjacent pair still decodes to ONE break',
  literalValue(half(13, 28, 13, 1), half(13, 28, 13, 0)), 'a\nb')

/**
 * F-1 (`minimal-counterexamples.txt` R10, `edge-frames.txt` D2). `Uc` is ONE
 * UTF-16 code unit, so a supplementary character streams as a high half
 * followed by its low half. T-FIX-06 removed the shared `pending` scratch slot
 * entirely: EVERY half is handed back as its own code unit, so two halves that
 * arrive next to each other concatenate into the character they spell (UTF-16
 * concatenation IS the pairing rule, exactly as the decomposed lane's paste
 * buffer does it) and a half whose partner never arrives stays visible instead
 * of being consumed with NOTHING in return (L-012). No state survives a
 * record, so two unrelated records can never be stitched into a character the
 * source never contained.
 */
check('m7: a lone high half is handed back, not consumed with zero return (R10)',
  literalValue(surrogatePair(0xd83d)), 'a\ud83db')
check('m8: ...and it may NOT be stitched onto another character\u2019s low half (D2)',
  literalValue(surrogatePair(0xd83d), 'X', surrogatePair(0xde00)), 'a\ud83dX\ude00b')
check('m9: ...nor across payload text — there is no state left to leak',
  literalValue(surrogatePair(0xd83d), 'xy', surrogatePair(0xde00)), 'a\ud83dxy\ude00b')
check('m10: control — two ADJACENT halves still compose ONE supplementary char',
  literalValue(surrogatePair(0xd83d), surrogatePair(0xde00)), 'a\u{1f600}b')
check('m11: arrival order is kept when three halves stream (R10 + edge-frames D1)',
  literalValue(surrogatePair(0xd83d), surrogatePair(0xd83e), surrogatePair(0xde00)), 'a\ud83d\ud83e\ude00b')
{
  const stream = `${ESC}[200~a${surrogatePair(0xd83d)}b${ESC}[201~`
  const cut = stream.indexOf(half(65, 30, 0xd83d, 0)) + 4
  check('m12: a chunk boundary inside the pair changes nothing',
    pasteIngress(pastePayloadChunks([stream.slice(0, cut), stream.slice(cut)])), 'a\ud83db')
}

/**
 * The DECLARED residual of the deletion side — pinned instead of implied. A
 * LONE record has no transition evidence, so the decoder keeps its bytes
 * (`verify-win32-input.tsx` §8c, d8); the ingress's residue contract then
 * deletes a complete ESC-bearing record whole (ADR-0002 decision 1 / ADR-0008
 * decision 2, pinned by (a)/(b)/(d) above and by `verify-paste-residue`). The
 * decode cannot rescue those bytes, and the earlier "keeps every byte" claim
 * was only ever true of the REWRITE, never of that deletion — these assertions
 * say so out loud.
 */
check('m13: residual — a lone record keeps its bytes in the payload',
  literalPayload(half(13, 28, 13, 1)), `a${half(13, 28, 13, 1)}b`)
check('m14: residual — ...and the ingress then deletes that complete record',
  literalValue(half(13, 28, 13, 1)), 'ab')
check('m15: residual — a Uc=0 pair likewise survives the decoder and not the ingress',
  literalValue(half(13, 28, 0, 1), half(13, 28, 0, 0)), 'ab')

/**
 * The SAME `decodedRecordChar` serves the ASSEMBLED lane
 * (`decodeWin32RecordText`), whose input is the record text a decomposed paste
 * leaked. A one-lane fix on a shared helper leaves the other caller guarded by
 * nothing but a probe (brooks-review, Change Propagation), so the second caller
 * gets the same three cases — the leaked spelling arrives CHARACTER BY
 * CHARACTER, exactly as the (c)/(e)/(j) fixtures deliver it.
 */
const leakedHalf = (uc: number): string => `${ESC}[65;30;${uc};1;0;1_`
const assembledValue = (text: string): string => pasteIngress(pastePayload(decomposedStream(text)))
check('m16: the ASSEMBLED lane hands a lone half back too (shared helper)',
  assembledValue(`a${leakedHalf(0xd83d)}b`), 'a\ud83db')
check('m17: ...and cannot stitch one record\u2019s half onto another\u2019s across payload text',
  assembledValue(`a${leakedHalf(0xd83d)}X${leakedHalf(0xde00)}b`), 'a\ud83dX\ude00b')
check('m18: control — adjacent halves in the assembled lane still compose ONE char',
  assembledValue(`a${leakedHalf(0xd83d)}${leakedHalf(0xde00)}b`), 'a\u{1f600}b')

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

/** The chip's own painted row — what (j)'s residue check must read, so it reads
 *  the same row the chip stats come from. Empty while no chip is up. */
function chipRowOnScreen(): string {
  for (const row of termTest.viewportLines(term)) {
    if (/[▸▾] \d+ (?:lines|行)・\d+ (?:chars|字)/u.test(row)) return row
  }
  return ''
}

type Round = {
  readonly value: string
  readonly submitted: string
  readonly chip: { lines: number; chars: number } | null
  readonly landed: boolean
  /** true when the paste ALONE dispatched a submit, before Enter was pressed */
  readonly selfSubmitted: boolean
}

/** Enter, with the second press the folded-composer path sometimes needs
 *  (a first press can land while the frame is still settling). Returns the
 *  submitted payload, or '' when nothing was dispatched. */
async function pressEnter(): Promise<string> {
  stdinObj.write('\r')
  const first = await settled(() => submittedCount > 0, { timeoutMs: 900 })
  if (!first) {
    stdinObj.write('\r')
    await settled(() => submittedCount > 0, { timeoutMs: SUBMIT_MS })
  }
  return submittedCount > 0 ? lastSubmitted : ''
}
/** One delivery round: paste -> read value + chip -> (unless `submit` is
 *  false) Enter -> read submit. `stream` is the decomposed win32-paste byte
 *  stream itself, so a round can use the mixed lanes a half-leaked break needs
 *  (`pasteStream`). `submit: false` leaves the prompt untouched and reports
 *  whether the paste alone submitted anything. */
async function deliver(stream: string, submit = true): Promise<Round> {
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
  const selfSubmitted = submittedCount > 0
  if (!submit) return { value, submitted: '', chip, landed, selfSubmitted }
  return { value, submitted: await pressEnter(), chip, landed, selfSubmitted }
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

  // (j) on the product: the reported symptom's own shape. Ten rows, 760 chars,
  // EVERY boundary replaced by record text — the chip must report the source
  // line count and Enter must send the source bytes (L-012: the symptom gone
  // AND the function still firing, on the real Chat mount).
  const allBoundary = await deliver(ALL_BOUNDARY_STREAM)
  console.log(`     all-boundary (on the product): landed=${allBoundary.landed} valueLines=${allBoundary.value.split('\n').length} chip=${allBoundary.chip === null ? 'none' : `${allBoundary.chip.lines} lines/${allBoundary.chip.chars} chars`} submittedLines=${allBoundary.submitted.split('\n').length} residueRows=${termTest.viewportLines(term).filter(row => RECORD_SHAPE.test(row)).length}`)
  check('j8: the composer holds the source bytes', allBoundary.value, ALL_BOUNDARY_SOURCE)
  checkNum('j9: chip lines == source lines (10)', allBoundary.chip?.lines ?? -1, ALL_BOUNDARY_ROWS.length)
  checkNum('j10: chip chars == source chars', allBoundary.chip?.chars ?? -1, ALL_BOUNDARY_SOURCE.length)
  check('j11: Enter submits the source byte-for-byte', allBoundary.submitted, ALL_BOUNDARY_SOURCE)
  checkNum('j12: the painted chip row carries no record residue (`_`)', residueCount(chipRowOnScreen()), 0)
  checkNum('j13: and no painted row carries a record-shaped run', termTest.viewportLines(term).filter(row => RECORD_SHAPE.test(row)).length, 0)

  // (k) on the product: T-FIX-01's convicted VK_PACKET forms, through the real
  // parser + composer + render. The chip must report the SOURCE lines and
  // chars, the paste alone must NOT submit (no Return record is dispatched),
  // and a real Enter must still send the payload byte-for-byte (L-012).
  const packetV10 = await deliver(PACKET_V10, false)
  console.log(`     VK_PACKET V10 (on the product): landed=${packetV10.landed} valueLines=${packetV10.value.split('\n').length} chip=${packetV10.chip === null ? 'none' : `${packetV10.chip.lines} lines/${packetV10.chip.chars} chars`} selfSubmitted=${packetV10.selfSubmitted}`)
  check('k11: the composer holds the source bytes', packetV10.value, ALL_BOUNDARY_SOURCE)
  checkNum('k12: chip lines == source lines (10)', packetV10.chip?.lines ?? -1, ALL_BOUNDARY_ROWS.length)
  checkNum('k13: chip chars == source chars (760)', packetV10.chip?.chars ?? -1, ALL_BOUNDARY_SOURCE.length)
  checkNum('k14: the paste alone does not submit (no Return is dispatched)', packetV10.selfSubmitted ? 1 : 0, 0)
  check('k15: Enter still submits the restored payload byte-for-byte', await pressEnter(), ALL_BOUNDARY_SOURCE)

  const packetV11 = await deliver(PACKET_V11, false)
  console.log(`     VK_PACKET V11 (on the product): landed=${packetV11.landed} valueLines=${packetV11.value.split('\n').length} chip=${packetV11.chip === null ? 'none' : `${packetV11.chip.lines} lines/${packetV11.chip.chars} chars`} selfSubmitted=${packetV11.selfSubmitted}`)
  check('k16: the composer holds the source bytes', packetV11.value, ALL_BOUNDARY_SOURCE)
  checkNum('k17: chip lines == source lines (10)', packetV11.chip?.lines ?? -1, ALL_BOUNDARY_ROWS.length)

  const packetV17 = await deliver(PACKET_V17, false)
  console.log(`     VK_PACKET V17 (on the product): landed=${packetV17.landed} valueLines=${packetV17.value.split('\n').length} chip=${packetV17.chip === null ? 'none' : `${packetV17.chip.lines} lines/${packetV17.chip.chars} chars`} selfSubmitted=${packetV17.selfSubmitted}`)
  check('k18: the composer holds the source bytes', packetV17.value, ALL_BOUNDARY_SOURCE)
  checkNum('k19: chip lines == source lines (10)', packetV17.chip?.lines ?? -1, ALL_BOUNDARY_ROWS.length)
  checkNum('k20: chip chars == source chars (760)', packetV17.chip?.chars ?? -1, ALL_BOUNDARY_SOURCE.length)

  // (l) on the product: the user's own capture — the bracketed paste whose
  // breaks are real record pairs — through the real parser + composer + render.
  // The chip must report the SOURCE lines/chars, the paste alone must NOT
  // submit (no Return event is dispatched), and a real Enter must still send
  // the payload byte-for-byte (L-012: symptom gone AND the function firing).
  const captured = await deliver(CAPTURE_STREAM, false)
  console.log(`     user capture (on the product): landed=${captured.landed} valueLines=${captured.value.split('\n').length} chip=${captured.chip === null ? 'none' : `${captured.chip.lines} lines/${captured.chip.chars} chars`} selfSubmitted=${captured.selfSubmitted}`)
  check('l12: the composer holds the capture\'s source bytes', captured.value, ALL_BOUNDARY_SOURCE)
  checkNum('l13: chip lines == source lines (10)', captured.chip?.lines ?? -1, ALL_BOUNDARY_ROWS.length)
  checkNum('l14: chip chars == source chars (760)', captured.chip?.chars ?? -1, ALL_BOUNDARY_SOURCE.length)
  checkNum('l15: the capture alone does not submit (no Return is dispatched)', captured.selfSubmitted ? 1 : 0, 0)
  check('l16: Enter still submits the decoded payload byte-for-byte', await pressEnter(), ALL_BOUNDARY_SOURCE)
  checkNum('l17: and no painted row carries a record-shaped run', termTest.viewportLines(term).filter(row => RECORD_SHAPE.test(row)).length, 0)
} finally {
  await instance?.unmount()
  rmSync(dataDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall paste-integrity assertions passed')
