/**
 * Windows file-drop paste regression: what a dropped file turns into.
 *
 * On Windows a desktop drop reaches the TUI as terminal BYTES, not text:
 * Windows Terminal / OpenConsole wrap the path in an OSC 8 hyperlink
 * (`ESC ] 8 ; <params> ; file:///… ST`), and a host running in
 * win32-input-mode (DECSET 9001 — this TUI enables it on native Windows,
 * see verify-win32-input.tsx) additionally decomposes that payload into
 * per-character synthesized key records.
 *
 * Two failure modes are pinned here, both of which surfaced as
 * `[16;42;0;1;16;1____…` garbage in the prompt instead of a path:
 *
 *  1. DECOMPOSED (win32-input-mode): the OSC 8 payload's ESC bytes become
 *     `Vk=27` records, which the record translator consumes as an `escape`
 *     key — leaving the parameter digits and the `file:///…` URI to be
 *     collected as paste text. The paste payload must come out clean.
 *  2. TOKENIZED (VT host): the same bytes arrive as whole CSI/OSC tokens.
 *     `parseTerminalResponse` matches `ESC ] <digits> ; …`, so an OSC 8
 *     hyperlink is swallowed as a bogus response — a dropped path must not
 *     silently vanish as sequence fragments either.
 *
 * Also covers the paste-payload contract itself: control sequences and inert
 * C0 bytes never survive into a paste key, while TAB, CR/LF, DEL and C1 text
 * do (the composer owns line-ending normalization and tab expansion;
 * verify-keys.tsx pins that a paste keeps its embedded DEL as data).
 *
 * Run with: node --import tsx/esm scripts/verify-paste-drop.ts
 * Exits 1 on the first failed assertion (CI gate).
 */
const { INITIAL_STATE, parseMultipleKeypresses } = await import('../src/ink/parse-keypress.js')
const { parsePastedImagePath } = await import('../src/utils/pastedImagePath.js')

type ParseResult = ReturnType<typeof parseMultipleKeypresses>
type ParsedInput = ParseResult[0][number]
type KeyParseState = ParseResult[1]

const ESC = '\x1b'
const BEL = '\u0007'
const ST = `${ESC}\\`

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`ok   ${label}`)
    return
  }
  failures++
  console.log(`FAIL ${label}\n     expected ${e}\n     actual   ${a}`)
}

/** Feed a byte stream through the real parser, returning every parsed input. */
function feed(chunks: readonly (string | null)[]): ParsedInput[] {
  let state: KeyParseState = { ...INITIAL_STATE }
  const out: ParsedInput[] = []
  for (const chunk of chunks) {
    const [items, next] = parseMultipleKeypresses(state, chunk)
    out.push(...items)
    state = next
  }
  return out
}

/** The paste payloads in a parse result, in order. */
function pastes(items: readonly ParsedInput[]): string[] {
  return items.filter(i => i.kind === 'key' && i.isPasted).map(i => i.sequence ?? '')
}

/**
 * Synthesize the win32-input-mode stream for `text`: one
 * `CSI 0;0;<Uc>;1;0;1 _` record per UTF-16 unit (conhost's
 * `SynthesizeKeyEvent` shape — Vk=0, Sc=0, Cs=0, keydown, one repeat).
 */
function win32Records(text: string): string {
  let out = ''
  for (const unit of text) {
    out += `${ESC}[0;0;${unit.charCodeAt(0)};1;0;1_`
  }
  return out
}

/** The char record for one bracketed-paste marker character. */
const win32Marker = (marker: string): string => win32Records(marker)

/**
 * The invariant this file exists for: a paste payload is user text, so no
 * byte of a terminal control sequence may appear in it — not the ESC
 * introducer, not an OSC 8 parameter field, and not an sRGB fragment
 * (`0;1`, `16;42`) left behind by a stripper that removed ESC only.
 */
const SEQUENCE_RESIDUE = /\u001b|file:\/\/|(?:^|;)\d+(?:;\d+)+;?/u

const residueOf = (payload: string): string | null => SEQUENCE_RESIDUE.exec(payload)?.[0] ?? null

// --- fixtures ---------------------------------------------------------------

const DROPPED = 'C:\\Users\\me\\My File.png'
const DROPPED_URI = 'file:///C:/Users/me/My%20File.png'
/** OSC 8 start with an `id=` params field, as OpenConsole emits for a drop. */
const OSC8_OPEN_ID = `${ESC}]8;id=16:42;${DROPPED_URI}${ST}`
/** OSC 8 with empty params + BEL terminator — the form this TUI itself emits. */
const OSC8_OPEN_PLAIN = `${ESC}]8;;${DROPPED_URI}${BEL}`
const OSC8_CLOSE_ST = `${ESC}]8;;${ST}`

// --- 1. decomposed drop under win32-input-mode ------------------------------

{
  const stream =
    win32Marker(`${ESC}[200~`) +
    win32Records(OSC8_OPEN_ID) +
    win32Records(OSC8_CLOSE_ST) +
    win32Marker(`${ESC}[201~`)
  const payloads = pastes(feed([stream]))
  check('decomposed drop yields exactly one paste', payloads.length, 1)
  // The ESC bytes of the payload become Vk=27 records, which the record
  // translator consumes as `escape` — so on this host the drop lands as
  // FRAGMENTS (`[16;42;0;1;16;1____`) rather than as a path. Nothing may
  // reach the draft: the composer has no path to insert, and fragments are
  // worse than nothing.
  check('decomposed drop leaves no sequence fragment', residueOf(payloads[0] ?? ''), null)
}

// --- 2. the same drop with the params field omitted -------------------------

{
  const stream =
    win32Marker(`${ESC}[200~`) +
    win32Records(OSC8_OPEN_PLAIN) +
    win32Records(OSC8_CLOSE_ST) +
    win32Marker(`${ESC}[201~`)
  check('params-less decomposed drop leaves no fragment', residueOf(pastes(feed([stream]))[0] ?? ''), null)
}

// --- 3. VT host: whole tokens, no decomposition -----------------------------

{
  const items = feed([`${ESC}[200~${OSC8_OPEN_ID}${OSC8_CLOSE_ST}${ESC}[201~`])
  // On a host that hands the sequence over whole, `parseTerminalResponse`
  // matches `ESC ] <digits> ; …` first, so the OSC 8 open is claimed as a
  // (bogus) response and the link never reaches the prompt. Assert the
  // payload is clean rather than promising the URI arrives — the residue
  // assertion above is the one that must hold on every host.
  const payload = pastes(items)[0] ?? ''
  check('tokenized drop leaves no sequence fragment', residueOf(payload), null)
}

// --- 4. payload hygiene contract --------------------------------------------

{
  const items = feed([`${ESC}[200~a${ESC}[31mb${BEL}c${ESC}]0;title${BEL}d${ESC}[201~`])
  check('SGR/OSC/BEL are stripped from the payload', pastes(items)[0], 'abcd')
}

{
  const items = feed([`${ESC}[200~\ttab\r\nline${ESC}[201~`])
  check('TAB and CR/LF survive for the composer', pastes(items)[0], '\ttab\r\nline')
}

{
  const items = feed([`${ESC}[200~\u0000\u0007\u0008keep${ESC}[201~`])
  check('inert C0 controls are dropped', pastes(items)[0], 'keep')
}

{
  // DEL and the C1 band are NOT stripped: DEL is a pinned paste-payload
  // contract, and a C1 code point in a UTF-8-decoded payload is user text,
  // not a terminal byte (see INERT_IN_PASTE).
  check('DEL survives a paste payload', pastes(feed([`${ESC}[200~a\u007fb${ESC}[201~`]))[0], 'a\u007fb')
  check('C1 text survives a paste payload', pastes(feed([`${ESC}[200~a\u0085b${ESC}[201~`]))[0], 'a\u0085b')
}

{
  // The reported symptom in one line: a dropped path's OSC 8 payload arrives
  // with ESC intact, an ESC-dropping pipeline turns it into
  // `[16;42;0;1;16;1…`, and that fragment is what lands in the prompt. Two
  // invariants keep it out — no ESC byte survives a paste payload, and no
  // `file://` URI is inserted as prose (it is decoded into a path instead).
  // A payload that merely LOOKS like a stripped fragment is left alone on
  // purpose: once the ESC bytes are gone, text and fragment are
  // indistinguishable, and guessing would corrupt legitimate input.
  const residue = '[16;42;0;1;16;1'
  const items = feed([`${ESC}[200~${residue} and ${ESC}]8;;file:///C:/tmp/a.png${BEL}x${ESC}[201~`])
  const payload = pastes(items)[0] ?? ''
  check('paste payload carries no ESC byte', payload.includes('\u001b'), false)
  check('paste payload carries no file:// URI', payload.includes('file://'), false)
}

// --- 5. the drop still reaches the image pipeline ---------------------------

{
  check(
    'a bare file:// URI decodes to the path',
    parsePastedImagePath(DROPPED_URI),
    DROPPED.replace(/%20/u, ' ').replace(/\//gu, '\\'),
  )
  check('a quoted file:// URI decodes to the path', parsePastedImagePath(`"${DROPPED_URI}"`), DROPPED)
  // A bare (unquoted) Windows token containing a space stays refused — the
  // parser cannot tell one path from two shell tokens, and the existing
  // contract is to fail closed there. A spaced path must arrive quoted.
  check('a bare spaced Windows path stays text', parsePastedImagePath(DROPPED), null)
  check('a bare Windows image path still parses', parsePastedImagePath('C:\\tmp\\shot.png'), 'C:\\tmp\\shot.png')
  check('a quoted spaced Windows path still parses', parsePastedImagePath(`"${DROPPED}"`), DROPPED)
  check('a non-image file:// URI is not an image drop', parsePastedImagePath('file:///C:/tmp/notes.txt'), null)
  check('a remote file:// authority is refused', parsePastedImagePath('file://server/share/a.png'), null)
  check('prose is still refused', parsePastedImagePath('look at file:///C:/tmp/a.png please'), null)
}

// --- 6. ordinary paste is untouched -----------------------------------------

{
  check('non-paste keys are unaffected', pastes(feed(['abc'])), [])
  check('plain multi-line paste survives', pastes(feed([`${ESC}[200~x\r\ny${ESC}[201~`]))[0], 'x\r\ny')
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall checks passed')
