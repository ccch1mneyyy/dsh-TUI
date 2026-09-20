#!/usr/bin/env node
/**
 * Regression for the composer-draft EDIT STATE (#846 follow-up, PR #942):
 * the draft snapshot's carried modes — fold block, fullscreen editor, vim
 * mode/submode — must survive a full-screen round trip, including on an
 * EMPTY composer (modes are user choices, not content), a staged
 * `[Image #N]` binding must stay committable after the trip, and Chat's own
 * unmount must release the staged capabilities only the waiting snapshot
 * still owns.
 *
 * Drives the REAL `Chat` + `PromptInput` through fake stdin and a headless
 * xterm (same harness as the investigation driver
 * `.specs/composer-draft-screen-switch/evidence/repro-draft-screen.tsx`).
 * Waits go through `scripts/lib/term-test.mjs` (`settled`) so the assertions
 * observe the same predicate they wait on.
 *
 * Maintainer trim note: the PR originally shipped an 8-scenario entry matrix
 * (ctrl-a/ctrl-t/no-draft/routed-screens/intentional-clear/session-switch/
 * inflight-stage). Text/caret/empty/ownership round trips are pinned by
 * `verify-composer-draft-handoff` (session-workspace group), the in-flight
 * staging fence by `verify-image-preview` (verify:build chain), so this file
 * keeps only `edit-state` — the coverage unique to the snapshot's new fields
 * plus the Chat unmount release. The full matrix lives in the PR's review
 * history for anyone who needs to re-run it.
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
// The composer's staged-image chip colour is part of the assertion below; the
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
  { render, Text },
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
const BRACKET_PASTE_START = '\x1b[200~'
const BRACKET_PASTE_END = '\x1b[201~'
/** CSI-u Ctrl+Shift+E: the fullscreen draft editor binding (E = 69,
 *  modifier 6 = ctrl+shift) — same encoding verify-expand-editor uses. */
const CTRL_SHIFT_E = '\x1b[69;6u'
/** CSI-u Ctrl+Enter: submit from inside the expanded editor. */
const CTRL_ENTER = '\x1b[13;5u'
/** ≥ FOLD_MIN_LINES (6): a bracketed paste of this folds into one chip. */
const BIG_PASTE = Array.from({ length: 12 }, (_, i) => `fold-line-${String(i).padStart(2, '0')}`).join('\n')
const STAGED_IMAGE_TOKEN = '[Image #1]'

/**
 * Renderer errors (`logError` -> `process.stderr` with a `[dsh-tui]` prefix)
 * are collected instead of swallowed: an error in the scenario must fail the
 * run even when the screen happens to recover.
 *
 * The same interception keeps a second signal: React dev-mode warnings also
 * reach `console.error` -> `process.stderr` and must not be ignored. Only the
 * pre-existing `useInsertionEffect` warning is whitelisted — the unmodified
 * `verify-expand-editor` fixture reproduces it on this repo, so it is not a
 * signal this change owns. Every other stderr line fails the scenario that
 * emitted it. Forwarded to the real stderr either way so a failure still
 * shows the original output.
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

/** Stderr lines the scenario may NOT produce: renderer errors keep their own
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
 * Stub channel: the seams the Chat tree needs to mount plus the staged-image
 * surface the edit-state scenario drives. Mutable slices are getters over
 * `state` so the assertions can observe them between renders; `bump()`
 * re-renders Chat like a real channel event.
 */
function makeChannel() {
  const listeners = new Set<() => void>()
  const state = {
    agentBindingGeneration: 0,
    /** Staged-image session epoch, mirroring the real channel: it advances
     *  whenever the capability map is cleared (`composer-images.ts:131-155`). */
    stagedImageEpoch: 0,
    staged: new Map<string, StubStagedImage>(),
    /** Stage ids the channel discarded (Ctrl+C revoke / Chat unmount release). */
    discarded: [] as string[],
    nextStage: 1,
    submitted: [] as Array<{ text: string; images: readonly unknown[] }>,
    clearCalls: 0,
    notifyLog: [] as string[],
    pluginScene: undefined as { id: string } | undefined,
    subagents: EMPTY_LIST,
    treePending: new Promise<null>(() => {}),
  }
  const channel = {
    whaleIdle: false,
    version: 0,
    rows: [{ id: 1, kind: 'user' as const, text: 'hi' }],
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
  }
  return channel
}

async function mountChat(): Promise<Harness> {
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
  const channel = makeChannel()
  const chatNode = React.createElement(Chat, {
    channel,
    questionStore: questions,
    fullscreen: true,
    // The plugin-scene branch is a top early return; a minimal real scene
    // (rendered with the TUI's own React/ui kit, like a plugin host does)
    // proves the branch is taken without needing a plugin registry.
    renderScene: (id: string) => React.createElement(Text, null, `PROBE-SCENE ${id}`),
  })
  const instance = await render(
    chatNode,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  // Idempotent: the unmount-release phase unmounts mid-scenario and the
  // finally block unmounts again — a second call must be a no-op.
  let unmounted = false
  return {
    term,
    stdin,
    channel,
    questions,
    unmount: () => {
      if (unmounted) return
      unmounted = true
      instance.unmount()
    },
  }
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
 * draft content. The border rows stay full width, so a real box/width change
 * still fails.
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

/** Visible draft text on the single-line composer (affordances stripped).
 *  The row leads with the session entry (⌸, or ⌂ while hovered) before the
 *  ❯ prompt, and a vim badge sits before the text when the mode is on. */
function draftText(app: Harness): string {
  return promptRow(app)
    .replace(/^[⌸⌂]\s*/, '')
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

function screenHas(app: Harness, text: string): boolean {
  return screen(app).some(line => line.includes(text))
}

function dashboardVisible(app: Harness): boolean {
  return screen(app).some(line => line.includes('子代理面板'))
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
 * absolutely-positioned overlay owns Enter.
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

/**
 * The full edit state (text, caret, staged `[Image #N]` attachment, fold
 * block, fullscreen editor, vim INSERT/NORMAL) survives a Ctrl+A trip.
 * Fold block and expanded editor cannot coexist on this build (toggleExpand
 * deliberately drops the block to show the full text), so the phases cover
 * the snapshot fields as a matrix instead of one impossible state.
 */
async function scenarioEditState(): Promise<string> {
  const scenario = 'edit-state'
  const app = await mountChat()
  const phases: string[] = []
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)

    // Vim on with an EMPTY composer: modes are user choices, not content, so
    // the snapshot must carry them even with nothing typed (the PR's write
    // guard counts edit state). Warm-up round trip doubles as the
    // listener-order warm-up so later Ctrl+A is owned by Chat.
    await runCommand(scenario, app, '/vim')
    await waitFor(scenario, 'vim INSERT badge', () => vimBadge(app) === 'INSERT', 8000)
    await roundTripDashboard(scenario, app)
    assertEqual(scenario, 'empty composer keeps vim mode across the trip', 'INSERT', vimBadge(app))
    assertEqual(scenario, 'empty composer grew no text across the trip', '', draftText(app))
    phases.push('empty-vim-retention')

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
    // `[Image #N] `; the waited-on token visibility is the observable anchor.
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
    // offset, which the snapshot deliberately does not carry.
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

    // ── Phase D: Chat unmount releases the snapshot-owned staged image ────
    // While a draft waits in the slot for the composer to remount, the
    // snapshot is the only owner of its staged capabilities. If Chat itself
    // goes away (leaving the TUI from a full-screen view), nothing would
    // ever restore or discard them — the unmount effect must release them
    // (hasStagedImage guard, idempotent) instead of leaving them for the
    // session's 128-entry FIFO to evict.
    app.stdin.write('release probe ')
    await waitFor(scenario, 'phase D head text', () => composerHas(app, 'release probe'))
    pasteText(app, pastedImagePath)
    await waitFor(scenario, 'phase D staged image token', () => composerHas(app, STAGED_IMAGE_TOKEN), 8000)
    const stageIdD = [...app.channel.state.staged.keys()].at(-1)!
    assertTrue(scenario, 'phase D capability alive before parking', app.channel.hasStagedImage(stageIdD))
    app.stdin.write(CTRL_A)
    await waitFor(scenario, 'dashboard to park the composer', () => dashboardVisible(app), 8000)
    assertTrue(scenario, 'composer unmounted behind the dashboard', !composerMounted(app))
    // Attribution lock (CodeRabbit): while parked, the capability is still
    // held and nothing has released it yet — so the release observed after
    // unmount() can only come from Chat's own teardown effect.
    assertTrue(
      scenario,
      'phase D capability alive and unreleased while parked',
      app.channel.hasStagedImage(stageIdD) && !app.channel.state.discarded.includes(stageIdD),
    )
    app.unmount()
    assertEqual(
      scenario,
      'Chat unmount releases the snapshot-owned staged image',
      false,
      app.channel.hasStagedImage(stageIdD),
    )
    assertEqual(
      scenario,
      'release recorded for the discarded stage id',
      true,
      app.channel.state.discarded.includes(stageIdD),
    )
    phases.push('unmount-release')

    summary = `\nPASS  ${scenario}  phases=${phases.length}  [${phases.join('; ')}]`
  } finally {
    app.unmount()
  }
  return summary
}

try {
  const results: string[] = []
  // `VERIFY_COMPOSER_SCENARIOS=edit-state` runs a subset (debugging and the
  // TDD RED capture); unset/empty runs everything registered below.
  const selected = (process.env.VERIFY_COMPOSER_SCENARIOS ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '')
  const runners: ReadonlyArray<readonly [string, () => Promise<string>]> = [
    ['edit-state', scenarioEditState],
  ]
  // A typo'd VERIFY_COMPOSER_SCENARIOS name would otherwise select zero
  // runners and let the script exit 0 with empty results.
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
    // A React warning (or any other stderr signal) emitted by this scenario
    // fails THIS scenario — only the verified pre-existing warning is
    // tolerated. The final check below catches stragglers between runs.
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
  // Positive control for the stderr triage itself: a new warning must be
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
