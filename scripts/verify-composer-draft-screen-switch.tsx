#!/usr/bin/env node
/**
 * Regression for change `composer-draft-screen-switch`: the composer draft
 * (text, newline structure and caret) must survive a full-screen view round
 * trip, while an empty composer keeps behaving exactly as before.
 *
 * Drives the REAL `Chat` + `PromptInput` through fake stdin and a headless
 * xterm (same harness as the investigation driver
 * `.specs/composer-draft-screen-switch/evidence/repro-draft-screen.tsx`).
 * Waits go through `scripts/lib/term-test.mjs` (`settled`/`settle`) so the
 * assertions observe the same predicate they wait on.
 *
 * Scenarios (REQUIREMENT「验证方式」):
 * - `ctrl-a`  (AC-1): draft with the caret mid-text, Ctrl+A, Esc — the input
 *   block AND the parked native caret (useDeclaredCursor) must match.
 * - `ctrl-t`  (AC-2): multi-line draft, Ctrl+T, q — block + caret match.
 * - `no-draft` (AC-7 basics): empty composer, Ctrl+A/Esc + Ctrl+T/q — no
 *   renderer error, no residual token, keys still land afterwards.
 * - `routed-screens` (AC-3): every early-return entry the stub can drive —
 *   Ctrl+A dashboard, subagent detail, Ctrl+T trajectory, plugin scene,
 *   interrupt lane (question over the dashboard) and a JobCard click into
 *   `/jobs` keep a real draft + caret; `/settings`, `/resume` (browse → Esc),
 *   `/tree`, `/jobs` (command), `/agentview` round-trip with the exact state
 *   command dispatch leaves behind (empty composer, caret 0).
 * - `edit-state` (AC-4): text + caret + `[Image #N]` staged attachment +
 *   fold block + fullscreen draft editor + vim INSERT/NORMAL are asserted
 *   field by field across a Ctrl+A round trip.
 * - `intentional-clear` (AC-5): Ctrl+C, empty-input double Esc, submit and
 *   `/clear` all stay cleared across a following full-screen round trip.
 * - `session-switch` (AC-6): a generation bump while the composer is parked
 *   (the `/resume` select-other, `/new`, `/bg`, attach fence) drops the old
 *   draft text and staged image instead of leaking them into the new session.
 * - `inflight-stage` (DESIGN D5): an image stage parked inside the channel
 *   when the composer unmounts is fenced by the unmount revision bump — no
 *   token, no visible/committable binding, the orphaned capability is
 *   reclaimed and editing resumes after the round trip.
 *
 * `routed-screens` documents one deliberate limitation: `/settings`,
 * `/resume` and `/tree` cannot be opened with a non-empty draft on this build
 * — command dispatch clears the composer synchronously before the screen
 * mounts — so those entries assert the empty-state round trip, while the
 * draft-carrying mechanism of the SAME early-return branches is covered by
 * the entries that open without consuming the composer (`/jobs` additionally
 * through the JobCard click path with a real draft). Manual UAT-3 covers the
 * literal per-command-entry draft wording.
 *
 * Run from the checkout root:
 *   node --import tsx/esm scripts/verify-composer-draft-screen-switch.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
// Isolate HOME before importing the app: i18n / preferences resolve at import.
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-composer-draft-'))
process.env.HOME = home
process.env.USERPROFILE = home
// The composer's staged-image chip colour is part of the AC-4 assertion; the
// terminal-image renderer itself is irrelevant here (and wants a real TTY).
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
/**
 * A real on-disk 1x1 PNG for the staged-image paste path: `parsePastedImagePath`
 * stats the path, `readBoundedRegularFile` reads the bytes and the channel stub
 * stages them; nothing decodes the pixels.
 */
const pastedImagePath = join(home, 'draft-probe.png')
writeFileSync(
  pastedImagePath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

const [
  { PassThrough, Writable },
  { default: React },
  { Terminal: XTerm },
  { render, AlternateScreen, Text },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS, completeCommands },
  { settled, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 36
const ESC = '\x1b'
const CTRL_A = '\x01'
const CTRL_T = '\x14'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const BACKSPACE = '\x7f'
const BRACKET_PASTE_START = '\x1b[200~'
const BRACKET_PASTE_END = '\x1b[201~'
/** CSI-u Ctrl+Shift+E: the fullscreen draft editor binding (E = 69,
 *  modifier 6 = ctrl+shift) — same encoding verify-expand-editor uses. */
const CTRL_SHIFT_E = '\x1b[69;6u'
/** CSI-u Ctrl+Enter: submit from inside the expanded editor. */
const CTRL_ENTER = '\x1b[13;5u'
/** ≥ FOLD_MIN_LINES (6): a bracketed paste of this folds into one chip. */
const BIG_PASTE = Array.from({ length: 12 }, (_, i) => `fold-line-${String(i).padStart(2, '0')}`).join('\n')
/** Unique markers: command descriptions share words with screen titles, so
 *  every entry asserts an empty/loading hint that only that screen renders. */
const SCREEN_MARK = {
  settings: '没有可配置的插件设置',
  resume: '当前目录没有可恢复的历史会话',
  tree: '正在加载会话树',
  jobs: '当前会话暂无后台任务',
  agentview: '没有会话。在下方输入任务描述',
  dashboard: '子代理面板',
  rewind: '选择一条消息，将对话回退到该处',
} as const
const STAGED_IMAGE_TOKEN = '[Image #1]'

/**
 * CSI-u Shift+Enter encodes the modifier raw 0x0a cannot: 0x0a arrives as a
 * plain `return` (submit), while `ESC[13;2u` reports shift+return and takes
 * PromptInput's "insert newline" arm — the same path a modern terminal gives
 * the user for a multi-line draft.
 */
const SHIFT_ENTER = '\x1b[13;2u'

/**
 * Renderer errors (`logError` -> `process.stderr` with a `[dsh-tui]` prefix)
 * are collected instead of swallowed: an error in any scenario must fail the
 * run even when the screen happens to recover.
 *
 * The same interception keeps a second signal (REVIEW F-9): React dev-mode
 * warnings also reach `console.error` -> `process.stderr` and were previously
 * ignored. Only the pre-existing `useInsertionEffect` warning is whitelisted
 * — the unmodified `verify-expand-editor` fixture reproduces it on this repo,
 * so it is not a signal this change owns. Every other stderr line fails the
 * scenario that emitted it. Forwarded to the real stderr either way so a
 * failure still shows the original output.
 */
const WHITELISTED_STDERR = 'useInsertionEffect must not schedule updates'
const runtimeErrors: string[] = []
/** Raw chunks, in write order: the runner attributes a new one to the
 *  scenario that was running, and the final harness check catches stragglers. */
const stderrChunks: string[] = []
const realStderrWrite = process.stderr.write.bind(process.stderr)
;(process.stderr as { write: (...args: unknown[]) => unknown }).write = ((
  chunk: unknown,
  ...rest: unknown[]
) => {
  const text = typeof chunk === 'string' ? chunk : String(chunk)
  if (text.includes('[dsh-tui]')) runtimeErrors.push(text.trim())
  stderrChunks.push(text)
  return (realStderrWrite as (...args: unknown[]) => unknown)(chunk, ...rest)
}) as typeof process.stderr.write

/** Stderr lines a scenario may NOT produce: renderer errors keep their own
 *  list (asserted at the end), the known React warning is whitelisted, and
 *  anything else is a new signal that must fail its owner. */
function unexpectedStderrLines(chunks: readonly string[]): string[] {
  return chunks
    .join('')
    .split('\n')
    .map(line => line.trim())
    .filter(line =>
      line !== ''
      && !line.includes('[dsh-tui]')
      && !line.includes(WHITELISTED_STDERR),
    )
}

class VerifyFailure extends Error {
  readonly scenario: string
  readonly detail: string
  readonly expected: unknown
  readonly actual: unknown

  constructor(scenario: string, detail: string, expected: unknown, actual: unknown) {
    super(`${scenario}: ${detail}`)
    this.name = 'VerifyFailure'
    this.scenario = scenario
    this.detail = detail
    this.expected = expected
    this.actual = actual
  }
}

function assertTrue(scenario: string, detail: string, actual: unknown): void {
  if (actual !== true) throw new VerifyFailure(scenario, detail, true, actual)
}

function assertEqual(scenario: string, detail: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new VerifyFailure(scenario, detail, expected, actual)
  }
}

/** Wait for a predicate that must eventually hold; timeout = hard failure. */
async function waitFor(
  scenario: string,
  what: string,
  pred: () => boolean,
  timeoutMs?: number,
): Promise<void> {
  const ok = await settled(pred, timeoutMs === undefined ? {} : { timeoutMs })
  if (!ok) throw new VerifyFailure(scenario, `timeout waiting for ${what}`, true, false)
}

interface Harness {
  term: InstanceType<typeof XTerm>
  stdin: InstanceType<typeof PassThrough>
  channel: ReturnType<typeof makeChannel>
  questions: InstanceType<typeof QuestionStore>
  unmount: () => void
}

interface StubStagedImage {
  readonly id: string
  readonly path: string
}

/** Stable references: a fresh `[]`/callback per render would make Chat's
 *  `useSyncExternalStore` loop on unchanged snapshots. */
const EMPTY_LIST: readonly never[] = Object.freeze([])
const noopUnsubscribe = (): (() => void) => () => {}

/**
 * Stub channel: the T04 fixture plus the seams the AC-3~AC-6 entries need
 * (settings screen without a host, agent-view rows, session tree, plugin
 * scene, subagents, interrupt lane, staged images, generation fence).
 * Mutable slices are getters over `state` so a scenario can flip them
 * between renders; `bump()` re-renders Chat like a real channel event.
 */
function makeChannel(options: {
  subagents?: readonly unknown[]
  rows?: readonly unknown[]
  /** Parks `stageComposerImage` so one scenario can hold an image stage in
   *  flight across an unmount (DESIGN D5 / `inflight-stage`). */
  stageGate?: () => Promise<void>
} = {}) {
  const listeners = new Set<() => void>()
  const state = {
    agentBindingGeneration: 0,
    /** Staged-image session epoch, mirroring the real channel: it advances
     *  whenever the capability map is cleared (`composer-images.ts:131-155`),
     *  so a generation bump and a #823 clear both revoke the capabilities
     *  through the same epoch instead of a dead `stagedImageGeneration: () => 0`
     *  (F-11). */
    stagedImageEpoch: 0,
    staged: new Map<string, StubStagedImage>(),
    nextStage: 1,
    submitted: [] as Array<{ text: string; images: readonly unknown[] }>,
    clearCalls: 0,
    /** Seam-level observations: on the real channel these effects surface as
     *  renders or notices; recording them lets a scenario wait on an event
     *  instead of a fixed pacing window (F-10). */
    stageCalls: 0,
    discarded: [] as string[],
    notifyLog: [] as string[],
    pluginScene: undefined as { id: string } | undefined,
    subagents: options.subagents ?? EMPTY_LIST,
    treePending: new Promise<null>(() => {}),
  }
  const channel = {
    whaleIdle: false,
    version: 0,
    rows: options.rows ?? [{ id: 1, kind: 'user' as const, text: 'hi' }],
    status: 'idle' as const,
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    reasoningEffort: 'max',
    effortLevels: [] as string[],
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    pending: [] as unknown[],
    commandList: LOCAL_COMMANDS,
    notifications: [] as unknown[],
    mode: { plan: false, sandbox: undefined },
    activityFrames: 'moon8',
    agentPreset: undefined,
    lastUserText: '',
    scrollGutter: 'timeline',
    state,
    get agentBindingGeneration() {
      return state.agentBindingGeneration
    },
    get pluginScene() {
      return state.pluginScene
    },
    get subagents() {
      return state.subagents
    },
    get backgroundJobs() {
      return EMPTY_LIST
    },
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    bump() {
      channel.version += 1
      for (const cb of listeners) cb()
    },
    submit(text: string, images: readonly unknown[] = []) {
      state.submitted.push({ text, images })
    },
    cancel: () => {},
    clear() {
      state.clearCalls += 1
    },
    notify: (message: string) => {
      state.notifyLog.push(String(message))
    },
    listModels: () => Promise.resolve([]),
    listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(true),
    renameSessionTo: () => Promise.resolve(true),
    setResumeTarget: () => {},
    loadOlder: () => {},
    mcpStatus: () => EMPTY_LIST,
    pushLocal: () => {},
    commandCompletions: (input: string) => completeCommands(input),
    stagedImageGeneration: () => state.stagedImageEpoch,
    stagedImage: (stageId: string) => state.staged.get(stageId),
    hasStagedImage: (stageId: string) => state.staged.has(stageId),
    discardStagedImage: (stageId: string) => {
      state.discarded.push(stageId)
      state.staged.delete(stageId)
    },
    stagedImageLimits: () => ({ maxImageBytes: 1_000_000, maxImagesPerMessage: 8 }),
    stageComposerImage: async () => {
      state.stageCalls += 1
      if (options.stageGate !== undefined) await options.stageGate()
      const stageId = `stage-${state.nextStage++}`
      state.staged.set(stageId, { id: stageId, path: pastedImagePath })
      return { stageId }
    },
    previewImages: () => EMPTY_LIST,
    subagentControl: { interrupt: () => {} },
    backgroundCurrent: async () => ({ ok: true, backgroundedSessionId: 'probe' }),
    agentViewRows: () => EMPTY_LIST,
    subscribeAgentView: noopUnsubscribe,
    settingsHost: () => undefined,
    settingsSections: () => EMPTY_LIST,
    subscribeSettingsSections: noopUnsubscribe,
    /** Session tree stays in its loading state (Esc must still close it). */
    buildSessionTree: () => state.treePending,
    openPluginScene(id: string) {
      state.pluginScene = { id }
      channel.bump()
    },
    closePluginScene() {
      state.pluginScene = undefined
      channel.bump()
    },
    /** Simulate `/resume` selecting another session, `/new`, `/bg`, attach:
     *  the real channel's generation change syncs the session and revokes the
     *  staged capabilities before the new generation is observable
     *  (`composer-images.ts` syncSession -> clearStagedImages). */
    bumpGeneration() {
      state.agentBindingGeneration += 1
      state.stagedImageEpoch += 1
      state.staged.clear()
      channel.bump()
    },
    /** Simulate #823's channel-side staged-image cleanup: capabilities go,
     *  epoch advances, agent generation stays (composer-images.ts:257-259). */
    clearStagedImages() {
      state.stagedImageEpoch += 1
      state.staged.clear()
      channel.bump()
    },
  }
  return channel
}

async function mountChat(options: {
  channel?: ReturnType<typeof makeChannel>
  alternateScreen?: boolean
} = {}): Promise<Harness> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
      term.write(String(chunk), callback)
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
      callback()
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() {
      return this
    }
    ref() {
      return this
    }
    unref() {
      return this
    }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  const stderr = new FakeStderr()
  const questions = new QuestionStore()
  const channel = options.channel ?? makeChannel()
  const chatNode = React.createElement(Chat, {
    channel,
    questionStore: questions,
    fullscreen: true,
    // The plugin-scene branch is a top early return; a minimal real scene
    // (rendered with the TUI's own React/ui kit, like a plugin host does)
    // proves the branch is taken without needing a plugin registry.
    renderScene: (id: string) => React.createElement(Text, null, `PROBE-SCENE ${id}`),
  })
  // The alternate-screen wrapper turns on mouse tracking for the JobCard
  // click path; keyboard-only scenarios stay on the bare renderer.
  const node = options.alternateScreen === true
    ? React.createElement(AlternateScreen, null, chatNode)
    : chatNode
  const instance = await render(
    node,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  return { term, stdin, channel, questions, unmount: () => instance.unmount() }
}

const screen = (app: Harness): string[] => viewportLines(app.term, ROWS)

function inputRange(app: Harness): { top: number; bottom: number } | null {
  const rows = screen(app)
  let bottom = -1
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].includes('╰')) {
      bottom = i
      break
    }
  }
  if (bottom < 0) return null
  for (let i = bottom - 1; i >= 0; i -= 1) {
    if (rows[i].includes('╭')) return { top: i, bottom }
  }
  return null
}

/**
 * The composer box: top border, content row(s), bottom border. Comparing this
 * slice before/after a round trip is the text + newline-structure assertion
 * (the transcript and hint rows outside it are not part of the draft).
 *
 * Trailing cell padding is stripped: it is a renderer frame artifact (a row
 * can be read while the renderer is still filling its remaining cells), not
 * draft content — an observed edit-state run failed on padding alone
 * (T-FIX-02 F-10 stability hardening). The border rows stay full width, so a
 * real box/width change still fails.
 */
function inputBlock(app: Harness): string[] | null {
  const range = inputRange(app)
  if (range === null) return null
  return screen(app).slice(range.top, range.bottom + 1).map(row => row.trimEnd())
}

/** First composer content row (`❯ …`) of the main view. */
function promptRow(app: Harness): string {
  return inputBlock(app)?.[1] ?? ''
}

/** Visible draft text on the single-line composer (affordances stripped). */
function draftText(app: Harness): string {
  return promptRow(app)
    .replace('❯', '')
    .replace('⛶', '')
    .replace(/^\s*(INSERT|NORMAL)\s*/, '')
    .trim()
}

function composerHas(app: Harness, text: string): boolean {
  return inputBlock(app)?.join('\n').includes(text) ?? false
}

function cursorPos(app: Harness): { x: number; y: number } {
  const buffer = app.term.buffer.active
  return { x: buffer.cursorX, y: buffer.cursorY }
}

function dashboardVisible(app: Harness): boolean {
  return screen(app).some(line => line.includes('子代理面板'))
}

function trajectoryVisible(app: Harness): boolean {
  // The title row is unique; the rotating tip line can also mention 轨迹.
  return screen(app).some(line => line.includes('\u2726 轨迹'))
}

/** Ctrl+A -> dashboard -> Esc -> main view (composer remounted). */
async function roundTripDashboard(scenario: string, app: Harness): Promise<void> {
  app.stdin.write(CTRL_A)
  await waitFor(scenario, 'subagent dashboard to open', () => dashboardVisible(app), 8000)
  app.stdin.write(ESC)
  // A key landing in the gap between a screen becoming visible and its input
  // listener registering is not observable. Re-send the close key ONLY when
  // the dashboard is genuinely still up (its hint row is present, not just a
  // stale title cell) — never after the main view is back, where an extra Esc
  // would touch the draft.
  const closed = await settled(
    () => !dashboardVisible(app) || composerMounted(app),
    { timeoutMs: 3000 },
  )
  if (!closed && screenHas(app, 'Enter 查看详情')) app.stdin.write(ESC)
  await waitForMainView(scenario, app, () => !dashboardVisible(app), 'subagent dashboard to close')
}

/** Ctrl+T -> trajectory scene -> q -> main view (composer remounted). */
async function roundTripTrajectory(scenario: string, app: Harness): Promise<void> {
  app.stdin.write(CTRL_T)
  await waitFor(scenario, 'trajectory scene to open', () => trajectoryVisible(app), 8000)
  app.stdin.write('q')
  await waitForMainView(scenario, app, () => !trajectoryVisible(app), 'trajectory scene to close')
}

/**
 * Wait for a screen round trip to land back on the main view. The composer
 * being mounted is the authoritative signal — an early-return screen and the
 * composer cannot coexist in a committed tree — so a row left over by the
 * renderer's diff/blit path must not hang the round trip. The clean path still
 * requires the screen marker to be gone; the fallback only fires when the
 * composer is back, and the callers' own block/caret assertions then run on
 * the restored composer.
 */
async function waitForMainView(
  scenario: string,
  app: Harness,
  closed: () => boolean,
  what: string,
): Promise<void> {
  const strict = await settled(() => closed() && composerMounted(app), { timeoutMs: 8000 })
  if (strict) return
  await waitFor(scenario, `${what} (composer mounted)`, () => composerMounted(app), 8000)
}

/** T05 additions: entry/deep-state helpers shared by the new scenarios. */

function screenHas(app: Harness, text: string): boolean {
  return screen(app).some(line => line.includes(text))
}

function findOnScreen(app: Harness, text: string): { col: number; row: number } | null {
  const rows = screen(app)
  for (let row = 0; row < rows.length; row += 1) {
    const col = rows[row].indexOf(text)
    if (col >= 0) return { col, row }
  }
  return null
}

/** True only for the MAIN composer box. The session browser renders its own
 *  `╭ ╰` search box, so a bare `inputBlock !== null` is not enough to prove
 *  the composer is mounted: the `❯` prompt glyph and the `⛶` affordance are. */
function composerMounted(app: Harness): boolean {
  const block = inputBlock(app)
  return block !== null
    && block.some(line => line.includes('❯'))
    && block.some(line => line.includes('⛶'))
}

function composerBlock(app: Harness): string[] | null {
  return composerMounted(app) ? inputBlock(app) : null
}

function composerState(app: Harness): { block: string[] | null; cursor: { x: number; y: number } } {
  return { block: composerBlock(app), cursor: cursorPos(app) }
}

function assertSameComposerState(
  scenario: string,
  label: string,
  before: { block: string[] | null; cursor: { x: number; y: number } },
  after: { block: string[] | null; cursor: { x: number; y: number } },
): void {
  assertEqual(scenario, `${label}: composer block`, before.block, after.block)
  assertEqual(scenario, `${label}: caret`, before.cursor, after.cursor)
}

/** Wait for the main view to be back (composer mounted, screen marker gone). */
async function waitForMain(scenario: string, app: Harness, goneMarker?: string): Promise<void> {
  await waitForMainView(
    scenario,
    app,
    () => goneMarker === undefined || !screenHas(app, goneMarker),
    goneMarker === undefined ? 'composer to remount' : `${goneMarker} to leave the screen`,
  )
}

/** T04 review suggestion T3: the "no image token left" decision stated once. */
function assertNoImageToken(scenario: string, label: string, app: Harness): void {
  assertTrue(
    scenario,
    `${label}: no [Image #N] token left`,
    !(inputBlock(app)?.join('\n') ?? '').includes('[Image #'),
  )
}

/** A staged token is a capability-backed chip (theme accent), not plain text.
 *  Mirrors verify-composer-image-tokens' colour probe. */
function tokenIsChip(app: Harness, token: string): { ok: boolean; detail: string } {
  const buffer = app.term.buffer.active
  for (let row = 0; row < ROWS; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
    const col = line.indexOf(token)
    if (col < 0) continue
    const cell = buffer.getLine(buffer.baseY + row)?.getCell(col)
    const plain = buffer.getLine(buffer.baseY + row)?.getCell(Math.max(0, col - 2))
    const ok = cell !== undefined && plain !== undefined
      && !cell.isFgDefault() && cell.getFgColor() !== plain.getFgColor()
    return { ok, detail: `row=${row} col=${col} tokenFg=${String(cell?.getFgColor())} plainFg=${String(plain?.getFgColor())}` }
  }
  return { ok: false, detail: 'token not visible' }
}

function vimBadge(app: Harness): 'INSERT' | 'NORMAL' | 'none' {
  if (screenHas(app, 'INSERT')) return 'INSERT'
  if (screenHas(app, 'NORMAL')) return 'NORMAL'
  return 'none'
}

/** Bracketed paste: fold-block creation and image-path staging share this. */
function pasteText(app: Harness, text: string): void {
  app.stdin.write(`${BRACKET_PASTE_START}${text}${BRACKET_PASTE_END}`)
}

/**
 * Type a slash command and run it. Both waits are observable anchors: the
 * composer row proves the text committed, and the completion card proves the
 * absolutely-positioned overlay owns Enter (the earlier fixed 200ms pacing
 * window had no anchor; F-10).
 */
async function runCommand(scenario: string, app: Harness, command: string): Promise<void> {
  app.stdin.write(command)
  await waitFor(scenario, `composer to show ${command}`, () => draftText(app) === command)
  await waitFor(
    scenario,
    `command completion card to own Enter for ${command}`,
    () => screenHas(app, '命令 · 共') && screenHas(app, `❯ ${command.slice(1)}`),
  )
  app.stdin.write('\r')
}

/** One draft-carrying entry: capture the composer, open+close, assert equal. */
async function runDraftEntry(
  scenario: string,
  app: Harness,
  label: string,
  enter: () => Promise<void>,
  draftMarker: string,
): Promise<void> {
  const before = composerState(app)
  assertTrue(
    scenario,
    `${label}: draft present before entering`,
    before.block !== null && before.block.join('\n').includes(draftMarker),
  )
  await enter()
  // CR #847: wait on the SAME predicate the assertion checks — the restored
  // composer row can land a frame after the screen closes, so waiting only for
  // `composerMounted` could read a half-restored state and report a false
  // failure on a valid round trip.
  const same = (): boolean => JSON.stringify(composerState(app)) === JSON.stringify(before)
  await settled(same, { timeoutMs: 8000 })
  const after = composerState(app)
  assertSameComposerState(scenario, label, before, after)
}

/** AC-1: Ctrl+A round trip keeps text and caret. */
async function scenarioCtrlA(): Promise<string> {
  const scenario = 'ctrl-a'
  const app = await mountChat()
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)

    app.stdin.write('hello world')
    await waitFor(scenario, 'typed draft', () => composerHas(app, 'hello world'))
    app.stdin.write(LEFT.repeat(6))
    await waitFor(scenario, 'caret parked mid-draft (offset 5)', () => cursorPos(app).x === 7)
    const midCaret = cursorPos(app)

    // Round trip 1 doubles as the listener-order warm-up: on a FRESH Chat
    // mount the composer's useInput effect registers before Chat's, so the
    // first Ctrl+A ALSO takes PromptInput's readline "beginning-of-line" arm
    // before the screen opens (pre-existing upstream behavior, not part of
    // this change). The draft must survive it; the caret is asserted on
    // round trip 2, once Chat's handler owns the key and stops propagation.
    await roundTripDashboard(scenario, app)
    assertEqual(scenario, 'draft text after first Ctrl+A -> Esc', 'hello world', draftText(app))

    const missing = midCaret.x - cursorPos(app).x
    if (missing > 0) app.stdin.write(RIGHT.repeat(missing))
    await waitFor(scenario, 'caret back mid-draft before measured trip', () => cursorPos(app).x === midCaret.x)
    const before = { block: inputBlock(app), cursor: cursorPos(app) }

    await roundTripDashboard(scenario, app)
    const after = { block: inputBlock(app), cursor: cursorPos(app) }

    assertEqual(scenario, 'composer block after Ctrl+A -> Esc', before.block, after.block)
    assertEqual(scenario, 'parked caret after Ctrl+A -> Esc', before.cursor, after.cursor)
    summary = `\nPASS  ${scenario}  caret=${JSON.stringify(after.cursor)}  snapshot=${JSON.stringify(after.block)}`
  } finally {
    app.unmount()
  }
  return summary
}

/** AC-2: Ctrl+T round trip keeps text, newline structure and caret. */
async function scenarioCtrlT(): Promise<string> {
  const scenario = 'ctrl-t'
  const app = await mountChat()
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)

    app.stdin.write('scene draft')
    await waitFor(scenario, 'first draft line', () => composerHas(app, 'scene draft'))
    app.stdin.write(SHIFT_ENTER)
    await waitFor(scenario, 'second composer row after Shift+Enter', () => inputBlock(app)?.length === 4)
    app.stdin.write('second line')
    await waitFor(scenario, 'second draft line', () => composerHas(app, 'second line'))

    app.stdin.write(LEFT.repeat(6))
    const range = inputRange(app)
    if (range === null) throw new VerifyFailure(scenario, 'composer box missing before Ctrl+T', true, null)
    await waitFor(
      scenario,
      'caret parked mid-second-line',
      () => cursorPos(app).x === 7 && cursorPos(app).y === range.top + 2,
    )

    const before = { block: inputBlock(app), cursor: cursorPos(app) }
    await roundTripTrajectory(scenario, app)
    const after = { block: inputBlock(app), cursor: cursorPos(app) }

    assertEqual(scenario, 'two-line composer block after Ctrl+T -> q', before.block, after.block)
    assertEqual(scenario, 'parked caret after Ctrl+T -> q', before.cursor, after.cursor)
    assertTrue(scenario, 'newline structure kept (two content rows)', after.block?.length === 4)
    summary = `\nPASS  ${scenario}  caret=${JSON.stringify(after.cursor)}  snapshot=${JSON.stringify(after.block)}`
  } finally {
    app.unmount()
  }
  return summary
}

/** AC-7 basics: empty composer round trips are inert and keys stay live. */
async function scenarioNoDraft(): Promise<string> {
  const scenario = 'no-draft'
  const app = await mountChat()
  const errorStart = runtimeErrors.length
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)
    assertTrue(scenario, 'input starts empty', draftText(app) === '')

    await roundTripDashboard(scenario, app)
    assertTrue(scenario, 'input still empty after Ctrl+A -> Esc', draftText(app) === '')
    assertNoImageToken(scenario, 'Ctrl+A -> Esc', app)

    await roundTripTrajectory(scenario, app)
    assertTrue(scenario, 'input still empty after Ctrl+T -> q', draftText(app) === '')
    assertNoImageToken(scenario, 'Ctrl+T -> q', app)

    // Keys must still land after both round trips (nothing latched/consumed).
    app.stdin.write('ping')
    await waitFor(scenario, 'typed key lands after round trips', () => draftText(app) === 'ping')
    app.stdin.write(BACKSPACE.repeat(4))
    await waitFor(scenario, 'backspace erases after round trips', () => draftText(app) === '')

    assertEqual(
      scenario,
      'renderer errors while driving empty composer',
      [],
      runtimeErrors.slice(errorStart),
    )
    summary = `\nPASS  ${scenario}  round-trips=2  keys=live  promptRow=${JSON.stringify(promptRow(app))}`
  } finally {
    app.unmount()
  }
  return summary
}

/**
 * Entry drivers for `routed-screens`: each opens one early-return screen and
 * returns to the main view, so the scenario body reads as a checklist and a
 * failure label points at the entry rather than at a line inside it.
 */
async function enterSubagentDetail(scenario: string, app: Harness): Promise<void> {
  app.stdin.write(CTRL_A)
  await waitFor(scenario, 'dashboard to open for detail', () => dashboardVisible(app), 8000)
  await waitFor(scenario, 'subagent card to render', () => screenHas(app, 'T05-SUBAGENT-FIXTURE'), 8000)
  app.stdin.write('\r')
  await waitFor(
    scenario,
    'subagent detail to replace the dashboard',
    () => screenHas(app, 'T05-SUBAGENT-FIXTURE') && !dashboardVisible(app),
    8000,
  )
  app.stdin.write(ESC)
  await waitFor(scenario, 'dashboard back after detail', () => dashboardVisible(app), 8000)
  app.stdin.write(ESC)
  await waitForMain(scenario, app, SCREEN_MARK.dashboard)
}

async function enterPluginScene(scenario: string, app: Harness): Promise<void> {
  app.channel.openPluginScene('t05-scene')
  await waitFor(scenario, 'plugin scene to open', () => screenHas(app, 'PROBE-SCENE t05-scene'), 8000)
  app.channel.closePluginScene()
  await waitForMain(scenario, app, 'PROBE-SCENE')
}

/** A pending question over the dashboard (the "interrupt lane") replaces the
 *  screen; cancelling lands back on the dashboard, then Esc returns. */
async function enterQuestionLane(scenario: string, app: Harness): Promise<void> {
  app.stdin.write(CTRL_A)
  await waitFor(scenario, 'dashboard to open for the question lane', () => dashboardVisible(app), 8000)
  const asked = app.questions.ask({
    questions: [{
      id: 't05-question',
      header: 'T05',
      question: 'T05-QUESTION-MARKER',
      options: [{ label: 'yes', value: 'yes' }],
    }],
  } as never)
  asked.catch(() => {})
  await waitFor(scenario, 'question lane to take the screen', () => screenHas(app, 'T05-QUESTION-MARKER'), 8000)
  assertTrue(scenario, 'interrupt lane unmounts the composer', !composerMounted(app))
  app.questions.cancelCurrent()
  await waitFor(
    scenario,
    'dashboard restored after the cancelled question',
    () => dashboardVisible(app) && !screenHas(app, 'T05-QUESTION-MARKER'),
    8000,
  )
  app.stdin.write(ESC)
  await waitForMain(scenario, app, SCREEN_MARK.dashboard)
}

/** The transcript JobCard is a real mouse entry into `/jobs`; this needs the
 *  alternate-screen wrapper (mouse tracking) used by the scenario harness. */
async function enterJobsByCardClick(scenario: string, app: Harness): Promise<void> {
  const pos = findOnScreen(app, 'T05-JOB-CARD')
  if (pos === null) throw new VerifyFailure(scenario, 'JobCard not visible to click', true, null)
  app.stdin.write(`\x1b[<0;${pos.col + 1};${pos.row + 1}M`)
  app.stdin.write(`\x1b[<0;${pos.col + 1};${pos.row + 1}m`)
  await waitFor(scenario, '/jobs panel from the card click', () => screenHas(app, SCREEN_MARK.jobs), 8000)
  app.stdin.write(ESC)
  await waitForMain(scenario, app, SCREEN_MARK.jobs)
}

/**
 * AC-3: every early-return entry the stub can drive round-trips without
 * losing the composer. Entries whose screen opens WITHOUT consuming the
 * composer (Ctrl+A dashboard, subagent detail, Ctrl+T trajectory, plugin
 * scene, interrupt lane, JobCard click into `/jobs`) are asserted with a
 * real draft + parked caret. `/settings`, `/resume`, `/tree`, `/jobs`
 * (command) and `/agentview` are command-dispatched: `clearDeliveredDraft`
 * empties the composer synchronously before those screens mount, so their
 * round trip must keep exactly that state (and never resurrect the command).
 */
async function scenarioRoutedScreens(): Promise<string> {
  const scenario = 'routed-screens'
  // A finished subagent for the dashboard/detail entry and a live job card
  // for the mouse path into the jobs panel.
  const subagentFixture = {
    agentId: 't05-subagent',
    description: 'T05-SUBAGENT-FIXTURE',
    status: 'completed' as const,
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    output: [] as string[],
    outputEvents: [] as unknown[],
    toolCalls: [] as unknown[],
  }
  const jobRow = {
    id: 2,
    kind: 'job' as const,
    text: 'T05-JOB-CARD',
    job: {
      id: 't05-job',
      kind: 'pwsh',
      label: 'T05-JOB-CARD',
      status: 'running' as const,
      startedAt: Date.now() - 3000,
      outputLines: [] as string[],
    },
  }
  const app = await mountChat({
    // Mouse tracking for the JobCard click; keyboard entries are unaffected.
    alternateScreen: true,
    channel: makeChannel({
      subagents: [subagentFixture],
      rows: [{ id: 1, kind: 'user', text: 'hi' }, jobRow],
    }),
  })
  const entries: string[] = []
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)

    // Warm-up round trip: on a fresh mount PromptInput's useInput effect
    // registers before Chat's (T04 note), so the FIRST Ctrl+A would also run
    // the readline beginning-of-line arm. One round trip inverts the order;
    // every measured entry below then leaves the caret untouched.
    await roundTripDashboard(scenario, app)

    app.stdin.write('routed draft')
    await waitFor(scenario, 'routed draft typed', () => composerHas(app, 'routed draft'))
    app.stdin.write(LEFT.repeat(5))
    await waitFor(scenario, 'caret parked at offset 7', () => cursorPos(app).x === 9)
    const baseline = composerState(app)

    // (1) Ctrl+A dashboard — the AC-1 entry repeated inside the matrix.
    await runDraftEntry(scenario, app, 'Ctrl+A dashboard', () => roundTripDashboard(scenario, app), 'routed draft')
    entries.push('Ctrl+A dashboard')

    // (2) Subagent detail: dashboard -> Enter -> detail -> Esc -> dashboard -> Esc.
    await runDraftEntry(scenario, app, 'subagent detail', () => enterSubagentDetail(scenario, app), 'routed draft')
    entries.push('subagent detail')

    // (3) Ctrl+T trajectory.
    await runDraftEntry(scenario, app, 'Ctrl+T trajectory', () => roundTripTrajectory(scenario, app), 'routed draft')
    entries.push('Ctrl+T trajectory')

    // (4) Plugin scene (stub-driven; the plugin registry itself is a host seam).
    await runDraftEntry(scenario, app, 'plugin scene', () => enterPluginScene(scenario, app), 'routed draft')
    entries.push('plugin scene')

    // (5) Interrupt lane: a pending question over the dashboard replaces the
    // screen; cancelling lands back on the dashboard, then Esc on the composer.
    await runDraftEntry(scenario, app, 'interrupt lane', () => enterQuestionLane(scenario, app), 'routed draft')
    entries.push('interrupt lane')

    // (6) JobCard click: the transcript card is a real mouse entry into /jobs.
    await runDraftEntry(scenario, app, '/jobs (JobCard click)', () => enterJobsByCardClick(scenario, app), 'routed draft')
    entries.push('/jobs (card click)')

    // The command matrix starts from an empty composer: Ctrl+C drops the
    // retained draft (its own semantics are asserted in intentional-clear).
    app.stdin.write('\x03')
    await waitFor(scenario, 'draft cleared before the command matrix', () => draftText(app) === '')

    // (7..11) Command-dispatched entries. Every one leaves an empty composer;
    // the round trip must preserve that state and not resurrect the command.
    const commandEntries: ReadonlyArray<readonly [string, string, string]> = [
      ['/settings', '/settings', SCREEN_MARK.settings],
      ['/resume (browse then Esc)', '/resume', SCREEN_MARK.resume],
      ['/tree', '/tree', SCREEN_MARK.tree],
      ['/jobs (command)', '/jobs', SCREEN_MARK.jobs],
      ['/agentview (open only)', '/agentview', SCREEN_MARK.agentview],
    ]
    for (const [label, command, marker] of commandEntries) {
      const stateBefore = composerState(app)
      assertTrue(scenario, `${label}: composer mounted and empty before dispatch`, stateBefore.block !== null && draftText(app) === '')
      await runCommand(scenario, app, command)
      await waitFor(scenario, `${label}: screen to open`, () => screenHas(app, marker), 8000)
      assertTrue(scenario, `${label}: composer unmounted behind the screen`, !composerMounted(app))
      app.stdin.write(ESC)
      await waitForMain(scenario, app, marker)
      assertSameComposerState(scenario, `${label}: post-command state`, stateBefore, composerState(app))
      assertTrue(scenario, `${label}: command text does not linger in the composer`, !(composerBlock(app)?.join('\n') ?? '').includes(command))
      assertNoImageToken(scenario, label, app)
      entries.push(label)
    }

    // The keyboard stays live after the whole matrix.
    app.stdin.write('ping')
    await waitFor(scenario, 'keys land after the routed matrix', () => draftText(app) === 'ping', 8000)
    app.stdin.write(BACKSPACE.repeat(4))
    await waitFor(scenario, 'backspace works after the routed matrix', () => draftText(app) === '')

    summary = `\nPASS  ${scenario}  entries=${entries.length}  baselineCaret=${JSON.stringify(baseline.cursor)}  [${entries.join('; ')}]`
  } finally {
    app.unmount()
  }
  return summary
}

/** AC-4: the full edit state (text, caret, staged `[Image #N]` attachment,
 *  fold block, fullscreen editor, vim INSERT/NORMAL) survives a Ctrl+A trip.
 *  Fold block and expanded editor cannot coexist on this build (toggleExpand
 *  deliberately drops the block to show the full text), so the phases cover
 *  the six snapshot fields as a matrix instead of one impossible state. */
async function scenarioEditState(): Promise<string> {
  const scenario = 'edit-state'
  const app = await mountChat()
  const phases: string[] = []
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)

    // Vim on, empty composer, then a warm-up round trip so later Ctrl+A is
    // owned by Chat (same listener-order note as ctrl-a).
    await runCommand(scenario, app, '/vim')
    await waitFor(scenario, 'vim INSERT badge', () => vimBadge(app) === 'INSERT', 8000)
    await roundTripDashboard(scenario, app)

    // ── Phase A: inline text + fold block + staged image, vim INSERT ──────
    app.stdin.write('alpha ')
    await waitFor(scenario, 'head text before the paste', () => composerHas(app, 'alpha'))
    pasteText(app, BIG_PASTE)
    await waitFor(
      scenario,
      'big bracketed paste to fold into one chip',
      () => screenHas(app, '▸') && !screenHas(app, 'fold-line-05'),
      8000,
    )
    assertTrue(scenario, 'fold chip keeps the first-line preview', screenHas(app, 'fold-line-00'))
    pasteText(app, pastedImagePath)
    await waitFor(scenario, 'staged image token', () => composerHas(app, STAGED_IMAGE_TOKEN), 8000)
    // The paste leaves the caret deterministically at the end of the inserted
    // `[Image #N] `; the waited-on token visibility is the observable anchor,
    // so no fixed pacing window is needed here.
    const beforeA = composerState(app)
    const chipA = tokenIsChip(app, STAGED_IMAGE_TOKEN)
    assertTrue(scenario, `phase A: token starts as a bound chip (${chipA.detail})`, chipA.ok)

    await roundTripDashboard(scenario, app)
    assertSameComposerState(scenario, 'phase A (INSERT + fold + image)', beforeA, composerState(app))
    assertTrue(scenario, 'phase A: fold chip survives', screenHas(app, '▸') && !screenHas(app, 'fold-line-05'))
    assertTrue(scenario, 'phase A: fold preview survives', screenHas(app, 'fold-line-00'))
    const chipA2 = tokenIsChip(app, STAGED_IMAGE_TOKEN)
    assertTrue(scenario, `phase A: image binding survives as a chip (${chipA2.detail})`, chipA2.ok)
    assertEqual(scenario, 'phase A: vim INSERT restored', 'INSERT', vimBadge(app))
    phases.push('INSERT+fold+image')

    // ── Phase B: vim NORMAL on a short image draft ───────────────────────
    // NORMAL is reached with no fold block, so the single Esc lands on the
    // vim arm (with a block present the first Esc unfolds — phase A owns that
    // assertion). The short draft keeps the token row in the inline window.
    app.stdin.write('\x03')
    await waitFor(scenario, 'phase B starts from an empty composer', () => draftText(app) === '')
    app.stdin.write('normal draft ')
    await waitFor(scenario, 'phase B head text', () => composerHas(app, 'normal draft'))
    pasteText(app, pastedImagePath)
    await waitFor(scenario, 'phase B staged image token', () => composerHas(app, STAGED_IMAGE_TOKEN), 8000)
    app.stdin.write(ESC) // vim INSERT -> NORMAL
    await waitFor(scenario, 'vim NORMAL badge', () => vimBadge(app) === 'NORMAL', 8000)
    await waitFor(scenario, 'phase B token row visible', () => screenHas(app, STAGED_IMAGE_TOKEN), 8000)
    const beforeB = composerState(app)
    await roundTripDashboard(scenario, app)
    assertSameComposerState(scenario, 'phase B (NORMAL + image)', beforeB, composerState(app))
    assertEqual(scenario, 'phase B: vim NORMAL restored', 'NORMAL', vimBadge(app))
    const chipB = tokenIsChip(app, STAGED_IMAGE_TOKEN)
    assertTrue(scenario, `phase B: image binding survives (${chipB.detail})`, chipB.ok)
    phases.push('NORMAL')

    // ── Phase C: fullscreen draft editor open ────────────────────────────
    app.stdin.write('i') // back to INSERT so the editor opens over a live caret
    await waitFor(scenario, 'vim back to INSERT', () => vimBadge(app) === 'INSERT', 8000)
    app.stdin.write(CTRL_SHIFT_E)
    await waitFor(scenario, 'fullscreen draft editor to open', () => screenHas(app, '草稿编辑'), 8000)
    assertTrue(scenario, 'editor shows the draft text', screenHas(app, 'normal draft'))
    assertTrue(scenario, 'editor shows the staged token text', screenHas(app, STAGED_IMAGE_TOKEN))
    // The editor paste leaves the caret deterministically at the end of the
    // draft. Enter a marker there (the wait observes the pre-trip caret), then
    // round-trip and type a second marker: it can only sit next to the first
    // if the restored caret is the same offset. Raw cursor coordinates are not
    // used here — in expanded mode they also depend on the editor scroll
    // offset, which DESIGN D4 explicitly does not snapshot.
    app.stdin.write('Z')
    await waitFor(
      scenario,
      'marker typed at the pre-trip editor caret',
      () => screenHas(app, `${STAGED_IMAGE_TOKEN} Z`),
      8000,
    )
    // Expanded mode renders the editor instead of the inline composer box, so
    // the round trip waits on the editor marker (inputBlock stays null).
    app.stdin.write(CTRL_A)
    await waitFor(scenario, 'dashboard over the editor', () => dashboardVisible(app), 8000)
    app.stdin.write(ESC)
    await waitFor(
      scenario,
      'fullscreen editor to remount after the dashboard',
      () => !dashboardVisible(app) && screenHas(app, '草稿编辑') && screenHas(app, 'normal draft'),
      8000,
    )
    assertTrue(scenario, 'phase C: fullscreen editor restored', screenHas(app, '草稿编辑'))
    assertTrue(scenario, 'phase C: editor text restored', screenHas(app, 'normal draft'))
    assertTrue(scenario, 'phase C: token text restored', screenHas(app, STAGED_IMAGE_TOKEN))
    // The second marker lands adjacent to the first only when the caret offset
    // survived the trip.
    app.stdin.write('W')
    await waitFor(
      scenario,
      'marker typed at the restored editor caret',
      () => screenHas(app, `${STAGED_IMAGE_TOKEN} ZW`),
      8000,
    )
    phases.push('fullscreen editor + caret')

    // Submit from the editor: the restored token must still be an attachable
    // capability, not inert text — the strongest image-binding assertion.
    app.stdin.write(CTRL_ENTER)
    await waitFor(scenario, 'submission to reach the channel', () => app.channel.state.submitted.length > 0, 8000)
    const submission = app.channel.state.submitted.at(-1)!
    assertTrue(
      scenario,
      'submitted text carries the restored caret position and draft',
      submission.text.includes(`${STAGED_IMAGE_TOKEN} ZW`),
    )
    assertEqual(scenario, 'submission carried exactly one staged image', 1, submission.images.length)
    phases.push('submit-binding')

    summary = `\nPASS  ${scenario}  phases=${phases.length}  [${phases.join('; ')}]`
  } finally {
    app.unmount()
  }
  return summary
}

/** AC-5: the four intentional-clear paths stay cleared across a following
 *  full-screen round trip (no resurrection of text or staged capabilities). */
async function scenarioIntentionalClear(): Promise<string> {
  const scenario = 'intentional-clear'
  const app = await mountChat()
  const cleared: string[] = []
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)

    // (1) Ctrl+C: text + staged image, single press clears and revokes it.
    app.stdin.write('clear-me')
    await waitFor(scenario, 'draft before Ctrl+C', () => composerHas(app, 'clear-me'))
    pasteText(app, pastedImagePath)
    await waitFor(scenario, 'staged image before Ctrl+C', () => composerHas(app, STAGED_IMAGE_TOKEN), 8000)
    const stageId = [...app.channel.state.staged.keys()][0]
    assertTrue(scenario, 'Ctrl+C: staged capability alive before the press', app.channel.hasStagedImage(stageId))
    app.stdin.write('\x03')
    await waitFor(
      scenario,
      'Ctrl+C to clear text and token',
      () => draftText(app) === '' && !composerHas(app, STAGED_IMAGE_TOKEN),
      8000,
    )
    assertTrue(scenario, 'Ctrl+C: staged capability revoked', app.channel.hasStagedImage(stageId) === false)
    await roundTripDashboard(scenario, app)
    assertEqual(scenario, 'Ctrl+C: text stays cleared after a round trip', '', draftText(app))
    assertTrue(scenario, 'Ctrl+C: token stays cleared after a round trip', !composerHas(app, STAGED_IMAGE_TOKEN))
    cleared.push('Ctrl+C')

    // (2) Esc clears a small draft; double-Esc on the now-empty input is the
    // rewind gesture and must not bring the draft back either.
    app.stdin.write('esc-me')
    await waitFor(scenario, 'draft before Esc', () => composerHas(app, 'esc-me'))
    app.stdin.write(ESC)
    await waitFor(scenario, 'single Esc clears the small draft', () => draftText(app) === '')
    // The first empty-input Esc arms the double-tap and emits the rewind
    // notice; waiting for that notice proves the tap registered before the
    // second one is sent (the fixed 150ms pacing window had no anchor; F-10).
    const tapsBefore = app.channel.state.notifyLog.length
    app.stdin.write(ESC)
    await waitFor(
      scenario,
      'empty-input Esc to arm the rewind double-tap',
      () => app.channel.state.notifyLog.length > tapsBefore,
    )
    app.stdin.write(ESC)
    await waitFor(scenario, 'empty-input double Esc opens the rewind picker', () => screenHas(app, SCREEN_MARK.rewind), 8000)
    app.stdin.write(ESC)
    await waitForMain(scenario, app, SCREEN_MARK.rewind)
    await roundTripDashboard(scenario, app)
    assertEqual(scenario, 'double-Esc: composer stays empty after a round trip', '', draftText(app))
    cleared.push('empty-input double Esc')

    // (3) Submit clears the delivered draft before the round trip.
    app.stdin.write('submit-me')
    await waitFor(scenario, 'draft before submit', () => composerHas(app, 'submit-me'))
    app.stdin.write('\r')
    await waitFor(
      scenario,
      'submit to reach the channel and clear the composer',
      () => app.channel.state.submitted.length === 1 && draftText(app) === '',
      8000,
    )
    assertEqual(scenario, 'submit delivered the draft exactly once', 'submit-me', app.channel.state.submitted[0]!.text)
    await roundTripDashboard(scenario, app)
    assertEqual(scenario, 'submit: composer stays empty after a round trip', '', draftText(app))
    cleared.push('submit')

    // (4) `/clear` resets the session and the composer stays empty afterwards.
    const clearsBefore = app.channel.state.clearCalls
    await runCommand(scenario, app, '/clear')
    await waitFor(scenario, '/clear to reach the channel', () => app.channel.state.clearCalls === clearsBefore + 1, 8000)
    await roundTripDashboard(scenario, app)
    assertEqual(scenario, '/clear: composer stays empty after a round trip', '', draftText(app))
    assertEqual(scenario, '/clear reached the channel exactly once', 1, app.channel.state.clearCalls)
    cleared.push('/clear')

    summary = `\nPASS  ${scenario}  clears=${cleared.length}  [${cleared.join('; ')}]`
  } finally {
    app.unmount()
  }
  return summary
}

/** AC-6: a real session switch must NOT restore the old draft. The generation
 *  bump while the composer is parked stands in for `/resume` selecting another
 *  session, `/new`, `/bg` and an agent-view attach (DESIGN D2); the second
 *  phase covers DESIGN D3's stale-capability filter with the generation equal. */
async function scenarioSessionSwitch(): Promise<string> {
  const scenario = 'session-switch'
  const app = await mountChat()
  const fences: string[] = []
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)

    // Session A: text + a staged image, parked behind the dashboard.
    app.stdin.write('session A draft')
    await waitFor(scenario, 'session A draft', () => composerHas(app, 'session A draft'))
    pasteText(app, pastedImagePath)
    await waitFor(scenario, 'session A image token', () => composerHas(app, STAGED_IMAGE_TOKEN), 8000)
    const stageIdA = [...app.channel.state.staged.keys()][0]
    assertTrue(scenario, 'session A staged capability alive', app.channel.hasStagedImage(stageIdA))

    app.stdin.write(CTRL_A)
    await waitFor(scenario, 'dashboard to park the composer', () => dashboardVisible(app), 8000)
    const generationBefore = app.channel.agentBindingGeneration
    app.channel.bumpGeneration()
    assertEqual(
      scenario,
      'generation bump applied while the composer is parked',
      generationBefore + 1,
      app.channel.agentBindingGeneration,
    )
    app.stdin.write(ESC)
    await waitForMain(scenario, app, SCREEN_MARK.dashboard)

    assertEqual(scenario, 'new session composer is empty', '', draftText(app))
    assertTrue(
      scenario,
      'old draft text does not appear in the new session',
      !(composerBlock(app)?.join('\n') ?? '').includes('session A draft'),
    )
    assertNoImageToken(scenario, 'generation fence', app)
    assertTrue(scenario, 'old staged capability is not re-bound as a chip', !tokenIsChip(app, STAGED_IMAGE_TOKEN).ok)
    app.stdin.write('new session draft')
    await waitFor(scenario, 'new session accepts typing', () => draftText(app) === 'new session draft', 8000)
    fences.push('generation bump (/resume-select-other, /new, /bg, attach)')

    // DESIGN D3 second fence: generation equal, but #823's channel cleanup
    // already reclaimed the capability. The visible token must come back as
    // inert text (never attachable), and submitting must not re-attach it.
    app.stdin.write('\x03')
    await waitFor(scenario, 'new session draft cleared', () => draftText(app) === '')
    app.stdin.write('stale image draft')
    await waitFor(scenario, 'stale draft text', () => composerHas(app, 'stale image draft'))
    pasteText(app, pastedImagePath)
    await waitFor(scenario, 'stale draft image token', () => composerHas(app, STAGED_IMAGE_TOKEN), 8000)
    const stageIdB = [...app.channel.state.staged.keys()][0]
    assertTrue(scenario, 'stale-case staged capability alive before parking', app.channel.hasStagedImage(stageIdB))
    app.stdin.write(CTRL_A)
    await waitFor(scenario, 'dashboard before the stale cleanup', () => dashboardVisible(app), 8000)
    app.channel.clearStagedImages() // #823: generation unchanged, capability gone
    app.stdin.write(ESC)
    await waitForMain(scenario, app, SCREEN_MARK.dashboard)

    // The renderer can commit the remounted composer one frame before its
    // restored content row is blitted (the T-FIX-01 group run caught exactly
    // this as a flake), so wait on the observable predicate before asserting
    // it instead of reading the frame immediately (F-10).
    const staleTokenRestored = await settled(
      () => composerHas(app, STAGED_IMAGE_TOKEN),
      { timeoutMs: 8000 },
    )
    assertTrue(
      scenario,
      'stale capability: token text stays visible as lazy text',
      staleTokenRestored,
    )
    const staleChip = tokenIsChip(app, STAGED_IMAGE_TOKEN)
    assertTrue(scenario, `stale capability: token is not a bound chip (${staleChip.detail})`, !staleChip.ok)
    app.stdin.write('\r')
    await waitFor(scenario, 'stale draft submitted', () => app.channel.state.submitted.length > 0, 8000)
    assertEqual(scenario, 'stale capability: submission carries no image', 0, app.channel.state.submitted.at(-1)!.images.length)
    fences.push('hasStagedImage fence (DESIGN D3 / #823)')

    summary = `\nPASS  ${scenario}  fences=${fences.length}  [${fences.join('; ')}]`
  } finally {
    app.unmount()
  }
  return summary
}

/**
 * AC-6 / DESIGN D5: a stage that is still in flight when the composer
 * unmounts must be fenced by the unmount revision bump. The full-screen
 * round trip is driven with the stage parked inside the channel seam
 * (`stageGate`) and released only while the composer is behind the
 * dashboard: the late continuation must not insert a token, must not mint a
 * visible or committable binding, and must reclaim the otherwise-unreachable
 * capability instead of leaving it orphaned; editing resumes afterwards.
 */
async function scenarioInflightStage(): Promise<string> {
  const scenario = 'inflight-stage'
  let releaseStage: (() => void) | undefined
  const stageGate = new Promise<void>(resolve => { releaseStage = resolve })
  const app = await mountChat({ channel: makeChannel({ stageGate: () => stageGate }) })
  const checks: string[] = []
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)

    app.stdin.write('inflight draft')
    await waitFor(scenario, 'draft before the image paste', () => composerHas(app, 'inflight draft'))

    // Bracketed paste of a real image path: the paste handler captures the
    // draft lease synchronously and the continuation parks inside
    // `channel.stageComposerImage`, so the stage never settles on its own.
    pasteText(app, pastedImagePath)
    await waitFor(
      scenario,
      'image stage to reach the channel seam (still unsettled)',
      () => app.channel.state.stageCalls === 1,
      8000,
    )
    assertTrue(scenario, 'no token while the stage is in flight', !composerHas(app, STAGED_IMAGE_TOKEN))
    assertEqual(scenario, 'no capability while the stage is in flight', 0, app.channel.state.staged.size)

    // Open the full-screen view (PromptInput unmounts: snapshot + revision
    // fence) and only THEN let the parked stage settle.
    app.stdin.write(CTRL_A)
    await waitFor(scenario, 'dashboard to park the composer mid-stage', () => dashboardVisible(app), 8000)
    assertTrue(scenario, 'composer is unmounted while the stage settles', !composerMounted(app))
    const discardedBefore = app.channel.state.discarded.length
    const noticesBefore = app.channel.state.notifyLog.length
    releaseStage!()
    // The fenced continuation reclaims the capability and emits no
    // `input-image-pasted` notice; without the unmount revision bump it
    // instead binds the token into the dead instance and notifies.
    const continuationSettled = await settled(
      () => app.channel.state.discarded.length > discardedBefore
        || app.channel.state.notifyLog.length > noticesBefore,
      { timeoutMs: 8000 },
    )
    const newNotices = app.channel.state.notifyLog.slice(noticesBefore)
    assertTrue(
      scenario,
      `unmounted continuation is fenced (settled=${continuationSettled}, orphaned=${app.channel.state.staged.size}, notices=${JSON.stringify(newNotices)})`,
      continuationSettled
        && app.channel.state.discarded.length === discardedBefore + 1
        && newNotices.length === 0,
    )

    // Return to the main view: the text draft is restored, with no token, no
    // chip and nothing committable.
    app.stdin.write(ESC)
    await waitForMain(scenario, app, SCREEN_MARK.dashboard)
    const textRestored = await settled(() => draftText(app) === 'inflight draft', { timeoutMs: 8000 })
    assertTrue(scenario, 'draft text is restored after the round trip', textRestored)
    assertNoImageToken(scenario, 'in-flight fence', app)
    const chip = tokenIsChip(app, STAGED_IMAGE_TOKEN)
    assertTrue(scenario, `in-flight token is not a visible binding (${chip.detail})`, !chip.ok)
    assertEqual(scenario, 'fenced stage leaves no orphaned capability', 0, app.channel.state.staged.size)

    app.stdin.write('\r')
    await waitFor(scenario, 'draft to submit', () => app.channel.state.submitted.length === 1, 8000)
    assertEqual(scenario, 'submission carries the typed draft', 'inflight draft', app.channel.state.submitted[0]!.text)
    assertEqual(scenario, 'submission carries no image binding', 0, app.channel.state.submitted[0]!.images.length)

    app.stdin.write('next line')
    await waitFor(scenario, 'typing works after the fenced trip', () => composerHas(app, 'next line'), 8000)
    checks.push('fenced-in-flight-stage', 'no-visible-binding', 'no-committable-binding', 'editing-resumed')
    summary = `\nPASS  ${scenario}  checks=${checks.length}  [${checks.join('; ')}]`
  } finally {
    app.unmount()
  }
  return summary
}

try {
  const results: string[] = []
  // `VERIFY_COMPOSER_SCENARIOS=ctrl-a,routed-screens` runs a subset (debugging
  // and the TDD RED capture for one scenario); unset/empty runs the full matrix.
  const selected = (process.env.VERIFY_COMPOSER_SCENARIOS ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '')
  const runners: ReadonlyArray<readonly [string, () => Promise<string>]> = [
    ['ctrl-a', scenarioCtrlA],
    ['ctrl-t', scenarioCtrlT],
    ['no-draft', scenarioNoDraft],
    ['routed-screens', scenarioRoutedScreens],
    ['edit-state', scenarioEditState],
    ['intentional-clear', scenarioIntentionalClear],
    ['session-switch', scenarioSessionSwitch],
    ['inflight-stage', scenarioInflightStage],
  ]
  // CR #847: a typo'd VERIFY_COMPOSER_SCENARIOS name would otherwise select
  // zero runners and let the script exit 0 with empty results.
  const known = new Set(runners.map(([name]) => name))
  const unknown = selected.filter(name => !known.has(name))
  if (unknown.length > 0) {
    throw new VerifyFailure(
      'harness',
      'unknown VERIFY_COMPOSER_SCENARIOS entries (expected a subset of the runner names)',
      [...known],
      unknown,
    )
  }
  for (const [name, run] of runners) {
    if (selected.length > 0 && !selected.includes(name)) continue
    const stderrStart = stderrChunks.length
    results.push(await run())
    // F-9: a React warning (or any other stderr signal) emitted by this
    // scenario fails THIS scenario — only the verified pre-existing warning
    // is tolerated. The final check below catches stragglers between runs.
    const unexpected = unexpectedStderrLines(stderrChunks.slice(stderrStart))
    if (unexpected.length > 0) {
      throw new VerifyFailure(
        name,
        'unexpected stderr output (React warnings are triaged, not ignored)',
        [],
        unexpected,
      )
    }
  }
  assertEqual('harness', 'renderer errors across scenarios', [], runtimeErrors)
  assertEqual('harness', 'unexpected stderr across scenarios', [], unexpectedStderrLines(stderrChunks))
  // Positive control for the F-9 triage itself: a new warning must be
  // flagged while the verified pre-existing line stays whitelisted.
  assertEqual(
    'harness',
    'stderr triage flags new warnings and tolerates the whitelisted one',
    [['Warning: some new React warning'], []],
    [
      unexpectedStderrLines(['Warning: some new React warning\n']),
      unexpectedStderrLines([`${WHITELISTED_STDERR}.\n`]),
    ],
  )
  console.log(results.join('\n'))
} catch (error) {
  if (error instanceof VerifyFailure) {
    console.error(`FAIL [${error.scenario}] ${error.detail}`)
    console.error(`  expected: ${JSON.stringify(error.expected)}`)
    console.error(`  actual:   ${JSON.stringify(error.actual)}`)
  } else {
    console.error(`FAIL [harness] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
  process.exitCode = 1
} finally {
  process.stderr.write = realStderrWrite as typeof process.stderr.write
  rmSync(home, { recursive: true, force: true })
}

if (process.exitCode === 1) process.exit(1)
console.log('verify-composer-draft-screen-switch OK')
process.exit(0)
