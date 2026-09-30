/**
 * Paste-residue regression for win32-input-mode ingress cleaning (#1090).
 *
 * A raw record (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`) that reaches the editable buffer
 * as text used to survive `stripAnsi` as a lone `_` — the stray underscores
 * reported after pasting multi-line text. `sanitizeEditableText` must strip
 * the whole record before `stripAnsi`.
 *
 * `sanitizePastedText` strips the ESC-less tail form ONLY when the same
 * payload also carries at least one full ESC-bearing record — that is the
 * only in-payload evidence of a split record stream. A literal bracketed
 * paste / Ctrl+V payload containing just the record-shaped text
 * `[13;28;13;1;0;1_` is therefore preserved byte-for-byte (#1097 review);
 * the mixed full-record + tail payload still loses the tail.
 *
 * Controls: real underscores, bracket text that only resembles a record
 * (fewer or more than five field separators), plain bracketed-paste content,
 * and typed text containing the tail shape (only paste payloads get the tail
 * strip). The pre-existing normalization (ANSI, CRLF, tabs) is re-asserted.
 *
 * Run with: node --import tsx/esm scripts/verify-paste-residue.tsx
 * Exits 1 on the first failed assertion (CI gate).
 */
import { sanitizeEditableText, sanitizePastedText } from '../src/components/PromptInput.js'
import { formatClipboardInsert } from '../src/utils/clipboard.js'

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

function checkBool(label: string, actual: boolean, expected: boolean): void {
  if (actual === expected) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label}\n     expected ${expected}\n     actual   ${actual}`)
  }
}

const ESC = '\u001b'
// A complete spec example: Vk;Sc;Uc;Kd;Cs;Rc.
const RECORD = `${ESC}[13;28;13;1;0;1_`
// Spec #4999 allows empty fields; the record grammar still has five `;`.
const RECORD_EMPTY = `${ESC}[;;65;1;0;1_`
// The same record without its ESC byte: what a split record leaves behind
// when the terminal/App escape timer flushed the prefix before the tail.
const TAIL = '[13;28;13;1;0;1_'

/** PromptInput.tsx bracketed-paste ingress: CRLF/CR fold before the paste
 *  sanitizer runs (the terminal paste branch). */
function bracketedPasteIngress(text: string): string {
  return sanitizePastedText(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
}

/** PromptInput.tsx Ctrl+V ingress: clipboard text is formatted (line endings
 *  normalized) and then goes through the same paste sanitizer. */
function ctrlVPasteIngress(text: string): string {
  return sanitizePastedText(formatClipboardInsert({ kind: 'text', text }))
}

// --- AC-B1: full records never degrade to a lone `_` -------------------------

check('full record is stripped whole from a paste payload', sanitizePastedText(`a${RECORD}b`), 'ab')
check('full record is stripped whole from any ingress', sanitizeEditableText(`a${RECORD}b`), 'ab')
check('spec-legal empty fields are part of the record grammar', sanitizePastedText(`a${RECORD_EMPTY}b`), 'ab')

// --- AC-B2: ESC-less tail is stripped only with in-payload split evidence ----

check(
  'literal tail-shape text is byte-identical through bracketed paste',
  bracketedPasteIngress(TAIL),
  TAIL,
)
check(
  'literal tail-shape text is byte-identical through Ctrl+V',
  ctrlVPasteIngress(TAIL),
  TAIL,
)
check(
  'repeated literal tail-shape text survives when no full record is present',
  bracketedPasteIngress(`${TAIL} ${TAIL}`),
  `${TAIL} ${TAIL}`,
)
check(
  'literal tail-shape text keeps every byte between ordinary words',
  bracketedPasteIngress(`before ${TAIL} after`),
  `before ${TAIL} after`,
)
checkBool('literal tail-shape text is never partially trimmed', bracketedPasteIngress(TAIL).includes('_'), true)

check('both forms back to back leave nothing', sanitizePastedText(`${RECORD}${TAIL}`), '')
checkBool('no partial residue survives as `_`', sanitizePastedText(`${RECORD}${TAIL}`).includes('_'), false)

check(
  'mixed paste strips only the tail once a full record proves the split',
  sanitizePastedText(`a${RECORD}b ${TAIL}c`),
  'ab c',
)
check(
  'record residue does not eat real `_`, near-miss brackets, or CRLF',
  sanitizePastedText(`a_b [1;2;3;4;5_] ${RECORD}\r\n[1;2;3;4;5_x ${TAIL}\n`),
  'a_b [1;2;3;4;5_] \n[1;2;3;4;5_x \n',
)

// --- AC-B3: no false positives -----------------------------------------------

check('bare underscores are never matched', sanitizePastedText('_ __ a_b ___'), '_ __ a_b ___')
check(
  'bracket text with fewer than five separators survives',
  sanitizePastedText('[1;2;3;4;5_] [x] [] [200~'),
  '[1;2;3;4;5_] [x] [] [200~',
)
check(
  'six separators is not the record grammar',
  sanitizePastedText('[13;28;13;1;0;1;9_'),
  '[13;28;13;1;0;1;9_',
)
check('typed tail-shaped text is left alone outside the paste path', sanitizeEditableText(`x${TAIL}y`), `x${TAIL}y`)
check(
  'ordinary bracketed-paste content is byte-identical',
  sanitizePastedText('line 1\nline 2\nline 3'),
  'line 1\nline 2\nline 3',
)
check(
  'bracketed-paste body containing a bracket chunk survives the tail probe',
  sanitizePastedText('line 1 [200~\r\nline 2'),
  'line 1 [200~\nline 2',
)
check('ANSI styling still goes through stripAnsi', sanitizePastedText(`${ESC}[31mred${ESC}[0m`), 'red')
check('CRLF and tabs still normalize after residue stripping', sanitizePastedText(`${RECORD}a\r\nb\tc`), 'a\nb        c')

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall paste-residue assertions passed')
