/**
 * Keyboard input parser - converts terminal input to key events
 *
 * Uses the termio tokenizer for escape sequence boundary detection,
 * then interprets sequences as keypresses.
 */
import { Buffer } from 'buffer'
import { fileURLToPath } from 'node:url'
import { isCSIFinal, isCSIIntermediate, isCSIParam, PASTE_END, PASTE_START } from './termio/csi.js'
import { createTokenizer, type Tokenizer } from './termio/tokenize.js'

// eslint-disable-next-line no-control-regex
const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/

// eslint-disable-next-line no-control-regex
const FN_KEY_RE =
  // eslint-disable-next-line no-control-regex
  /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/

// Complete CSI framing, including sequences outside our keyboard vocabulary.
// Keep their identity so InputEvent's unknown-code guard suppresses protocol
// bytes rather than stripping ESC and inserting the parameters as text.
// eslint-disable-next-line no-control-regex
const COMPLETE_CSI_RE = /^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]$/

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
const WIN32_INPUT_PREFIX_RE = /^\x1b\[[\d;]*$/
const WIN32_INPUT_BODY_PREFIX_RE = /^\x1b\[\d*;\d*;\d*;[01]?(?:;\d*){0,2}$/
// A record fits well within 64 bytes (six INPUT_RECORD integer fields).
// Bound both memory and the time ambiguous digits can be held after ESC.
const WIN32_INPUT_MAX_LENGTH = 64
const WIN32_INPUT_GRACE_MS = 1000

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
// Prefix variant (no $ anchor): matches a complete SGR report at the START
// of a longer string, for streaming consumption of "report + suffix" tokens
// (e.g. `;34Mabc` — the terminal batched the tail and the next keystrokes
// into one read). The $-anchored SGR_MOUSE_TAIL_RE above stays for the
// "token is exactly one report" path.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_TAIL_PREFIX_RE = /^\[<\d+;\d+;\d+[Mm]/
// True prefix of an SGR report body (`[<btn;col;row`), including the
// ambiguous 2/3-byte heads `[` and `[<`. Mirrors SGR_MOUSE_RE's grammar
// (three numeric params, final byte excluded) and MUST stay in sync with
// SGR_MOUSE_RE / parseMouseEvent() — the single SGR grammar source for this
// family. Only the provenance-gated head hold below uses it; the pre-existing
// `[<`+digits hold keeps SGR_MOUSE_PREFIX_RE.
const SGR_MOUSE_HEAD_PREFIX_RE = /^\[(?:<(?:\d+(?:;\d*){0,2})?)?$/

// ADR-0007 D4: an ambiguous `[`/`ESC[` head may be claimed this long after a
// REAL mouse report (kind:'mouse') was parsed — the P2 evidence that the user
// is actually using the mouse. 5s is the initial value; on-device calibration
// may retune it (still bounded by the first-capture hold deadline below).
const MOUSE_REPORT_ACTIVITY_MS = 5000
// ADR-0007 D5: gated head holds obey the family's 64-byte bound.
const MOUSE_HEAD_HOLD_MAX_LENGTH = 64

// How long a held SGR mouse prefix waits for its continuation before being
// discarded. The hold sentinel re-arms App's 50ms flush timer, so the hold
// faces a discard decision on every parse call — the lifetime is measured
// from FIRST capture, not "survived this call", or a press split by two
// quiet flushes (>~100ms of SSH jitter / render stall) is destroyed and its
// tail leaks into the prompt as text (field-reproduced: `18;34M` typed
// itself). 1s covers WAN jitter and heavy-render stalls. Digits/semicolons
// typed during that window are indistinguishable from report fragments;
// the deadline bounds this ambiguity. It runs on every call so continuous
// input cannot starve it into a de-facto immortal hold.
const MOUSE_TAIL_HOLD_GRACE_MS = 1000
// How long an unfinished terminal-reply prefix may be held for its
// continuation, and how many bytes of it may accumulate. Same caliber as the
// win32 record hold above: measured from FIRST capture (later flushes must not
// renew it), deadline checked on every parse call, and an over-limit or
// expired hold is released by tokenizer.reset() — protocol bytes are dropped
// rather than leaked into the prompt.
const TERMINAL_RESPONSE_TAIL_GRACE_MS = 1000
const TERMINAL_RESPONSE_MAX_LENGTH = 64

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
// Kitty graphics APC response: ESC_G key=value,...;OK|error ESC\\
// eslint-disable-next-line no-control-regex
const KITTY_GRAPHICS_RE = /^\x1b_G([^;]*);([^\x1b]*)\x1b\\$/
// DECXCPR cursor position: CSI ? row ; col R
// The ? marker disambiguates from modified F3 keys (Shift+F3 = CSI 1;2 R,
// Ctrl+F3 = CSI 1;5 R, etc.) — plain CSI row;col R is genuinely ambiguous.
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_RE = /^\x1b\[\?(\d+);(\d+)R$/
// XTWINOPS pixel-size replies: CSI 6;height;width t (cell) and
// CSI 4;height;width t (text area).
// eslint-disable-next-line no-control-regex
const TERMINAL_PIXEL_SIZE_RE = /^\x1b\[([46]);(\d+);(\d+)t$/
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

/**
 * Terminal control sequences that must never survive into a paste payload.
 *
 * A desktop file DROP reaches the TUI as terminal bytes, not as text: Windows
 * Terminal / OpenConsole hand a dropped path over as an OSC 8 hyperlink
 * (`ESC ] 8 ; <params> ; file:///… ST`), and a `DECSET 9001` (win32-input-mode)
 * host additionally decomposes that payload into per-character key records
 * (see the decomposed-paste matcher below). The hyperlink itself is RESTORED
 * to its local path before this hygiene runs (see `createPasteKey` and the
 * OSC 8 block below); what is stripped here is the rest of the protocol
 * shapes a paste payload can carry.
 *
 * Scope (DESIGN D3, narrowed by measurement): COMPLETE OSC sequences only.
 * CSI sequences, bare ESC bytes and C0 control bytes are deliberately KEPT —
 * a bracketed paste's payload is user data. PR #1142 pins that protocol-shaped
 * literal text (`ESC[1;2;3;1A`) survives byte-for-byte
 * (`scripts/verify-win32-input.tsx`), and the whole C0 band belongs to the
 * COMPOSER: every single-line paste ingress flattens C0/C1 to a SPACE
 * (`flattenPasteInline`), so a C0 byte dropped here does not sanitize
 * anything — it deletes the space the composer owes
 * (`scripts/verify-question-paste.tsx` 1a/1c pin that flattening, TAB/CR/LF
 * and DEL included). The wide strip (CSI + residual ESC) proved mutually
 * exclusive with the #1142 contract.
 */
// eslint-disable-next-line no-control-regex -- deliberate: paste payloads carry terminal sequences
const OSC_IN_PASTE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu
/**
 * Strip the protocol frames one paste payload can carry — see
 * {@link OSC_IN_PASTE} for the exact scope.
 *
 * This is the LAST step of the paste choke point, and it is deliberately the
 * only one: no C0/C1 byte is removed here, because removal is lossy where the
 * composer is not (it flattens those bytes to spaces). The registration that
 * briefly added an inert-C0 strip here was the CI regression that
 * `scripts/verify-question-paste.tsx` 1a/1c caught; `verify-paste-drop`
 * re-pins the surviving side of that contract.
 */
function cleanPastePayload(content: string): string {
  return content.replace(OSC_IN_PASTE, '')
}

function createPasteKey(content: string): ParsedKey {
  // Order is a contract (D6/D1): a complete OSC 8 drop frame is RESTORED to
  // its local path BEFORE the payload hygiene — hygiene strips the very OSC
  // frame the drop is encoded in. Every paste path goes through this ONE
  // choke point (VT bracketed paste, the decomposed win32 paste, and both
  // flush paths), so no caller has to remember the order.
  const dropPath = osc8DropPath(content)
  const text = dropPath === null ? cleanPastePayload(content) : pastePayloadForPath(dropPath)
  return {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: text,
    raw: text,
    isPasted: true,
  }
}

// -- OSC 8 drop frames -------------------------------------------------------
//
// Windows hands a dropped file over as an OSC 8 hyperlink:
//
//   ESC ] 8 ; <params> ; <URI> ( BEL | ST )
//
// `params` is the hyperlink attribute list (`id=16:42`, or empty for the form
// this TUI itself emits) and the URI is everything after the SECOND `;` — a
// URI may legally contain `;`, params may not.
//
// A frame is claimed in the fixed decision order (D6) by
// `claimProtocolSequence`, and — when the frame set was already reassembled
// into one paste body (win32 decomposed paste / VT bracketed paste) — by
// `createPasteKey` before the payload hygiene runs.

/** OSC 8 introducer: `ESC ] 8 ;`. */
const OSC8_FRAME_PREFIX = '\x1b]8;'
/**
 * Longest OSC 8 frame the record accumulator will hold. A drop URI is a local
 * path plus percent-encoding, and the composer's own pasted-path cap is 4096
 * chars (`MAX_PASTED_PATH_CHARS`), so anything beyond this cannot become a
 * usable path and must not extend a hold indefinitely.
 */
const OSC8_FRAME_MAX_LENGTH = 4096

type Osc8Frame = {
  /** Frame URI — '' for a hyperlink CLOSE frame (`ESC ] 8 ; ; …`). */
  uri: string
  /** Offset just past the frame, terminator included when present. */
  end: number
}

/**
 * Read one OSC 8 frame at `offset`. Returns null when the bytes there are not
 * an OSC 8 frame, or when the URI is followed by anything other than a frame
 * terminator (BEL 0x07 / ST `ESC \`) or the start of the next frame.
 *
 * The "next frame" shape matters because the win32 record translator drops
 * BEL outright (a synthesized Uc=7 record carries no key meaning), so a
 * decomposed drop can lose its BEL terminator before the payload is
 * reassembled. A lone frame with neither a terminator nor a successor stays
 * unclaimed: the tail of a truncated stream must not be read as a path.
 */
function readOsc8Frame(payload: string, offset: number): Osc8Frame | null {
  if (!payload.startsWith(OSC8_FRAME_PREFIX, offset)) return null
  const paramsEnd = payload.indexOf(';', offset + OSC8_FRAME_PREFIX.length)
  if (paramsEnd === -1) return null
  const uriStart = paramsEnd + 1
  let uriEnd = uriStart
  while (uriEnd < payload.length && payload[uriEnd] !== '\u0007' && payload[uriEnd] !== '\x1b') {
    uriEnd++
  }
  const uri = payload.slice(uriStart, uriEnd)
  if (payload[uriEnd] === '\u0007') return { uri, end: uriEnd + 1 }
  if (payload.startsWith('\x1b\\', uriEnd)) return { uri, end: uriEnd + 2 }
  if (payload.startsWith(OSC8_FRAME_PREFIX, uriEnd)) return { uri, end: uriEnd }
  return null
}

/**
 * The local path a payload restores to, or null when the payload is NOT a
 * pure OSC 8 frame set or its URI is not a decodable LOCAL file URL. Called
 * with one complete sequence (the decision chain) or with a whole reassembled
 * paste body (the choke point).
 *
 * Fail-closed rules (DESIGN D4 / AC-4):
 * - only `file://` URIs are restored — other schemes fall through to the
 *   normal response/prose handling;
 * - a URI carrying whitespace is multiple tokens, not one path, and is
 *   refused (the same conservative contract as `parsePastedImagePath`);
 * - more than one distinct URI is a multi-file drop, which v1 does not
 *   cover: fail closed rather than silently keep only the first file;
 * - a remote authority (`file://server/share/…`) or a decode failure is
 *   never silently reinterpreted as a local path;
 * - a payload with any trailing non-OSC-8 bytes is NOT a drop and is left to
 *   the hygiene path, so prose that merely quotes a link keeps its text.
 */
function osc8DropPath(payload: string): string | null {
  let offset = 0
  let uri: string | undefined
  while (offset < payload.length) {
    const frame = readOsc8Frame(payload, offset)
    if (frame === null || frame.end <= offset) return null
    if (frame.uri !== '') {
      if (uri !== undefined && uri !== frame.uri) return null
      uri = frame.uri
    }
    offset = frame.end
  }
  if (uri === undefined || /\s/u.test(uri)) return null
  return localPathOfFileUri(uri)
}

/**
 * `file://` URI → local path (percent-escapes decoded by `fileURLToPath`), or
 * null when the URI is not a local file URL or decoding fails.
 */
function localPathOfFileUri(uri: string): string | null {
  if (!/^file:\/\//iu.test(uri)) return null
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  // A non-empty authority is a remote share (UNC): refuse it instead of
  // letting `fileURLToPath` reinterpret it as a local path on hosts that
  // ignore the authority. `localhost` is this machine.
  if (url.host !== '' && url.host !== 'localhost') return null
  try {
    return fileURLToPath(url)
  } catch {
    return null
  }
}

/**
 * The paste payload for a restored drop path. `parsePastedImagePath` accepts
 * exactly one whitespace-free token, or the whole payload quoted — and a drop
 * is ONE unambiguous file, so a path containing whitespace is handed over in
 * the quoted single-token form the composer already documents
 * (`@"my dir/a.ts"` is the mention spelling of the same shape). A path no
 * quote can represent (a literal `"`) stays bare: the composer then inserts
 * it verbatim, which is the pre-existing fail-closed behaviour for ambiguous
 * tokens. Windows paths cannot contain `"`, so on this platform the quoted
 * form is exactly the decoded path.
 */
function pastePayloadForPath(path: string): string {
  if (!/[\s"]/u.test(path)) return path
  return path.includes('"') ? path : `"${path}"`
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
  /** Kitty graphics protocol response to an a=q capability query. */
  | { type: 'kittyGraphics'; imageId: number; status: string }
  /** DSR: cursor position report (answer to CSI 6 n) */
  | { type: 'cursorPosition'; row: number; col: number }
  /** XTWINOPS: physical pixels for one cell or the terminal text area. */
  | {
      type: 'terminalPixelSize'
      scope: 'cell' | 'window'
      height: number
      width: number
    }
  /** OSC response: generic operating-system-command reply (e.g. OSC 11 bg color) */
  | { type: 'osc'; code: number; data: string }
  /** XTVERSION: terminal name/version string (answer to CSI > 0 q).
   *  Example values: "xterm.js(5.5.0)", "ghostty 1.2.0", "iTerm2 3.6". */
  | { type: 'xtversion'; name: string }

// Unfinished prefixes of every reply shape parseTerminalResponse() knows.
// MUST be kept in sync with the pattern list above: a reply type added there
// needs an alternative here too, or a ConPTY-split tail of that shape is
// released at the flush and leaks into the prompt as literal text.
//   ESC [ ? …              DA1 / kitty flags / DECXCPR / DECRPM
//   ESC [ ? … $            DECRPM's `$y` intermediate byte
//   ESC [ > …              DA2
//   ESC [ digits [; digits]  DSR (row;col) and XTWINOPS pixel-size replies
//   ESC [ … $              a `$`-intermediate CSI awaiting its final byte
//   ESC P > | …            XTVERSION (DCS)
// Only PREFIXES are matched; completeness is always decided by
// parseTerminalResponse(), never by this regex. Introducer-only prefixes
// (`ESC [`, `ESC P`) are deliberately excluded: they are indistinguishable
// from ordinary key input, and holding the bare `ESC [` swallowed
// `ESC[`+letter input in the #1073 review.
// eslint-disable-next-line no-control-regex
const TERMINAL_RESPONSE_PREFIX_RE =
  /^(?:\x1b\[\?[\d;]*\$?|\x1b\[>[\d;]*|\x1b\[[\d;]*\$|\x1b\[\d+(?:;\d+)*|\x1bP>\|)/

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

    if ((m = TERMINAL_PIXEL_SIZE_RE.exec(s))) {
      return {
        type: 'terminalPixelSize',
        scope: m[1] === '6' ? 'cell' : 'window',
        height: parseInt(m[2]!, 10),
        width: parseInt(m[3]!, 10),
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

  if (s.startsWith('\x1b_G')) {
    const m = KITTY_GRAPHICS_RE.exec(s)
    if (m) {
      const imageId = m[1]!
        .split(',')
        .map(field => field.split('=', 2))
        .find(([key]) => key === 'i')?.[1]
      if (imageId !== undefined && /^\d+$/u.test(imageId)) {
        return {
          type: 'kittyGraphics',
          imageId: parseInt(imageId, 10),
          status: m[2]!,
        }
      }
    }
  }

  return null
}

// Unfinished prefixes of the reply shapes parseTerminalResponse() accepts,
// paired with the response type they can still complete into. This is the
// shape half of the claim gate: a held reply fragment is only joined to its
// continuation while one of these types is actually expected by a pending
// query (terminalExpectedResponseTypes). The patterns are deliberately
// tighter than TERMINAL_RESPONSE_PREFIX_RE: `?` + two params can still grow
// into a DA1 but never into a DECRPM (`?mode;status$y` has exactly two
// params), so a DA1-shaped fragment is released as literal text as soon as
// only DECRPM is in flight. `parseTerminalResponse` remains the only
// authority on completeness.
// eslint-disable-next-line no-control-regex
const INCOMPLETE_RESPONSE_PREFIXES: ReadonlyArray<
  readonly [TerminalResponse['type'], RegExp]
> = [
  // DA1: any `?`-parameter list (including the bare introducer).
  ['da1', /^\x1b\[\?[\d;]*$/],
  // DECRPM: `?mode;status` before the `$` intermediate, then the same before
  // `$` + final.
  ['decrpm', /^\x1b\[\?\d*(?:;\d*)?$/],
  ['decrpm', /^\x1b\[\?\d+;\d+\$$/],
  // Kitty flags and DECXCPR: one `?` + at most two numeric params.
  ['kittyKeyboard', /^\x1b\[\?\d*$/],
  ['cursorPosition', /^\x1b\[\?\d*(?:;\d*)?$/],
  // DA2: any `>`-parameter list.
  ['da2', /^\x1b\[>[\d;]*$/],
  // XTWINOPS: `6;h;w t` / `4;h;w t`, up to the final byte.
  ['terminalPixelSize', /^\x1b\[[46](?:;\d*){0,2}$/],
  // XTVERSION: `P>` can still gain `|` and a payload; ST's ESC may flush.
  ['xtversion', /^\x1bP>(?:\|[^\x1b]*(?:\x1b)?)?$/],
]

/**
 * Response types an unfinished reply-shaped candidate could still complete
 * into, judged from its introducer and parameter bytes alone. Empty means
 * the bytes cannot become a known reply (either a final byte already ended a
 * different sequence, or the shape is unknown) and must stay literal.
 * @param candidate - the inbound bytes, with the ESC introducer synthesized.
 * @returns the types a continuation could still produce.
 */
function possibleResponseTypes(
  candidate: string,
): Set<TerminalResponse['type']> {
  const types = new Set<TerminalResponse['type']>()
  for (const [type, pattern] of INCOMPLETE_RESPONSE_PREFIXES) {
    if (pattern.test(candidate)) types.add(type)
  }
  return types
}

/**
 * Whether an unfinished candidate can still become a response the host is
 * currently waiting for. Both halves are required: an in-flight query of the
 * matching type, and a shape that can still produce it.
 */
function expectsResponseType(
  candidate: string,
  expected: ReadonlySet<TerminalResponse['type']>,
): boolean {
  for (const type of possibleResponseTypes(candidate)) {
    if (expected.has(type)) return true
  }
  return false
}

/**
 * Find the shortest complete terminal response at the head of a post-flush
 * tail whose introducer ESC was already flushed as a key. The caller
 * synthesizes the ESC back; `parseTerminalResponse` decides completeness, so
 * only a type the host expects is claimed and trailing bytes are left for
 * ordinary parsing.
 * @param tail - fragment without its ESC introducer.
 * @param expected - response types of the queries still awaiting a reply.
 * @returns the claimed response and how many bytes of `tail` it consumed, or
 *   undefined when no expected reply completes at the head.
 */
function claimExpectedResponseHead(
  tail: string,
  expected: ReadonlySet<TerminalResponse['type']>,
): { response: TerminalResponse; consumed: number } | undefined {
  const limit = Math.min(tail.length, TERMINAL_RESPONSE_MAX_LENGTH)
  for (let consumed = 2; consumed <= limit; consumed++) {
    const head = '\x1b' + tail.slice(0, consumed)
    const response = parseTerminalResponse(head)
    if (response) {
      return expected.has(response.type)
        ? { response, consumed }
        : undefined
    }
    // A head that can no longer become an expected reply ends the scan:
    // longer candidates extend a shape that is already closed or unknown.
    if (!expectsResponseType(head, expected)) return undefined
  }
  return undefined
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
  /**
   * True when the last character appended to `buffer` came from a CR record
   * (Uc=13). Classic conhost spells a pasted CRLF break as a CR record
   * followed by an LF record (Uc=10); the LF half must fold into the CR's
   * newline instead of appending a second one (issue #1090).
   */
  lastWasCarriageReturn: boolean
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
 * Uc field of the raw win32 record behind `key`, or undefined when the key
 * did not come from one (the decomposed stream also carries plain keys).
 */
function win32RecordUc(key: ParsedKey): number | undefined {
  const match = WIN32_INPUT_RE.exec(key.raw ?? '')
  if (!match) return undefined
  const field = match[1]!.split(';')[2]
  return field === undefined || field === '' ? 0 : parseInt(field, 10)
}

/**
 * Append one paste-body key to the decomposed-paste buffer. Classic conhost
 * spells a pasted CRLF break as two records — CR (Uc=13) then LF (Uc=10) —
 * and the LF must fold into the CR's newline instead of appending a second
 * one (issue #1090). Only a CR record arms the fold, so LF-only text, a lone
 * CR, and ordinary characters (including a real `_`) keep their bytes.
 */
function appendWin32PasteChar(state: Win32PasteState, key: ParsedKey): void {
  const ch = win32RecordChar(key)
  if (ch === undefined) return
  if (ch !== '\n') {
    state.lastWasCarriageReturn = false
    state.buffer += ch
    return
  }
  const uc = win32RecordUc(key)
  if (uc === 10 && state.lastWasCarriageReturn) {
    // LF record closing the CRLF pair: the CR already emitted the newline.
    state.lastWasCarriageReturn = false
    return
  }
  state.lastWasCarriageReturn = uc === 13
  state.buffer += '\n'
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
        state.lastWasCarriageReturn = false
        return []
      }
      // End marker complete: the whole paste as a single event.
      const paste = createPasteKey(state.buffer)
      state.active = false
      state.buffer = ''
      state.lastWasCarriageReturn = false
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
      for (const k of held) appendWin32PasteChar(state, k)
      return feedWin32Paste(state, key)
    }
    return [...held, ...feedWin32Paste(state, key)]
  }

  if (state.active) {
    appendWin32PasteChar(state, key)
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

/**
 * The ONE decision chain for a complete reassembled terminal sequence. The
 * order is a contract (DESIGN D6) and must not be permuted:
 *
 *   1. OSC 8 drop frame — a dropped file's hyperlink. It must win over the
 *      OSC response shape in step 2, which also matches `ESC ] 8 ; …` and
 *      used to swallow the whole link as a bogus terminal reply (#1067).
 *   2. terminal response — DECRPM/DA/OSC replies to our own queries
 *      (#1177's type-bound claiming).
 *   3. mouse report — SGR (1006), with the X10 report as the legacy
 *      compatibility fallback.
 *
 * A sequence that falls through all three is a record body or a keypress, and
 * only the caller can tell which (`parseReassembledWin32Protocol` for records,
 * the token loop for VT input), so that dispatch stays with the caller.
 */
function claimProtocolSequence(sequence: string): ParsedInput | null {
  const dropPath = osc8DropPath(sequence)
  if (dropPath !== null) {
    // Hand the local path to the ONE paste choke point (D2), so the existing
    // image stage / `@` reference pipeline sees a normal paste.
    return createPasteKey(pastePayloadForPath(dropPath))
  }

  const response = parseTerminalResponse(sequence)
  if (response) return { kind: 'response', sequence, response }

  return parseMouseEvent(sequence) ?? parseX10MouseEvent(sequence)
}

function parseReassembledWin32Protocol(sequence: string): ParsedInput | null {
  // Fixed decision order (D6) — see claimProtocolSequence.
  const claimed = claimProtocolSequence(sequence)
  if (claimed) return claimed

  if (SGR_MOUSE_RE.test(sequence) || (sequence.length === 6 && sequence.startsWith('\x1b[M'))) {
    return parseKeypress(sequence)
  }
  return null
}

/** Release every key held for the current candidate sequence. */
function releaseWin32ProtocolHold(state: Win32ProtocolState): ParsedKey[] {
  const held = state.held
  state.held = []
  state.sequence = ''
  return held
}

/**
 * Resolve one accumulated protocol candidate. An array is the dispatch result
 * (empty while the frame is still incomplete); null means the bytes are not a
 * protocol shape we may hold, and the caller releases its keys.
 *
 * Order and bounds are the existing contract (#1142/#1177) with the OSC 8
 * drop frame (D1) added FIRST: under win32-input-mode a drop can arrive as
 * per-character synthesized records without bracketed-paste markers, so the
 * hyperlink has to be reassembled here, ahead of any response/mouse claim.
 * Holding past the introducer also keeps it away from
 * `parseTerminalResponse`, whose OSC shape would otherwise take
 * `ESC ] 8 ; …` as a bogus reply and swallow the dropped path (#1067).
 * The OSC terminator is BEL or ST with its own length cap: a BEL record has
 * no key meaning and is dropped by the translator, so a decomposed frame can
 * lose its BEL — such a frame is released by the flush bound like any other
 * abandoned sequence.
 */
function resolveWin32ProtocolCandidate(
  state: Win32ProtocolState,
  sequence: string,
  ch: string,
): ParsedInput[] | null {
  if (sequence === '\x1b' || sequence === '\x1b[') return []

  if (sequence.startsWith('\x1b]')) {
    const terminated = sequence.endsWith('\u0007') || sequence.endsWith('\x1b\\')
    if (!terminated) return sequence.length <= OSC8_FRAME_MAX_LENGTH ? [] : null
    const held = releaseWin32ProtocolHold(state)
    const parsed = parseReassembledWin32Protocol(sequence)
    return parsed ? [parsed] : held
  }

  if (!sequence.startsWith('\x1b[') || sequence.length > 64) return null

  if (sequence.startsWith('\x1b[M')) {
    if (sequence.length < 6) return []
    const held = releaseWin32ProtocolHold(state)
    const parsed = sequence.length === 6
      ? parseReassembledWin32Protocol(sequence)
      : null
    return parsed ? [parsed] : held
  }

  const code = ch.charCodeAt(0)
  if ((code >= 0x20 && code <= 0x3f)) return []
  if (code >= 0x40 && code <= 0x7e) {
    const held = releaseWin32ProtocolHold(state)
    const parsed = parseReassembledWin32Protocol(sequence)
    return parsed ? [parsed] : held
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
    const held = releaseWin32ProtocolHold(state)
    return [...held, ...feedWin32Protocol(state, key)]
  }

  state.held.push(key)
  state.sequence += ch
  return (
    resolveWin32ProtocolCandidate(state, state.sequence, ch) ??
    releaseWin32ProtocolHold(state)
  )
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
   * Host-injected platform gate: this machine MIGHT run the private win32
   * input mode (`supportsWin32InputMode()`). Read-only — capability alone is
   * not evidence and never lights anything by itself; only an explicit
   * `false` closes the gate, and leaving the field absent keeps the parser's
   * pre-gate behavior for direct callers.
   */
  win32Capable?: boolean
  /**
   * Lit by successfully decoding a win32 record. Only behind that evidence
   * may a plain `ESC[` fragment extend the hold (see isRecordPrefix).
   */
  win32InputMode?: boolean
  /** First capture of a buffered win32 record; never renewed by flushes. */
  win32InputStartedAt?: number
  /** A flushed lone ESC may be followed by an ESC-less record fragment. */
  win32EscFlushedAt?: number
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
   * the next chunk completes it (resynthesis) or it is invalidated — typed
   * `[`-led text never matches the guard pattern and passes through. A gated
   * hold (mouseTailHoldReleasable === true) is RELEASED as ordinary keys on
   * invalidation (ADR-0007 D5); a legacy hold keeps the pre-gate discard.
   * A hold never survives evidence that its report died: report bytes are
   * contiguous on the wire, so a fresh ESC sequence, a complete mouse
   * report, or text that cannot continue the pattern all invalidate it.
   */
  mouseTailHold?: string
  /**
   * Date.now() of the FIRST capture of the current mouseTailHold. The hold
   * is discarded once this age exceeds MOUSE_TAIL_HOLD_GRACE_MS — checked at
   * the top of EVERY parse call, not only on flush: continuous input keeps
   * re-arming App's 50ms flush timer, so a flush-only check may never run
   * while the user types. Surviving a single quiet flush is not enough
   * either (the sentinel re-arms the timer, so the next quiet flush would
   * otherwise kill a slow split).
   */
  mouseTailHoldAt?: number
  /**
   * Host-injected evidence (ADR-0007 D2): the terminal may emit SGR mouse
   * reports — `<AlternateScreen mouseTracking>` is in effect. App re-injects
   * it on every `processInput` from Ink's `altScreenMouseTracking`; the
   * parser only reads it. Absent keeps the pre-gate behavior for direct
   * callers, explicit `false` closes the gate (no shape is claimed).
   */
  mouseReportingActive?: boolean
  /**
   * Date.now() of the most recent successfully decoded mouse report
   * (`kind:'mouse'`). The ambiguous `[`/`ESC[` head (ADR-0007 D4, evidence P2)
   * is only claimed while a real report is inside MOUSE_REPORT_ACTIVITY_MS.
   */
  lastMouseReportAt?: number
  /**
   * True when the current `mouseTailHold` was claimed through the injected
   * mouseReportingActive gate: expiry/overflow RELEASES the held bytes as
   * ordinary keys (ADR-0007 D5). Untracked legacy shape-specific holds (direct
   * callers that never inject the gate) keep the pre-gate silent discard.
   */
  mouseTailHoldReleasable?: boolean
  /**
   * Transport-level evidence for the ambiguous 2-byte `ESC[` head (ADR-0007
   * D4 addendum): `ESC[` when BOTH bytes were buffered inside ONE non-flush
   * read starting from an empty tokenizer buffer. Human two-stroke typing
   * (Esc, then `[`) cannot land in one read, so this is protocol-head shape
   * evidence that grants the P1 claim without P2; the head accumulated across
   * reads leaves this unset and still needs P2. Parser-internal only — App
   * never injects it. Consumed (and cleared) by the next parse call.
   */
  mouseHeadSingleRead?: string
  /**
   * Date.now() of the most recent flush that emitted a lone Escape key from an
   * incomplete terminal sequence. Any text chunk inside the window may be that
   * sequence's delayed tail — the bound is time (TERMINAL_RESPONSE_TAIL_GRACE_MS),
   * not just the chunk that follows the flush.
   */
  terminalResponseTailAfterEscFlushAt?: number
  /**
   * Date.now() of the FIRST capture of the reply prefix currently held open
   * across flushes (see TERMINAL_RESPONSE_TAIL_GRACE_MS). Later flushes and
   * continuations never renew it; the hold is released — bytes dropped — once
   * it expires or its in-flight claim disappears. Parser-maintained, like
   * mouseTailHoldAt; never host-injected.
   */
  terminalResponseHoldAt?: number
  /**
   * Parser-maintained reply fragment held across calls after its introducer
   * ESC was already flushed as a standalone key (a ConPTY split that lands
   * mid-tail). The fragment has the synthesized ESC removed; the next text
   * chunk may complete it. It lives only inside the
   * terminalResponseTailAfterEscFlushAt window and is dropped — never
   * emitted as text — once that window closes, the evidence disappears or
   * the fragment stops being reply-shaped.
   */
  terminalResponseReattachTail?: string
  /**
   * Host-injected, read-only in-flight evidence for terminal-query replies:
   * the response types of the queries still awaiting a reply
   * (querier.pendingResponseTypes). A reply is only claimed while one of
   * these types is both expected and shape-compatible with the bytes; an
   * absent or empty list means no evidence, so the parser never claims a
   * response tail and direct callers keep the pre-gate behavior. The host
   * re-injects it on every call, so a settled query stops counting at once.
   */
  terminalExpectedResponseTypes?: readonly TerminalResponse['type'][]
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
 * @param input - the input chunk; null applies the escape timeout (in-flight
 * win32 records keep their bounded recovery grace).
 * @returns the parsed inputs plus the state to pass to the next call.
 */
export function parseMultipleKeypresses(
  prevState: KeyParseState,
  input: Buffer | string | null = '',
): [ParsedInput[], KeyParseState] {
  const isFlush = input === null
  let inputString = isFlush ? '' : inputToString(input)

  // Get or create tokenizer
  const tokenizer = prevState._tokenizer ?? createTokenizer({
    x10Mouse: true,
    splitInputControls: true,
  })

  // Keep record framing in the tokenizer, rather than converting a timed-out
  // prefix into a key and trying to scrub its text later (#827). The host
  // capability flag only says the platform MIGHT run the private mode; only a
  // decoded record proves it does, so the two stay separate: a frame whose
  // own shape is already record-specific holds on its own (that is how even
  // the first record survives a split), and anything else needs an open gate
  // plus a lit parser. A lone ESC therefore keeps its 50ms behavior on hosts
  // that ignore DECSET 9001, and bracketed-paste payloads remain literal.
  let win32InputMode = prevState.win32InputMode ?? false
  let win32InputStartedAt = prevState.win32InputStartedAt
  let win32EscFlushedAt = prevState.win32EscFlushedAt
  let inPaste = prevState.mode === 'IN_PASTE'
  const now = Date.now()
  // Gate × evidence. The nullish default keeps direct callers that never
  // inject the flag on the pre-gate behavior.
  const win32HoldAllowed = (prevState.win32Capable ?? true) && win32InputMode
  const isRecordPrefix = (value: string): boolean =>
    !inPaste && WIN32_INPUT_PREFIX_RE.test(value) &&
    (WIN32_INPUT_BODY_PREFIX_RE.test(value) || win32HoldAllowed)
  // Evidence is the live query lifecycle, not a recency window: the host
  // injects the response types of the queries still awaiting an answer, and
  // a reply is only ever claimed when its shape can complete into one of
  // them. Read-only here and re-read on every call, so a query that settles
  // (matched reply, sentinel drain, dispose) stops authorizing immediately.
  const expectedResponseTypes = new Set(
    prevState.terminalExpectedResponseTypes ?? [],
  )
  const hasQueryEvidence = expectedResponseTypes.size > 0
  // A buffer that is already reply-specific (TERMINAL_RESPONSE_PREFIX_RE) is
  // eligible to be held open for its continuation — but only with the
  // host-injected in-flight-query evidence (D1) AND a shape/type match (D2).
  // Record framing is judged first (D6): every numeric CSI prefix the record
  // branch can frame belongs to it, and this predicate never re-labels one.
  // Without evidence nothing is held, so a direct caller that never injects
  // it keeps the pre-gate behavior (D7 / AC-3). Paste payloads stay literal,
  // exactly like the record branch above.
  const isResponsePrefix = (value: string): boolean =>
    !isRecordPrefix(value) && !inPaste && TERMINAL_RESPONSE_PREFIX_RE.test(value)

  if (win32InputStartedAt !== undefined && now - win32InputStartedAt >= WIN32_INPUT_GRACE_MS) {
    tokenizer.reset()
    win32InputStartedAt = undefined
  }
  if (win32EscFlushedAt !== undefined && now - win32EscFlushedAt >= WIN32_INPUT_GRACE_MS) {
    win32EscFlushedAt = undefined
  }
  // Tracks the win32 ESC-flush recovery below: a reconstructed `ESC` byte is
  // NOT transport evidence for the single-read `ESC[` claim (F-2) — the ESC
  // came from an earlier read's flush, i.e. exactly the two-stroke typing the
  // P2 gate exists for.
  let win32EscPrepended = false
  // Same deadline discipline for the reply-prefix hold: first capture only,
  // checked on every call (not just on flush, so continuous input cannot
  // starve it), and released by resetting the tokenizer — bytes dropped, the
  // same caliber as the win32 record hold, never leaked into the prompt.
  let terminalResponseHoldAt = prevState.terminalResponseHoldAt
  if (
    terminalResponseHoldAt !== undefined &&
    now - terminalResponseHoldAt >= TERMINAL_RESPONSE_TAIL_GRACE_MS
  ) {
    if (isResponsePrefix(tokenizer.buffer())) tokenizer.reset()
    terminalResponseHoldAt = undefined
  }
  if (inputString && win32EscFlushedAt !== undefined) {
    // Only the immediate continuation of an actual ESC flush may acquire
    // a missing introducer. Never capture arbitrary '['-led user text.
    if (
      prevState.mode !== 'IN_PASTE' && tokenizer.buffer() === '' &&
      /^\[(?:[\d;]|$)/.test(inputString) &&
      (WIN32_INPUT_BODY_PREFIX_RE.test('\x1b' + inputString) || win32HoldAllowed)
    ) {
      inputString = '\x1b' + inputString
      win32EscPrepended = true
    }
    win32EscFlushedAt = undefined
  }

  const pending = tokenizer.buffer()
  if (isRecordPrefix(pending) && inputString) {
    const continuation = /^[\d;]*/.exec(inputString)![0]
    const final = inputString[continuation.length]
    const code = final?.charCodeAt(0)
    // A numeric prefix is not proof of Win32 framing: even four or more
    // parameters can belong to another CSI. Let the tokenizer consume valid
    // parameter/intermediate/final bytes; only an invalid continuation can
    // abandon the old frame. A bare ASCII letter may therefore end the CSI,
    // not start user text. Native Win32 typing supplies a fresh ESC record.
    if (
      code !== undefined &&
      !isCSIParam(code) && !isCSIIntermediate(code) && !isCSIFinal(code)
    ) {
      tokenizer.reset()
      win32InputStartedAt = undefined
      if (final === '\x1b') inputString = inputString.slice(continuation.length)
    }
  }

  // Two independent reasons to keep the tokenizer's buffer across a flush:
  // the #1142 record frame (win32), and an unfinished reply prefix when the
  // host reports a query in flight (D1 × D2). Each keeps its own bound (D6);
  // an over-limit buffer is dropped exactly like #1142 drops an oversized
  // record frame.
  const recordPrefix = isRecordPrefix(tokenizer.buffer())
  // Evidence is re-read on every call, never latched: once the host stops
  // reporting a query in flight — or the buffer's shape can no longer
  // complete into a response type it expects — the claim ends. A captured
  // hold is then dropped by the release branch below instead of being
  // flushed into the body (no evidence, no claim).
  const claimsResponsePrefix =
    hasQueryEvidence &&
    isResponsePrefix(tokenizer.buffer()) &&
    expectsResponseType(tokenizer.buffer(), expectedResponseTypes)
  let deferFlush = isFlush && (recordPrefix || claimsResponsePrefix)
  if (
    deferFlush &&
    tokenizer.buffer().length >
      (recordPrefix ? WIN32_INPUT_MAX_LENGTH : TERMINAL_RESPONSE_MAX_LENGTH)
  ) {
    tokenizer.reset()
    deferFlush = false
  }
  // Tokenizer buffer entering THIS call — captured before feed so the
  // single-read `ESC[` evidence below cannot be granted to a head whose ESC
  // or `[` was buffered by an earlier call.
  const pendingBeforeFeed = tokenizer.buffer()
  // First capture only: later flushes (App re-arms its timer while
  // `incomplete` is set) must not renew the deadline.
  if (deferFlush && claimsResponsePrefix) terminalResponseHoldAt ??= now
  // A captured hold can lose its authorization before the flush: the host
  // re-injects the pending set on every call, so a query that settles (or a
  // shape that evolves out of the expected types) turns claimsResponsePrefix
  // false. Falling back to tokenizer.flush() there would hand the buffered
  // reply prefix to parseKeypress() as a key/literal text. Drop it like the
  // expiry path instead and end the hold. Both the captured timestamp and
  // the reply shape are required: bytes that were never held keep the
  // pre-gate release semantics (AC-3).
  const releaseResponseHold =
    isFlush &&
    terminalResponseHoldAt !== undefined &&
    isResponsePrefix(tokenizer.buffer()) &&
    !claimsResponsePrefix
  if (releaseResponseHold) {
    tokenizer.reset()
    terminalResponseHoldAt = undefined
  }
  const tokens = isFlush
    ? deferFlush || releaseResponseHold ? [] : tokenizer.flush()
    : tokenizer.feed(inputString)
  // ADR-0007 D4 addendum (F-2): grant the ambiguous `ESC[` head P1-only claim
  // when both bytes were buffered inside this one non-flush read from an empty
  // buffer. Set here, consumed by the flush call that emits it, then cleared
  // (a flush feeds nothing). Cross-read accumulation leaves it unset → P2.
  const mouseHeadSingleRead =
    !isFlush && !win32EscPrepended && pendingBeforeFeed === '' && tokenizer.buffer() === '\x1b['
      ? '\x1b['
      : undefined
  if (isFlush && !inPaste && tokens.some(token => token.value === '\x1b')) {
    win32EscFlushedAt = now
  }

  // Convert tokens to parsed keys, handling paste mode
  const keys: ParsedInput[] = []
  let pasteBuffer = prevState.pasteBuffer
  // Surrogate-pair scratch for win32-input-mode records. Threaded through a
  // local object so prevState is never mutated — callers can seed the parser
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
    lastWasCarriageReturn: false,
  }
  const win32Protocol: Win32ProtocolState = prevState.win32Protocol ?? {
    held: [],
    sequence: '',
  }
  // Pending fragmented SGR mouse prefix (see KeyParseState.mouseTailHold).
  let mouseTailHold: string | undefined = prevState.mouseTailHold
  // First-capture timestamp of the current hold — the discard is time-based
  // (MOUSE_TAIL_HOLD_GRACE_MS), not per-call: the hold sentinel re-arms
  // App's 50ms flush timer, so a per-call flag would still let the SECOND
  // quiet flush kill a press split by >~100ms (observed over SSH).
  let mouseTailHoldAt: number | undefined = prevState.mouseTailHoldAt
  const terminalResponseTailAfterEscFlushAt =
    prevState.terminalResponseTailAfterEscFlushAt
  // Fragment of a reply whose introducer ESC was already flushed as a key,
  // held across calls until the rest of its shape arrives (see
  // KeyParseState.terminalResponseReattachTail).
  let terminalResponseReattachTail: string | undefined =
    prevState.terminalResponseReattachTail
  // Re-attach (D3b, handed over from #796): a lone Escape was genuinely
  // flushed, so a text token inside the window may be the rest of a reply
  // that lost its introducer. Claim it only inside the bounded window AND
  // with a query in flight whose expected response type the shape can still
  // complete into — the missing gate CodeRabbit flagged on #796.
  // parseTerminalResponse() remains the completeness authority; bytes whose
  // shape matches no expected type stay literal, and without injected
  // evidence this branch never fires (AC-3).
  // Bounded by TIME, not by "the next call": a burst can interleave a chunk
  // between the flush and the tail (another reply answering an earlier query,
  // or a keystroke), and the real-ConPTY dry run leaked the tail when that
  // chunk closed the window early.
  const mayRecoverTerminalResponseTail =
    hasQueryEvidence &&
    terminalResponseTailAfterEscFlushAt !== undefined &&
    Date.now() - terminalResponseTailAfterEscFlushAt <= TERMINAL_RESPONSE_TAIL_GRACE_MS
  // Carry that stamp under the same discipline while it is still in-window,
  // and drop it once it expires (or the evidence is gone) so no stale window
  // survives — the #1142 record window above carries its own stamp the same way.
  const carryTailAfterEscFlush = mayRecoverTerminalResponseTail
    ? terminalResponseTailAfterEscFlushAt
    : undefined
  // A closed window also drops the fragment it was holding: those bytes
  // cannot be joined to a reply any more, and protocol-shaped bytes are
  // dropped rather than shown.
  if (carryTailAfterEscFlush === undefined) terminalResponseReattachTail = undefined

  // Claim provenance of the current hold (see KeyParseState docs): true =
  // gated (RELEASE on expiry/overflow), false = legacy silent discard,
  // undefined = no hold.
  let mouseTailHoldReleasable: boolean | undefined =
    prevState.mouseTailHoldReleasable
  let lastMouseReportAt = prevState.lastMouseReportAt
  const clearMouseTailHold = (): void => {
    mouseTailHold = undefined
    mouseTailHoldAt = undefined
    mouseTailHoldReleasable = undefined
  }

  // Evidence gate for the SGR head family (ADR-0007 D2/D4). App injects
  // mouseReportingActive on every processInput; absent keeps direct callers on
  // the pre-gate `[<`+digits hold, explicit `false` claims nothing, explicit
  // `true` also allows the ambiguous `[`/`[<` heads — with `[`/`ESC[` needing
  // a real report inside MOUSE_REPORT_ACTIVITY_MS (P2 evidence).
  const mouseClaim =
    prevState.mouseReportingActive === true
      ? 'gated'
      : prevState.mouseReportingActive === false
        ? 'closed'
        : 'legacy'
  const mouseReportActivityLive = (): boolean =>
    lastMouseReportAt !== undefined &&
    now - lastMouseReportAt <= MOUSE_REPORT_ACTIVITY_MS
  /**
   * Decide whether `body` (a token with any leading ESC stripped) is an SGR
   * report head this parser may hold. `undefined` = ordinary input (no claim);
   * otherwise `releasable` says whether invalidation RELEASES the bytes
   * (gated claim) or silently discards them (legacy shape-specific claim).
   * `singleReadHead` = the `ESC[` body was formed inside ONE read (transport
   * evidence, ADR-0007 D4 addendum) and therefore counts as P1 evidence.
   */
  const claimSgrHead = (
    body: string,
    singleReadHead = false,
  ): { releasable: boolean } | undefined => {
    if (mouseClaim === 'closed') return undefined
    if (SGR_MOUSE_PREFIX_RE.test(body))
      return { releasable: mouseClaim === 'gated' }
    // The ambiguous 1/2-byte heads exist only for the gated family; legacy
    // callers keep the pre-gate behavior (plain text).
    if (mouseClaim !== 'gated') return undefined
    if (body === '[<') return { releasable: true }
    // `[`/`ESC[` (D4): without a recent real report this stays ordinary text
    // (the pre-fix Esc+`[` behavior) unless both bytes arrived in one read —
    // human two-stroke typing cannot do that (F-2).
    if (body === '[')
      return mouseReportActivityLive() || singleReadHead ? { releasable: true } : undefined
    return undefined
  }

  /**
   * Single invalidation/RELEASE entry (F-6): a gated hold is replayed as
   * ordinary keys in arrival order (ADR-0007 D5); a legacy hold keeps the
   * pre-gate silent discard. Every invalidation, including an unrelated
   * protocol boundary, funnels through here; only successful completion of
   * the held report clears it without replay.
   */
  const releaseHeldMouseHead = (): void => {
    if (mouseTailHold === undefined) return
    if (mouseTailHoldReleasable === true) keys.push(parseKeypress(mouseTailHold))
    clearMouseTailHold()
  }
  /** Hard deadline + gated size bound, checked at the top of EVERY call. */
  const shouldReleaseHold = (): boolean =>
    mouseTailHold !== undefined &&
    (now - (mouseTailHoldAt ?? 0) > MOUSE_TAIL_HOLD_GRACE_MS ||
      (mouseTailHoldReleasable === true &&
        mouseTailHold.length > MOUSE_HEAD_HOLD_MAX_LENGTH))

  // Hard deadline + size bound, checked at the top of EVERY call — not only on
  // flush. Continuous input keeps cancelling and re-arming App's 50ms flush
  // timer, so a flush-only check can starve while the user types: a hold past
  // its grace would then still merge a late `;34M` (or plain digits) into a
  // phantom report. A gated hold RELEASES its bytes as ordinary keys instead
  // of dropping them (ADR-0007 D5); legacy holds keep the pre-gate discard.
  if (shouldReleaseHold()) releaseHeldMouseHead()

  // Mutable token queue: a text token that starts with the completion of
  // the CURRENT hold but carries trailing bytes is split in-place — the
  // completion tail is consumed now, the suffix is pushed back for the
  // next iteration (it may itself be another protocol prefix, a win32
  // tail, or ordinary typing). This avoids both re-feeding the tokenizer
  // with already-tokenized bytes AND the stale-hold pre-expansion bug
  // (a response/CSI/paste earlier in the same batch may have cleared the
  // hold before the tail-shaped text token is reached).
  const tokenQueue: Array<{ type: 'sequence' | 'text'; value: string }> = [...tokens]

  for (let qi = 0; qi < tokenQueue.length; qi++) {
    const token = tokenQueue[qi]!
    if (token.type === 'sequence') {
      // Once the DCS introducer ESC has timed out, the tokenizer emits an
      // XTVERSION tail as text but its ST/BEL terminator as a sequence. Join
      // that terminator before treating it as an unrelated key. A lone ST
      // introducer ESC may itself time out before the trailing backslash.
      const heldTail = terminalResponseReattachTail
      if (
        heldTail !== undefined &&
        heldTail.startsWith('P>|') &&
        mayRecoverTerminalResponseTail &&
        expectedResponseTypes.has('xtversion')
      ) {
        if (token.value === '\x1b' && heldTail.length + 3 <= TERMINAL_RESPONSE_MAX_LENGTH) {
          terminalResponseReattachTail = heldTail + '\x1b'
          win32EscFlushedAt = undefined
          continue
        }
        if (token.value === '\x1b\\' || token.value === '\x07') {
          const sequence = '\x1b' + heldTail + token.value
          const response = sequence.length <= TERMINAL_RESPONSE_MAX_LENGTH
            ? parseTerminalResponse(sequence)
            : null
          if (response?.type === 'xtversion') {
            terminalResponseReattachTail = undefined
            keys.push({ kind: 'response', sequence, response })
            continue
          }
        }
      }
      // An unrelated sequence between the held fragment and its terminator
      // proves the reply died; do not merge it with later input.
      terminalResponseReattachTail = undefined
      if (token.value === PASTE_START) {
        inPaste = true
        pasteBuffer = ''
        // Bracketed paste is a terminal-controlled mode: report bytes are
        // contiguous on the wire, so a held SGR prefix's report is dead
        // once paste starts. Release it — a late `;34M` arriving after the
        // paste must not merge into a phantom press.
        releaseHeldMouseHead()
      } else if (token.value === PASTE_END) {
        // Always emit a paste key, even for empty pastes. This allows
        // downstream handlers to detect empty pastes (e.g., for clipboard
        // image handling on macOS). The paste content may be empty string.
        keys.push(createPasteKey(pasteBuffer))
        inPaste = false
        pasteBuffer = ''
        // Paste end is a terminal protocol boundary too — a held SGR prefix
        // from before the paste cannot complete now.
        releaseHeldMouseHead()
      } else if (inPaste) {
        // Sequences inside paste are treated as literal text
        pasteBuffer += token.value
      } else {
        const win32 = parseWin32KeyEvent(token.value, win32Ctx)
        if (win32 !== undefined) {
          win32InputMode = true
          // A fresh protocol record proves a held SGR prefix's report died:
          // report bytes are contiguous on the wire, so nothing may
          // interleave between a report's fragments.
          releaseHeldMouseHead()
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
          // Fixed decision order (D6) for one complete token — see
          // claimProtocolSequence: OSC 8 drop (#1178) → terminal reply
          // (#1177) → mouse (SGR 1006 first, X10 as the legacy 1000/1002
          // fallback). This parser's SGR head-fragment claim family
          // (#1160/#1120) lives inside the mouse step, below the complete
          // claim, and never runs ahead of OSC 8 or a reply. Wheel falls
          // through to parseKeypress, which turns it into a wheel key WITH
          // the pointer coordinates for position-based routing.
          const claimed = claimProtocolSequence(token.value)
          if (claimed !== null) {
            // Any claim — drop, terminal reply or complete mouse report — is
            // a protocol boundary: a held prefix belongs to an older, dead
            // report. Release it BEFORE it can merge the next fragment into
            // a phantom event. A complete report also lights the P2 evidence
            // window for the ambiguous `[`/`ESC[` heads.
            if (claimed.kind === 'mouse') lastMouseReportAt = now
            releaseHeldMouseHead()
            keys.push(claimed)
          } else {
            const head = token.value.replace(/^\x1b/, '')
            // F-2 transport evidence: `ESC[` buffered in ONE read (see
            // KeyParseState.mouseHeadSingleRead) grants the P1-only claim.
            const singleReadHead =
              token.value === '\x1b[' && prevState.mouseHeadSingleRead === token.value
            const claim = claimSgrHead(head, singleReadHead)
            if (
              claim !== undefined &&
              (!claim.releasable || head.length <= MOUSE_HEAD_HOLD_MAX_LENGTH)
            ) {
              // Flush-truncated SGR head: the tokenizer's flush emitted the
              // buffered head (ESC still attached) as a sequence token. It
              // is protocol bytes mid-report, not a key — strip the ESC,
              // hold for the continuation (the text-token branch below
              // completes it), and never let it fall through to
              // parseKeypress, where it would leak into the prompt.
              // A fresh head REPLACES any stale hold instead of appending:
              // the new report's arrival proves the old one's tail never
              // came (`[<0;18` + `[<64;…` concatenated parses as garbage).
              // F-1: a gated old hold is RELEASED first so its bytes are
              // neither dropped nor ordered after the new head's bytes.
              releaseHeldMouseHead()
              mouseTailHold = head
              mouseTailHoldAt = now
              mouseTailHoldReleasable = claim.releasable
            } else if (claim !== undefined && claim.releasable) {
              // Over the gated 64B bound: release immediately — never hold,
              // never drop (ADR-0007 D5).
              releaseHeldMouseHead()
              keys.push(parseKeypress(head))
            } else {
              // Ordinary key sequence (arrows, function keys, …) — still an
              // ESC protocol start, so a held head's report is dead. F-1:
              // a gated hold is RELEASED in arrival order first.
              releaseHeldMouseHead()
              keys.push(parseKeypress(token.value))
            }
          }
        }
      }
    } else if (token.type === 'text') {
      if (inPaste) {
        pasteBuffer += token.value
      } else if (WIN32_INPUT_TAILS_RE.test(token.value)) {
        // Protocol bytes — a live SGR mouse report cannot contain them, so
        // a held prefix's report is dead. Release before recovering.
        releaseHeldMouseHead()
        terminalResponseReattachTail = undefined
        // A delayed win32-input-mode continuation can arrive after App's
        // escape timer has already flushed its ESC prefix. Recover complete
        // record tails so their protocol bytes do not leak into the prompt.
        for (const tail of token.value.match(WIN32_INPUT_TAIL_RE) ?? []) {
          const win32 = parseWin32KeyEvent('\x1b' + tail, win32Ctx)
          if (win32 !== undefined) win32InputMode = true
          if (win32 !== undefined && win32 !== null) {
            for (let i = 0; i < win32.repeat; i++) {
              keys.push(...feedWin32Input(win32Paste, win32Protocol, win32.key))
            }
          }
        }
      } else if (
        SGR_MOUSE_TAIL_RE.test(token.value) ||
        /^\[M[\x60-\x7f][\x20-\uffff]{2}$/.test(token.value)
      ) {
        // Standalone COMPLETE orphan SGR/X10 mouse tail (fullscreen only —
        // mouse tracking is off otherwise). A heavy render blocked the event
        // loop past App's 50ms flush timer, so the buffered ESC was flushed
        // as a lone Escape and the continuation `[<btn;col;rowM` arrived as
        // text. Re-synthesize with the ESC prefix so the scroll event still
        // fires instead of leaking into the prompt. The spurious Escape is
        // gone; App.tsx's readableLength check prevents it. The X10 Cb slot
        // is narrowed to the wheel range [\x60-\x7f] (0x40|modifiers + 32) —
        // a full [\x20-] range would match typed input like `[MAX]` batched
        // into one read and silently drop it as a phantom click.
        // Any older hold belongs to a DIFFERENT, dead report: a complete
        // report's arrival proves its tail never came. Release the stale
        // hold and resynthesize this tail cleanly — concatenating them
        // (`ESC + hold + complete tail`) parses as garbage and leaks the
        // protocol bytes into the prompt as an ordinary key.
        releaseHeldMouseHead()
        terminalResponseReattachTail = undefined
        const resynthesized = '\x1b' + token.value
        const mouse = parseMouseEvent(resynthesized)
        // A real report lights the P2 evidence window for ambiguous heads.
        if (mouse) lastMouseReportAt = now
        keys.push(mouse ?? parseKeypress(resynthesized))
      } else if (
        mouseTailHold !== undefined &&
        SGR_MOUSE_TAIL_PREFIX_RE.test(mouseTailHold + token.value)
      ) {
        // Completion of the held prefix: the split report's tail finally
        // arrived (SSH jitter, render-stalled reads). Resynthesize and clear.
        // If the token carries trailing bytes beyond the completion (e.g.
        // `;34Mabc` — the terminal batched the tail and the next keystrokes
        // into one read), split the suffix off and push it back into the
        // token queue for the next iteration — it may itself be another
        // protocol prefix, a win32 tail, or ordinary typing. The prefix
        // regex (no $ anchor) matches the report at the head; the suffix
        // is whatever follows.
        terminalResponseReattachTail = undefined
        const combined = mouseTailHold + token.value
        const m = combined.match(SGR_MOUSE_TAIL_PREFIX_RE)!
        const reportEnd = m[0].length
        if (reportEnd < combined.length) {
          const suffix = combined.slice(reportEnd)
          tokenQueue.splice(qi + 1, 0, { type: 'text', value: suffix })
        }
        const resynthesized = '\x1b' + combined.slice(0, reportEnd)
        clearMouseTailHold()
        const mouse = parseMouseEvent(resynthesized)
        // A real report lights the P2 evidence window for ambiguous heads.
        if (mouse) lastMouseReportAt = now
        keys.push(mouse ?? parseKeypress(resynthesized))
      } else {
        // #1177 terminal-reply re-attach runs first (decision order D6:
        // reply before mouse): the introducer ESC may already have been
        // flushed, so this text token — joined with any held fragment — may
        // be the rest of a reply. The one shape authority
        // (`claimExpectedResponseHead`) decides completeness, and a claim
        // needs BOTH a pending query of the matching expected type and a
        // shape that can still complete into it; anything else keeps the
        // token literal (AC-3) and drops a stale fragment rather than
        // leaking protocol bytes.
        const replyCandidate = (terminalResponseReattachTail ?? '') + token.value
        const claimedResponse = mayRecoverTerminalResponseTail
          ? claimExpectedResponseHead(replyCandidate, expectedResponseTypes)
          : undefined
        if (claimedResponse) {
          terminalResponseReattachTail = undefined
          // A completed reply is a protocol boundary: a held SGR head's
          // report is dead (same caliber as the sequence-token reply path).
          releaseHeldMouseHead()
          keys.push({
            kind: 'response',
            sequence: '\x1b' + replyCandidate.slice(0, claimedResponse.consumed),
            response: claimedResponse.response,
          })
          // Trailing bytes beyond the completed reply are ordinary input
          // (the terminal batched the tail with the next keystrokes).
          const suffix = replyCandidate.slice(claimedResponse.consumed)
          if (suffix) tokenQueue.splice(qi + 1, 0, { type: 'text', value: suffix })
        } else {
          const replyStillOpen =
            mayRecoverTerminalResponseTail &&
            replyCandidate.length <= TERMINAL_RESPONSE_MAX_LENGTH &&
            expectsResponseType('\x1b' + replyCandidate, expectedResponseTypes)
          const freshReplyPrefix =
            mayRecoverTerminalResponseTail &&
            token.value.length <= TERMINAL_RESPONSE_MAX_LENGTH &&
            expectsResponseType('\x1b' + token.value, expectedResponseTypes)
          if (replyStillOpen) {
            // Still an open expected reply prefix — hold it for the next
            // call. The reply shape proves any held mouse report is dead, so
            // release the old mouse hold before claiming the reply.
            releaseHeldMouseHead()
            terminalResponseReattachTail = replyCandidate
          } else if (freshReplyPrefix) {
            // The held fragment (if any) cannot be completed; drop it and
            // give the fresh bytes their own chance to start a reply prefix.
            // Again the reply claim releases any old mouse hold.
            releaseHeldMouseHead()
            terminalResponseReattachTail = token.value
          } else {
            // SGR head family: claim a fresh head, extend an active hold, or
            // pass ordinary text through. `claimSgrHead` pairs shape with
            // evidence; a hold only survives while `hold + token` remains a
            // legal head prefix (SGR_MOUSE_HEAD_PREFIX_RE, grammar-locked to
            // SGR_MOUSE_RE), so text that cannot continue it proves the held
            // report died.
            terminalResponseReattachTail = undefined
            const combined = (mouseTailHold ?? '') + token.value
            const claim = claimSgrHead(token.value)
            const canExtend =
              mouseTailHold !== undefined &&
              SGR_MOUSE_HEAD_PREFIX_RE.test(combined)
            if (
              canExtend &&
              (mouseTailHoldReleasable !== true ||
                combined.length <= MOUSE_HEAD_HOLD_MAX_LENGTH)
            ) {
              // Continuation (`<` after a bare `[`, digits/semicolons after
              // `[<`): keep the FIRST-capture deadline — flushes must not
              // renew it.
              mouseTailHold = combined
            } else if (
              claim !== undefined &&
              (!claim.releasable ||
                token.value.length <= MOUSE_HEAD_HOLD_MAX_LENGTH)
            ) {
              // Incomplete SGR head arriving as a text token (ConPTY/SSH
              // split the report mid-sequence and the flush timer already
              // released the buffered ESC prefix): hold it for the next
              // chunk instead of leaking protocol bytes into the prompt. A
              // fresh head REPLACES any stale hold — two reports never
              // concatenate — so the deadline restarts from this capture.
              // F-1: a gated old hold is RELEASED first so its bytes are
              // replayed in arrival order, not dropped.
              releaseHeldMouseHead()
              mouseTailHold = token.value
              mouseTailHoldAt = now
              mouseTailHoldReleasable = claim.releasable
            } else {
              // The open report is dead (text that cannot continue it) or
              // the gated 64B bound is exceeded: a gated hold RELEASES its
              // bytes in arrival order (ADR-0007 D5) so no user input is
              // dropped; legacy holds keep the pre-gate silent discard.
              // This token then passes through as ordinary typing.
              releaseHeldMouseHead()
              keys.push(parseKeypress(token.value))
            }
          }
        }
      }
    }
  }

  // Inspect the trailing buffer AFTER processing tokens: this read may have
  // entered a literal paste, or decoded the first win32 record. Emitting a
  // token ended the old sequence, so a new prefix gets its own deadline.
  if (tokens.length > 0) win32InputStartedAt = undefined
  if (isRecordPrefix(tokenizer.buffer())) {
    if (tokenizer.buffer().length > WIN32_INPUT_MAX_LENGTH) {
      tokenizer.reset()
      win32InputStartedAt = undefined
    } else {
      win32InputStartedAt ??= now
    }
  } else {
    win32InputStartedAt = undefined
  }

  // If flushing and still in paste mode, emit what we have
  if (isFlush && inPaste && pasteBuffer) {
    keys.push(createPasteKey(pasteBuffer))
    inPaste = false
    pasteBuffer = ''
  }

  // Flush handling for the decomposed win32 paste: mid-paste (active) the
  // quiet timeout means the paste stream ended — finalize with whatever
  // was collected (mirrors the VT IN_PASTE flush above; a truncated end
  // marker must not strand the matcher and eat all future typing). Outside
  // a paste, release any held marker-prefix keys (e.g. a lone Escape).
  // A deferred record flush must not split these higher-level matchers.
  if (isFlush && !deferFlush && win32Paste.active) {
    let content = win32Paste.buffer
    for (const k of win32Paste.held) content += win32RecordChar(k) ?? ''
    keys.push(createPasteKey(content))
    win32Paste.active = false
    win32Paste.buffer = ''
    win32Paste.held = []
    win32Paste.matched = 0
    win32Paste.lastWasCarriageReturn = false
  } else if (isFlush && !deferFlush && win32Paste.held.length > 0) {
    keys.push(...win32Paste.held)
    win32Paste.held = []
    win32Paste.matched = 0
    win32Paste.lastWasCarriageReturn = false
  }

  // A quiet timeout ends a synthesized protocol candidate. Incomplete mouse
  // reports are terminal input and must not become prompt text; other held
  // input (a lone Escape or an unknown CSI sequence) remains ordinary keys.
  if (isFlush && !deferFlush && win32Protocol.held.length > 0) {
    const isMouseCandidate =
      win32Protocol.sequence.startsWith('\x1b[<') ||
      win32Protocol.sequence.startsWith('\x1b[M')
    if (!isMouseCandidate) keys.push(...win32Protocol.held)
    win32Protocol.held = []
    win32Protocol.sequence = ''
  }

  // A held SGR mouse head that never completed expires in the deadline check
  // at the top of this call — on flush AND on ordinary input alike
  // (continuous input starves flush-only checks). A gated hold is RELEASED as
  // ordinary keys there (ADR-0007 D5: delayed but never dropped); a legacy
  // shape-specific hold keeps the pre-gate silent discard. Partial recovery
  // of the coords is not attempted — a mouse event with guessed terminators
  // would dispatch phantom clicks.

  // The reply-prefix hold lives only while the tokenizer still retains a
  // reply-shaped prefix: completion, release or reset all end it, so the
  // NEXT hold captures its own first-capture deadline.
  if (terminalResponseHoldAt !== undefined && !isResponsePrefix(tokenizer.buffer())) {
    terminalResponseHoldAt = undefined
  }

  // A REAL lone-Escape flush — an Escape emitted as its own key, not the ESC
  // introducer of a buffered sequence. Only this opens the #796 re-attach
  // window; the window alone is not evidence (D1), and a direct caller that
  // never injects the provenance keeps the pre-change behavior.
  const escapeFlushedNow =
    isFlush &&
    keys.some(
      key =>
        key.kind === 'key' &&
        key.name === 'escape' &&
        key.sequence === '\x1b',
    )
  // A fresh lone-Escape flush opens a NEW window: a fragment held against
  // the old one cannot be part of a reply whose introducer just arrived.
  if (escapeFlushedNow) terminalResponseReattachTail = undefined

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
    // The host gate rides along: App replaces its state with this object on
    // every read, and the hold must stay closed for the whole session.
    win32Capable: prevState.win32Capable,
    // Same host-injected contract for the query evidence: read-only here,
    // re-injected by App on every input call, so it is never stale.
    terminalExpectedResponseTypes: prevState.terminalExpectedResponseTypes,
    win32InputMode,
    win32InputStartedAt,
    win32EscFlushedAt,
    win32HighSurrogate: win32Ctx.high,
    win32AltHighSurrogate: win32Ctx.altHigh,
    win32Paste,
    win32Protocol,
    // The host gate rides along as well: App replaces its state with this
    // object on every read, and re-injects the latest evidence each call.
    mouseReportingActive: prevState.mouseReportingActive,
    lastMouseReportAt,
    mouseTailHold,
    mouseTailHoldAt,
    mouseTailHoldReleasable,
    // Parser-internal transport evidence: set by the read that buffered the
    // head, consumed by the next call (the flush that emits `ESC[`), then
    // cleared because that call feeds nothing.
    mouseHeadSingleRead,
    terminalResponseHoldAt,
    terminalResponseReattachTail,
    // A fresh lone-Escape flush re-arms the window; otherwise the carried
    // stamp keeps it open (see carryTailAfterEscFlush above).
    terminalResponseTailAfterEscFlushAt: escapeFlushedNow
      ? Date.now()
      : carryTailAfterEscFlush,
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

  if (!key.name && !key.code && COMPLETE_CSI_RE.test(s)) {
    key.code = s.slice(1)
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
