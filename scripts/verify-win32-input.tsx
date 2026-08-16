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
  // INITIAL_STATE is a shared singleton (App.tsx seeds the parser with it) —
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

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall win32-input-mode assertions passed')
