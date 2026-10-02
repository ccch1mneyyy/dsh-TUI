/**
 * Regression tests for win32-input-mode parsing (#147).
 *
 * On native Windows the TUI enables DECSET 9001 (CSI ?9001h) instead of
 * kitty/modifyOtherKeys — Windows Terminal/conhost never attach modifiers to
 * Enter in VT protocols (microsoft/terminal#530), so Shift+Enter is only
 * visible as a win32 INPUT_RECORD: CSI Vk;Sc;Uc;Kd;Cs;Rc _.
 *
 * Covers:
 *  1. the issue's probe bytes (Shift+Enter full press/release cycle)
 *  2. modifier recovery: Ctrl+letter (exitOnCtrlC), Ctrl+[ as Escape
 *     (legacy VT parity), AltGr as plain text (international layouts)
 *  3. spec-legal field omission (spec #4999: all fields optional)
 *  4. Uc winning over the Vk name table (NumLock-on numpad shares Vk with
 *     the Ins/Home cluster — tcell encoding)
 *  5. UTF-16 surrogate pairs across records, incl. state-pollution guards
 *  6. repeat-count expansion, keyup/modifier swallowing
 *  7. record fragments across escape flushes, expiry and resynchronization
 *  8. the capability gate without decoded evidence (Esc stays at 50ms on
 *     hosts that ignore DECSET 9001), split-position sweeps, and the
 *     64-byte / 1-second hold bounds
 *
 * Run with: node --import tsx/esm scripts/verify-win32-input.tsx
 * Exits 1 on the first failed assertion (CI gate).
 */
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type KeyParseState,
  type ParsedInput,
} from '../src/ink/parse-keypress.js'
import { supportsWin32InputMode } from '../src/ink/terminal.js'
import { default as App } from '../src/ink/components/App.js'
import { InputEvent } from '../src/ink/events/input-event.js'

type KeySummary = {
  kind: string
  name?: string
  shift?: boolean
  meta?: boolean
  ctrl?: boolean
  super?: boolean
  seq?: string
  isPasted?: boolean
}

function summarize(keys: ParsedInput[]): KeySummary[] {
  return keys.map(k =>
    k.kind === 'key'
      ? {
          kind: 'key',
          name: k.name,
          shift: k.shift,
          meta: k.meta,
          ctrl: k.ctrl,
          super: k.super,
          seq: k.sequence,
          isPasted: k.isPasted,
        }
      : { kind: k.kind },
  )
}

class Feeder {
  private state: KeyParseState = { mode: 'NORMAL', incomplete: '', pasteBuffer: '' }

  feed(s: string | null): KeySummary[] {
    const [keys, st] = parseMultipleKeypresses(this.state, s)
    this.state = st
    return summarize(keys)
  }
}

let failures = 0

function checkBoolean(label: string, actual: boolean, expected: boolean): void {
  if (actual === expected) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label}\n     expected ${expected}\n     actual   ${actual}`)
  }
}

function check(label: string, actual: KeySummary[], expected: KeySummary[]): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label}\n     expected ${e}\n     actual   ${a}`)
  }
}

const CSI = '\x1b['

// --- 0. host capability gate ------------------------------------------------

checkBoolean(
  'native Windows terminals enable win32-input-mode',
  supportsWin32InputMode('win32', undefined, undefined),
  true,
)
checkBoolean(
  'Termy-style xterm.js hosts keep standard VT input on Windows',
  supportsWin32InputMode('win32', 'vscode', '6.0.0'),
  false,
)
checkBoolean(
  'native VS Code keeps win32-input-mode on Windows',
  supportsWin32InputMode('win32', 'vscode', '1.103.0'),
  true,
)
checkBoolean(
  'non-Windows terminals never enable win32-input-mode',
  supportsWin32InputMode('linux', undefined, undefined),
  false,
)

// A win32 record translated to a named/special key keeps the raw record as
// its sequence; a translated text char uses the char itself.
const wkey = (name: string, mods: Partial<KeySummary> = {}, seq?: string): KeySummary => ({
  kind: 'key',
  name,
  shift: false,
  meta: false,
  ctrl: false,
  super: false,
  seq: seq ?? name,
  isPasted: false,
  ...mods,
})
const wchar = (c: string, mods: Partial<KeySummary> = {}): KeySummary => wkey(c, mods, c)

// --- 1. the issue's probe bytes ---------------------------------------------

{
  const f = new Feeder()
  check('VK_SHIFT keydown is swallowed', f.feed(`${CSI}16;42;0;1;48;1_`), [])
  check('Shift+Enter keydown is shift+return', f.feed(`${CSI}13;28;13;1;48;1_`), [
    wkey('return', { shift: true }, `${CSI}13;28;13;1;48;1_`),
  ])
  check('VK_RETURN keyup is swallowed', f.feed(`${CSI}13;28;13;0;48;1_`), [])
  check('VK_SHIFT keyup is swallowed', f.feed(`${CSI}16;42;0;0;32;1_`), [])
}
check('plain Enter has no modifiers', new Feeder().feed(`${CSI}13;28;13;1;32;1_`), [
  wkey('return', {}, `${CSI}13;28;13;1;32;1_`),
])
check('Ctrl+Enter (Cs=NumLock|LeftCtrl) is ctrl+return', new Feeder().feed(`${CSI}13;28;13;1;40;1_`), [
  wkey('return', { ctrl: true }, `${CSI}13;28;13;1;40;1_`),
])
{
  // Escape is a paste-marker prefix candidate, so it is held briefly and
  // released by the next key or the flush timer (same 50ms semantics as a
  // lone VT ESC).
  const f = new Feeder()
  check('Esc record is held as a marker candidate', f.feed(`${CSI}27;1;27;1;32;1_`), [])
  check('Esc is released on flush', f.feed(null), [
    wkey('escape', {}, `${CSI}27;1;27;1;32;1_`),
  ])
}

// --- 2. modifier recovery ----------------------------------------------------

check('Ctrl+C recovers the letter from Vk (exitOnCtrlC)', new Feeder().feed(`${CSI}67;46;3;1;40;1_`), [
  wchar('c', { ctrl: true }),
])
check('Ctrl+[ stays usable as Escape (legacy VT parity)', new Feeder().feed(`${CSI}219;26;27;1;8;1_`), [
  wkey('escape', { ctrl: true }, `${CSI}219;26;27;1;8;1_`),
])
check('Ctrl+] recovers via the OEM table', new Feeder().feed(`${CSI}221;29;29;1;8;1_`), [
  wchar(']', { ctrl: true }),
])
check('Ctrl+8 reports Uc=DEL and must not parse as a literal \\x7f', new Feeder().feed(`${CSI}56;9;127;1;8;1_`), [
  wchar('8', { ctrl: true }),
])
check('Ctrl+/ (Uc=DEL, OEM_2) recovers as ctrl+/', new Feeder().feed(`${CSI}191;53;127;1;24;1_`), [
  wchar('/', { ctrl: true, shift: true }),
])
check('Ctrl+Alt+Space keeps its modifiers (not AltGr text)', new Feeder().feed(`${CSI}32;57;32;1;13;1_`), [
  wkey('space', { ctrl: true, meta: true }, ' '),
])
check('plain Space is plain text', new Feeder().feed(`${CSI}32;57;32;1;32;1_`), [
  wkey('space', {}, ' '),
])
check('Space with Vk omitted (spec-legal) is still text', new Feeder().feed(`${CSI};;32;1_`), [
  wkey('space', {}, ' '),
])
check('VK_PACKET Space (Unicode-injected input) is still text', new Feeder().feed(`${CSI}231;0;32;1;0;1_`), [
  wkey('space', {}, ' '),
])
check('VK_PACKET graphic char ignores Vk entirely', new Feeder().feed(`${CSI}231;0;20320;1;0;1_`), [
  wchar('你'),
])
check('AltGr+Q (RightAlt+synthetic LeftCtrl, Uc=@) is plain text', new Feeder().feed(`${CSI}81;16;64;1;41;1_`), [
  wchar('@'),
])
check('AltGr+7 (Uc={) drops both modifier flags', new Feeder().feed(`${CSI}55;8;123;1;9;1_`), [
  wchar('{'),
])
check('Shift+Tab keeps the shift bit', new Feeder().feed(`${CSI}9;15;9;1;48;1_`), [
  wkey('tab', { shift: true }, `${CSI}9;15;9;1;48;1_`),
])
check('Shift+Up keeps the shift bit', new Feeder().feed(`${CSI}38;72;0;1;304;1_`), [
  wkey('up', { shift: true }, `${CSI}38;72;0;1;304;1_`),
])

// --- 3. spec-legal field omission --------------------------------------------

check('reduced record (Cs/Rc omitted) still yields the char', new Feeder().feed(`${CSI}65;30;97;1_`), [
  wchar('a'),
])
check('omitted Kd defaults to keyup and is swallowed', new Feeder().feed(`${CSI}65;30;97_`), [])
check('empty Cs field falls back to default', new Feeder().feed(`${CSI}65;30;97;1;;1_`), [
  wchar('a'),
])

// --- 4. Uc wins over the Vk name table ---------------------------------------

check('NumLock-on numpad 0 (tcell: Vk=VK_INSERT, Uc=0) is text', new Feeder().feed(`${CSI}45;82;48;1;32;1_`), [
  wchar('0'),
])
check('dedicated Insert (ENHANCED_KEY, Uc=0) stays insert', new Feeder().feed(`${CSI}45;14;0;1;288;1_`), [
  wkey('insert', {}, `${CSI}45;14;0;1;288;1_`),
])

// --- 5. surrogate pairs -------------------------------------------------------

{
  const f = new Feeder()
  check('high surrogate half is held back', f.feed(`${CSI}49;2;55357;1;32;1_`), [])
  check('low surrogate half completes the pair', f.feed(`${CSI}49;2;56832;1;32;1_`), [
    wchar('😀'),
  ])
}
{
  // CharToKeyEvents emits down+up per UTF-16 unit — a keyup between the
  // halves must not clear the pending high surrogate.
  const f = new Feeder()
  f.feed(`${CSI}49;2;55357;1;32;1_`) // high down
  check('high-surrogate keyup is swallowed but keeps the pending pair', f.feed(`${CSI}49;2;55357;0;32;1_`), [])
  check('low keydown after the keyup still completes the pair', f.feed(`${CSI}49;2;56832;1;32;1_`), [
    wchar('😀'),
  ])
}
{
  const f = new Feeder()
  f.feed(`${CSI}49;2;55357;1;32;1_`) // high half pending
  check('an intervening key settles a pending pair', f.feed(`${CSI}38;72;0;1;288;1_`), [
    wkey('up', {}, `${CSI}38;72;0;1;288;1_`),
  ])
  check('the orphaned low half is then dropped, not combined', f.feed(`${CSI}49;2;56832;1;32;1_`), [])
}
{
  // INITIAL_STATE is a shared singleton (also usable directly by callers) —
  // a pending high surrogate must not leak into it.
  const [keys, st] = parseMultipleKeypresses(INITIAL_STATE, `${CSI}49;2;55357;1;32;1_`)
  check('high surrogate via INITIAL_STATE yields no key', summarize(keys), [])
  if (INITIAL_STATE.win32HighSurrogate === undefined && st.win32HighSurrogate === 55357) {
    console.log('ok   INITIAL_STATE is not mutated (pair state rides on the new state)')
  } else {
    failures++
    console.log(
      `FAIL INITIAL_STATE mutation guard\n     expected INITIAL_STATE.win32HighSurrogate undefined and new state 55357\n` +
        `     actual   ${INITIAL_STATE.win32HighSurrogate} / ${st.win32HighSurrogate}`,
    )
  }
}

// --- 6. repeat count, IME text ------------------------------------------------

check('Rc=3 expands to three events', new Feeder().feed(`${CSI}88;45;120;1;32;3_`), [
  wchar('x'),
  wchar('x'),
  wchar('x'),
])
check('IME-composed CJK arrives via Uc', new Feeder().feed(`${CSI}65;30;20320;1;32;1_`), [
  wchar('你'),
])

// A native Windows paste can split a win32-input-mode record after ESC.
// When the 50ms escape timer fires before the tail arrives, the tokenizer
// has already emitted Escape; the later `[Vk;Sc;Uc;Kd;Cs;Rc_` tail must
// still be recognized instead of leaking the protocol bytes into the input.
{
  const f = new Feeder()
  check('split win32 record: ESC waits for its tail', f.feed('\x1b'), [])
  check('split win32 record: timeout releases Escape', f.feed(null), [
    wkey('escape', {}, '\x1b'),
  ])
  check('split win32 record: late CJK tail is recovered', f.feed('[0;0;36825;1;0;1_'), [
    wchar('这'),
  ])
}
check(
  'split win32 records: adjacent late tails are all recovered',
  new Feeder().feed('[0;0;36825;1;0;1_[0;0;26679;1;0;1_'),
  [wchar('这'), wchar('样')],
)

// --- 7. orphaned low surrogates never reach the Vk table ----------------------

check('orphaned low surrogate with Vk=32 is swallowed (not Space)', new Feeder().feed(`${CSI}32;57;56832;1;0;1_`), [])
check('orphaned low surrogate with Vk=13 is swallowed (not Return)', new Feeder().feed(`${CSI}13;28;56832;1;0;1_`), [])

// --- 8. decomposed bracketed paste (classic conhost) --------------------------
//
// conhost pastes via TextToKeyEvents: the ESC[200~ / ESC[201~ markers AND
// the body all arrive as per-char win32 records. The matcher must reassemble
// them into a single isPasted event — leaking the markers or dispatching a
// body Return would submit the prompt mid-paste.

/** Build the down+up win32 record pair for one synthesized paste char. */
function pasteRecs(vk: number, uc: number, cs = 0): string {
  return `${CSI}${vk};0;${uc};1;${cs};1_${CSI}${vk};0;${uc};0;${cs};1_`
}
// Marker chars exactly as conhost's Clipboard::TextToKeyEvents emits them:
// pushControlSequence calls SynthesizeKeyEvent(Vk=0, Sc=0, Uc=char, Cs=0)
// for every char of ESC[200~ / ESC[201~ — no Vk, no modifiers, not even
// Shift on '~'.
const P2_OPEN =
  pasteRecs(0, 27) + // ESC
  pasteRecs(0, 91) + // [
  pasteRecs(0, 50) + // 2
  pasteRecs(0, 48) + // 0
  pasteRecs(0, 48) + // 0
  pasteRecs(0, 126) // ~
const P2_CLOSE =
  pasteRecs(0, 27) +
  pasteRecs(0, 91) +
  pasteRecs(0, 50) +
  pasteRecs(0, 48) +
  pasteRecs(0, 49) + // 1
  pasteRecs(0, 126)
// Body chars go through CharToKeyEvents and DO carry real virtual keys.
const P2_BODY = pasteRecs(65, 97) + pasteRecs(13, 13) + pasteRecs(66, 98) // a \n b

function checkPaste(label: string, keys: KeySummary[], expectedSeq: string): void {
  const ok =
    keys.length === 1 &&
    keys[0]!.kind === 'key' &&
    keys[0]!.isPasted === true &&
    keys[0]!.seq === expectedSeq
  if (ok) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label}\n     expected one isPasted event ${JSON.stringify(expectedSeq)}\n     actual   ${JSON.stringify(keys)}`)
  }
}

{
  const f = new Feeder()
  checkPaste('decomposed paste of a\\nb yields one paste event', f.feed(P2_OPEN + P2_BODY + P2_CLOSE), 'a\nb')
}
{
  const f = new Feeder()
  check('marker split across chunks: open prefix holds', f.feed(P2_OPEN.slice(0, P2_OPEN.length / 2)), [])
  checkPaste('marker split across chunks: rest completes the paste', f.feed(P2_OPEN.slice(P2_OPEN.length / 2) + P2_BODY + P2_CLOSE), 'a\nb')
}
{
  const f = new Feeder()
  check('lone Escape record is held, not emitted', f.feed(`${CSI}27;1;27;1;0;1_`), [])
  check('flush releases the held Escape', f.feed(null), [
    wkey('escape', {}, `${CSI}27;1;27;1;0;1_`),
  ])
}
{
  const f = new Feeder()
  f.feed(`${CSI}27;1;27;1;0;1_`) // Escape held as candidate prefix
  check('false marker start releases Escape before the real key', f.feed(`${CSI}88;45;120;1;0;1_`), [
    wkey('escape', {}, `${CSI}27;1;27;1;0;1_`),
    wchar('x'),
  ])
}
{
  // Truncated paste: opener + body, stream goes quiet — the 500ms flush must
  // finalize with what was collected instead of stranding the matcher.
  const f = new Feeder()
  f.feed(P2_OPEN + P2_BODY)
  checkPaste('flush finalizes a truncated paste', f.feed(null), 'a\nb')
  check('matcher is not stranded after the truncated paste', f.feed(`${CSI}88;45;120;1;0;1_`), [
    wchar('x'),
  ])
}
{
  // Supplementary-plane chars in the body: the surrogate pair must survive
  // collection into the paste buffer (name length is 2 in UTF-16).
  const f = new Feeder()
  const emoji = pasteRecs(49, 55357) + pasteRecs(49, 56832) // 😀 down/up pairs
  checkPaste('supplementary-plane char survives the paste buffer', f.feed(P2_OPEN + emoji + P2_CLOSE), '😀')
}

// --- 8b. CRLF folding inside a decomposed paste (#1090) -----------------------
//
// Classic conhost spells a pasted CRLF break as two records: a real
// VK_RETURN CR record (Uc=13) and the synthesized LF record (Uc=10) that
// CharToKeyEvents emits for the '\n' half. Both translate to 'return', so
// without folding the paste gains one blank line per CRLF. The LF half
// arrives Vk=0 from CharToKeyEvents; hosts that promote it keep Uc=10 with
// Vk=13, so both shapes are covered here.

const CR = pasteRecs(13, 13)
const LF_SYNTH = pasteRecs(0, 10)
const LF_VK = pasteRecs(13, 10)
const CRLF = CR + LF_SYNTH

{
  const f = new Feeder()
  checkPaste(
    'decomposed CRLF paste yields one newline',
    f.feed(P2_OPEN + pasteRecs(65, 97) + CRLF + pasteRecs(66, 98) + P2_CLOSE),
    'a\nb',
  )
}
{
  const f = new Feeder()
  const body = pasteRecs(65, 97) + CRLF + pasteRecs(66, 98) + CR + LF_VK + pasteRecs(67, 99)
  checkPaste('multi-line CRLF paste keeps one newline per break', f.feed(P2_OPEN + body + P2_CLOSE), 'a\nb\nc')
}
{
  const f = new Feeder()
  check('CR record ends the chunk with the paste buffer intact', f.feed(P2_OPEN + pasteRecs(65, 97) + CR), [])
  checkPaste('LF in the next chunk folds into the buffered CR', f.feed(LF_SYNTH + pasteRecs(66, 98) + P2_CLOSE), 'a\nb')
}
{
  const f = new Feeder()
  checkPaste(
    'LF-only record without a CR stays one newline',
    f.feed(P2_OPEN + pasteRecs(65, 97) + LF_SYNTH + pasteRecs(66, 98) + P2_CLOSE),
    'a\nb',
  )
}
{
  const f = new Feeder()
  checkPaste('a lone CR record stays one newline', f.feed(P2_OPEN + pasteRecs(65, 97) + CR + pasteRecs(66, 98) + P2_CLOSE), 'a\nb')
}
{
  const f = new Feeder()
  checkPaste(
    'CR followed by ordinary text does not fold',
    f.feed(P2_OPEN + pasteRecs(65, 97) + CR + pasteRecs(95, 95) + pasteRecs(66, 98) + P2_CLOSE),
    'a\n_b',
  )
}
{
  const f = new Feeder()
  checkPaste(
    'CR CR LF folds only the CRLF pair',
    f.feed(P2_OPEN + pasteRecs(65, 97) + CR + CR + LF_SYNTH + pasteRecs(66, 98) + P2_CLOSE),
    'a\n\nb',
  )
}
{
  const f = new Feeder()
  checkPaste(
    'CR LF LF keeps the unpaired second LF',
    f.feed(P2_OPEN + pasteRecs(65, 97) + CR + LF_SYNTH + LF_SYNTH + pasteRecs(66, 98) + P2_CLOSE),
    'a\n\nb',
  )
}
{
  const f = new Feeder()
  checkPaste(
    'ordinary punctuation in a paste body is untouched',
    f.feed(P2_OPEN + pasteRecs(95, 95) + pasteRecs(91, 91) + pasteRecs(93, 93) + P2_CLOSE),
    '_[]',
  )
}


// --- 9. Alt+numpad Unicode input (payload rides on the Alt keyup) -------------
//
// Feature_UseNumpadEventsForClipboardInput: Alt-down, digit records without
// text, then a single Alt-UP whose Uc carries the composed character
// (Microsoft's own test uses U+00BC ¼ for Alt+6+3... here Alt+0188 style).
// Realistic fields: VK_MENU has Sc=56, Alt records carry LEFT_ALT (Cs=2)
// while held, and the digit records pressed during the hold keep the Alt
// state in their Cs.

const ALT_DOWN = `${CSI}18;56;0;1;2;1_`
const ALT_UP = `${CSI}18;56;0;0;0;1_`
const altUpPayload = (uc: number) => `${CSI}18;56;${uc};0;0;1_`
const numpad = (vk: number, sc: number) => `${CSI}${vk};${sc};0;1;2;1_${CSI}${vk};${sc};0;0;2;1_`

{
  const f = new Feeder()
  check('Alt-down is swallowed', f.feed(ALT_DOWN), [])
  check('numpad digit records carry no text', f.feed(`${numpad(102, 49)}${numpad(99, 51)}`), [])
  check('Alt-UP delivers the composed char', f.feed(altUpPayload(188)), [wchar('¼')])
}
{
  // Same stream inside an active paste: the char must land in the buffer.
  const f = new Feeder()
  checkPaste('Alt+numpad char works inside a paste', f.feed(P2_OPEN + ALT_DOWN + altUpPayload(188) + P2_CLOSE), '¼')
}
check('ordinary keyup with Uc is still swallowed (no double input)', new Feeder().feed(`${CSI}65;30;97;0;32;1_`), [])

// Two Alt rounds per supplementary char (WindowsInbox clipboard synthesis
// iterates UTF-16 units): the pending high must survive the second round's
// Alt-down and any payload-free, Alt-held numpad digit records.
{
  const f = new Feeder()
  f.feed(ALT_DOWN) // round 1
  check('Alt-up high surrogate holds', f.feed(altUpPayload(55357)), [])
  check('second Alt-down does not settle the synthesized high', f.feed(ALT_DOWN), [])
  check('Alt-up low surrogate completes the pair', f.feed(altUpPayload(56832)), [wchar('😀')])
}
{
  const f = new Feeder()
  const stream =
    ALT_DOWN +
    numpad(102, 49) + // numpad 6 down/up (Alt held, no payload)
    altUpPayload(55357) + // Alt-up: high half
    ALT_DOWN + // round 2
    numpad(99, 51) + // numpad 3 down/up
    altUpPayload(56832) // Alt-up: low half
  check('two Alt rounds with interleaved numpad records yield the emoji', f.feed(stream), [wchar('😀')])
}
{
  // Same two-round stream inside an active paste.
  const f = new Feeder()
  const stream = ALT_DOWN + altUpPayload(55357) + ALT_DOWN + altUpPayload(56832)
  checkPaste('two-round Alt surrogate works inside a paste', f.feed(P2_OPEN + stream + P2_CLOSE), '😀')
}
{
  const f = new Feeder()
  f.feed(altUpPayload(55357)) // synthesized high pending
  check('unrelated input settles the synthesized high', f.feed(`${CSI}88;45;120;1;0;1_`), [wchar('x')])
  check('the orphaned synthesized low half is then dropped', f.feed(altUpPayload(56832)), [])
}

// The pending synthesized high must NOT bridge across input that is not
// part of the synthesis stream: real Shift/Ctrl transitions and numpad
// digits pressed without Alt all settle it.
for (const [label, bridge] of [
  ['Shift down/up', `${CSI}16;42;0;1;48;1_${CSI}16;42;0;0;32;1_`],
  ['Ctrl down/up', `${CSI}17;29;0;1;40;1_${CSI}17;29;0;0;32;1_`],
  ['numpad digit without Alt', `${CSI}102;49;0;1;32;1_${CSI}102;49;0;0;32;1_`],
] as const) {
  const f = new Feeder()
  f.feed(altUpPayload(55357)) // synthesized high pending
  f.feed(bridge)
  check(`no surrogate bridge across ${label}`, f.feed(altUpPayload(56832)), [])
}

// --- 10. record framing across the escape timer (#827) -----------------------
// Drive the parser from an explicit starting state. `null` stands for App's
// escape timer, and `text` is what the draft would receive — collected through
// InputEvent exactly as prompt-input consumes it, with no wall-clock sleeps.
function drive(start: KeyParseState, chunks: Array<string | null>): {
  keys: ParsedInput[]
  state: KeyParseState
  text: string
} {
  let state = start
  const keys: ParsedInput[] = []
  for (const chunk of chunks) {
    const [out, next] = parseMultipleKeypresses(state, chunk)
    state = next
    keys.push(...out)
  }
  return {
    keys,
    state,
    text: keys.flatMap(key => key.kind === 'key' ? new InputEvent(key).input : []).join(''),
  }
}

// `enabled` seeds the evidence bit (`win32InputMode`, lit by decoding a
// record); `capable` seeds the host gate App injects (T02). Leaving `capable`
// absent keeps the pre-gate meaning — the parser treats a missing gate as
// open — so every existing call site above/below is untouched.
function fragments(chunks: Array<string | null>, enabled = true, capable?: boolean) {
  const seed: KeyParseState = { ...INITIAL_STATE, win32InputMode: enabled }
  if (capable !== undefined) seed.win32Capable = capable
  return drive(seed, chunks)
}

const SHIFT_RECORD = `${CSI}16;42;0;1;16;1_`
const A_RECORD = `${CSI}65;30;97;1;0;1_`
const CJK_RECORD = `${CSI}0;0;22269;1;0;1_`
for (const record of [
  SHIFT_RECORD, A_RECORD, CJK_RECORD, `${CSI}65;30;97;0;0;1_`,
  `${CSI}13;28;13;1;16;1_`, `${CSI}88;45;120;1;0;3_`,
  `${CSI}189;12;95;1;16;1_`, `${CSI};;97;1_`,
]) {
  const expected = fragments([record])
  for (let split = 1; split < record.length; split++) {
    const actual = fragments([record.slice(0, split), null, null, record.slice(split)])
    // A raw lone ESC still releases promptly. Its continuation can recover
    // text, but cannot undo an already dispatched Escape event.
    const keys = split === 1 ? actual.keys.slice(1) : actual.keys
    check(`flush split ${split}/${record.length}: ${JSON.stringify(record)}`,
      summarize(keys), summarize(expected.keys))
    checkBoolean('InputEvent text matches intact record', actual.text === expected.text, true)
  }
}
checkBoolean('reported Shift prefix is protected without an explicit mode flag',
  fragments([SHIFT_RECORD.slice(0, -1), null, '_'], false).keys.length === 0, true)
checkBoolean('record framing does not mutate INITIAL_STATE',
  INITIAL_STATE.win32InputMode === undefined && INITIAL_STATE.win32InputStartedAt === undefined, true)
checkBoolean('complete record enables framing for subsequent early splits',
  fragments([SHIFT_RECORD, `${CSI}6`, null, '5;30;97;1;0;1_'], false).text === 'a', true)
checkBoolean('recovered complete tail also enables subsequent framing',
  fragments([SHIFT_RECORD.slice(1), `${CSI}6`, null, '5;30;97;1;0;1_'], false).text === 'a', true)

{
  const tail = CJK_RECORD.slice(1)
  const result = fragments(['\x1b', null, ...[...tail].flatMap(ch => [ch, null])])
  checkBoolean('ESC-less tail may fragment at every byte, across repeated flushes', result.text === '国', true)
}
checkBoolean('recovered tail preserves batched ordinary suffix and following record',
  fragments(['\x1b', null, '[65;30;', null, '97;1;0;1__suffix' + CJK_RECORD]).text === 'a_suffix国', true)
checkBoolean('fresh ESC discards an abandoned record before the next record',
  fragments([SHIFT_RECORD.slice(0, -1), null, A_RECORD]).text === 'a', true)
checkBoolean('fresh ESC after numeric continuation discards the old record',
  fragments([`${CSI}16;`, null, '42;0;' + A_RECORD]).text === 'a', true)
checkBoolean('ordinary Win32 typing abandons a held record without eating text',
  fragments([SHIFT_RECORD.slice(0, -1), null,
    [...'hello_'].map(ch => `${CSI}231;0;${ch.charCodeAt(0)};1;0;1_`).join(''),
  ]).text === 'hello_', true)
checkBoolean('a non-CSI continuation abandons the record without eating Unicode text',
  fragments([SHIFT_RECORD.slice(0, -1), null, '你好_']).text === '你好_', true)

// A raw 'h' after a numeric CSI prefix is a valid final byte, even if the
// sender intended "abandoned record + hello_". The byte stream cannot tell
// those apart. Preserve the CSI as one protocol event, suppress its input,
// and keep the suffix; never guess differently based on read boundaries.
for (const chunks of [
  [SHIFT_RECORD.slice(0, -1) + 'hello_'],
  [SHIFT_RECORD.slice(0, -1), 'hello_'],
  [SHIFT_RECORD.slice(0, -1), null, 'h', 'ello_'],
]) {
  const result = fragments(chunks)
  const protocol = result.keys[0]
  checkBoolean('ambiguous CSI final stays attached to its prefix',
    protocol?.kind === 'key' && protocol.sequence === SHIFT_RECORD.slice(0, -1) + 'h', true)
  checkBoolean('unknown CSI contributes no protocol text; suffix survives', result.text === 'ello_', true)
}

// The review's four-parameter prefix is also a legal incomplete Win32
// record. A non-underscore final must resolve it as CSI, not a typed letter.
for (const sequence of [
  '\x1b[1;2;3;1A', '\x1b[1;2;3;1h', '\x1b[1;2;3;1u',
  '\x1b[1;2;3;1~', '\x1b[1;2;3;1$y', '\x1b[1;2;3;1:2A',
]) {
  for (const enabled of [false, true]) {
    const intact = fragments([sequence], enabled)
    const protocol = intact.keys[0]
    checkBoolean('unknown CSI retains its complete sequence and protocol code',
      intact.keys.length === 1 && protocol?.kind === 'key' &&
      protocol.sequence === sequence && protocol.code === sequence.slice(1), true)
    checkBoolean(`unknown CSI is not editable text: ${JSON.stringify(sequence)}`, intact.text === '', true)
    for (let split = 1; split < sequence.length; split++) {
      const actual = fragments([sequence.slice(0, split), sequence.slice(split)], enabled)
      checkBoolean(`CSI event is chunk invariant (mode=${enabled}, split=${split})`,
        JSON.stringify(actual.keys) === JSON.stringify(intact.keys), true)
    }
    const prefix = '\x1b[1;2;3;1'
    const flushed = fragments([prefix, null, sequence.slice(prefix.length)], enabled)
    checkBoolean(`CSI final after flush keeps the original event (mode=${enabled})`,
      JSON.stringify(flushed.keys) === JSON.stringify(intact.keys) && flushed.text === '', true)
  }
  checkPaste('unknown CSI inside bracketed paste stays literal',
    summarize(fragments(['\x1b[200~', sequence, '\x1b[201~']).keys), sequence)
}

for (const sequence of [
  '\x1b[1;2A', '\x1b[13;2u', '\x1b[27;2;13~', '\x1b[6;20;10t',
  '\x1b[25~', '\x1b[57358u', '\x1b[27;2;57358~',
  '\x1b[<0;2;3M', '\x1b[M !!', '\x1b[?1;0c',
]) {
  for (const split of [2, sequence.length - 1]) {
    // For non-numeric protocols only the shared ESC[ prefix uses the
    // Win32 grace; their own mid-report timeouts retain existing behavior.
    const chunks: Array<string | null> = [sequence.slice(0, split), sequence.slice(split)]
    if (split === 2 || /^\x1b\[[\d;]*$/.test(chunks[0]!)) chunks.splice(1, 0, null)
    const actual = fragments(chunks)
    const expected = fragments([sequence])
    check(`non-Win32 CSI survives split ${split}: ${JSON.stringify(sequence)}`,
      summarize(actual.keys), summarize(expected.keys))
    checkBoolean('non-Win32 InputEvent text is unchanged', actual.text === expected.text, true)
  }
}
for (const text of ['_', '[', '[123', '[1;2', 'hello_']) {
  checkBoolean(`ordinary text stays literal: ${JSON.stringify(text)}`,
    fragments([text, null]).text === text, true)
}
checkBoolean('non-Win32 Escape then bracket text remains literal',
  fragments(['\x1b', null, '[123', null], false).text === '[123', true)
checkBoolean('unrelated input clears orphan ESC provenance',
  fragments(['\x1b', null, 'x', '[123', null]).text === 'x[123', true)
checkBoolean('bracketed paste preserves protocol-shaped literal text',
  fragments(['\x1b[200~', SHIFT_RECORD.slice(0, -1), '_', '\x1b[201~']).text === SHIFT_RECORD.slice(1), true)
checkBoolean('paste opener and record-shaped payload in one read do not start a record deadline',
  fragments(['\x1b[200~' + SHIFT_RECORD.slice(0, -1)]).state.win32InputStartedAt === undefined, true)
checkBoolean('a literal pasted ESC flush is not orphan keyboard ESC provenance',
  fragments(['\x1b[200~\x1b', null, '[123', null]).text === '[123', true)
{
  const surrogateRecords = [
    `${CSI}49;2;55357;1;0;1_`, `${CSI}49;2;55357;0;0;1_`, `${CSI}49;2;56832;1;0;1_`,
  ]
  checkBoolean('UTF-16 surrogate state survives record-internal flushes and keyup',
    fragments(surrogateRecords.flatMap(record => [record.slice(0, -1), null, '_'])).text === '😀', true)
}

{
  // Every record of a decomposed paste is itself split before its final
  // byte. A record-grace flush must not prematurely finalize the paste or
  // release a held start/end marker as real keyboard events.
  const records = (P2_OPEN + P2_BODY + P2_CLOSE).match(/\x1b\[[\d;]*_/g)!
  const chunks = records.flatMap(record => [record.slice(0, -1), null, null, '_'])
  checkPaste('decomposed paste survives record-internal flushes', summarize(fragments(chunks).keys), 'a\nb')
}
for (const protocol of ['\x1b[<0;32;5M', '\x1b[?1;0c']) {
  const encoded = [...protocol].map(ch => pasteRecs(0, ch.charCodeAt(0))).join('')
  const records = encoded.match(/\x1b\[[\d;]*_/g)!
  const actual = fragments(records.flatMap(record => [record.slice(0, -1), null, '_']))
  checkBoolean(`synthesized protocol survives record-internal flushes: ${JSON.stringify(protocol)}`,
    JSON.stringify(actual.keys) === JSON.stringify(fragments([encoded]).keys), true)
}
{
  const originalNow = Date.now
  let now = 10000
  Date.now = () => now
  try {
    let [, state] = parseMultipleKeypresses({ ...INITIAL_STATE, win32InputMode: true }, `${CSI}65;`)
    const startedAt = state.win32InputStartedAt
    for (const chunk of [null, '30;', null, '97;1;0;1', null]) {
      now += 150
      const [keys, next] = parseMultipleKeypresses(state, chunk)
      state = next
      check('quiet flushes and fragments do not release a partial record', summarize(keys), [])
      checkBoolean('continuations do not renew the record deadline', state.win32InputStartedAt === startedAt, true)
    }
    now = 11000
    const [expired, next] = parseMultipleKeypresses(state, null)
    check('expired record is discarded, not dispatched', summarize(expired), [])
    checkBoolean('expiry clears the buffer and timer sentinel', next.incomplete === '', true)
    check('ordinary underscore after expiry is not swallowed',
      summarize(parseMultipleKeypresses(next, '_')[0]), summarize(fragments(['_']).keys))

    // Expiry is also checked on input, not only on quiet flushes.
    now = 20000
    ;[, state] = parseMultipleKeypresses({ ...INITIAL_STATE, win32InputMode: true }, `${CSI}65;`)
    now = 21000
    const [typed] = parseMultipleKeypresses(state, '123')
    check('continuous input cannot keep an expired hold alive', summarize(typed), summarize(fragments(['123']).keys))

    now = 30000
    ;[, state] = parseMultipleKeypresses({ ...INITIAL_STATE, win32InputMode: true }, `${CSI}65;`)
    now = 30900
    ;[, state] = parseMultipleKeypresses(state, '30;97;1;0;1_' + `${CSI}16;`)
    now = 31100
    const [flushed, refreshed] = parseMultipleKeypresses(state, null)
    check('a new record in the same read gets its own deadline', summarize(flushed), [])
    checkBoolean('the new prefix remains buffered', refreshed.incomplete === `${CSI}16;`, true)

    now = 40000
    ;[, state] = parseMultipleKeypresses({ ...INITIAL_STATE, win32InputMode: true }, '\x1b')
    ;[, state] = parseMultipleKeypresses(state, null)
    now = 41000
    const [literal] = parseMultipleKeypresses(state, '[123')
    check('expired orphan ESC does not capture later bracket text', summarize(literal), summarize(fragments(['[123']).keys))
  } finally {
    Date.now = originalNow
  }
}
checkBoolean('oversized incomplete record has bounded storage',
  fragments([`${CSI}${'1'.repeat(80)}`, null]).state.incomplete === '', true)

// --- 11. capability gate without decoded evidence (AC-4) ---------------------
// App must hand the parser `win32Capable` — a gate — and never a lit evidence
// bit. These cases seed the parser exactly the way App does (a fresh instance,
// so a revert to "the platform capability lights the mode" fails right here on
// native Windows), and compare against the closed-gate control: an unlit
// capable host has to be indistinguishable from classic VT input.
const appStart = (): KeyParseState => new App({} as never).keyParseState
checkBoolean('AC-4 App injects the gate and never lights the parser by itself',
  appStart().win32InputMode !== true && appStart().win32Capable === supportsWin32InputMode(), true)

for (const chunks of [
  ['\x1b', null],               // a lone Escape releases on the flush
  [CSI, null],                  // a bare CSI introducer must not start a hold
  [CSI, null, 'a'],             // ...nor eat the next letter as its final byte
  ['\x1b', null, '[123'],       // '['-led literal text stays literal
  ['\x1b', null, '[1;2;3'],     // ...as do record-like but non-body shapes
  ['\x1b', null, '[1,2'],
] as Array<Array<string | null>>) {
  const gated = drive(appStart(), chunks)
  const closed = fragments(chunks, false, false)
  const label = JSON.stringify(chunks)
  check(`AC-4 unlit capable host mirrors the classic path: ${label}`,
    summarize(gated.keys), summarize(closed.keys))
  checkBoolean(`AC-4 unlit capable host types the same text: ${label}`, gated.text === closed.text, true)
}

{
  const bare = drive(appStart(), [CSI, null])
  checkBoolean('AC-4 a bare CSI introducer arms no hold on an unlit capable host',
    bare.state.win32InputStartedAt === undefined, true)
  checkBoolean('AC-4 a lone Escape is still released by the flush',
    drive(appStart(), ['\x1b', null]).keys.length === 1, true)
  checkBoolean('AC-4 a flushed introducer cannot eat the letter after it',
    drive(appStart(), [CSI, null, 'a']).text === '[a', true)
  // An explicit `false` is authoritative even for an already-lit parser.
  const closedGate = fragments([`${CSI}16;`, null], true, false)
  checkBoolean('AC-4 an explicitly closed gate releases a non-body frame even when lit',
    closedGate.state.win32InputStartedAt === undefined && closedGate.text === '[16;', true)
  // Callers predating the gate keep the pre-T02 hold (missing == open).
  const legacy = fragments([CSI, null], true)
  checkBoolean('AC-4 callers that inject no gate keep the pre-gate hold',
    legacy.keys.length === 0 && legacy.state.win32InputStartedAt !== undefined, true)
  // ADR-0003 Consequences keeps this ambiguity on purpose: a body-shaped
  // literal is indistinguishable from a record prefix inside the ESC window.
  // Pinned so the documented trade-off cannot drift away unnoticed.
  const residual = drive(appStart(), ['\x1b', null, '[1;2;3;1'])
  checkBoolean('AC-4 documented residual: a body-shaped literal inside the ESC window is still captured',
    residual.keys.length === 1 && residual.text === '' && residual.state.win32InputStartedAt !== undefined, true)
}

// --- 12. AC-1: a half record never reaches the draft ------------------------
for (const enabled of [false, true]) {
  const half = fragments([`${CSI}16;42;0;1;16;1`, null, '_'], enabled, true)
  check(`AC-1 half record + flush + late '_' dispatches no key (lit=${enabled})`,
    summarize(half.keys), [])
  checkBoolean(`AC-1 InputEvent.input stays empty (lit=${enabled})`, half.text === '', true)
}

// --- 13. AC-2: every split position x 0..2 flushes --------------------------
// One flush is App's 50ms escape timer, two model the re-armed timer.
const interleave = (head: string, tail: string, flushes: number): Array<string | null> =>
  [head, ...Array<string | null>(flushes).fill(null), tail]
// Smallest split whose head the parser holds across a quiet flush: the first
// body-shaped prefix, i.e. where D2/ADR-0003 starts guaranteeing recovery.
const heldFrom = (record: string): number => {
  for (let split = 2; split <= record.length; split++) {
    if (fragments([record.slice(0, split), null], false, true).keys.length === 0) return split
  }
  return record.length
}
for (const record of [`${CSI}88;45;120;1;32;1_`, CJK_RECORD]) {
  const intact = fragments([record])
  const boundary = heldFrom(record)
  checkBoolean(`AC-2 unlit hold boundary lies inside the frame: ${JSON.stringify(record)}`,
    boundary > 1 && boundary < record.length, true)
  for (let split = 1; split < record.length; split++) {
    for (const flushes of [0, 1, 2]) {
      const actual = fragments(interleave(record.slice(0, split), record.slice(split), flushes))
      // A split that isolates a raw lone ESC still releases an Escape event
      // before the tail is re-attached, and that cannot be undone.
      const keys = split === 1 && flushes > 0 ? actual.keys.slice(1) : actual.keys
      check(`AC-2 lit split ${split}/${record.length} flush=${flushes}: ${JSON.stringify(record)}`,
        summarize(keys), summarize(intact.keys))
    }
  }
  for (const split of [1, boundary, boundary + 2, record.length - 2, record.length - 1]) {
    for (const flushes of [0, 1, 2]) {
      const actual = fragments(interleave(record.slice(0, split), record.slice(split), flushes), false, true)
      const keys = split === 1 && flushes > 0 ? actual.keys.slice(1) : actual.keys
      check(`AC-2 unlit split ${split}/${record.length} flush=${flushes}: ${JSON.stringify(record)}`,
        summarize(keys), summarize(intact.keys))
    }
  }
  // The tail may fragment further still: '...;' + '1' + '_'.
  for (const enabled of [false, true]) {
    for (const count of [0, 1, 2]) {
      const gap = Array<string | null>(count).fill(null)
      const actual = fragments([record.slice(0, -2), ...gap, '1', ...gap, '_'], enabled, true)
      check(`AC-2 tail re-split lit=${enabled} flush=${count}: ${JSON.stringify(record)}`,
        summarize(actual.keys), summarize(intact.keys))
    }
  }
}

// --- 14. AC-5: a complete but unknown CSI never reaches editable text -------
for (const sequence of [`${CSI}1;2;3;1A`, `${CSI}1;2;3;1$y`]) {
  const intact = fragments([sequence], false, true)
  const protocol = intact.keys[0]
  checkBoolean(`AC-5 unknown CSI keeps its identity: ${JSON.stringify(sequence)}`,
    intact.keys.length === 1 && protocol?.kind === 'key' &&
    protocol.sequence === sequence && protocol.code === sequence.slice(1), true)
  // Only a record-shaped (numeric) head survives a quiet flush; an
  // intermediate byte such as `$` is released as classic input, so that tail
  // has to arrive alone.
  const head = sequence.replace(/[^\d;]+$/, '')
  for (const chunks of [
    ...Array.from({ length: sequence.length - 1 }, (_, i) => [sequence.slice(0, i + 1), sequence.slice(i + 1)]),
    [head, null, sequence.slice(head.length)],
    [head, null, null, sequence.slice(head.length)],
  ] as Array<Array<string | null>>) {
    const actual = fragments(chunks, false, true)
    checkBoolean(`AC-5 parameter bytes and final stay out of the draft: ${JSON.stringify(chunks)}`,
      actual.text === '' && JSON.stringify(actual.keys) === JSON.stringify(intact.keys), true)
  }
}

// --- 15. AC-5 bounds: an abandoned hold must never strand later input -------
{
  // Past WIN32_INPUT_MAX_LENGTH (64) and still body-shaped, so the frame is
  // genuinely held until the bound releases it.
  const overlong = `${CSI}65;30;97;1;${'1'.repeat(60)}`
  const bounded = fragments([overlong, null, 'ok'], false, true)
  checkBoolean(`AC-5 a ${overlong.length}-byte held frame is discarded, not stranded`,
    bounded.state.win32InputStartedAt === undefined && bounded.state.incomplete === '', true)
  checkBoolean('AC-5 typing after the discard still reaches the draft', bounded.text.endsWith('ok'), true)
  const prefixOnly = fragments([`${CSI}${'1'.repeat(65)}`, null, 'ok'], false, true)
  checkBoolean('AC-5 a non-body prefix past the limit leaves nothing held either',
    prefixOnly.state.win32InputStartedAt === undefined && prefixOnly.state.incomplete === '', true)
  checkBoolean('AC-5 ...and typing after it is not swallowed', prefixOnly.text.endsWith('ok'), true)
}
{
  // The 1s grace (D3) bounds an unlit capable host's hold the same way.
  const originalNow = Date.now
  let now = 60000
  Date.now = () => now
  try {
    let state: KeyParseState = { ...INITIAL_STATE, win32Capable: true, win32InputMode: false }
    ;[, state] = parseMultipleKeypresses(state, `${CSI}65;30;97;1;`)
    checkBoolean('AC-5 an unlit capable host does hold a body-shaped frame',
      state.win32InputStartedAt !== undefined, true)
    now += 1000
    const [expired, next] = parseMultipleKeypresses(state, null)
    check('AC-5 the frame is discarded at the grace deadline', summarize(expired), [])
    checkBoolean('AC-5 expiry clears the hold sentinel', next.win32InputStartedAt === undefined, true)
    check('AC-5 ordinary typing after expiry is not swallowed',
      summarize(parseMultipleKeypresses(next, '_')[0]), summarize(fragments(['_']).keys))
  } finally {
    Date.now = originalNow
  }
}

// --- 16. VK_PACKET (231) records carry their character in Uc (T-FIX-02) ------
//
// VK_PACKET means "the character is in Uc" (SendInput / keybd_event Unicode
// injection; Windows Terminal re-encodes a paste this way under
// win32-input-mode). Printable Uc already reached text input through the
// Uc-wins-over-Vk path, but the CONTROL characters a pasted break is spelled
// with fell through to the swallow at the end of parseWin32KeyEvent: every
// break record vanished, so a decomposed paste assembled without newlines
// (user report: a 10-line / 760-char paste folded to `1 line・751 chars`).
// These assertions put VK_PACKET on the same "character rides in Uc" lane the
// Vk=0 synthesized records already use — and keep Uc=0 swallowed.

const packetRec = (uc: number): string => pasteRecs(231, uc)

check('VK_PACKET CR (Uc=13) is a Return, not a swallowed record', new Feeder().feed(`${CSI}231;0;13;1;0;1_`), [
  wkey('return', {}, `${CSI}231;0;13;1;0;1_`),
])
check('VK_PACKET LF (Uc=10) is a Return too', new Feeder().feed(`${CSI}231;0;10;1;0;1_`), [
  wkey('return', {}, `${CSI}231;0;10;1;0;1_`),
])
check('VK_PACKET Tab (Uc=9) is a Tab', new Feeder().feed(`${CSI}231;0;9;1;0;1_`), [
  wkey('tab', {}, `${CSI}231;0;9;1;0;1_`),
])
check('VK_PACKET Backspace (Uc=8) is a Backspace', new Feeder().feed(`${CSI}231;0;8;1;0;1_`), [
  wkey('backspace', {}, `${CSI}231;0;8;1;0;1_`),
])
check('VK_PACKET DEL (Uc=127) is a Backspace', new Feeder().feed(`${CSI}231;0;127;1;0;1_`), [
  wkey('backspace', {}, `${CSI}231;0;127;1;0;1_`),
])
check('VK_PACKET Escape (Uc=27) is held as a candidate sequence prefix', new Feeder().feed(`${CSI}231;0;27;1;0;1_`), [])
{
  // …and released on the flush exactly like a real VK_ESCAPE record (the
  // escape timer holds any translated Escape, not just the named-key one).
  const f = new Feeder()
  f.feed(`${CSI}231;0;27;1;0;1_`)
  check('VK_PACKET Escape flushes as an Escape', f.feed(null), [
    wkey('escape', {}, `${CSI}231;0;27;1;0;1_`),
  ])
}
check('VK_PACKET with Uc=0 carries no payload and stays swallowed', new Feeder().feed(`${CSI}231;0;0;1;0;1_`), [])

{
  // A decomposed paste spelled with VK_PACKET records: V10/V17's break lane
  // (CR record + LF record) must fold to ONE newline, exactly like the Vk=0
  // synthesized lane above (#1090).
  const f = new Feeder()
  const body = packetRec(97) + packetRec(13) + packetRec(10) + packetRec(98)
  checkPaste('decomposed paste with VK_PACKET CR+LF breaks yields one newline', f.feed(P2_OPEN + body + P2_CLOSE), 'a\nb')
}
{
  // V11's break lane: the CR record alone.
  const f = new Feeder()
  const body = packetRec(97) + packetRec(13) + packetRec(98)
  checkPaste('decomposed paste with a lone VK_PACKET CR break yields one newline', f.feed(P2_OPEN + body + P2_CLOSE), 'a\nb')
}
{
  // The zero-information record must stay swallowed — a paste may not gain a
  // newline from a Uc=0 VK_PACKET record (issue #1251 UAT's V9 shape).
  const f = new Feeder()
  const body = packetRec(97) + packetRec(0) + packetRec(98)
  checkPaste('a Uc=0 VK_PACKET record adds no character inside a paste', f.feed(P2_OPEN + body + P2_CLOSE), 'ab')
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall win32-input-mode assertions passed')
