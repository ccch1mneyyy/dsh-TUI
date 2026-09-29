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
 *     collected as paste text. The drop must be RECOGNIZED and restored to
 *     its local path instead.
 *  2. TOKENIZED (VT host): the same bytes arrive as whole CSI/OSC tokens.
 *     `parseTerminalResponse` matches `ESC ] <digits> ; …`, so an OSC 8
 *     hyperlink used to be swallowed as a bogus response — the dropped path
 *     must not silently vanish as a sequence fragment either.
 *
 * The restored payload is the decoded local path in the composer's
 * single-token form (quoted when it contains whitespace), so the existing
 * image stage / `@` pipeline accepts it (`parsePastedImagePath`).
 *
 * Also covers the paste-payload contract itself, as narrowed in T02: complete
 * OSC sequences and inert C0 bytes never survive into a paste key, while TAB,
 * CR/LF, DEL, C1 text and protocol-SHAPED LITERAL TEXT (a bracketed paste's
 * `ESC[31m`) do — the composer owns line-ending normalization, and PR #1142
 * pins that a paste's protocol-shaped bytes stay byte-identical
 * (`verify-win32-input.tsx`).
 *
 * Run with: node --import tsx/esm scripts/verify-paste-drop.ts
 * Exits 1 on the first failed assertion (CI gate).
 */
const { INITIAL_STATE, parseMultipleKeypresses } = await import('../src/ink/parse-keypress.js')
const { parsePastedImagePath } = await import('../src/utils/pastedImagePath.js')
const { fileURLToPath } = await import('node:url')

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
 * TERMINAL PROTOCOL FRAME may appear in it — not an OSC 8 parameter field,
 * not a `file://` URI. (A protocol-shaped LITERAL like `ESC[31m` is user text
 * under the #1142 contract and is deliberately not covered here; see the
 * narrowed hygiene section below.)
 */
const SEQUENCE_RESIDUE = /\u001b|file:\/\/|(?:^|;)\d+(?:;\d+)+;?/u

const residueOf = (payload: string): string | null => SEQUENCE_RESIDUE.exec(payload)?.[0] ?? null

// --- fixtures ---------------------------------------------------------------

const DROPPED_URI = 'file:///C:/Users/me/My%20File.png'
/** The decoded local path, platform-correct: `C:\Users\me\My File.png` on
 *  Windows, `/C:/Users/me/My File.png` on the POSIX hosts CI runs this group
 *  on (`.github/workflows/ci.yml` input-terminal = ubuntu-latest). */
const DROPPED = fileURLToPath(DROPPED_URI)
/** Windows-literal shape for the shell-token tests: drive-letter parsing and
 *  quoting are pure string handling, so they must pass on every host. */
const DROPPED_WINDOWS = 'C:\\Users\\me\\My File.png'
/** The restored payload: percent-decoded, in the composer's single-token
 *  (quoted) form so `parsePastedImagePath` accepts the whole payload. */
const DROPPED_PAYLOAD = `"${DROPPED}"`
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
  const items = feed([stream])
  const payloads = pastes(items)
  check('decomposed drop yields exactly one paste', payloads.length, 1)
  // T02 (AC-1 / AC-8): the OSC 8 frame is RECOGNIZED as the drop it is — the
  // payload is the percent-decoded local path, not the `]8;…` fragments the
  // ESC-consuming pipeline used to leave behind.
  check('decomposed drop restores the dropped path', payloads[0] ?? '', DROPPED_PAYLOAD)
  check(
    'decomposed drop stages through the image pipeline',
    parsePastedImagePath(payloads[0] ?? ''),
    DROPPED,
  )
  check('decomposed drop leaves no sequence fragment', residueOf(payloads[0] ?? ''), null)
  check(
    'decomposed drop is not claimed as a terminal reply',
    items.some(item => item.kind === 'response'),
    false,
  )
}

// --- 2. the same drop with the params field omitted -------------------------

{
  const stream =
    win32Marker(`${ESC}[200~`) +
    win32Records(OSC8_OPEN_PLAIN) +
    win32Records(OSC8_CLOSE_ST) +
    win32Marker(`${ESC}[201~`)
  const payload = pastes(feed([stream]))[0] ?? ''
  // The BEL terminator does not survive the record translator (a Uc=7
  // synthesized record carries no key meaning), so this pins that an
  // unterminated-but-unambiguous frame still restores.
  check('params-less decomposed drop restores the dropped path', payload, DROPPED_PAYLOAD)
  check('params-less decomposed drop leaves no fragment', residueOf(payload), null)
}

// --- 3. VT host: whole tokens, no decomposition -----------------------------

{
  const items = feed([`${ESC}[200~${OSC8_OPEN_ID}${OSC8_CLOSE_ST}${ESC}[201~`])
  const payload = pastes(items)[0] ?? ''
  // On a host that hands the sequence over whole, the frame arrives as
  // tokens inside the bracketed paste; it must be restored there too (the
  // pasted body is reassembled into one payload before hygiene runs).
  check('tokenized drop restores the dropped path', payload, DROPPED_PAYLOAD)
  check('tokenized drop leaves no sequence fragment', residueOf(payload), null)
}

// --- 3b. bare decomposed drop, no bracketed-paste markers -------------------
//
// The issue's own stream shape: conhost decomposes the hyperlink into
// per-character records with no paste markers around them. The ESC record
// used to be consumed as an Escape key and the rest leaked into the draft as
// `]8;id=16:42;file:///…` text; the frame must be reassembled and restored.

{
  const items = feed([win32Records(OSC8_OPEN_ID) + win32Records(OSC8_CLOSE_ST)])
  check('bare decomposed drop yields one paste', pastes(items).length, 1)
  check('bare decomposed drop restores the dropped path', pastes(items)[0] ?? '', DROPPED_PAYLOAD)
  check(
    'bare decomposed drop leaks no protocol fragment as text',
    items.some(
      item => item.kind === 'key' && item.isPasted !== true && (item.sequence ?? '').includes(']8;'),
    ),
    false,
  )
}

// --- 3c. the same drop as a bare VT token -----------------------------------
//
// #1067 analysis 5: `parseTerminalResponse` matched `ESC ] 8 ; …` as an OSC
// reply, so the vterm path lost the link entirely. The drop chain must claim
// it first (D6 order: OSC 8 → reply → mouse).

{
  const items = feed([OSC8_OPEN_ID])
  check('bare VT drop restores the dropped path', pastes(items)[0] ?? '', DROPPED_PAYLOAD)
  check(
    'bare VT drop is not claimed as a terminal reply',
    items.some(item => item.kind === 'response'),
    false,
  )
}

// --- 3d. control: without OSC 8, records behave exactly as before -----------
//
// The recognizer must be inert for ordinary paste traffic: a decomposed paste
// with no hyperlink in it still yields exactly its literal text.

{
  const stream = win32Marker(`${ESC}[200~`) + win32Records('plain text') + win32Marker(`${ESC}[201~`)
  check('control: decomposed paste without OSC 8 is unchanged', pastes(feed([stream]))[0], 'plain text')
  const reply = feed([`${ESC}]11;rgb:0000/0000/0000${BEL}`])
  check(
    'control: an ordinary OSC reply is still claimed as a reply',
    reply.length === 1 && reply[0]?.kind === 'response' &&
      reply[0].response.type === 'osc' && reply[0].response.code === 11,
    true,
  )
}

// --- 3e. OSC 8 frames that must NOT become a path (fail-closed) -------------

{
  check('a remote OSC 8 authority is not restored', pastes(feed([`${ESC}]8;;file://server/share/a.png${ST}`])), [])
  check('a non-file OSC 8 URI is not restored', pastes(feed([`${ESC}]8;;https://example.com/a.png${ST}`])), [])
  check(
    'a multi-token OSC 8 URI is not restored',
    pastes(feed([`${ESC}]8;;file:///C:/a.png file:///C:/b.png${ST}`])),
    [],
  )
  // Multi-file drops are v2. When ONE reassembled payload carries two
  // distinct URIs, refuse the whole payload instead of silently keeping only
  // the first file. (A VT host that hands each frame over as its own token
  // claims them one by one — v2 territory either way.)
  const multiFile = `${ESC}[200~${ESC}]8;;file:///C:/a.png${ST}${ESC}]8;;file:///C:/b.png${ST}${ESC}[201~`
  const multiPayload = pastes(feed([multiFile]))[0] ?? ''
  check('a multi-file OSC 8 payload restores no single path', multiPayload, '')
  check('a multi-file OSC 8 payload inserts no file:// text', multiPayload.includes('file://'), false)
  // A lone frame with neither terminator nor successor is indistinguishable
  // from a stream truncated mid-payload; it must fail closed (nothing
  // restored) instead of fabricating a path from a partial URI.
  const truncated = `${ESC}[200~${ESC}]8;;file:///C:/tmp/a.png${ESC}[201~`
  check('an unterminated lone OSC 8 frame is not restored', pastes(feed([truncated]))[0] ?? '', '')
  // A payload that merely CONTAINS a hyperlink next to prose is not a drop:
  // the prose survives (minus the stripped OSC frame), and the link's URI is
  // never inserted as a fabricated path.
  const prose = `${ESC}[200~look at ${OSC8_OPEN_ID} please${ESC}[201~`
  check('prose with an embedded OSC 8 frame keeps its text', pastes(feed([prose]))[0], 'look at  please')
}

// --- 4. payload hygiene contract --------------------------------------------

{
  const items = feed([`${ESC}[200~a${ESC}[31mb${BEL}c${ESC}]0;title${BEL}d${ESC}[201~`])
  // Narrowed hygiene (T02 / DESIGN D3): complete OSC and inert C0 are
  // stripped, but protocol-SHAPED LITERAL text — the SGR `ESC[31m` here — is
  // the user's data and survives, exactly as PR #1142 pins for bracketed
  // paste (`verify-win32-input.tsx`). The wide strip (CSI + residual ESC)
  // proved mutually exclusive with that contract.
  check('OSC/BEL are stripped; literal CSI survives (#1142)', pastes(items)[0], `a${ESC}[31mbcd`)
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
  // with ESC intact, and the ESC-consuming pipeline turned it into
  // `[16;42;0;1;16;1…` fragments that landed in the prompt. The drop frame is
  // now claimed as a path before hygiene runs (T02); text that merely LOOKS
  // like a stripped fragment is left alone on purpose — once the ESC bytes
  // are gone, text and fragment are indistinguishable, and guessing would
  // corrupt legitimate input. The OSC 8 frame embedded in that prose is still
  // stripped as a protocol sequence, so no `file://` URI is inserted as text
  // and the surrounding field is never hijacked into a phantom drop.
  const residue = '[16;42;0;1;16;1'
  const items = feed([`${ESC}[200~${residue} and ${ESC}]8;;file:///C:/tmp/a.png${BEL}x${ESC}[201~`])
  const payload = pastes(items)[0] ?? ''
  check('payload is not hijacked by an embedded OSC 8 frame', payload, `${residue} and x`)
  check('paste payload carries no file:// URI', payload.includes('file://'), false)
}

// --- 5. the drop still reaches the image pipeline ---------------------------

{
  check('a bare file:// URI decodes to the path', parsePastedImagePath(DROPPED_URI), DROPPED)
  check('a quoted file:// URI decodes to the path', parsePastedImagePath(`"${DROPPED_URI}"`), DROPPED)
  // A bare (unquoted) Windows token containing a space stays refused — the
  // parser cannot tell one path from two shell tokens, and the existing
  // contract is to fail closed there. A spaced path must arrive quoted.
  check('a bare spaced Windows path stays text', parsePastedImagePath(DROPPED_WINDOWS), null)
  check('a bare Windows image path still parses', parsePastedImagePath('C:\\tmp\\shot.png'), 'C:\\tmp\\shot.png')
  check('a quoted spaced Windows path still parses', parsePastedImagePath(`"${DROPPED_WINDOWS}"`), DROPPED_WINDOWS)
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
