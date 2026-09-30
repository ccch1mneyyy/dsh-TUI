/**
 * Four-path paste-loss probe: ONE payload, ONE render instance, four real
 * delivery paths into the composer, one verdict line each.
 *
 *   P1  VT bracketed paste (`ESC[200~ … ESC[201~`) — whole + chunked variants
 *   P2  win32 decomposed records (CSI Vk;Sc;Uc;Kd;Cs;Rc _):
 *       P2a synthesized Vk=0/Sc=0 records (verify-win32-input.tsx §8 shape)
 *       P2b real Vk/Sc records (issue #827 observation: `[65;30;97;1;0;1_`)
 *       P2c mixed stream: the payload carries >=1 ESC-bearing full record AND
 *           several ESC-less tails whose Uc ENCODES a payload character
 *           (the `\n` / the next line's first char) — the #827 Win10 form
 *           where record text leaks into the payload (DESIGN D5(c))
 *   P3  Ctrl+V self-read clipboard (stubbed reader, real async key path)
 *   P4  TUI selection copy -> paste (live frame + getSelectedText, pasted P1)
 *
 * The payload is synthetic CRLF text (never the real clipboard): >=6 lines and
 * >=600 chars, every line starts with an uppercase letter and ends with `.`,
 * every line carries its own SENTINEL, plus a small (<600 chars, 2 lines)
 * control payload that cannot fold.
 *
 * This is a DISCRIMINATOR, not a regression: a symptom is a valid outcome.
 * Exit 0 once every delivery printed its verdict; non-zero only when the
 * harness itself broke (import failure, no frame, missing verdict).
 *
 * Verdict line (superset of the DESIGN D4 fields — `variant` and the extra
 * diagnostics are additive, no mandated field is dropped):
 *   path=P1 variant=whole payload=big valueLines=10 submitLines=10
 *     chipLines=10 firstDiff=none
 * `firstDiff` compares the submitted text (the value when nothing was
 * submitted) against the CRLF->LF normalized source, as `<index>:"<exp>"→
 * "<act>"` (`⌀` = end of string). `chipLines` is parsed from the rendered
 * `▸ N lines・M chars` / `▸ N 行・M 字` fold chip (`n/a` when unfolded).
 * Extra diagnostics appear only when non-`none`, so a clean line stays short:
 *   valueDiff      composer value vs the same source (ingress + submit split)
 *   deliveredDiff  composer value vs what the TRANSPORT handed over — the
 *                  ingress-deletion signal (H2), measured without blaming the
 *                  transport for bytes it never delivered
 *   copyDiff / copiedChars / pasteDiff   P4 only: the copy step's own
 *                  deviation (transcript chrome included), its length, and the
 *                  paste step's deviation from what was copied
 *
 * Waiting is `settle`/`settled` from scripts/lib/term-test.mjs only (NFR: no
 * fixed sleep). Evidence for each delivery (verdict + the raw viewport) is
 * written under .specs/dsh-tui-paste-loss-and-plugin-gate/probe/matrix/ when
 * the script runs inside the flow-comet workspace; a plain clone writes
 * nothing (see PROBE_DIR below).
 *
 * Hypothesis discriminants (`--case h1..h5`, DESIGN §2): each case turns one
 * prediction into a readable row set — h1 delivery-form coverage (matrix
 * subset, split into transport vs ingress deviation), h2 the ESC-less tail
 * strip width and the strip ORDER (real `sanitizePastedText` vs
 * `sanitizeEditableText` vs two local counterfactual replicas) plus the tie
 * back to the rendered P2c value, h3 chunk boundaries (four extra profiles),
 * h4 value-vs-submit-vs-chip line counts across the whole matrix, h5 the
 * selection-copy step's own deviation (insertions vs deletions). Every case
 * ends in `verdict=agrees|deviates|undecided`; the raw output per hypothesis
 * goes to probe/verdict/<hN>.txt. The vocabulary is ASCII so the evidence
 * files stay readable whatever the console code page does.
 *
 * Run with: node --import tsx/esm scripts/repro-paste-loss.tsx             # T01 matrix only (unchanged)
 *           node --import tsx/esm scripts/repro-paste-loss.tsx --all       # matrix + h1..h5
 *           node --import tsx/esm scripts/repro-paste-loss.tsx --case h2   # one discriminant
 */
process.env.FORCE_COLOR = '3'
// The chip stats are parsed as `▸ N lines・M chars`; the parser accepts the zh
// form too. Pin the language before any module import resolves it.
process.env.DSH_TUI_LANG = 'en'

const [{ mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync }, { tmpdir }, { join }, { fileURLToPath, pathToFileURL }, { registerHooks }] = await Promise.all([
  import('node:fs'),
  import('node:os'),
  import('node:path'),
  import('node:url'),
  import('node:module'),
])

// Redirect ~/.dsh-tui (history.jsonl / resume.txt / theme.json) into a temp
// dir BEFORE any module import resolves utils/paths.js — os.homedir() reads
// these env vars, so the submits below never touch the real history.
const dataDir = mkdtempSync(join(tmpdir(), 'repro-paste-loss-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir

/**
 * Where the per-delivery evidence lands. Only the flow-comet workspace has
 * `.claude/worktrees/` three levels above this script; anywhere else the
 * probe stays read-only (a plain clone must not grow a `.specs/` tree).
 */
const workspaceRoot = new URL('../../../../', import.meta.url)
/** Per-delivery snapshots (T01 shape, one file per delivery; the trailing
 *  separator is part of the banner T01's evidence files recorded). */
const PROBE_DIR = existsSync(fileURLToPath(new URL('.claude/worktrees', workspaceRoot)))
  ? fileURLToPath(new URL('.specs/dsh-tui-paste-loss-and-plugin-gate/probe/matrix/', workspaceRoot))
  : null
/** Per-hypothesis raw output (T02): one `<hN>.txt` per discriminant case. */
const VERDICT_DIR = PROBE_DIR === null ? null : join(PROBE_DIR, '..', 'verdict')

// ── CLI ────────────────────────────────────────────────────────────────────

/** The DESIGN §2 predictions, in order. */
const CASE_IDS = ['h1', 'h2', 'h3', 'h4', 'h5'] as const
type CaseId = (typeof CASE_IDS)[number]

const USAGE = 'usage: repro-paste-loss.tsx [--all] [--case h1..h5]...'

/** `--all` = the T01 matrix plus every case; `--case hN` = that case only
 *  (running only the deliveries it needs); no argument = the T01 matrix
 *  alone, with its 14 verdict lines and evidence files unchanged. */
function parseArgs(argv: readonly string[]): { matrix: boolean; cases: CaseId[] } {
  if (argv.length === 0) return { matrix: true, cases: [] }
  const cases: CaseId[] = []
  let matrix = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--all') {
      matrix = true
      for (const id of CASE_IDS) if (!cases.includes(id)) cases.push(id)
    } else if (arg === '--case' || arg.startsWith('--case=')) {
      const value = arg.startsWith('--case=') ? arg.slice('--case='.length) : argv[(i += 1)] ?? ''
      for (const id of value.split(',')) {
        if (!(CASE_IDS as readonly string[]).includes(id)) {
          console.error(`unknown case: ${id === '' ? '<empty>' : id} (${USAGE})`)
          process.exit(2)
        }
        if (!cases.includes(id as CaseId)) cases.push(id as CaseId)
      }
    } else {
      console.error(`unknown argument: ${arg} (${USAGE})`)
      process.exit(2)
    }
  }
  return { matrix, cases }
}

const cli = parseArgs(process.argv.slice(2))
/** Echoed into every evidence header, so the raw output names its own run. */
const commandLine = process.argv.slice(2).join(' ') || '(no arguments: matrix only)'

/**
 * P3 stubs the clipboard by redirecting ONE import specifier. PromptInput
 * reads the clipboard through a module-level `readClipboard` import and has no
 * reader-override prop (unlike AskUserQuestionPanel's `readClipboardOverride`),
 * and a PATH shim cannot work on Windows (`readClipboardWindows` execs
 * `powershell`). The stub re-exports the real module surface and replaces only
 * `readClipboard`, so nothing outside this script changes and the real OS
 * clipboard is never read (the stub call counter proves it).
 */
const CLIPBOARD_STUB_SOURCE = [
  `export * from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../src/utils/clipboard.ts', import.meta.url))).href)}`,
  'export function readClipboard() { return globalThis.__pasteLossReadClipboard() }',
].join('\n')
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromPromptInput = (context.parentURL ?? '').includes('/components/PromptInput.')
    if (fromPromptInput && /\/utils\/clipboard\.js$/u.test(specifier)) {
      return {
        url: `data:text/javascript;base64,${Buffer.from(CLIPBOARD_STUB_SOURCE).toString('base64')}`,
        shortCircuit: true,
        format: 'module',
      }
    }
    return nextResolve(specifier, context)
  },
})

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, termTest, { startSelection, updateSelection, finishSelection }, { default: inkInstances }, { supportsWin32InputMode }, promptSanitizers] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/selection.js'),
  import('../src/ink/instances.js'),
  import('../src/ink/terminal.js'),
  // The H2 discriminant measures the PRODUCT functions (not a re-implementation):
  // `Chat` already pulls this module in, so the import costs nothing.
  import('../src/components/PromptInput.js'),
])

const { sanitizePastedText, sanitizeEditableText } = promptSanitizers

const COLS = 110
const ROWS = 48
/** Bounded conditions, never a blind sleep: a paste the ingress deleted
 *  wholesale never satisfies "value non-empty", so that wait has to end. */
const LAND_MS = 2500
const SUBMIT_MS = 2500
const RESET_MS = 2500
/** Window for the FIRST Enter before the off-bottom retry (see runDelivery). */
const SUBMIT_FIRST_MS = 600
/** Prefix length used to tie a wait to the painted value. */
const PAINT_PROBE_CHARS = 12

// ── payloads (DESIGN D3) ────────────────────────────────────────────────────

const WORDS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett']

/** `Alpha-L1-SENTINEL-A1 … tail-1-----.` — line-start sentinel, uppercase
 *  head, `.` tail; >=74 chars each, so 10 lines clear the 600-char fold gate. */
const bigLine = (i: number): string => {
  const n = i + 1
  const head = `${WORDS[i]}-L${n}-SENTINEL-${String.fromCharCode(64 + n)}${n}`
  const filler = `${String(n).padStart(2, '0')}${'0123456789'.repeat(4)}`
  return `${`${head} ${filler} tail-${n}`.padEnd(74, '-')}.`
}

interface Payload {
  readonly name: 'big' | 'small'
  readonly lines: readonly string[]
  /** Editor-copy shape: CRLF, exactly what these paths must deliver. */
  readonly crlf: string
  /** CRLF -> LF normalization of {@link crlf}, the comparison source. */
  readonly lf: string
  /** Whether the fold gate (>=6 lines or >=600 chars) must trip. */
  readonly folds: boolean
}

const makePayload = (name: 'big' | 'small', lines: string[]): Payload => {
  const crlf = lines.join('\r\n')
  return { name, lines, crlf, lf: lines.join('\n'), folds: lines.length >= 6 || crlf.length >= 600 }
}

const payloads: Record<'big' | 'small', Payload> = {
  big: makePayload('big', Array.from({ length: 10 }, (_, i) => bigLine(i))),
  small: makePayload('small', ['Alpha-S1-SENTINEL-A1 small-first.', 'Bravo-S2-SENTINEL-B2 small-second.']),
}

// ── win32 INPUT_RECORD encoders ─────────────────────────────────────────────

const CSI = '\x1b['
const SHIFT_PRESSED = 48

/** Windows Set-1 make codes (letters and the digit row). */
const LETTER_SCAN: Record<string, number> = {
  A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36,
  K: 37, L: 38, M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20,
  U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
}
const DIGIT_SCAN: Record<string, number> = {
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
}
/** OEM punctuation as verify-win32-input.tsx uses it (`-`=189/12, `_`=189/12+Shift). */
const OEM: Record<string, readonly [number, number, number]> = {
  '-': [189, 12, 0], '.': [190, 52, 0], '[': [219, 26, 0], ']': [221, 29, 0],
  ';': [186, 39, 0], '_': [189, 12, SHIFT_PRESSED],
}

/** The record's own fields: [Vk, Sc, Uc, Cs]. Real virtual keys and Windows
 *  Set-1 make codes for the chars this payload uses; letters carry
 *  SHIFT_PRESSED when uppercase, CR keeps the `13;28;13` shape and LF the
 *  synthesized Vk=0 half (verify-win32-input.tsx §1/§2/§8b, issue #827). */
function recordFields(ch: string): readonly [number, number, number, number] {
  if (ch === '\r') return [13, 28, 13, 0]
  if (ch === '\n') return [0, 0, 10, 0]
  const upper = ch.toUpperCase()
  if (LETTER_SCAN[upper] !== undefined && /[A-Za-z]/u.test(ch)) {
    return [upper.charCodeAt(0), LETTER_SCAN[upper]!, ch.codePointAt(0)!, /[A-Z]/u.test(ch) ? SHIFT_PRESSED : 0]
  }
  if (DIGIT_SCAN[ch] !== undefined) return [ch.charCodeAt(0), DIGIT_SCAN[ch]!, ch.codePointAt(0)!, 0]
  if (ch === ' ') return [32, 57, 32, 0]
  const oem = OEM[ch]
  if (oem !== undefined) return [oem[0], oem[1], ch.codePointAt(0)!, oem[2]]
  return [0, 0, ch.codePointAt(0)!, 0]
}

/** One record as its down+up pair — the shape scripts/verify-win32-input.tsx
 *  §8 builds with `pasteRecs(vk, uc, cs)`. */
const rec = (vk: number, sc: number, uc: number, cs = 0): string =>
  `${CSI}${vk};${sc};${uc};1;${cs};1_${CSI}${vk};${sc};${uc};0;${cs};1_`

const realRec = (ch: string): string => rec(...recordFields(ch))
/** The down record alone, ESC-stripped: the exact text an ESC-less tail has. */
const tailOf = (ch: string): string => {
  const [vk, sc, uc, cs] = recordFields(ch)
  return `${CSI}${vk};${sc};${uc};1;${cs};1_`.slice(1)
}
/** Every char synthesized (Vk=0/Sc=0) — the §8 marker shape, and what conhost
 *  emits for chars it does not translate to a virtual key. */
const synthRec = (ch: string): string => rec(0, 0, ch.codePointAt(0)!)
/** An ESC carried as a leaked payload character (`ESC[27;1;27;1;0;1_`, §8). */
const ESC_CHAR_REC = rec(27, 1, 27)

/** Marker chars as conhost's Clipboard::TextToKeyEvents emits them:
 *  SynthesizeKeyEvent(Vk=0, Sc=0, Uc=char, Cs=0) per char of ESC[200~ / 201~
 *  (verify-win32-input.tsx §8 `P2_OPEN` / `P2_CLOSE`). */
const markerRecs = (text: string): string => [...text].map(ch => synthRec(ch)).join('')
const P2_OPEN = markerRecs('\x1b[200~')
const P2_CLOSE = markerRecs('\x1b[201~')

/** ESC-less CR record text — the shape `WIN32_RECORD_RESIDUE_TAIL` strips
 *  (issue #1090 / #1097) and the shape a split CR record leaves behind. */
const CR_TAIL = tailOf('\r')
/** The same record with its ESC: the in-payload `hasRecordStream` evidence. */
const CR_RECORD = `\x1b${CR_TAIL}`

/**
 * The line boundaries where the transport leaks record text instead of
 * decoding it: the newline before line 2 keeps its ESC, later ones are
 * ESC-less tails, and two of them take the next line's first char with them.
 * Named, because these indices ARE the H2 scenario.
 */
const LEAK_ESC_BEARING_NEWLINE = 1
const LEAK_TAIL_ONLY_NEWLINE = 4
const LEAK_TAIL_WITH_CHAR_NEWLINE = 6

/**
 * The payload the transport hands over in the #827 form: the intended text,
 * except that at {@link LEAK_ESC_BEARING_NEWLINE} / {@link LEAK_TAIL_ONLY_NEWLINE}
 * / {@link LEAK_TAIL_WITH_CHAR_NEWLINE} the record stream leaked as TEXT — one
 * ESC-bearing CR record plus ESC-less tails — where the user's newline (and at
 * two of them the next line's first char) was. Delivered through P2c as
 * per-char records (a leaked record IS just text to the transport). The
 * ESC-bearing leak is what lights `sanitizePastedText`'s `hasRecordStream`, so
 * the ESC-less tails that encode payload characters are stripped — the H2
 * discriminator: a payload whose own characters look like split-record tails.
 */
const leakedPayload = (p: Payload): string => p.lines.reduce((acc, line, i) => {
  if (i === 0) return line
  if (i === LEAK_ESC_BEARING_NEWLINE) return `${acc}${CR_RECORD}${tailOf(line[0]!)}${line.slice(1)}`
  if (i === LEAK_TAIL_ONLY_NEWLINE) return `${acc}${CR_TAIL}${line}`
  if (i === LEAK_TAIL_WITH_CHAR_NEWLINE) return `${acc}${CR_TAIL}${tailOf(line[0]!)}${line.slice(1)}`
  return `${acc}\n${line}`
}, '')

// ── harness ────────────────────────────────────────────────────────────────

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

const fakeStdout = new FakeStdout()
const stdinObj = new FakeStdin()
/** Waiting/reading goes through the shared helpers (issue #532): the wait and
 *  the assertion share one predicate, and a fixed sleep would read a stale
 *  screen on a slow runner. */
const { settled } = termTest
const screenHas = (s: string): boolean => termTest.screenHas(term, s)
const findText = (s: string): { col: number; row: number } | null => termTest.findText(term, s)
const viewport = (): string[] => termTest.viewportLines(term)

const listeners = new Set<() => void>()
let submittedCount = 0
let lastSubmitted = ''
const channel: any = {
  // Probe determinism: the welcome header's animated whale art repaints on its
  // own clock, which would make two runs' viewport snapshots differ. The flag
  // is a plain channel option (same as the settings row `dsh-tui.whale`), so
  // the screen stays the real Chat layout.
  whale: false,
  whaleIdle: false,
  version: 0,
  rows: [] as unknown[],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  mode: { plan: false },
  reasoningEffort: 'max',
  tokens: { input: 1, output: 1 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: Date.now(),
  lastUserText: '',
  pending: [],
  commandList: [],
  notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit(text: string) { lastSubmitted = text; submittedCount += 1; bump() },
  cancel: () => {}, clear: () => {},
  notify(msg: string) { channel.notifications.push(msg); bump() },
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
  stagedImage: () => undefined, discardStagedImage: () => {},
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

/** The composer value read path: Chat exposes its PromptController slot
 *  (`promptControllerRef`), whose `text()` returns the live value mirror —
 *  the same seam verify-composer-draft-handoff.tsx uses. */
const composerRef: { current: { text(): string; clear(): void } | null } = { current: null }
const composerText = (): string => composerRef.current?.text() ?? ''

// ── verdict helpers ────────────────────────────────────────────────────────

/** First differing UTF-16 index as `<index>:"<exp>"→"<act>"` (`⌀` = end of
 *  string), or `none` when byte-identical. */
function diffText(expected: string, actual: string): string {
  const n = Math.min(expected.length, actual.length)
  for (let i = 0; i < n; i++) {
    if (expected[i] !== actual[i]) return `${i}:${JSON.stringify(expected[i])}→${JSON.stringify(actual[i])}`
  }
  if (expected.length === actual.length) return 'none'
  return `${n}:${expected.length > n ? JSON.stringify(expected[n]) : '⌀'}→${actual.length > n ? JSON.stringify(actual[n]) : '⌀'}`
}

/** The one normalization these paths owe: CRLF -> LF (both paste ingresses
 *  fold it before the payload is inserted). */
const normalize = (s: string): string => s.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')

/** `wc -l` with the empty string reading as zero lines. */
const linesOf = (text: string): number => (text === '' ? 0 : text.split('\n').length)

/**
 * Exact insert/delete accounting between two strings, via the longest common
 * subsequence: `deleted` counts the source chars no longer there, `inserted`
 * the chars that came from nowhere. Exact matters here — a greedy scan would
 * read "the first char was deleted" as "everything after it was deleted too"
 * and turn a one-character defect into a four-character one. Iterated by code
 * point over an ASCII payload, so it is also a byte-level reading here.
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

/** The fold chip's line/char counts read off the rendered row
 *  (`▸ 10 lines・759 chars` / `▾ 10 行・759 字`); null while no chip is up. */
function chipOnScreen(): { lines: number; chars: number } | null {
  for (const row of viewport()) {
    const m = /[▸▾] (\d+) (?:lines|行)・(\d+) (?:chars|字)/u.exec(row)
    if (m) return { lines: Number(m[1]), chars: Number(m[2]) }
  }
  return null
}

// ── delivery plan ──────────────────────────────────────────────────────────

/** The delivery identities the verdict lines use (`variant` is the sub-form of
 *  one path: P1 whole vs chunked, the three win32 record shapes, …). */
type PathId = 'P1' | 'P2a' | 'P2b' | 'P2c' | 'P3' | 'P4'
type VariantId = 'whole' | 'chunked' | 'synth' | 'real-vk' | 'mixed' | 'ctrl-v' | 'copy'

interface Delivery {
  readonly path: PathId
  readonly variant: VariantId
  readonly payload: Payload
  /** The stdin chunks this path delivers, in order. */
  readonly chunks: readonly string[]
  /** The payload TEXT the transport hands over (P2c overrides it). */
  readonly deliveredText: string
  /** Stable evidence file stem (`<path>[-<variant>]-<payload>`). */
  readonly file: string
  /** Case-only variant: its verdict line is prefixed `h3-extra` and it writes
   *  no matrix evidence file (the matrix stays the T01 14-row set). */
  readonly matrix?: false
  readonly extra: (copied: string, submitted: string) => string[]
}

/** The CRLF text cut into three reads, the first split INSIDE a CRLF pair and
 *  the second mid-line (H3: per-chunk `\r` / `\n` handling). */
function chunkedPaste(crlf: string): string[] {
  let index = -1
  for (let i = 0; i < 5; i++) index = crlf.indexOf('\r\n', index + 1)
  const head = crlf.slice(0, index + 1)
  const rest = crlf.slice(index + 1)
  let mid = Math.floor(rest.length / 2)
  while (mid < rest.length && (rest[mid] === '\r' || rest[mid] === '\n')) mid += 1
  return [`\x1b[200~${head}`, rest.slice(0, mid), `${rest.slice(mid)}\x1b[201~`]
}

const deliveries: Delivery[] = []
for (const payload of [payloads.big, payloads.small]) {
  const leaked = leakedPayload(payload)
  deliveries.push(
    {
      path: 'P1', variant: 'whole', payload,
      chunks: [`\x1b[200~${payload.crlf}\x1b[201~`], deliveredText: payload.crlf,
      file: `P1-whole-${payload.name}`, extra: () => [],
    },
    {
      path: 'P1', variant: 'chunked', payload,
      chunks: chunkedPaste(payload.crlf), deliveredText: payload.crlf,
      file: `P1-chunked-${payload.name}`, extra: () => [],
    },
    {
      path: 'P2a', variant: 'synth', payload,
      chunks: [P2_OPEN + [...payload.crlf].map(ch => synthRec(ch)).join('') + P2_CLOSE],
      deliveredText: payload.crlf, file: `P2a-${payload.name}`, extra: () => [],
    },
    {
      path: 'P2b', variant: 'real-vk', payload,
      chunks: [P2_OPEN + [...payload.crlf].map(ch => realRec(ch)).join('') + P2_CLOSE],
      deliveredText: payload.crlf, file: `P2b-${payload.name}`, extra: () => [],
    },
    {
      path: 'P2c', variant: 'mixed', payload,
      chunks: [P2_OPEN + [...leaked].map(ch => (ch === '\x1b' ? ESC_CHAR_REC : synthRec(ch))).join('') + P2_CLOSE],
      deliveredText: leaked, file: `P2c-${payload.name}`, extra: () => [],
    },
    {
      path: 'P3', variant: 'ctrl-v', payload,
      chunks: ['\x16'], deliveredText: payload.crlf, file: `P3-${payload.name}`, extra: () => [],
    },
    {
      path: 'P4', variant: 'copy', payload,
      // P4's transport is the TUI's own copy: whatever `copied` held is what
      // gets pasted, so the delivered text is recorded from that, not here.
      chunks: [], deliveredText: '', file: `P4-${payload.name}`,
      // The copy step's own deviation (transcript chrome included) and the
      // paste step's deviation from what was copied — H5 lives in the first.
      extra: (copied, submitted) => [
        `copyDiff=${diffText(payload.lf, copied)}`,
        `copiedChars=${[...copied].length}`,
        `pasteDiff=${diffText(copied, submitted)}`,
      ],
    },
  )
}

// ── run ────────────────────────────────────────────────────────────────────

/**
 * H3-only chunk profiles: the matrix already cuts a CRLF pair and a line in
 * half, so these two push the same payload through the nastiest splits a real
 * read can produce — one byte per read, and a read that ends inside the
 * bracket marker itself (H3: per-chunk `\r` / `\n` handling).
 */
const perCharChunks = (text: string): string[] => [...text].map(ch => ch)
const h3ExtraDeliveries: readonly Delivery[] = [payloads.big, payloads.small].flatMap(payload => [
  {
    path: 'P1' as const, variant: 'chunked' as const, payload, matrix: false as const,
    chunks: perCharChunks(`\x1b[200~${payload.crlf}\x1b[201~`), deliveredText: payload.crlf,
    file: `P1-perchar-${payload.name}`, extra: () => [] as string[],
  },
  {
    path: 'P1' as const, variant: 'chunked' as const, payload, matrix: false as const,
    chunks: ['\x1b[20', `0~${payload.crlf}\x1b[20`, '1~'], deliveredText: payload.crlf,
    file: `P1-marker-split-${payload.name}`, extra: () => [] as string[],
  },
])

const deliveriesByFile = new Map<string, Delivery>(
  [...deliveries, ...h3ExtraDeliveries].map(d => [d.file, d]),
)
/** The 14 matrix rows, in plan order (h4 reads every one of them). */
const MATRIX_KEYS: readonly string[] = deliveries.map(d => d.file)

const verdicts: string[] = []
let harnessFailures = 0
let probeWrites = 0
/** Per-hypothesis files written (the `--all` summary reports them apart from
 *  the matrix ones, so the T01 summary line keeps its original meaning). */
let hypothesisFiles = 0

function writeEvidence(file: string, body: string): void {
  if (PROBE_DIR === null) return
  mkdirSync(PROBE_DIR, { recursive: true })
  writeFileSync(join(PROBE_DIR, `${file}.txt`), body)
  probeWrites += 1
}

const evidenceBody = (
  d: Delivery, verdict: string, value: string, submitted: string, copied: string | null, snapshot: string[],
): string => [
  `# paste-loss probe evidence — path=${d.path} variant=${d.variant} payload=${d.payload.name}`,
  '# note: the splash rotates one `Tip:` row per mount; it is masked as <rotating>',
  '# so two runs of the same command compare byte-for-byte.',
  `verdict: ${verdict}`,
  ...(d.deliveredText === '' ? [] : [
    `deliveredText (what the transport handed the composer; ${[...d.deliveredText].length} chars):`,
    JSON.stringify(d.deliveredText),
  ]),
  `source (CRLF->LF normalized intent; ${[...d.payload.lf].length} chars):`,
  JSON.stringify(d.payload.lf),
  `composer value before Enter (${[...value].length} chars):`,
  JSON.stringify(value),
  `submitted (${[...submitted].length} chars):`,
  JSON.stringify(submitted),
  ...(copied === null ? [] : [`copied by the TUI selection (${[...copied].length} chars):`, JSON.stringify(copied)]),
  `--- rendered viewport (${ROWS} rows, ${COLS} cols) ---`,
  snapshot.map(row => row.includes('Tip: ') ? `${row.slice(0, row.indexOf('Tip: '))}Tip: <rotating>` : row).join('\n'),
  '',
].join('\n')

/** Empty the composer through the controller: value, fold block, selection and
 *  the expanded editor all reset, so the next path starts from one state. */
async function resetComposer(): Promise<void> {
  composerRef.current?.clear()
  await settled(() => composerText() === '' && chipOnScreen() === null, { timeoutMs: RESET_MS })
}

/**
 * Wait for the frame to stop moving: the composer growing reflows the
 * transcript and the reveal animation keeps repainting for a few frames after
 * the value is already on screen. Two identical consecutive polls is the
 * condition (no fixed sleep), so the snapshot each verdict carries is a
 * settled frame.
 */
async function quiesce(): Promise<void> {
  let previous = '\u0000'
  let stable = 0
  await settled(() => {
    const current = viewport().join('\n')
    stable = current === previous ? stable + 1 : 0
    previous = current
    return stable >= 2
  }, { timeoutMs: 2000, stepMs: 60 })
}

/** The one verdict line per delivery (the DESIGN D4 fields plus the additive
 *  diagnostics; `landed=false` marks a paste that left the composer empty, so
 *  `valueLines=0` reads as "nothing arrived" rather than "empty round"). */
function verdictLine(
  d: Delivery, value: string, submitted: string, chipLines: number | null, copied: string | null, landed: boolean,
): string {
  return [
    `path=${d.path}`, `variant=${d.variant}`, `payload=${d.payload.name}`,
    `valueLines=${linesOf(value)}`, `submitLines=${linesOf(submitted)}`,
    `chipLines=${chipLines === null ? 'n/a' : chipLines}`,
    `firstDiff=${diffText(d.payload.lf, submitted !== '' ? submitted : value)}`,
    ...(diffText(d.payload.lf, value) !== 'none' ? [`valueDiff=${diffText(d.payload.lf, value)}`] : []),
    // What the INGRESS deleted from what the transport actually handed over
    // (as opposed to what the transport itself already failed to deliver):
    // the H2 signal, and only non-`none` on the mixed (leaked-record) payload.
    ...(d.deliveredText !== '' && diffText(normalize(d.deliveredText), value) !== 'none'
      ? [`deliveredDiff=${diffText(normalize(d.deliveredText), value)}`]
      : []),
    ...d.extra(copied ?? '', submitted),
    ...(!landed && value === '' ? ['landed=false'] : []),
  ].join(' ')
}

/**
 * P4's transport: paint the payload as a transcript row, then copy it out of
 * the live frame through the same selection extraction the TUI's own copy
 * uses (`copySelectionNoClear` -> `getSelectedText` on `frontFrame.screen`).
 */
async function copySelectionTransport(d: Delivery): Promise<string> {
  channel.rows = [{ id: 901, kind: 'user', text: d.payload.lf }]
  bump()
  const first = d.payload.lines[0]!.slice(0, PAINT_PROBE_CHARS)
  const last = d.payload.lines.at(-1)!.slice(0, PAINT_PROBE_CHARS)
  const painted = await settled(
    () => findText(first) !== null && findText(last) !== null,
    { timeoutMs: LAND_MS },
  )
  const ink: any = inkInstances.get(fakeStdout)
  if (!painted || ink === undefined) return ''
  const a = findText(first)!
  const z = findText(last)!
  // End at the payload text's own width: whatever the row paints after it
  // (rail cells, timestamps) is chrome, not copied text.
  const width = Math.max(...d.payload.lines.map(l => [...l].length))
  startSelection(ink.selection, a.col, a.row)
  updateSelection(ink.selection, Math.min(COLS - 1, a.col + width - 1), z.row)
  finishSelection(ink.selection)
  const copied = ink.copySelectionNoClear() as string
  ink.clearTextSelection()
  return copied
}

/** One delivery's readings, kept so later cases reuse them instead of
 *  re-rendering the same path (the composer is reset between deliveries, so
 *  re-running would only cost time and risk a different frame). */
interface DeliveryResult {
  readonly d: Delivery
  readonly value: string
  readonly submitted: string
  readonly chipLines: number | null
  readonly copied: string | null
  readonly verdict: string
  readonly snapshot: readonly string[]
}

const results = new Map<string, DeliveryResult>()

/** Deliver one transport, read the verdict off the composer, then submit it. */
async function runDelivery(d: Delivery): Promise<DeliveryResult> {
  await resetComposer()
  submittedCount = 0
  lastSubmitted = ''
  if (d.path === 'P3') {
    stubCalls = 0
    stubText = d.deliveredText
  }
  const copied = d.path === 'P4' ? await copySelectionTransport(d) : null
  if (d.path === 'P4') stdinObj.write(`\x1b[200~${copied}\x1b[201~`)
  else for (const chunk of d.chunks) stdinObj.write(chunk)
  const landed = await settled(
    // "Landed" means PAINTED: the controller's value mirror updates
    // synchronously in setInput while the frame still shows the old box, so
    // the wait is tied to the rendered value. A paste the ingress deleted
    // wholesale never satisfies it — the bounded wait is what ends the round.
    () => composerText() !== '' && screenHas(composerText().slice(0, PAINT_PROBE_CHARS)),
    { timeoutMs: LAND_MS },
  )
  const value = composerText()
  const chip = chipOnScreen()
  await quiesce()
  const snapshot = viewport()
  // Submit read-out. The chat screen reserves one Enter for its off-bottom
  // restore (`↓ back to bottom (Enter/End)`), and that press never reaches the
  // composer; the probe therefore presses Enter, gives the app a bounded window
  // to submit, and presses again. A submit clears the draft synchronously, so
  // the second press can never double-send. Both waits are conditions.
  stdinObj.write('\r')
  let submittedNow = await settled(() => submittedCount > 0, { timeoutMs: SUBMIT_FIRST_MS })
  if (!submittedNow) {
    stdinObj.write('\r')
    submittedNow = await settled(() => submittedCount > 0, { timeoutMs: SUBMIT_MS })
  }
  const submitted = submittedCount > 0 ? lastSubmitted : ''
  if (d.path === 'P3') stubReads += stubCalls
  const verdict = verdictLine(d, value, submitted, chip?.lines ?? null, copied, landed)
  const result: DeliveryResult = { d, value, submitted, chipLines: chip?.lines ?? null, copied, verdict, snapshot }
  results.set(d.file, result)
  if (d.matrix === false) {
    // Case-only variant: never part of the 14-row matrix block.
    console.log(`h3-extra ${verdict}`)
  } else {
    verdicts.push(verdict)
    console.log(verdict)
    writeEvidence(d.file, evidenceBody(d, verdict, value, submitted, copied, snapshot))
  }
  return result
}

/** Run a named delivery once; every later case reuses that reading. */
async function ensureDelivery(file: string): Promise<DeliveryResult> {
  const cached = results.get(file)
  if (cached !== undefined) return cached
  const d = deliveriesByFile.get(file)
  if (d === undefined) throw new Error(`unknown delivery: ${file}`)
  return runDelivery(d)
}

// ── H1–H5 discriminants (DESIGN §2) ────────────────────────────────────────

/** `agrees` = the prediction held, `deviates` = it did not, `undecided` =
 *  the run could not separate it (never a silent pass). */
type CaseVerdict = 'agrees' | 'deviates' | 'undecided'

interface CaseRun {
  readonly id: CaseId
  readonly title: string
  readonly lines: readonly string[]
  readonly verdict: CaseVerdict
  readonly reason: string
}

/** H1 · only the real-Vk and the mixed record streams reproduce the symptom. */
const H1_KEYS = ['P1-whole-big', 'P1-chunked-big', 'P2a-big', 'P2b-big', 'P2c-big'] as const

async function caseH1(): Promise<CaseRun> {
  const lines: string[] = ['h1 predict=only-real-vk-and-mixed-record-streams-reproduce']
  const clean: string[] = []
  const dirty: string[] = []
  for (const key of H1_KEYS) {
    const r = await ensureDelivery(key)
    const delivered = normalize(r.d.deliveredText)
    // Split the deviation in two: `transportDiff` is what the transport never
    // handed over at all, `ingressDiff` what the ingress deleted from what it
    // did hand over (the H2 signal, measured without blaming the transport).
    lines.push([
      `h1 row ${key}`, `valueLines=${linesOf(r.value)}`,
      `firstDiff=${diffText(r.d.payload.lf, r.submitted === '' ? r.value : r.submitted)}`,
      `transportDiff=${diffText(r.d.payload.lf, delivered)}`,
      `ingressDiff=${diffText(delivered, r.value)}`,
    ].join(' '))
    if (r.verdict.includes('firstDiff=none')) clean.push(key)
    else dirty.push(key)
  }
  lines.push(`h1 clean=[${clean.join(',')}] dirty=[${dirty.join(',')}]`)
  let verdict: CaseVerdict = 'undecided'
  let reason = 'no-delivery-deviated-so-the-form-question-is-unresolved'
  if (dirty.includes('P2b-big')) {
    verdict = 'agrees'
    reason = 'real-vk-record-stream-reproduces-the-symptom'
  } else if (clean.includes('P2b-big') && clean.includes('P1-chunked-big') && dirty.includes('P2c-big')) {
    verdict = 'deviates'
    reason = 'real-vk-and-chunked-forms-deliver-byte-clean-only-payload-carried-record-text-reproduces'
  }
  return { id: 'h1', title: 'H1 terminal delivery form coverage (DESIGN 2)', lines, verdict, reason }
}

/**
 * H2 counterfactuals — JUDGEMENT ONLY, PRODUCT CODE IS UNTOUCHED. Both keep
 * the product's arming condition (`hasRecordStream` on the original text) so
 * each stays a one-variable change:
 *   ① reorder — strip the full ESC-bearing record BEFORE the ESC-less tail,
 *      so the tail can no longer split a record from the inside;
 *   ② anchor  — keep the order, but make the tail regex refuse a match that
 *      directly follows an ESC (negative lookbehind), i.e. never match the
 *      record's own `[.._` half.
 * The two fixes are separable on purpose: ① cannot repair the width of the
 * rule, ② cannot repair an ESC-less tail that is real payload text — the
 * experiment has to say which gap each one leaves open (ADR-0008).
 */
const RECORD_RE = /\u001b\[\d*(?:;\d*){5}_/gu
const RECORD_TAIL_RE = /\[\d*(?:;\d*){5}_/gu
const RECORD_TAIL_NOT_AFTER_ESC_RE = /(?<!\u001b)\[\d*(?:;\d*){5}_/gu

function reorderedSanitizePasted(text: string): string {
  const hasRecordStream = text.match(RECORD_RE) !== null
  const withoutRecords = text.replace(RECORD_RE, '')
  return sanitizeEditableText(hasRecordStream ? withoutRecords.replace(RECORD_TAIL_RE, '') : withoutRecords)
}

function anchoredSanitizePasted(text: string): string {
  const hasRecordStream = text.match(RECORD_RE) !== null
  return sanitizeEditableText(hasRecordStream ? text.replace(RECORD_TAIL_NOT_AFTER_ESC_RE, '') : text)
}

/** A real conhost CR record — the shape issue #827/#1090 leaked as text. */
const H2_RECORD_CR = '\u001b[13;28;13;1;0;1_'

interface H2Unit {
  readonly id: string
  readonly text: string
  /** Text that is ordinary payload: the strip must not touch a char of it. */
  readonly zeroHarm?: true
}

const H2_UNITS: readonly H2Unit[] = [
  // The T01 minimal experiment: a full record immediately followed by payload.
  { id: 'realistic-minimal', text: `${H2_RECORD_CR}ravo` },
  // The shortest string that satisfies BOTH record grammars: `\d*` allows the
  // digit groups to be empty, so five bare separators are a valid record.
  { id: 'grammar-minimal', text: '\u001b[;;;;;_r' },
  // Payload that itself carries an ESC-less record-shaped word: the width
  // question (ADR-0002's zero-harm contract), separate from the order one.
  { id: 'literal-tail-in-payload', text: `${H2_RECORD_CR}x[13;28;13;1;0;1_y` },
  { id: 'literal-tail-without-record', text: '[13;28;13;1;0;1_y', zeroHarm: true },
  { id: 'record-then-newline', text: `${H2_RECORD_CR}\nBravo`, zeroHarm: true },
  { id: 'real-underscore', text: 'Alpha_beta [draft_1] tail_r', zeroHarm: true },
  { id: 'bracket-lookalike', text: 'array[13;28;13;1;0;1_]x', zeroHarm: true },
  // Not a one-off: every record in the stream can eat its follower.
  { id: 'two-records-two-chars', text: `${H2_RECORD_CR}r${H2_RECORD_CR}s` },
]

interface H2Reading {
  readonly unit: H2Unit
  readonly product: string
  readonly editableOnly: string
  readonly reordered: string
  readonly anchored: string
  readonly defectChars: number
  readonly reorderedDefect: number
  readonly anchoredDefect: number
}

async function caseH2(): Promise<CaseRun> {
  const lines: string[] = ['h2 predict=mixed-tail-loses-newline-plus-next-char-and-removing-the-strip-restores-it']
  const readings: H2Reading[] = []
  let zeroHarmHeld = true
  for (const unit of H2_UNITS) {
    const product = sanitizePastedText(unit.text)
    const editableOnly = sanitizeEditableText(unit.text)
    const reordered = reorderedSanitizePasted(unit.text)
    const anchored = anchoredSanitizePasted(unit.text)
    // `defectChars` = what the paste-only rule deleted ON TOP of the innocent
    // (typed-text) reading. The record text itself is deleted by both readings,
    // so this counts exactly the payload characters the rule eats.
    const defectChars = align(editableOnly, product).deleted
    const reorderedDefect = align(editableOnly, reordered).deleted
    const anchoredDefect = align(editableOnly, anchored).deleted
    readings.push({ unit, product, editableOnly, reordered, anchored, defectChars, reorderedDefect, anchoredDefect })
    if (unit.zeroHarm === true && defectChars !== 0) zeroHarmHeld = false
    lines.push([
      `h2 unit id=${unit.id}`, `chars=${[...unit.text].length}`, `input=${JSON.stringify(unit.text)}`,
      `product=${JSON.stringify(product)}`, `editableOnly=${JSON.stringify(editableOnly)}`,
      `reordered=${JSON.stringify(reordered)}`, `anchored=${JSON.stringify(anchored)}`,
      `defectChars=${defectChars}`, `reorderedDefect=${reorderedDefect}`, `anchoredDefect=${anchoredDefect}`,
    ].join(' '))
  }

  // The mechanism in three observed steps, from the real functions: the tail
  // strip splits the full record open (`ESC` + the tail is removed), the
  // full-record regex then has nothing left to match, and the orphan ESC is
  // handed to `stripAnsi` — which eats itself plus the following payload char.
  const mechanismInput = `${H2_RECORD_CR}ravo`
  const tailStripped = mechanismInput.replace(RECORD_TAIL_RE, '')
  lines.push([
    'h2 mechanism', `input=${JSON.stringify(mechanismInput)}`,
    `afterTailStrip=${JSON.stringify(tailStripped)}`,
    `fullRecordLeftForTheRecordRegex=${tailStripped.match(RECORD_RE) !== null}`,
    `orphanEscPlusFollower=${JSON.stringify(sanitizeEditableText(tailStripped))}`,
    `product=${JSON.stringify(sanitizePastedText(mechanismInput))}`,
    `productEqualsTailStripThenEditable=${sanitizePastedText(mechanismInput) === sanitizeEditableText(tailStripped)}`,
  ].join(' '))

  // Which following characters does the orphan ESC eat? Scan the printable
  // range instead of quoting a regex class: the set IS the evidence.
  const eaten: string[] = []
  const kept: string[] = []
  for (let code = 33; code <= 126; code += 1) {
    const ch = String.fromCharCode(code)
    const defect = align(sanitizeEditableText(`${H2_RECORD_CR}${ch}`), sanitizePastedText(`${H2_RECORD_CR}${ch}`)).deleted
    if (defect > 0) eaten.push(ch)
    else kept.push(ch)
  }
  lines.push(`h2 scan-follower record+<c> for c in !..~ : eaten=${eaten.length} kept=${kept.length} eatenChars=${JSON.stringify(eaten.join(''))}`)

  // Minimal trigger, derived rather than asserted: the family varies only the
  // number of bare separators, and only five of them satisfy the grammar.
  const family = Array.from({ length: 8 }, (_, seps) => `\u001b[${';'.repeat(seps)}_r`)
  const triggering = family.filter(t => align(sanitizeEditableText(t), sanitizePastedText(t)).deleted > 0)
  const shortest = triggering[0] ?? ''
  lines.push(`h2 minimal family=ESC[+<k-semicolons>+_+r k=0..7 candidates=${family.length} triggering=${triggering.length} shortest=${JSON.stringify(shortest)} shortestChars=${[...shortest].length} with-real-record=${JSON.stringify(`${H2_RECORD_CR}r`)} chars=${[...`${H2_RECORD_CR}r`].length}`)

  // Tie the unit-level defect to the rendered symptom: feed the recorded P2c
  // transport text through the PRODUCT function and compare with the value the
  // composer actually held. If they are equal, the ingress under test is the
  // one that produced the on-screen (and on-submit) loss — no other step needed.
  const p2c = await ensureDelivery('P2c-big')
  const delivered = normalize(p2c.d.deliveredText)
  const source = p2c.d.payload.lf
  const e2eProduct = sanitizePastedText(delivered)
  const e2eReordered = reorderedSanitizePasted(delivered)
  const e2eEditableOnly = sanitizeEditableText(delivered)
  lines.push([
    'h2 e2e path=P2c-big', `sourceChars=${[...source].length}`, `deliveredChars=${[...delivered].length}`,
    `renderedValueChars=${[...p2c.value].length}`, `productChars=${[...e2eProduct].length}`,
    `productMatchesRenderedValue=${e2eProduct === p2c.value}`,
    `payloadCharsLostProduct=${align(source, e2eProduct).deleted}`,
    `payloadCharsLostEditableOnly=${align(source, e2eEditableOnly).deleted}`,
    `payloadCharsLostReordered=${align(source, e2eReordered).deleted}`,
    `ingressDeletedProduct=${[...delivered].length - [...e2eProduct].length}`,
    `ingressDeletedReordered=${[...delivered].length - [...e2eReordered].length}`,
  ].join(' '))

  const defectOf = (id: string): number => readings.find(r => r.unit.id === id)?.defectChars ?? -1
  const orderDefectProven = defectOf('realistic-minimal') > 0 && defectOf('grammar-minimal') > 0
  const defectUnits = readings.filter(r => r.defectChars > 0).map(r => `${r.unit.id}:${r.defectChars}`)
  const orderFixLeft = readings.filter(r => r.reorderedDefect > 0).map(r => `${r.unit.id}:${r.reorderedDefect}`)
  const anchorFixLeft = readings.filter(r => r.anchoredDefect > 0).map(r => `${r.unit.id}:${r.anchoredDefect}`)
  lines.push(`h2 fix-compare defectUnits=[${defectUnits.join(',')}] orderFixLeaves=[${orderFixLeft.join(',')}] anchorFixLeaves=[${anchorFixLeft.join(',')}] zeroHarmHeld=${zeroHarmHeld}`)

  let verdict: CaseVerdict = 'undecided'
  let reason = 'order-defect-not-reproduced-by-the-minimal-inputs'
  if (orderDefectProven && e2eProduct === p2c.value && zeroHarmHeld) {
    verdict = 'agrees'
    reason = 'paste-only-strip-eats-a-payload-char-and-the-product-function-reproduces-the-rendered-value'
  } else if (!orderDefectProven) {
    verdict = 'deviates'
    reason = 'no-order-defect-observed'
  } else if (!zeroHarmHeld) {
    reason = 'order-defect-proven-but-a-zero-harm-unit-was-damaged'
  }
  return { id: 'h2', title: 'H2 ESC-less tail strip width and strip order (DESIGN 2)', lines, verdict, reason }
}

/** H3 · a download split across reads changes `\r` / `\n` handling. */
const H3_KEYS = ['P1-whole-big', 'P1-chunked-big', 'P1-perchar-big', 'P1-marker-split-big', 'P1-perchar-small', 'P1-marker-split-small'] as const

async function caseH3(): Promise<CaseRun> {
  const lines: string[] = ['h3 predict=chunked-delivery-differs-from-whole-delivery']
  const dirty: string[] = []
  for (const key of H3_KEYS) {
    const r = await ensureDelivery(key)
    const submitted = r.submitted === '' ? r.value : r.submitted
    lines.push([
      `h3 row ${key}`, `reads=${r.d.chunks.length}`, `valueLines=${linesOf(r.value)}`,
      `submitLines=${linesOf(r.submitted)}`, `chipLines=${r.chipLines ?? 'n/a'}`,
      `firstDiff=${diffText(r.d.payload.lf, submitted)}`, `crKeptInValue=${r.value.includes('\r')}`,
    ].join(' '))
    if (!r.verdict.includes('firstDiff=none')) dirty.push(key)
  }
  lines.push(`h3 dirty=[${dirty.join(',')}]`)
  const chunkedDirty = dirty.filter(key => key !== 'P1-whole-big')
  const verdict: CaseVerdict = chunkedDirty.length > 0 ? 'agrees' : dirty.length === 0 ? 'deviates' : 'undecided'
  const reason = chunkedDirty.length > 0
    ? `chunked-reads-deviate:${chunkedDirty.join(',')}`
    : 'every-chunk-profile-matches-the-whole-payload-reading'
  return { id: 'h3', title: 'H3 bracketed paste across chunk boundaries (DESIGN 2)', lines, verdict, reason }
}

/** H4 · the fold build / submit assembly drops the newlines. */
async function caseH4(): Promise<CaseRun> {
  const lines: string[] = ['h4 predict=value-keeps-newlines-while-submitted-does-not']
  let valueAboveSubmit = 0
  let submitDiffers = 0
  let chipAboveValue = 0
  for (const key of MATRIX_KEYS) {
    const r = await ensureDelivery(key)
    const submitVsValue = r.submitted === '' ? 'n/a' : diffText(r.value, r.submitted)
    if (linesOf(r.value) > linesOf(r.submitted)) valueAboveSubmit += 1
    if (submitVsValue !== 'n/a' && submitVsValue !== 'none') submitDiffers += 1
    if (r.chipLines !== null && r.chipLines !== linesOf(r.value)) chipAboveValue += 1
    lines.push([
      `h4 row ${key}`, `valueLines=${linesOf(r.value)}`, `submitLines=${linesOf(r.submitted)}`,
      `chipLines=${r.chipLines ?? 'n/a'}`, `valueKeepsNewlines=${r.value.includes('\n')}`,
      `submitVsValue=${submitVsValue}`,
    ].join(' '))
  }
  lines.push(`h4 counts rows=${MATRIX_KEYS.length} valueLinesAboveSubmitLines=${valueAboveSubmit} submitDiffersFromValue=${submitDiffers} chipAboveValueLines=${chipAboveValue}`)
  const verdict: CaseVerdict = valueAboveSubmit === 0 && submitDiffers === 0 ? 'deviates' : 'agrees'
  const reason = verdict === 'deviates'
    ? 'submit-assembly-carries-the-value-verbatim-every-line-loss-already-happened-in-the-value'
    : 'value-and-submit-line-counts-diverge'
  return { id: 'h4', title: 'H4 fold build and submit assembly (DESIGN 2)', lines, verdict, reason }
}

/** H5 · the selection copy loses newlines and boundary characters. */
const H5_KEYS = ['P4-big', 'P4-small'] as const

async function caseH5(): Promise<CaseRun> {
  const lines: string[] = ['h5 predict=selection-copy-drops-newlines-and-boundary-chars']
  let pasteLossless = true
  let copyDeleted = 0
  let copyInserted = 0
  for (const key of H5_KEYS) {
    const r = await ensureDelivery(key)
    const copied = r.copied ?? ''
    const submitted = r.submitted === '' ? r.value : r.submitted
    const copy = align(r.d.payload.lf, copied)
    if (!r.verdict.includes('pasteDiff=none')) pasteLossless = false
    copyDeleted += copy.deleted
    copyInserted += copy.inserted
    lines.push([
      `h5 row ${key}`, `sourceChars=${[...r.d.payload.lf].length}`, `copiedChars=${[...copied].length}`,
      `copyInserted=${copy.inserted}`, `copyDeleted=${copy.deleted}`,
      `copyFirstDiff=${diffText(r.d.payload.lf, copied)}`, `pasteVsCopied=${diffText(copied, submitted)}`,
      `pasteVsSource=${diffText(r.d.payload.lf, submitted)}`, `copyStepLossless=${copy.deleted === 0}`,
    ].join(' '))
  }
  lines.push(`h5 counts copyDeletedTotal=${copyDeleted} copyInsertedTotal=${copyInserted} pasteStepLossless=${pasteLossless}`)
  let verdict: CaseVerdict = 'undecided'
  let reason = 'copy-deletes-source-chars-while-the-paste-step-is-byte-exact'
  if (!pasteLossless) {
    verdict = 'agrees'
    reason = 'the-p4-delivery-itself-loses-bytes'
  } else if (copyDeleted === 0) {
    verdict = 'deviates'
    reason = 'copy-adds-transcript-chrome-only-and-the-paste-step-is-byte-exact'
  }
  return { id: 'h5', title: 'H5 selection copy softWrap / contentEnd clamp (DESIGN 2)', lines, verdict, reason }
}

const CASES: Record<CaseId, () => Promise<CaseRun>> = { h1: caseH1, h2: caseH2, h3: caseH3, h4: caseH4, h5: caseH5 }

/** The deliveries each case consumes — used to record what it read. */
const caseUsage: Record<CaseId, readonly string[]> = {
  h1: H1_KEYS, h2: ['P2c-big'], h3: H3_KEYS, h4: MATRIX_KEYS, h5: H5_KEYS,
}

/** `<hN>.txt`: the case's own raw output, plus the readings it consumed, so a
 *  verdict in the report can be re-checked without re-running the probe. */
function writeCaseEvidence(run: CaseRun): void {
  if (VERDICT_DIR === null) return
  const used = caseUsage[run.id].map(key => results.get(key)).filter((r): r is DeliveryResult => r !== undefined)
  // Focused cases carry the full dumps; h4 reads all 14 rows, whose dumps are
  // already in probe/matrix/, so it carries their verdict lines instead.
  const dumps = used.length <= 6
    ? used.flatMap(r => [
      `# ${r.d.file} — transport handed over (${[...normalize(r.d.deliveredText)].length} chars):`,
      JSON.stringify(normalize(r.d.deliveredText)),
      `# ${r.d.file} — composer value (${[...r.value].length} chars):`,
      JSON.stringify(r.value),
      `# ${r.d.file} — submitted (${[...r.submitted].length} chars):`,
      JSON.stringify(r.submitted),
      ...(r.copied === null ? [] : [`# ${r.d.file} — copied by the selection (${[...r.copied].length} chars):`, JSON.stringify(r.copied)]),
    ])
    : [`# per-delivery dumps: probe/matrix/<file>.txt (${used.length} files)`]
  const body = [
    `# paste-loss probe — hypothesis discriminant ${run.id}: ${run.title}`,
    `# command: node --import tsx/esm scripts/repro-paste-loss.tsx ${commandLine}`,
    `# platform=${process.platform} node=${process.version} probe=${PROBE_DIR ?? '<skipped>'}`,
    '# raw output (this case, verbatim):',
    ...run.lines,
    '# deliveries this case consumed (verbatim verdict lines):',
    ...used.map(r => `verdict: ${r.verdict}`),
    ...dumps,
    `conclusion: verdict=${run.verdict} reason=${run.reason}`,
    '',
  ].join('\n')
  mkdirSync(VERDICT_DIR, { recursive: true })
  writeFileSync(join(VERDICT_DIR, `${run.id}.txt`), body)
  hypothesisFiles += 1
}

/** Discriminator self-check: the diff must see the historical signature
 *  (deleted `\n` + the following char) and a flattened payload, otherwise a
 *  `firstDiff=none` verdict would prove nothing. */
function selfCheck(): void {
  const p = payloads.big
  const index = p.lf.indexOf('\n')
  const deleted = p.lf.slice(0, index) + p.lf.slice(index + 2)
  const flattened = p.lf.replace(/\n/gu, '')
  console.log(`selfcheck deleted-newline-and-char → firstDiff=${diffText(p.lf, deleted)} lines=${deleted.split('\n').length}`)
  console.log(`selfcheck flattened-payload → firstDiff=${diffText(p.lf, flattened)} lines=${flattened.split('\n').length}`)
  console.log(`selfcheck clean-payload → firstDiff=${diffText(p.lf, p.lf)} lines=${p.lf.split('\n').length}`)
  console.log(`payload big=${[...p.lf].length}chars/${p.lines.length}lines folds=${p.folds} small=${[...payloads.small.lf].length}chars/${payloads.small.lines.length}lines folds=${payloads.small.folds}`)
}

// P3 stub state, read by the redirected module (see CLIPBOARD_STUB_SOURCE).
let stubText = ''
let stubCalls = 0
/** Total stub reads across both P3 rounds — the real reader is never called. */
let stubReads = 0
;(globalThis as any).__pasteLossReadClipboard = () => {
  stubCalls += 1
  return Promise.resolve({ kind: 'text', text: stubText })
}

const instance = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} promptControllerRef={composerRef as never} onExit={() => {}} />
  </AlternateScreen>,
  { stdout: fakeStdout, stdin: stdinObj, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)

try {
  console.log(`probe platform=${process.platform} node=${process.version} win32-input-mode-capable=${supportsWin32InputMode(process.platform, process.env.TERM_PROGRAM, process.env.TERM_PROGRAM_VERSION)} probeDir=${PROBE_DIR ?? '<skipped>'}`)
  selfCheck()
  // First frame: the composer controller is installed by a layout effect and
  // the prompt glyph is painted with it — one condition, no pacing sleep.
  const ready = await settled(() => composerRef.current !== null && screenHas('❯'), { timeoutMs: 8000 })
  if (!ready) throw new Error('composer never mounted')

  // The T01 block runs first and prints exactly what it printed before: same
  // 14 verdict lines, same summary line, same evidence files.
  if (cli.matrix) {
    for (const d of deliveries) await runDelivery(d)

    const expected = deliveries.length
    const dirty = verdicts.filter(v => !v.includes('firstDiff=none')).length
    console.log(`verdicts=${verdicts.length}/${expected} symptoms=${dirty} p3-stub-reads=${stubReads} probe-files=${probeWrites}`)
    if (verdicts.length !== expected) {
      harnessFailures += 1
      console.error(`harness: ${expected - verdicts.length} delivery(ies) produced no verdict`)
    }
  }

  // Discriminants last: `--all` lets them reuse the matrix readings, and a
  // `--case hN` run renders only the deliveries that case needs.
  const caseRuns: CaseRun[] = []
  for (const id of cli.cases) {
    const run = await CASES[id]()
    caseRuns.push(run)
    console.log(`--- case ${run.id}: ${run.title} ---`)
    for (const line of run.lines) console.log(line)
    console.log(`${run.id} verdict=${run.verdict} reason=${run.reason}`)
    writeCaseEvidence(run)
  }
  if (caseRuns.length > 0) {
    console.log(`h-cases=${caseRuns.length} h-files=${hypothesisFiles} h-conclusions=${caseRuns.map(r => `${r.id}:${r.verdict}`).join(' ')}`)
  }
} catch (error: unknown) {
  harnessFailures += 1
  console.error(`harness error: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await instance.unmount()
  rmSync(dataDir, { recursive: true, force: true })
}
process.exit(harnessFailures === 0 ? 0 : 1)
