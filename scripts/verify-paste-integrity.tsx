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
 *
 * Run with: node --import tsx/esm scripts/verify-paste-integrity.tsx
 * Exits 1 on the first failed assertion (CI gate).
 */
import { sanitizeEditableText, sanitizePastedText } from '../src/components/PromptInput.js'
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type KeyParseState,
  type ParsedInput,
} from '../src/ink/parse-keypress.js'

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

/** The decomposed-paste stream (classic conhost under win32-input-mode): the
 *  marker strings AND the body are synthesized per-character records, so the
 *  parser's decomposed-paste matcher reassembles them into one paste. */
const decomposedStream = (text: string): string =>
  markerRecs(`${ESC}[200~`) +
  [...text].map(ch => (ch === ESC ? ESC_CHAR_REC : synthRec(ch))).join('') +
  markerRecs(`${ESC}[201~`)

/** The payload one parse of `input` hands over as a paste, or '' when the
 *  stream produced no paste key at all. */
function pastePayload(input: string): string {
  const [keys]: [ParsedInput[], KeyParseState] = parseMultipleKeypresses(INITIAL_STATE, input)
  const paste = keys.find((k: ParsedInput) => k.kind === 'key' && k.isPasted)
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

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall paste-integrity assertions passed')
