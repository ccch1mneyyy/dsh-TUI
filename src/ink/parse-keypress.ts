/**
 * Keyboard input parser - converts terminal input to key events
 *
 * Uses the termio tokenizer for escape sequence boundary detection,
 * then interprets sequences as keypresses.
 */
import { Buffer } from 'buffer'
import { PASTE_END, PASTE_START } from './termio/csi.js'
import { createTokenizer, type Tokenizer } from './termio/tokenize.js'

// eslint-disable-next-line no-control-regex
const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/

// eslint-disable-next-line no-control-regex
const FN_KEY_RE =
  // eslint-disable-next-line no-control-regex
  /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/

// CSI u (kitty keyboard protocol): ESC [ codepoint [; modifier] u
// Example: ESC[13;2u = Shift+Enter, ESC[27u = Escape (no modifiers)
// Modifier is optional - when absent, defaults to 1 (no modifiers)
// eslint-disable-next-line no-control-regex
const CSI_U_RE = /^\x1b\[(\d+)(?:;(\d+))?u/

// xterm modifyOtherKeys: ESC [ 27 ; modifier ; keycode ~
// Example: ESC[27;2;13~ = Shift+Enter. Emitted by Ghostty/tmux/xterm when
// modifyOtherKeys=2 is active or via user keybinds, typically over SSH where
// TERM sniffing misses Ghostty and we never push Kitty keyboard mode.
// Note param order is reversed vs CSI u (modifier first, keycode second).
// eslint-disable-next-line no-control-regex
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/

// win32-input-mode (ConPTY, DECSET 9001): CSI Vk;Sc;Uc;Kd;Cs;Rc _
// One record per key event, carrying the full INPUT_RECORD state:
//   Vk = virtual-key code (VK_RETURN=13, VK_ESCAPE=27, VK_UP=38, ...)
//   Sc = scan code (unused — Vk+Uc fully determine the key)
//   Uc = UTF-16 code unit of the produced character (0 for non-printing)
//   Kd = keydown(1)/keyup(0)
//   Cs = dwControlKeyState (0x01/0x02 Alt, 0x04/0x08 Ctrl, 0x10 Shift;
//        also NUMLOCK 0x20 / CAPSLOCK 0x80 / ENHANCED 0x100 — mask before
//        testing modifiers)
//   Rc = repeat count
// All six fields are optional per spec #4999 and take their KEY_EVENT_RECORD
// defaults (Vk/Sc/Uc/Kd/Cs=0, Rc=1) when omitted or empty — a reduced 'a'
// keydown is legitimately `CSI 65;30;97;1_`. This is the only encoding that
// preserves Enter's Shift/Ctrl bits on Windows (issue #147). Enabled on
// win32 instead of kitty/modifyOtherKeys.
// eslint-disable-next-line no-control-regex
const WIN32_INPUT_RE = /^\x1b\[([\d;]*)_$/
const WIN32_INPUT_TAIL_RE = /\[\d*;\d*;\d*;[01](?:;\d*){0,2}_/g
const WIN32_INPUT_TAILS_RE = /^(?:\[\d*;\d*;\d*;[01](?:;\d*){0,2}_)+$/

// Prefix of a fragmenting SGR mouse report (`[<btn;col;rowM/m`). ConPTY can
// split one report across multiple stdin reads; when App's 50ms escape timer
// fires between the fragments, the pieces stop being part of one buffered
// sequence and would leak into the prompt as visible `[<0;32;5M` garbage
// (the orphan-tail branch below only matches COMPLETE tails). A prefix that
// matches this regex (and is not plain `[`-typed text — see the hold logic)
// is mouse-protocol-shaped and safe to hold for the 50ms grace window.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_PREFIX_RE = /^\[<\d+(?:;\d*){0,2}$/
// Complete SGR tail exactly as the orphan branch expects it.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_TAIL_RE = /^\[<\d+;\d+;\d+[Mm]$/

// dwControlKeyState modifier bits (others — NUMLOCK_ON 0x20, CAPSLOCK_ON
// 0x80, ENHANCED_KEY 0x100 — are state indicators, not pressed modifiers)
const WIN32_CS_ALT = 0x01 | 0x02
const WIN32_CS_CTRL = 0x04 | 0x08
const WIN32_CS_SHIFT = 0x10

// Virtual-key codes that produce no input event of their own: the bare
// modifier keys. Their pressed state rides on the NEXT real key's Cs field,
// so both their keydown and keyup records are dropped.
const WIN32_VK_MODIFIER = new Set([16, 17, 18]) // VK_SHIFT, VK_CONTROL, VK_MENU

// Virtual-key code → key name for non-printing keys. Names match the
// keyName vocabulary below so input-event's nonAlphanumericKeys filter
// clears their raw sequence from text input. Printable keys are NOT here —
// they map through Uc (or Vk for Ctrl+letter, whose Uc is a control code).
const WIN32_VK_NAMES: Record<number, string> = {
  8: 'backspace', // VK_BACK
  9: 'tab', // VK_TAB
  13: 'return', // VK_RETURN
  27: 'escape', // VK_ESCAPE
  32: 'space', // VK_SPACE
  33: 'pageup', // VK_PRIOR
  34: 'pagedown', // VK_NEXT
  35: 'end', // VK_END
  36: 'home', // VK_HOME
  37: 'left', // VK_LEFT
  38: 'up', // VK_UP
  39: 'right', // VK_RIGHT
  40: 'down', // VK_DOWN
  45: 'insert', // VK_INSERT
  46: 'delete', // VK_DELETE
}
// VK_F1 (112) .. VK_F12 (123)
for (let i = 0; i < 12; i++) WIN32_VK_NAMES[112 + i] = `f${i + 1}`

// OEM punctuation virtual-key codes → base character, used to recover
// Ctrl+<punctuation> combos (Ctrl+] etc.) whose Uc collapses to a control
// code. US-layout values; other layouts differ, but these combos are
// rare enough that a best-effort base key beats swallowing the event.
const WIN32_VK_OEM_CHARS: Record<number, string> = {
  186: ';', // VK_OEM_1
  187: '=', // VK_OEM_PLUS
  188: ',', // VK_OEM_COMMA
  189: '-', // VK_OEM_MINUS
  190: '.', // VK_OEM_PERIOD
  191: '/', // VK_OEM_2
  192: '`', // VK_OEM_3
  219: '[', // VK_OEM_4
  220: '\\', // VK_OEM_5
  221: ']', // VK_OEM_6
  222: "'", // VK_OEM_7
  226: '\\', // VK_OEM_102
}

// -- Terminal response patterns (inbound sequences from the terminal itself) --
// DECRPM: CSI ? Ps ; Pm $ y  — response to DECRQM (request mode)
// eslint-disable-next-line no-control-regex
const DECRPM_RE = /^\x1b\[\?(\d+);(\d+)\$y$/
// DA1: CSI ? Ps ; ... c  — primary device attributes response
// eslint-disable-next-line no-control-regex
const DA1_RE = /^\x1b\[\?([\d;]*)c$/
// DA2: CSI > Ps ; ... c  — secondary device attributes response
// eslint-disable-next-line no-control-regex
const DA2_RE = /^\x1b\[>([\d;]*)c$/
// Kitty keyboard flags: CSI ? flags u  — response to CSI ? u query
// (private ? marker distinguishes from CSI u key events)
// eslint-disable-next-line no-control-regex
const KITTY_FLAGS_RE = /^\x1b\[\?(\d+)u$/
// DECXCPR cursor position: CSI ? row ; col R
// The ? marker disambiguates from modified F3 keys (Shift+F3 = CSI 1;2 R,
// Ctrl+F3 = CSI 1;5 R, etc.) — plain CSI row;col R is genuinely ambiguous.
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_RE = /^\x1b\[\?(\d+);(\d+)R$/
// OSC response: OSC code ; data (BEL|ST)
// eslint-disable-next-line no-control-regex
const OSC_RESPONSE_RE = /^\x1b\](\d+);(.*?)(?:\x07|\x1b\\)$/s
// XTVERSION: DCS > | name ST  — terminal name/version string (answer to CSI > 0 q).
// xterm.js replies "xterm.js(X.Y.Z)"; Ghostty, kitty, iTerm2, etc. reply with
// their own name. Unlike TERM_PROGRAM, this survives SSH since the query/reply
// goes through the pty, not the environment.
// eslint-disable-next-line no-control-regex
const XTVERSION_RE = /^\x1bP>\|(.*?)(?:\x07|\x1b\\)$/s
// SGR mouse event: CSI < button ; col ; row M (press) or m (release)
// Button codes: 64=wheel-up, 65=wheel-down (0x40 | wheel-bit).
// Button 32=left-drag (0x20 | motion-bit). Plain 0/1/2 = left/mid/right click.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/

function createPasteKey(content: string): ParsedKey {
  return {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: content,
    raw: content,
    isPasted: true,
  }
}

/** DECRPM status values (response to DECRQM) */
export const DECRPM_STATUS = {
  NOT_RECOGNIZED: 0,
  SET: 1,
  RESET: 2,
  PERMANENTLY_SET: 3,
  PERMANENTLY_RESET: 4,
} as const

/**
 * A response sequence received from the terminal (not a keypress).
 * Emitted in answer to queries like DECRQM, DA1, OSC 11, etc.
 */
export type TerminalResponse =
  /** DECRPM: answer to DECRQM (request DEC private mode status) */
  | { type: 'decrpm'; mode: number; status: number }
  /** DA1: primary device attributes (used as a universal sentinel) */
  | { type: 'da1'; params: number[] }
  /** DA2: secondary device attributes (terminal version info) */
  | { type: 'da2'; params: number[] }
  /** Kitty keyboard protocol: current flags (answer to CSI ? u) */
  | { type: 'kittyKeyboard'; flags: number }
  /** DSR: cursor position report (answer to CSI 6 n) */
  | { type: 'cursorPosition'; row: number; col: number }
  /** OSC response: generic operating-system-command reply (e.g. OSC 11 bg color) */
  | { type: 'osc'; code: number; data: string }
  /** XTVERSION: terminal name/version string (answer to CSI > 0 q).
   *  Example values: "xterm.js(5.5.0)", "ghostty 1.2.0", "iTerm2 3.6". */
  | { type: 'xtversion'; name: string }

/**
 * Try to recognize a sequence token as a terminal response.
 * Returns null if the sequence is not a known response pattern
 * (i.e. it should be treated as a keypress).
 *
 * These patterns are syntactically distinguishable from keyboard input —
 * no physical key produces CSI ? ... c or CSI ? ... $ y, so they can be
 * safely parsed out of the input stream at any time.
 */
function parseTerminalResponse(s: string): TerminalResponse | null {
  // CSI-prefixed responses
  if (s.startsWith('\x1b[')) {
    let m: RegExpExecArray | null

    if ((m = DECRPM_RE.exec(s))) {
      return {
        type: 'decrpm',
        mode: parseInt(m[1]!, 10),
        status: parseInt(m[2]!, 10),
      }
    }

    if ((m = DA1_RE.exec(s))) {
      return { type: 'da1', params: splitNumericParams(m[1]!) }
    }

    if ((m = DA2_RE.exec(s))) {
      return { type: 'da2', params: splitNumericParams(m[1]!) }
    }

    if ((m = KITTY_FLAGS_RE.exec(s))) {
      return { type: 'kittyKeyboard', flags: parseInt(m[1]!, 10) }
    }

    if ((m = CURSOR_POSITION_RE.exec(s))) {
      return {
        type: 'cursorPosition',
        row: parseInt(m[1]!, 10),
        col: parseInt(m[2]!, 10),
      }
    }

    return null
  }

  // OSC responses (e.g. OSC 11 ; rgb:... for bg color query)
  if (s.startsWith('\x1b]')) {
    const m = OSC_RESPONSE_RE.exec(s)
    if (m) {
      return { type: 'osc', code: parseInt(m[1]!, 10), data: m[2]! }
    }
  }

  // DCS responses (e.g. XTVERSION: DCS > | name ST)
  if (s.startsWith('\x1bP')) {
    const m = XTVERSION_RE.exec(s)
    if (m) {
      return { type: 'xtversion', name: m[1]! }
    }
  }

  return null
}

function splitNumericParams(params: string): number[] {
  if (!params) return []
  return params.split(';').map(p => parseInt(p, 10))
}

/**
 * Build a modifier-free text key from a win32 record (used for the
 * Alt+numpad payload on Alt-release). `sequence` defaults to the char —
 * space needs the literal ' ' so input-event lets it through as text.
 */
function win32TextKey(raw: string, name: string, sequence = name): ParsedKey {
  return {
    kind: 'key',
    name,
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence,
    raw,
    isPasted: false,
  }
}

/**
 * Translate a win32-input-mode record (CSI Vk;Sc;Uc;Kd;Cs;Rc _) into a
 * ParsedKey, so the rest of the input pipeline sees the same key objects as
 * on VT-protocol terminals (issue #147).
 *
 * @param ctx - surrogate-pair scratch state. Uc is a UTF-16 code unit, so a
 *   supplementary-plane character (emoji, CJK ext-B) arrives as two
 *   consecutive records; the high half waits in `ctx.high` for its low half.
 *   Mutated here, never on the caller's KeyParseState — the caller threads
 *   it into the next call's state.
 * @returns `undefined` when `s` is not a win32 record (caller falls through
 *   to the VT parsers); `null` for a record that must be swallowed (keyup,
 *   bare modifier transition, orphaned surrogate half); otherwise the key
 *   plus its repeat count (Rc — ConPTY coalesces held-key repeats into one
 *   record).
 */
function parseWin32KeyEvent(
  s: string,
  ctx: { high?: number; altHigh?: number },
): { key: ParsedKey; repeat: number } | null | undefined {
  const m = WIN32_INPUT_RE.exec(s)
  if (!m) return undefined

  const fields = m[1]!.split(';')
  const num = (i: number, dflt: number): number => {
    const f = fields[i]
    return f === undefined || f === '' ? dflt : parseInt(f, 10)
  }
  const vk = num(0, 0)
  const uc = num(2, 0)
  const keydown = num(3, 0) === 1
  const cs = num(4, 0)
  // Rc coalesces auto-repeat; cap it so a corrupt/huge field can't flood the
  // input queue (legitimate bursts arrive as separate records anyway).
  const repeat = Math.max(1, Math.min(num(5, 1) || 1, 64))

  // A line editor acts on keypresses only — keyup carries no meaning and
  // would double every key if dispatched. Checked BEFORE settling a pending
  // surrogate pair: CharToKeyEvents emits down+up per UTF-16 unit, so a
  // supplementary character legitimately streams as high-down, high-up,
  // low-down — a keyup must never clear the held high half.
  if (!keydown) {
    // Exception: Alt+numpad Unicode input (WindowsInbox's
    // Feature_UseNumpadEventsForClipboardInput). The stream is Alt-down,
    // digit records with no text, then a single Alt KEYUP whose Uc carries
    // the composed character — the only payload in the stream. Ordinary
    // keyups also carry Uc, so this is gated strictly on VK_MENU release
    // with a nonzero Uc.
    if (vk !== 18 || uc === 0) return null
    // A supplementary-plane char is synthesized per UTF-16 unit: TWO Alt
    // rounds, high half then low half, each riding its own Alt-up. The
    // pending high waits in ctx.altHigh — a dedicated slot, because the
    // next round's Alt-down/numpad records are keydowns that would settle
    // the regular ctx.high before the low half ever arrives.
    if (uc >= 0xd800 && uc <= 0xdbff) {
      ctx.altHigh = uc
      return null
    }
    if (uc >= 0xdc00 && uc <= 0xdfff) {
      const high = ctx.altHigh
      ctx.altHigh = undefined
      if (high === undefined) return null
      return { key: win32TextKey(s, String.fromCharCode(high, uc)), repeat: 1 }
    }
    // BMP payload: any pending synthesized high is orphaned by this char.
    ctx.altHigh = undefined
    if (uc === 0x20) {
      return { key: win32TextKey(s, 'space', ' '), repeat: 1 }
    }
    if (uc > 0x20 && !(uc >= 0x7f && uc <= 0x9f)) {
      return { key: win32TextKey(s, String.fromCharCode(uc)), repeat: 1 }
    }
    return null
  }

  // Every keydown settles a pending pair: a high half followed by anything
  // but its low half is dropped, never combined across keys.
  const highSurrogate = ctx.high
  ctx.high = undefined

  // The Alt+numpad pending high survives ONLY the synthesis stream's own
  // filler records: a payload-free VK_MENU transition (the next round's
  // Alt-down), or a payload-free numpad digit while Alt is held (Cs carries
  // an Alt bit). Real Shift/Ctrl transitions and digits pressed without
  // Alt are real input — they settle (drop) the pending high.
  const altHeld = (cs & WIN32_CS_ALT) !== 0
  const isSynthesisFiller =
    (vk === 18 && uc === 0) || (vk >= 96 && vk <= 105 && uc === 0 && altHeld)
  if (!isSynthesisFiller) {
    ctx.altHigh = undefined
  }

  // Bare modifier transitions: their state rides on the next real key's Cs.
  if (WIN32_VK_MODIFIER.has(vk)) return null

  const shift = (cs & WIN32_CS_SHIFT) !== 0
  let ctrl = (cs & WIN32_CS_CTRL) !== 0
  let meta = (cs & WIN32_CS_ALT) !== 0

  const base = {
    kind: 'key' as const,
    fn: false,
    ctrl,
    meta,
    shift,
    option: false,
    super: false,
    raw: s,
    isPasted: false,
  }

  // Printable text comes through Uc, already shift/IME-composed by the
  // console host — so it must win over the Vk name table: NumLock-on numpad
  // keys legitimately carry the Ins/Del/Home/... cluster's Vk with the digit
  // in Uc (tcell emits e.g. CSI 45;82;48;1;32;1_ for numpad 0), and only Uc
  // (plus the ENHANCED_KEY bit, which text keys never set) tells them apart.
  // "Printable" excludes C0, DEL and the C1 band (matching Windows
  // Terminal's own codepoint > 0x20 && != 0x7f rule, extended over C1):
  // Ctrl+8 / Ctrl+/ report Uc=0x7F and must reach the Ctrl recovery chain
  // below.
  let char: string | undefined
  if (uc >= 0xd800 && uc <= 0xdbff) {
    ctx.high = uc
    return null
  }
  if (uc >= 0xdc00 && uc <= 0xdfff) {
    // Orphaned low half (no pending high): swallow immediately. Falling
    // through to the Vk table would resurrect it as a named key — a stray
    // CSI 32;57;56832;1;0;1_ must not become a Space.
    if (highSurrogate === undefined) return null
    char = String.fromCharCode(highSurrogate, uc)
  } else if (uc > 0x20 && !(uc >= 0x7f && uc <= 0x9f)) {
    char = String.fromCharCode(uc)
  }

  // Space gets its own Vk-independent branch: spec-legal records omit Vk
  // (CSI ;;32;1_) and Unicode-injected input arrives as VK_PACKET (231) —
  // neither reaches the Vk=32 name entry below. Unlike graphic chars,
  // space KEEPS ctrl/meta: Ctrl+Alt+Space is a binding, not AltGr text
  // (input-event maps ctrl+space to ' ').
  if (uc === 0x20) {
    return { key: { ...base, name: 'space', sequence: ' ' }, repeat }
  }

  if (char !== undefined) {
    // AltGr arrives as RightAlt + a synthesized LeftCtrl with the printable
    // char in Uc — that's text input ('@', '€', '\', '|', braces on
    // international layouts), not a Ctrl+Alt binding. Clearing the modifiers
    // is required for the text to be insertable at all (PromptInput rejects
    // input carrying ctrl/meta). Genuine Ctrl+Alt+<printable> bindings are
    // indistinguishable from AltGr by Windows design.
    if (ctrl && meta) {
      ctrl = false
      meta = false
    }
    return { key: { ...base, ctrl, meta, name: char, sequence: char }, repeat }
  }

  // Synthesized character records (conhost's SynthesizeKeyEvent: Vk=0,
  // Sc=0, Cs=0) carry their entire payload in Uc — including the control
  // chars that spell the bracketed-paste markers (ESC[200~ / ESC[201~).
  // Map the editing-relevant ones to named keys so the decomposed-paste
  // reassembler below can see the marker characters at all.
  if (vk === 0) {
    if (uc === 27) return { key: { ...base, name: 'escape', sequence: s }, repeat }
    if (uc === 13 || uc === 10) return { key: { ...base, name: 'return', sequence: s }, repeat }
    if (uc === 9) return { key: { ...base, name: 'tab', sequence: s }, repeat }
    if (uc === 8 || uc === 0x7f) return { key: { ...base, name: 'backspace', sequence: s }, repeat }
    return null
  }

  // Non-printing keys by virtual-key code. sequence stays the raw record so
  // input-event clears it via nonAlphanumericKeys ('space' isn't in that
  // list — it needs the literal ' ' as sequence to reach text input).
  const named = WIN32_VK_NAMES[vk]
  if (named) {
    return {
      key: { ...base, name: named, sequence: named === 'space' ? ' ' : s },
      repeat,
    }
  }

  // Ctrl combos collapse Uc to a control code (Ctrl+C → 3, Ctrl+[ → 27,
  // Ctrl+2 → 0). Recover the base key from Vk so the combination isn't
  // swallowed: Ctrl+[ must stay usable as Escape (legacy VT parity — the
  // \x1b byte), letters map to their name for bindings like Ctrl+C
  // (exitOnCtrlC), punctuation via the OEM table.
  if (ctrl) {
    if (uc === 27) {
      return { key: { ...base, name: 'escape', sequence: s }, repeat }
    }
    const baseChar =
      vk >= 65 && vk <= 90
        ? String.fromCharCode(vk + 32)
        : vk >= 48 && vk <= 57
          ? String.fromCharCode(vk)
          : WIN32_VK_OEM_CHARS[vk]
    if (baseChar !== undefined) {
      return { key: { ...base, name: baseChar, sequence: baseChar }, repeat }
    }
  }

  // No usable payload (unmapped function key, dead key, Uc=0): swallow so
  // the raw record can't leak into the prompt as text.
  return null
}

// -- Decomposed bracketed paste (classic conhost under win32-input-mode) --
//
// Classic conhost pastes via Clipboard::TextToKeyEvents: the literal marker
// strings ESC[200~ / ESC[201~ AND the paste body are all synthesized as
// per-UTF-16-unit KEY_EVENT_RECORDs, which win32-input-mode then encodes as
// individual CSI records. The token-level PASTE_START/PASTE_END handling
// never fires, the marker characters leak into the prompt as `[200~`, and
// body newlines arrive as real Return presses that would SUBMIT the prompt
// (issue #147 review). Windows Terminal sends the raw bracketed-paste
// string instead and is unaffected. Reassemble the markers here from the
// key-record stream: while the start-marker prefix is matching, candidate
// keys are HELD (not emitted) so a false start can be released intact;
// between markers, text-equivalent records collect into one paste event.

/** Mutable cross-call state for the decomposed-paste matcher. */
export type Win32PasteState = {
  /** true between the decomposed start and end markers */
  active: boolean
  /** progress into the marker pattern currently being matched */
  matched: number
  /** keys held while a marker prefix match is in flight */
  held: ParsedKey[]
  /** collected paste content while active */
  buffer: string
}

// Character spellings of CSI 200~ / CSI 201~ as key records: the ESC char
// arrives as a Vk=27 record (name 'escape'), the rest as text chars.
const WIN32_PASTE_START_CHARS = ['\x1b', '[', '2', '0', '0', '~']
const WIN32_PASTE_END_CHARS = ['\x1b', '[', '2', '0', '1', '~']

/**
 * The text equivalent of a translated win32 key for paste purposes: chars
 * map to themselves, named editing keys to their control char. Returns
 * undefined for keys with no text meaning (arrows, F-keys).
 */
function win32RecordChar(key: ParsedKey): string | undefined {
  switch (key.name) {
    case 'escape':
      return '\x1b'
    case 'space':
      return ' '
    case 'tab':
      return '\t'
    case 'return':
      return '\n'
    case 'backspace':
      return '\x7f'
    default:
      // Text keys carry their char as BOTH name and sequence; named keys
      // keep the raw CSI record as sequence. This avoids a UTF-16 length
      // check — a supplementary-plane char (emoji, CJK ext-B) is a
      // length-2 string but still text.
      return key.sequence === key.name ? key.name : undefined
  }
}

/**
 * Feed one translated win32 key through the decomposed-paste matcher.
 * Returns the keys to emit (empty while holding a candidate prefix or
 * collecting paste content).
 */
function feedWin32Paste(state: Win32PasteState, key: ParsedKey): ParsedKey[] {
  const pattern = state.active ? WIN32_PASTE_END_CHARS : WIN32_PASTE_START_CHARS
  // Marker chars never carry Ctrl/Alt in the synthesized stream; requiring
  // this keeps a user's real Ctrl+[ from starting a phantom paste. Shift is
  // allowed — '~' legitimately arrives with it.
  const ch = key.ctrl || key.meta ? undefined : win32RecordChar(key)

  if (ch !== undefined && ch === pattern[state.matched]) {
    state.held.push(key)
    state.matched++
    if (state.matched === pattern.length) {
      state.matched = 0
      state.held = []
      if (!state.active) {
        state.active = true
        state.buffer = ''
        return []
      }
      // End marker complete: the whole paste as a single event.
      const paste = createPasteKey(state.buffer)
      state.active = false
      state.buffer = ''
      return [paste]
    }
    return []
  }

  // Mismatch: release whatever prefix was held, then re-evaluate the
  // current key from a clean match position (it may itself start a marker,
  // e.g. ESC ESC [ 2 0 1 ~).
  if (state.matched > 0) {
    const held = state.held
    state.held = []
    state.matched = 0
    if (state.active) {
      for (const k of held) state.buffer += win32RecordChar(k) ?? ''
      return feedWin32Paste(state, key)
    }
    return [...held, ...feedWin32Paste(state, key)]
  }

  if (state.active) {
    state.buffer += win32RecordChar(key) ?? ''
    return []
  }
  return [key]
}

// -- Terminal protocols decomposed into synthesized win32 key records --

export type Win32ProtocolState = {
  held: ParsedKey[]
  sequence: string
}

function synthesizedWin32Char(key: ParsedKey): string | undefined {
  const match = WIN32_INPUT_RE.exec(key.raw ?? '')
  if (!match) return undefined
  const fields = match[1]!.split(';')
  const num = (index: number, dflt: number): number => {
    const field = fields[index]
    return field === undefined || field === '' ? dflt : parseInt(field, 10)
  }
  if (num(0, 0) !== 0 || num(1, 0) !== 0 || num(3, 0) !== 1 || num(4, 0) !== 0) {
    return undefined
  }
  return win32RecordChar(key)
}

function parseReassembledWin32Protocol(sequence: string): ParsedInput | null {
  const response = parseTerminalResponse(sequence)
  if (response) return { kind: 'response', sequence, response }

  const mouse = parseMouseEvent(sequence) ?? parseX10MouseEvent(sequence)
  if (mouse) return mouse

  if (SGR_MOUSE_RE.test(sequence) || (sequence.length === 6 && sequence.startsWith('\x1b[M'))) {
    return parseKeypress(sequence)
  }
  return null
}

function feedWin32Protocol(
  state: Win32ProtocolState,
  key: ParsedKey,
): ParsedInput[] {
  const ch = synthesizedWin32Char(key)
  if (state.held.length === 0) {
    if (ch !== '\x1b') return [key]
    state.held.push(key)
    state.sequence = ch
    return []
  }

  if (ch === undefined) {
    const held = state.held
    state.held = []
    state.sequence = ''
    return [...held, ...feedWin32Protocol(state, key)]
  }

  state.held.push(key)
  state.sequence += ch
  const sequence = state.sequence

  if (sequence === '\x1b' || sequence === '\x1b[') return []

  if (!sequence.startsWith('\x1b[') || sequence.length > 64) {
    const held = state.held
    state.held = []
    state.sequence = ''
    return held
  }

  if (sequence.startsWith('\x1b[M')) {
    if (sequence.length < 6) return []
    const held = state.held
    state.held = []
    state.sequence = ''
    const parsed = sequence.length === 6
      ? parseReassembledWin32Protocol(sequence)
      : null
    return parsed ? [parsed] : held
  }

  const code = ch.charCodeAt(0)
  if ((code >= 0x20 && code <= 0x3f)) return []
  if (code >= 0x40 && code <= 0x7e) {
    const held = state.held
    state.held = []
    state.sequence = ''
    const parsed = parseReassembledWin32Protocol(sequence)
    return parsed ? [parsed] : held
  }

  const held = state.held
  state.held = []
  state.sequence = ''
  return held
}

function feedWin32Input(
  pasteState: Win32PasteState,
  protocolState: Win32ProtocolState,
  key: ParsedKey,
): ParsedInput[] {
  const inputs: ParsedInput[] = []
  for (const pasteKey of feedWin32Paste(pasteState, key)) {
    inputs.push(...feedWin32Protocol(protocolState, pasteKey))
  }
  return inputs
}

/**
 * Parser state carried between parseMultipleKeypresses calls: paste mode,
 * buffered incomplete input, and the internal tokenizer instance.
 */
export type KeyParseState = {
  mode: 'NORMAL' | 'IN_PASTE'
  incomplete: string
  pasteBuffer: string
  /**
   * Pending high surrogate from a win32-input-mode record. Uc is a UTF-16
   * code unit, so supplementary-plane characters (emoji, CJK ext-B) arrive
   * as two consecutive records; the high half waits here for its low half.
   */
  win32HighSurrogate?: number
  /**
   * Pending high surrogate for the Alt+numpad synthesis path — separate
   * from win32HighSurrogate because the two Alt rounds of one supplementary
   * char interleave with keydown records (Alt-down, numpad digits) that
   * would settle the regular slot before the low half arrives.
   */
  win32AltHighSurrogate?: number
  /**
   * Decomposed bracketed-paste tracking for win32-input-mode. Classic
   * conhost synthesizes pastes as per-char KEY_EVENT_RECORDs — including
   * the ESC[200~ / ESC[201~ markers themselves — so under W32IM the markers
   * arrive as ordinary key records and must be reassembled here (issue #147).
   */
  win32Paste?: Win32PasteState
  /**
   * Terminal CSI bytes synthesized by classic conhost as one win32 input
   * record per character. Only Vk=0/Sc=0 records enter this matcher, keeping
   * physically typed text out of the protocol path.
   */
  win32Protocol?: Win32ProtocolState
  /**
   * Pending prefix of an SGR mouse report that fragmented mid-sequence
   * (ConPTY split a report across reads and App's escape timer flushed the
   * buffered ESC prefix). Holds at most one incomplete `[<btn;col;row` tail;
   * the next chunk completes it (resynthesis) or a flush discards it —
   * typed `[`-led text never matches the guard pattern and passes through.
   */
  mouseTailHold?: string
  // Internal tokenizer instance
  _tokenizer?: Tokenizer
}

/** Initial `KeyParseState` for a fresh parser. */
export const INITIAL_STATE: KeyParseState = {
  mode: 'NORMAL',
  incomplete: '',
  pasteBuffer: '',
}

function inputToString(input: Buffer | string): string {
  if (Buffer.isBuffer(input)) {
    if (input[0]! > 127 && input[1] === undefined) {
      ;(input[0] as unknown as number) -= 128
      return '\x1b' + String(input)
    } else {
      return String(input)
    }
  } else if (input !== undefined && typeof input !== 'string') {
    return String(input)
  } else if (!input) {
    return ''
  } else {
    return input
  }
}

/**
 * Tokenize and parse a chunk of terminal input into parsed keys, mouse
 * events, and terminal responses, maintaining paste-mode state.
 * @param prevState - the state returned by the previous call, or INITIAL_STATE.
 * @param input - the input chunk; null flushes the tokenizer's pending input.
 * @returns the parsed inputs plus the state to pass to the next call.
 */
export function parseMultipleKeypresses(
  prevState: KeyParseState,
  input: Buffer | string | null = '',
): [ParsedInput[], KeyParseState] {
  const isFlush = input === null
  const inputString = isFlush ? '' : inputToString(input)

  // Get or create tokenizer
  const tokenizer = prevState._tokenizer ?? createTokenizer({
    x10Mouse: true,
    splitInputControls: true,
  })

  // Tokenize the input
  const tokens = isFlush ? tokenizer.flush() : tokenizer.feed(inputString)

  // Convert tokens to parsed keys, handling paste mode
  const keys: ParsedInput[] = []
  let inPaste = prevState.mode === 'IN_PASTE'
  let pasteBuffer = prevState.pasteBuffer
  // Surrogate-pair scratch for win32-input-mode records. Threaded through a
  // local object so prevState is never mutated — App.tsx seeds the parser
  // with the shared INITIAL_STATE singleton, and a pending high surrogate
  // leaking into it would survive into fresh parser instances.
  const win32Ctx: { high?: number; altHigh?: number } = {
    high: prevState.win32HighSurrogate,
    altHigh: prevState.win32AltHighSurrogate,
  }
  // Decomposed-paste matcher state rides on a shared mutable object across
  // calls (like _tokenizer). Fresh instances never touch INITIAL_STATE —
  // the field stays undefined there and the object is created on demand.
  const win32Paste: Win32PasteState = prevState.win32Paste ?? {
    active: false,
    matched: 0,
    held: [],
    buffer: '',
  }
  const win32Protocol: Win32ProtocolState = prevState.win32Protocol ?? {
    held: [],
    sequence: '',
  }
  // Pending fragmented SGR mouse prefix (see KeyParseState.mouseTailHold).
  let mouseTailHold: string | undefined = prevState.mouseTailHold
  // Set when THIS call captured (or extended) the hold — a flush that fires
  // in the same call the fragments arrived must not discard them: the
  // terminal's continuation bytes can still be in flight (ConPTY delivered
  // the first read's tail after the 50ms timer armed). Only a hold that
  // survived a full parse call without completing is stale (below).
  let holdTouchedThisCall = false

  for (const token of tokens) {
    if (token.type === 'sequence') {
      if (token.value === PASTE_START) {
        inPaste = true
        pasteBuffer = ''
      } else if (token.value === PASTE_END) {
        // Always emit a paste key, even for empty pastes. This allows
        // downstream handlers to detect empty pastes (e.g., for clipboard
        // image handling on macOS). The paste content may be empty string.
        keys.push(createPasteKey(pasteBuffer))
        inPaste = false
        pasteBuffer = ''
      } else if (inPaste) {
        // Sequences inside paste are treated as literal text
        pasteBuffer += token.value
      } else {
        const win32 = parseWin32KeyEvent(token.value, win32Ctx)
        if (win32 !== undefined) {
          // win32-input-mode record. null means a swallowed event (keyup,
          // bare modifier, orphaned surrogate) — the sequence is consumed
          // either way and never reaches the VT keypress parser.
          if (win32 !== null) {
            // Keys pass through the decomposed-paste matcher: on classic
            // conhost the bracketed-paste markers themselves arrive as key
            // records and must be reassembled before dispatch.
            for (let i = 0; i < win32.repeat; i++) {
              keys.push(...feedWin32Input(win32Paste, win32Protocol, win32.key))
            }
          }
        } else {
          const response = parseTerminalResponse(token.value)
          if (response) {
            keys.push({ kind: 'response', sequence: token.value, response })
          } else {
            // SGR first (1006); X10 (legacy 1000/1002 without SGR) as the
            // compatibility fallback for clicks/drags. Wheel falls through
            // to parseKeypress, which turns it into a wheel key WITH the
            // pointer coordinates for position-based routing.
            const mouse =
              parseMouseEvent(token.value) ??
              parseX10MouseEvent(token.value)
            if (mouse) {
              keys.push(mouse)
            } else if (SGR_MOUSE_PREFIX_RE.test(token.value.replace(/^\x1b/, ''))) {
              // Flush-truncated SGR mouse report: the tokenizer's flush
              // emitted the buffered prefix (ESC still attached) as a
              // sequence token. It is protocol bytes mid-report, not a key —
              // strip the ESC, hold for the continuation (the text-token
              // branch above completes it), and never let it fall through
              // to parseKeypress, where it would leak into the prompt.
              mouseTailHold = (mouseTailHold ?? '') + token.value.replace(/^\x1b/, '')
              holdTouchedThisCall = true
            } else {
              keys.push(parseKeypress(token.value))
            }
          }
        }
      }
    } else if (token.type === 'text') {
      if (inPaste) {
        pasteBuffer += token.value
      } else if (WIN32_INPUT_TAILS_RE.test(token.value)) {
        // A delayed win32-input-mode continuation can arrive after App's
        // escape timer has already flushed its ESC prefix. Recover complete
        // record tails so their protocol bytes do not leak into the prompt.
        for (const tail of token.value.match(WIN32_INPUT_TAIL_RE) ?? []) {
          const win32 = parseWin32KeyEvent('\x1b' + tail, win32Ctx)
          if (win32 !== undefined && win32 !== null) {
            for (let i = 0; i < win32.repeat; i++) {
              keys.push(...feedWin32Input(win32Paste, win32Protocol, win32.key))
            }
          }
        }
      } else if (
        SGR_MOUSE_TAIL_RE.test(token.value) ||
        (mouseTailHold !== undefined &&
          SGR_MOUSE_TAIL_RE.test(mouseTailHold + token.value)) ||
        /^\[M[\x60-\x7f][\x20-\uffff]{2}$/.test(token.value)
      ) {
        // Orphaned SGR/X10 mouse tail (fullscreen only — mouse tracking is off
        // otherwise). A heavy render blocked the event loop past App's 50ms
        // flush timer, so the buffered ESC was flushed as a lone Escape and
        // the continuation `[<btn;col;rowM` arrived as text. Re-synthesize
        // with the ESC prefix so the scroll event still fires instead of
        // leaking into the prompt. The spurious Escape is gone; App.tsx's
        // readableLength check prevents it. The X10 Cb slot is narrowed to
        // the wheel range [\x60-\x7f] (0x40|modifiers + 32) — a full [\x20-]
        // range would match typed input like `[MAX]` batched into one read
        // and silently drop it as a phantom click.
        const resynthesized = '\x1b' + (mouseTailHold ?? '') + token.value
        mouseTailHold = undefined
        const mouse = parseMouseEvent(resynthesized)
        keys.push(mouse ?? parseKeypress(resynthesized))
      } else if (
        SGR_MOUSE_PREFIX_RE.test(token.value) ||
        // Continuation of an active hold: with the prefix already captured,
        // the next fragment (`32;5M`'s leading digits, more params) is
        // digits/semicolons — meaningless as typing on its own and part of
        // the in-flight report. Any completion is caught by the tail branch
        // above first, so reaching here with a hold means still incomplete.
        (mouseTailHold !== undefined && /^[\d;]*$/.test(token.value) && token.value !== '')
      ) {
        // Incomplete SGR mouse prefix: ConPTY split the report mid-sequence
        // and the flush timer already released the buffered ESC prefix, so
        // this text token carries protocol bytes, not typing. Hold it for the
        // next chunk (which completes the tail — handled by the branch above
        // via the combined `hold + value` check) instead of leaking into the
        // prompt; a flush discards the hold. The regex demands `<` + digits,
        // which no realistic typed text produces as a single text token.
        mouseTailHold = (mouseTailHold ?? '') + token.value
        holdTouchedThisCall = true
      } else {
        keys.push(parseKeypress(token.value))
      }
    }
  }

  // If flushing and still in paste mode, emit what we have
  if (isFlush && inPaste && pasteBuffer) {
    keys.push(createPasteKey(pasteBuffer))
    inPaste = false
    pasteBuffer = ''
  }

  // Flush handling for the decomposed win32 paste: mid-paste (active) the
  // 50ms quiet timer means the paste stream ended — finalize with whatever
  // was collected (mirrors the VT IN_PASTE flush above; a truncated end
  // marker must not strand the matcher and eat all future typing). Outside
  // a paste, release any held marker-prefix keys (e.g. a lone Escape).
  if (isFlush && win32Paste.active) {
    let content = win32Paste.buffer
    for (const k of win32Paste.held) content += win32RecordChar(k) ?? ''
    keys.push(createPasteKey(content))
    win32Paste.active = false
    win32Paste.buffer = ''
    win32Paste.held = []
    win32Paste.matched = 0
  } else if (isFlush && win32Paste.held.length > 0) {
    keys.push(...win32Paste.held)
    win32Paste.held = []
    win32Paste.matched = 0
  }

  // A quiet timeout ends a synthesized protocol candidate. Incomplete mouse
  // reports are terminal input and must not become prompt text; other held
  // input (a lone Escape or an unknown CSI sequence) remains ordinary keys.
  if (isFlush && win32Protocol.held.length > 0) {
    const isMouseCandidate =
      win32Protocol.sequence.startsWith('\x1b[<') ||
      win32Protocol.sequence.startsWith('\x1b[M')
    if (!isMouseCandidate) keys.push(...win32Protocol.held)
    win32Protocol.held = []
    win32Protocol.sequence = ''
  }

  // A held SGR mouse prefix that never completed: a flush that fires on a
  // call which did NOT capture/extend the hold means the 50ms grace expired
  // without continuation bytes — the fragments are a dead report (terminal
  // dropped the tail of the sequence). Discard rather than emit: protocol
  // bytes that reach the prompt as text are exactly the leak this hold
  // exists to prevent. Partial recovery of the coords is not worth one more
  // branch — a mouse event with guessed terminators would dispatch phantom
  // clicks. A hold captured in THIS call survives its own flush: ConPTY can
  // deliver the first read's remainder after the timer armed (the very D-
  // scenario the hold exists for), and the next call completes it.
  if (isFlush && mouseTailHold !== undefined && !holdTouchedThisCall) {
    mouseTailHold = undefined
  }

  // Build new state
  const newState: KeyParseState = {
    mode: inPaste ? 'IN_PASTE' : 'NORMAL',
    // App.tsx arms its flush timer whenever `incomplete` is non-empty. The
    // tokenizer only reports raw bytes there, so paste-matcher holds (a
    // marker prefix in flight, or an active paste) set a sentinel to get the
    // same 50ms release — a lone Escape stays as responsive as in VT mode.
    // A held mouse prefix rides the same mechanism so its grace window
    // actually opens.
    incomplete:
      tokenizer.buffer() ||
      (win32Paste.held.length > 0 ||
      win32Paste.active ||
      win32Protocol.held.length > 0 ||
      mouseTailHold !== undefined
        ? '\x1b'
        : ''),
    pasteBuffer,
    win32HighSurrogate: win32Ctx.high,
    win32AltHighSurrogate: win32Ctx.altHigh,
    win32Paste,
    win32Protocol,
    mouseTailHold,
    _tokenizer: tokenizer,
  }

  return [keys, newState]
}

const keyName: Record<string, string> = {
  /* xterm/gnome ESC O letter */
  OP: 'f1',
  OQ: 'f2',
  OR: 'f3',
  OS: 'f4',
  /* Application keypad mode (numpad digits 0-9) */
  Op: '0',
  Oq: '1',
  Or: '2',
  Os: '3',
  Ot: '4',
  Ou: '5',
  Ov: '6',
  Ow: '7',
  Ox: '8',
  Oy: '9',
  /* Application keypad mode (numpad operators) */
  Oj: '*',
  Ok: '+',
  Ol: ',',
  Om: '-',
  On: '.',
  Oo: '/',
  OM: 'return',
  /* xterm/rxvt ESC [ number ~ */
  '[11~': 'f1',
  '[12~': 'f2',
  '[13~': 'f3',
  '[14~': 'f4',
  /* from Cygwin and used in libuv */
  '[[A': 'f1',
  '[[B': 'f2',
  '[[C': 'f3',
  '[[D': 'f4',
  '[[E': 'f5',
  /* common */
  '[15~': 'f5',
  '[17~': 'f6',
  '[18~': 'f7',
  '[19~': 'f8',
  '[20~': 'f9',
  '[21~': 'f10',
  '[23~': 'f11',
  '[24~': 'f12',
  /* xterm ESC [ letter */
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  '[E': 'clear',
  '[F': 'end',
  '[H': 'home',
  /* xterm/gnome ESC O letter */
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  OE: 'clear',
  OF: 'end',
  OH: 'home',
  /* xterm/rxvt ESC [ number ~ */
  '[1~': 'home',
  '[2~': 'insert',
  '[3~': 'delete',
  '[4~': 'end',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  /* putty */
  '[[5~': 'pageup',
  '[[6~': 'pagedown',
  /* rxvt */
  '[7~': 'home',
  '[8~': 'end',
  /* rxvt keys with modifiers */
  '[a': 'up',
  '[b': 'down',
  '[c': 'right',
  '[d': 'left',
  '[e': 'clear',

  '[2$': 'insert',
  '[3$': 'delete',
  '[5$': 'pageup',
  '[6$': 'pagedown',
  '[7$': 'home',
  '[8$': 'end',

  Oa: 'up',
  Ob: 'down',
  Oc: 'right',
  Od: 'left',
  Oe: 'clear',

  '[2^': 'insert',
  '[3^': 'delete',
  '[5^': 'pageup',
  '[6^': 'pagedown',
  '[7^': 'home',
  '[8^': 'end',
  /* misc. */
  '[Z': 'tab',
}

/**
 * Key names that never produce printable input (function keys, navigation,
 * modifiers, mouse), used to filter parsed keypresses.
 */
export const nonAlphanumericKeys = [
  // Filter out single-character values (digits, operators from numpad) since
  // those are printable characters that should produce input
  ...Object.values(keyName).filter(v => v.length > 1),
  // escape and backspace are assigned directly in parseKeypress (not via the
  // keyName map), so the spread above misses them. Without these, ctrl+escape
  // via Kitty/modifyOtherKeys leaks the literal word "escape" as input text
  // (input-event.ts:58 assigns keypress.name when ctrl is set).
  'escape',
  'backspace',
  'wheelup',
  'wheeldown',
  'wheelleft',
  'wheelright',
  'mouse',
]

const isShiftKey = (code: string): boolean => {
  return [
    '[a',
    '[b',
    '[c',
    '[d',
    '[e',
    '[2$',
    '[3$',
    '[5$',
    '[6$',
    '[7$',
    '[8$',
    '[Z',
  ].includes(code)
}

const isCtrlKey = (code: string): boolean => {
  return [
    'Oa',
    'Ob',
    'Oc',
    'Od',
    'Oe',
    '[2^',
    '[3^',
    '[5^',
    '[6^',
    '[7^',
    '[8^',
  ].includes(code)
}

/**
 * Decode XTerm-style modifier value to individual flags.
 * Modifier encoding: 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0) + (super ? 8 : 0)
 *
 * Note: `meta` here means Alt/Option (bit 2). `super` is a distinct
 * modifier (bit 8, i.e. Cmd on macOS / Win key). Most legacy terminal
 * sequences can't express super — it only arrives via kitty keyboard
 * protocol (CSI u) or xterm modifyOtherKeys.
 */
function decodeModifier(modifier: number): {
  shift: boolean
  meta: boolean
  ctrl: boolean
  super: boolean
} {
  const m = modifier - 1
  return {
    shift: !!(m & 1),
    meta: !!(m & 2),
    ctrl: !!(m & 4),
    super: !!(m & 8),
  }
}

/**
 * Map keycode to key name for modifyOtherKeys/CSI u sequences.
 * Handles both ASCII keycodes and Kitty keyboard protocol functional keys.
 *
 * Numpad codepoints are from Unicode Private Use Area, defined at:
 * https://sw.kovidgoyal.net/kitty/keyboard-protocol/#functional-key-definitions
 */
function keycodeToName(keycode: number): string | undefined {
  switch (keycode) {
    case 9:
      return 'tab'
    case 13:
      return 'return'
    case 27:
      return 'escape'
    case 32:
      return 'space'
    case 127:
      return 'backspace'
    // Kitty keyboard protocol numpad keys (KP_0 through KP_9)
    case 57399:
      return '0'
    case 57400:
      return '1'
    case 57401:
      return '2'
    case 57402:
      return '3'
    case 57403:
      return '4'
    case 57404:
      return '5'
    case 57405:
      return '6'
    case 57406:
      return '7'
    case 57407:
      return '8'
    case 57408:
      return '9'
    case 57409: // KP_DECIMAL
      return '.'
    case 57410: // KP_DIVIDE
      return '/'
    case 57411: // KP_MULTIPLY
      return '*'
    case 57412: // KP_SUBTRACT
      return '-'
    case 57413: // KP_ADD
      return '+'
    case 57414: // KP_ENTER
      return 'return'
    case 57415: // KP_EQUAL
      return '='
    default:
      // Printable ASCII characters
      if (keycode >= 32 && keycode <= 126) {
        return String.fromCharCode(keycode).toLowerCase()
      }
      return undefined
  }
}

/**
 * A parsed user keypress or paste: the key name, modifier flags, the raw
 * escape sequence, and whether the input arrived via bracketed paste.
 */
export type ParsedKey = {
  kind: 'key'
  fn: boolean
  name: string | undefined
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  super: boolean
  sequence: string | undefined
  raw: string | undefined
  code?: string
  isPasted: boolean
  /**
   * Pointer column (0-indexed) for wheel keys — SGR/X10 wheel sequences
   * carry the position the wheel event occurred at. Undefined for
   * non-wheel keys.
   */
  mouseCol?: number
  /** Pointer row (0-indexed) for wheel keys. See mouseCol. */
  mouseRow?: number
  /** Raw SGR/X10 button byte for wheel modifiers and direction. */
  mouseButton?: number
}

/** A terminal response sequence (DECRPM, DA1, OSC reply, etc.) parsed
 *  out of the input stream. Not user input — consumers should dispatch
 *  to a response handler. */
export type ParsedResponse = {
  kind: 'response'
  /** Raw escape sequence bytes, for debugging/logging */
  sequence: string
  response: TerminalResponse
}

/** SGR mouse event with coordinates. Emitted for clicks, drags, and
 *  releases (wheel events remain ParsedKey). col/row are 1-indexed
 *  from the terminal sequence (CSI < btn;col;row M/m). */
export type ParsedMouse = {
  kind: 'mouse'
  /** Raw SGR button code. Low 2 bits = button (0=left,1=mid,2=right),
   *  bit 5 (0x20) = drag/motion, bit 6 (0x40) = wheel. */
  button: number
  /** 'press' for M terminator, 'release' for m terminator */
  action: 'press' | 'release'
  /** 1-indexed column (from terminal) */
  col: number
  /** 1-indexed row (from terminal) */
  row: number
  sequence: string
}

/** Everything that can come out of the input parser: a user keypress/paste,
 *  a mouse click/drag event, or a terminal response to a query we sent. */
export type ParsedInput = ParsedKey | ParsedMouse | ParsedResponse

/**
 * Parse an SGR mouse event sequence into a ParsedMouse, or null if not a
 * mouse event or if it's a wheel event (wheel stays as ParsedKey for the
 * keybinding system). Button bit 0x40 = wheel, bit 0x20 = drag/motion.
 */
function parseMouseEvent(s: string): ParsedMouse | null {
  const match = SGR_MOUSE_RE.exec(s)
  if (!match) return null
  const button = parseInt(match[1]!, 10)
  // Wheel events (bit 6 set, low bits 0/1 for up/down) stay as ParsedKey
  // so the keybinding system can route them to scroll handlers.
  if ((button & 0x40) !== 0) return null
  return {
    kind: 'mouse',
    button,
    action: match[4] === 'M' ? 'press' : 'release',
    col: parseInt(match[2]!, 10),
    row: parseInt(match[3]!, 10),
    sequence: s,
  }
}

/**
 * Parse an X10 mouse sequence (CSI M + Cb/Cx/Cy raw bytes, each +32) into
 * a ParsedMouse, or null for anything else. Serves terminals that honor
 * DECSET 1000/1002 but ignore 1006 (SGR): clicks and button-drags become
 * real ParsedMouse events so text selection works there too.
 *
 * Classic X10 reports release as Cb low bits 3 with the same `M` framing;
 * it cannot identify WHICH button was released, but App can pair it with its
 * active left selection/drag session. No-button hover is not representable,
 * so hover stays SGR-only. Wheel returns null (parseKeypress's wheel branch
 * turns it into a key with coordinates).
 */
function parseX10MouseEvent(s: string): ParsedMouse | null {
  if (s.length !== 6 || !s.startsWith('\x1b[M')) return null
  const button = s.charCodeAt(3) - 32
  // Wheel (bit 6) → key path. Low bits 3 without motion is the classic
  // X10 release code (button identity is unavailable, pairing happens in App).
  if ((button & 0x40) !== 0) return null
  const release = (button & 0x03) === 3 && (button & 0x20) === 0
  return {
    kind: 'mouse',
    button,
    action: release ? 'release' : 'press',
    // X10 coords are 1-indexed like SGR (charCode - 32).
    col: s.charCodeAt(4) - 32,
    row: s.charCodeAt(5) - 32,
    sequence: s,
  }
}

function parseKeypress(s: string = ''): ParsedKey {
  let parts

  const key: ParsedKey = {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: s,
    raw: s,
    isPasted: false,
  }

  key.sequence = key.sequence || s || key.name

  // Handle CSI u (kitty keyboard protocol): ESC [ codepoint [; modifier] u
  // Example: ESC[13;2u = Shift+Enter, ESC[27u = Escape (no modifiers)
  let match: RegExpExecArray | null
  if ((match = CSI_U_RE.exec(s))) {
    const codepoint = parseInt(match[1]!, 10)
    // Modifier defaults to 1 (no modifiers) when not present
    const modifier = match[2] ? parseInt(match[2], 10) : 1
    const mods = decodeModifier(modifier)
    const name = keycodeToName(codepoint)
    return {
      kind: 'key',
      name,
      fn: false,
      ctrl: mods.ctrl,
      meta: mods.meta,
      shift: mods.shift,
      option: false,
      super: mods.super,
      sequence: s,
      raw: s,
      isPasted: false,
    }
  }

  // Handle xterm modifyOtherKeys: ESC [ 27 ; modifier ; keycode ~
  // Must run before FN_KEY_RE — FN_KEY_RE only allows 2 params before ~ and
  // would leave the tail as garbage if it partially matched.
  if ((match = MODIFY_OTHER_KEYS_RE.exec(s))) {
    const mods = decodeModifier(parseInt(match[1]!, 10))
    const name = keycodeToName(parseInt(match[2]!, 10))
    return {
      kind: 'key',
      name,
      fn: false,
      ctrl: mods.ctrl,
      meta: mods.meta,
      shift: mods.shift,
      option: false,
      super: mods.super,
      sequence: s,
      raw: s,
      isPasted: false,
    }
  }

  // SGR mouse wheel events. Click/drag/release events are handled
  // earlier by parseMouseEvent and emitted as ParsedMouse, so they
  // never reach here. Mask with 0x43 (bits 6+1+0) to check wheel-flag
  // + direction while ignoring modifier bits (Shift=0x04, Meta=0x08,
  // Ctrl=0x10) — modified wheel events (e.g. Ctrl+scroll, button=80)
  // should still be recognized as wheelup/wheeldown.
  //
  // The SGR sequence carries the pointer position (CSI < btn;col;row M) —
  // preserved on the ParsedKey (mouseCol/mouseRow, 0-indexed) so wheel
  // routing can hit-test the ScrollBox under the pointer instead of
  // scrolling a hardcoded target. Buttons 66/67 are horizontal wheel
  // (wheelleft/wheelright); kept as keys with coords for future consumers.
  if ((match = SGR_MOUSE_RE.exec(s))) {
    const button = parseInt(match[1]!, 10)
    const col = parseInt(match[2]!, 10) - 1
    const row = parseInt(match[3]!, 10) - 1
    const dir = button & 0x43
    if (dir === 0x40) return createWheelKey(s, 'wheelup', col, row, button)
    if (dir === 0x41) return createWheelKey(s, 'wheeldown', col, row, button)
    if (dir === 0x42) return createWheelKey(s, 'wheelleft', col, row, button)
    if (dir === 0x43) return createWheelKey(s, 'wheelright', col, row, button)
    // Shouldn't reach here (parseMouseEvent catches non-wheel) but be safe
    return createNavKey(s, 'mouse', false)
  }

  // X10 mouse: CSI M + 3 raw bytes (Cb+32, Cx+32, Cy+32). Terminals that
  // ignore DECSET 1006 (SGR) but honor 1000/1002 emit this legacy encoding.
  // Button bits match SGR: 0x40 = wheel, low bit = direction, 0x20 = drag.
  // Wheel events become wheel keys (with coordinates, like SGR); clicks and
  // drags and the generic low-bits-3 release become ParsedMouse so X10-only
  // terminals get selection and click/drag completion support.
  if (s.length === 6 && s.startsWith('\x1b[M')) {
    const button = s.charCodeAt(3) - 32
    const col = s.charCodeAt(4) - 32 - 1
    const row = s.charCodeAt(5) - 32 - 1
    const dir = button & 0x43
    if (dir === 0x40) return createWheelKey(s, 'wheelup', col, row, button)
    if (dir === 0x41) return createWheelKey(s, 'wheeldown', col, row, button)
    if (dir === 0x42) return createWheelKey(s, 'wheelleft', col, row, button)
    if (dir === 0x43) return createWheelKey(s, 'wheelright', col, row, button)
    // Non-wheel X10 clicks/drags are intercepted by parseX10MouseEvent in
    // parseMultipleKeypresses before this function runs; reaching here means
    // a flush path bypassed it (no-button motion without the drag bit — X10
    // hover, unsupported). Swallow as before.
    return createNavKey(s, 'mouse', false)
  }

  if (s === '\r') {
    key.raw = undefined
    key.name = 'return'
  } else if (s === '\x1b\r' || s === '\x1b\n') {
    // Option+Enter on terminals without extended key reporting (Terminal.app,
    // default macOS terminal) sends ESC CR when "Use Option as Meta" is on —
    // the tokenizer passes CR through as text since it's not an ESC final
    // byte, so the pair arrives here as one chunk (issue #110).
    key.raw = undefined
    key.name = 'return'
    key.meta = true
  } else if (s === '\n') {
    key.name = 'enter'
  } else if (s === '\t') {
    key.name = 'tab'
  } else if (s === '\b' || s === '\x1b\b') {
    key.name = 'backspace'
    key.meta = s.charAt(0) === '\x1b'
  } else if (s === '\x7f' || s === '\x1b\x7f') {
    key.name = 'backspace'
    key.meta = s.charAt(0) === '\x1b'
  } else if (s === '\x1b' || s === '\x1b\x1b') {
    key.name = 'escape'
    key.meta = s.length === 2
  } else if (s === ' ' || s === '\x1b ') {
    key.name = 'space'
    key.meta = s.length === 2
  } else if (s === '\x1f') {
    key.name = '_'
    key.ctrl = true
  } else if (s <= '\x1a' && s.length === 1) {
    key.name = String.fromCharCode(s.charCodeAt(0) + 'a'.charCodeAt(0) - 1)
    key.ctrl = true
  } else if (s.length === 1 && s >= '0' && s <= '9') {
    key.name = 'number'
  } else if (s.length === 1 && s >= 'a' && s <= 'z') {
    key.name = s
  } else if (s.length === 1 && s >= 'A' && s <= 'Z') {
    key.name = s.toLowerCase()
    key.shift = true
  } else if ((parts = META_KEY_CODE_RE.exec(s))) {
    key.meta = true
    key.shift = /^[A-Z]$/.test(parts[1]!)
  } else if ((parts = FN_KEY_RE.exec(s))) {
    const segs = [...s]

    if (segs[0] === '\u001b' && segs[1] === '\u001b') {
      key.option = true
    }

    const code = [parts[1], parts[2], parts[4], parts[6]]
      .filter(Boolean)
      .join('')

    const modifier = ((parts[3] || parts[5] || 1) as number) - 1

    key.ctrl = !!(modifier & 4)
    key.meta = !!(modifier & 2)
    key.super = !!(modifier & 8)
    key.shift = !!(modifier & 1)
    key.code = code

    key.name = keyName[code]
    key.shift = isShiftKey(code) || key.shift
    key.ctrl = isCtrlKey(code) || key.ctrl
  }

  // iTerm in natural text editing mode
  if (key.raw === '\x1Bb') {
    key.meta = true
    key.name = 'left'
  } else if (key.raw === '\x1Bf') {
    key.meta = true
    key.name = 'right'
  }

  switch (s) {
    case '\u001b[1~':
      return createNavKey(s, 'home', false)
    case '\u001b[4~':
      return createNavKey(s, 'end', false)
    case '\u001b[5~':
      return createNavKey(s, 'pageup', false)
    case '\u001b[6~':
      return createNavKey(s, 'pagedown', false)
    case '\u001b[1;5D':
      return createNavKey(s, 'left', true)
    case '\u001b[1;5C':
      return createNavKey(s, 'right', true)
  }

  return key
}

function createNavKey(s: string, name: string, ctrl: boolean): ParsedKey {
  return {
    kind: 'key',
    name,
    ctrl,
    meta: false,
    shift: false,
    option: false,
    super: false,
    fn: false,
    sequence: s,
    raw: s,
    isPasted: false,
  }
}

/**
 * Build a wheel ParsedKey preserving the pointer position and modifier
 * bits from the protocol's button byte (Shift=0x04, Meta/Alt=0x08,
 * Ctrl=0x10 — same bit layout decodeModifier documents).
 */
function createWheelKey(
  s: string,
  name: string,
  col: number,
  row: number,
  button: number,
): ParsedKey {
  return {
    kind: 'key',
    name,
    ctrl: (button & 0x10) !== 0,
    meta: (button & 0x08) !== 0,
    shift: (button & 0x04) !== 0,
    option: false,
    super: false,
    fn: false,
    sequence: s,
    raw: s,
    isPasted: false,
    mouseCol: col,
    mouseRow: row,
    mouseButton: button,
  }
}
