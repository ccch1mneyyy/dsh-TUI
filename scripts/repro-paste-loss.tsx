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
 * Run with: node --import tsx/esm scripts/repro-paste-loss.tsx
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
const PROBE_DIR = existsSync(fileURLToPath(new URL('.claude/worktrees', workspaceRoot)))
  ? fileURLToPath(new URL('.specs/dsh-tui-paste-loss-and-plugin-gate/probe/matrix/', workspaceRoot))
  : null

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

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, termTest, { startSelection, updateSelection, finishSelection }, { default: inkInstances }, { supportsWin32InputMode }] = await Promise.all([
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
])

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

const verdicts: string[] = []
let harnessFailures = 0
let probeWrites = 0

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
  const linesOf = (text: string): number => (text === '' ? 0 : text.split('\n').length)
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

/** Deliver one transport, read the verdict off the composer, then submit it. */
async function runDelivery(d: Delivery): Promise<void> {
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
  verdicts.push(verdict)
  console.log(verdict)
  writeEvidence(d.file, evidenceBody(d, verdict, value, submitted, copied, snapshot))
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

  for (const d of deliveries) await runDelivery(d)

  const expected = deliveries.length
  const dirty = verdicts.filter(v => !v.includes('firstDiff=none')).length
  console.log(`verdicts=${verdicts.length}/${expected} symptoms=${dirty} p3-stub-reads=${stubReads} probe-files=${probeWrites}`)
  if (verdicts.length !== expected) {
    harnessFailures += 1
    console.error(`harness: ${expected - verdicts.length} delivery(ies) produced no verdict`)
  }
} catch (error: unknown) {
  harnessFailures += 1
  console.error(`harness error: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await instance.unmount()
  rmSync(dataDir, { recursive: true, force: true })
}
process.exit(harnessFailures === 0 ? 0 : 1)
