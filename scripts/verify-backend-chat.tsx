/**
 * The real `Chat` over a channel bound to a NON-DSH session (Phase 2
 * checkpoint B): the slash menu offers only the commands the backend serves,
 * a typed built-in the backend lacks shows `cmd-unavailable-backend` and
 * never reaches the model (nor steers into a running turn), and plain text
 * still goes through `session.submit`.
 *
 * Run: node --import tsx/esm scripts/verify-backend-chat.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, { setLang, t }, { default: instances }, { findText, settled, sleep, viewportLines }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/dsh-adapter/approvals.js'),
    import('../src/dsh-adapter/channel.js'),
    import('../src/i18n.js'),
    import('../src/ink/instances.js'),
    import('./lib/term-test.mjs'),
  ])
const { activateModernEmojiWidths } = await import('./lib/modern-widths.mjs')
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentInput, AgentSession, SubmitPlacement } from '../src/agent/session.js'
import type { WorkingActivityView } from '../src/adapter/ports/channel-view.js'
import { ActivityStore } from '../src/dsh-adapter/activity-store.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) throw new Error(`${label}${detail ? `\n${detail}` : ''}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const submits: { input: AgentInput; placement: SubmitPlacement }[] = []
const mcpCalls: string[] = []
const listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
const session: AgentSession = {
  ref: { backendId: 'claude', sessionId: '44444444-4444-4444-8444-444444444444' },
  cwd: process.cwd(),
  status: 'idle',
  capabilities: {
    native: {},
    // Phase 5b: `/mcp reconnect|toggle` reach the backend's MCP control.
    mcp: {
      status: () => Promise.resolve([{ name: 'github', status: 'connected', toolCount: 2 }]),
      reconnect: name => { mcpCalls.push(`reconnect:${name}`); return Promise.resolve() },
      toggle: (name, enabled) => { mcpCalls.push(`toggle:${name}:${enabled}`); return Promise.resolve() },
    },
  },
  history: () => Promise.resolve([]),
  subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  submit(input, placement) {
    submits.push({ input, placement })
    return Promise.resolve({ accepted: true })
  },

  cancel: () => Promise.resolve({ stillQueued: [] }),
  dispose: () => Promise.resolve(),
}
const emit = (events: readonly AgentEvent[]): void => {
  for (const listener of [...listeners]) listener(events, { replay: false, wake: 'sync' })
}

const ctx = {
  on: () => () => undefined,
  get: () => undefined,
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
} as never
const channel = createChannel(ctx, session, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' })

const COLS = 100
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin()
const stdout = new FakeStdout()
const screen = (): string => viewportLines(term, ROWS).join('\n')
const instance = await ui.render(
  React.createElement(Chat, {
    channel: channel as never,
    questionStore: new QuestionStore(),
    approvalStore: new ApprovalStore(),
    onExit: () => undefined,
    fullscreen: false,
    trajectorySeen: true,
  }),
  { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
)
for (const value of instances.values()) instances.set(process.stdout, value)
const toasts = (): string => channel.notifications.map(item => item.text).join(' | ')
const typeLine = async (text: string): Promise<void> => {
  for (const char of text) stdin.write(char)
  // 固定窗:pacing the prompt applies typed characters on its own render tick.
  await sleep(60)
}
const clearLine = async (): Promise<void> => {
  for (let i = 0; i < 24; i += 1) stdin.write('\x7f')
  // 固定窗:pacing backspaces land before the next keystroke batch.
  await sleep(60)
}

try {
  // 固定窗:pacing the key handlers attach after the first frame.
  await sleep(300)
  await typeLine('/pre')
  // 固定窗:探针 a menu that must NOT open has no completion condition to poll.
  await sleep(200)
  check('the slash menu hides commands the backend lacks', !screen().includes(t('sugg-commands-title')) && channel.commandCompletions('/pre').length === 0, screen())
  await clearLine()
  await typeLine('/ne')
  check('the slash menu offers served commands', await settled(() => screen().includes(t('sugg-commands-title')) && screen().includes('Start a new conversation')), screen())
  await clearLine()
  // The composition root serves /restart and /kernel by respawning the
  // process (a Claude session included), so every backend lists them.
  check('restart and kernel are offered on a non-DSH backend',
    channel.commandCompletions('/rest').some(command => command.name === 'restart')
      && channel.commandCompletions('/kern').some(command => command.name === 'kernel'),
    JSON.stringify(channel.commandCompletions('/re').map(command => command.name)))

  await typeLine('/preset')
  stdin.write('\r')
  const refusal = t('cmd-unavailable-backend', { cmd: 'preset', backend: 'Claude' })
  check('a typed unavailable command explains itself', await settled(() => toasts().includes(refusal)), toasts())
  check('the refused command never reaches the model', submits.length === 0)
  await clearLine()

  emit([{ type: 'turn.start', turn: 1, origin: 'user', time: Date.now() }])
  await typeLine('/rewind')
  stdin.write('\r')
  const rewindRefusal = t('cmd-unavailable-backend', { cmd: 'rewind', backend: 'Claude' })
  check('while working it is refused, not steered in', await settled(() => toasts().includes(rewindRefusal)) && submits.length === 0, toasts())
  emit([{ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: Date.now() }])
  await clearLine()

  // Review fix: keys that open DSH-only surfaces explain themselves instead
  // of opening an empty UI (or cycling nothing).
  stdin.write('\x1b[Z')
  check('Shift+Tab without native modes explains itself', await settled(() => toasts().includes(t('capability-unavailable-backend', { name: 'mode' }))), toasts())
  stdin.write('\x14')
  // 三态契约（设计 §④）：核心已挂中立 AgentEvent 折叠源——Ctrl+T 打开
  // 的轨迹场景渲染折叠账本（上面发出的 turn 已成行），不弹能力缺失通
  // 知、不拒绝入口；unsupported 只属于未挂数据源的组合。
  check('Ctrl+T over the folded core renders the trajectory ledger', await settled(() => screen().includes(t('traj-title')) && screen().includes('1 turns')) && !screen().includes(t('trajectory-unsupported')) && !toasts().includes(t('capability-unavailable-backend', { name: 'trace' })), screen())
  stdin.write('q')
  check('the trajectory scene returns to the conversation', await settled(() => !screen().includes(t('traj-title'))))
  stdin.write('\x1b')
  // 固定窗:pacing the double-Esc detector needs two distinct key events.
  await sleep(80)
  stdin.write('\x1b')
  check('double-Esc without rewind explains itself', await settled(() => toasts().includes(t('capability-unavailable-backend', { name: 'rewind' }))), toasts())

  // Phase 5b: /mcp subcommands where the backend controls its servers.
  await typeLine('/mcp reconnect github')
  stdin.write('\r')
  check('/mcp reconnect <name> reaches the backend and says so', await settled(() => mcpCalls.includes('reconnect:github') && toasts().includes(t('mcp-reconnected', { name: 'github' }))), `${mcpCalls.join()} | ${toasts()}`)
  await clearLine()
  await typeLine('/mcp toggle github off')
  stdin.write('\r')
  check('/mcp toggle <name> off reaches the backend', await settled(() => mcpCalls.includes('toggle:github:false')), mcpCalls.join())
  await clearLine()
  await typeLine('/mcp toggle github')
  stdin.write('\r')
  check('/mcp toggle without on|off shows the usage', await settled(() => toasts().includes(t('mcp-control-usage'))) && mcpCalls.length === 2, toasts())
  await clearLine()
  await typeLine('/mcp')
  stdin.write('\r')
  check('plain /mcp still shows the status report', await settled(() => screen().includes('github')) && submits.length === 0, screen())
  await clearLine()

  await typeLine('hello backend')
  stdin.write('\r')
  check('plain text goes to session.submit', await settled(() => submits.length === 1) && submits[0]!.input.text === 'hello backend', JSON.stringify(submits))
} finally {
  instance.unmount()
  channel.releaseContributions()
  term.dispose()
}

// ── bare /effort on a FRESH channel: before any event or first prompt ──
// The slider trusts listEfforts to have said why it cannot open (Chat
// returns silently for <= 1 tiers). These mounts emit nothing and submit
// nothing — exactly the fresh-startup shape where the levels list is
// whatever the backend itself reports.
const { applySidePanelSplitEnabled, applySidePanelOpen, applySidePanelPanels, getSidePanelSplitEnabled, getSidePanelOpen, getSidePanelPanels } = await import('../src/tuiDisplayPrefs.js')
const freshSession = (capabilities: Partial<AgentSession['capabilities']>): AgentSession => ({
  ref: { backendId: 'fake', sessionId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' },
  cwd: process.cwd(),
  status: 'idle',
  capabilities: { native: {}, ...capabilities },
  history: () => Promise.resolve([]),
  subscribe: () => () => undefined,
  submit: () => Promise.resolve({ accepted: true }),

  cancel: () => Promise.resolve({ stillQueued: [] }),
  dispose: () => Promise.resolve(),
})
const runEffortCase = async (label: string, levels: { id: string; label: string }[], current: string | undefined, expectToast: string | undefined, expectSlider: boolean): Promise<void> => {
  const sets: string[] = []
  const submits: AgentInput[] = []
  const session = freshSession({
    effort: { levels: () => levels, current: () => current, set: id => { sets.push(id); return Promise.resolve() } },
  })
  session.submit = input => { submits.push(input); return Promise.resolve({ accepted: true }) }
  const channel = createChannel(ctx, session, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' })
  const term = new XTerm({ cols: 100, rows: 30, scrollback: 0, allowProposedApi: true })
  class Out extends Writable { columns = 100; rows = 30; isTTY = true; _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) } }
  class In extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
  const stdin = new In()
  const instance = await ui.render(
    React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: false, trajectorySeen: true }),
    { stdout: new Out() as never, stdin: stdin as never, stderr: new Out() as never, exitOnCtrlC: false, patchConsole: false },
  )
  try {
    await sleep(300) // 固定窗:pacing the key handlers attach after the first frame.
    for (const char of '/effort') stdin.write(char)
    await sleep(60) // 固定窗:pacing the prompt applies typed characters on its own render tick.
    stdin.write('\r')
    await sleep(200) // 固定窗:pacing listEfforts resolves and the overlay or toast paints.
    const text = viewportLines(term, 30).join('\n')
    const toasts = channel.notifications.map(item => item.text).join(' | ')
    check(`${label}: the route answers with its toast`, expectToast === undefined || toasts.includes(expectToast), `${toasts} :: ${text}`)
    check(`${label}: the slider opens only for a real range`, text.includes(t('picker-title-effort')) === expectSlider, text)
    check(`${label}: nothing reached the model`, submits.length === 0, JSON.stringify(submits.map(input => input.text)))
    if (expectSlider) {
      stdin.write('\u001b[C')
      await sleep(150) // 固定窗:pacing the live-apply keystroke lands on one setEffort call.
      check(`${label}: → applies exactly one control set`, sets.length === 1 && sets[0] === 'medium', sets.join(','))
      check(`${label}: the apply never submits either`, submits.length === 0, JSON.stringify(submits.map(input => input.text)))
    }
  } finally {
    instance.unmount()
    channel.releaseContributions()
    term.dispose()
  }
}
await runEffortCase('bare /effort with no tiers', [], undefined, t('effort-unsupported'), false)
await runEffortCase('bare /effort with a single tier', [{ id: 'medium', label: 'Medium' }], 'medium', t('effort-single-tier', { name: 'Medium' }), false)
await runEffortCase('bare /effort with a real range', [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], 'low', undefined, true)

// ── /resume with the sidebar split open routes by workspace capability ──
// The workspace PANEL reads the DSH workspace ledger. A backend without
// that capability (the Claude browser shape) used to have its /resume
// swallowed by the panel: no catalog read, no history on screen — while
// the user asked for their sessions. Such backends keep the full-screen
// supervisor; a DSH channel keeps the panel route.
{
  const previousSplit = getSidePanelSplitEnabled()
  const previousOpen = getSidePanelOpen()
  const previousPanels = getSidePanelPanels()
  applySidePanelSplitEnabled(true)
  applySidePanelPanels('info,workspace')
  applySidePanelOpen(true)
  const SPLIT_COLS = 150
  const SPLIT_ROWS = 30
  const mountSplitChat = async (session: AgentSession, launch: {
    readonly model: string
    readonly provider: string
    readonly openSession?: (target: { kind: string; sessionId?: string; cwd?: string }) => Promise<AgentSession>
    readonly sessionCatalog?: { list(): Promise<readonly unknown[]> }
  }): Promise<{ text(): string; write(data: string): void; toasts(): string[]; unmount(): void }> => {
    const term = new XTerm({ cols: SPLIT_COLS, rows: SPLIT_ROWS, scrollback: 0, allowProposedApi: true })
    class Out extends Writable { columns = SPLIT_COLS; rows = SPLIT_ROWS; isTTY = true; _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) } }
    class In extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
    const stdin = new In()
    const channel = createChannel(ctx, session, {
      model: launch.model, provider: launch.provider, cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent',
      ...(launch.openSession === undefined ? {} : { openSession: launch.openSession }),
      ...(launch.sessionCatalog === undefined ? {} : { sessionCatalog: launch.sessionCatalog }),
    } as never)
    const instance = await ui.render(
      React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: true, trajectorySeen: true }),
      { stdout: new Out() as never, stdin: stdin as never, stderr: new Out() as never, exitOnCtrlC: false, patchConsole: false },
    )
    return {
      text: () => viewportLines(term, SPLIT_ROWS).join('\n'),
      write: (data: string) => { stdin.write(data) },
      toasts: () => channel.notifications.map(item => item.text),
      unmount: () => { instance.unmount(); channel.releaseContributions(); term.dispose() },
    }
  }
  try {
    // The Claude shape: resume wired, no workspace capability.
    let catalogReads = 0
    const opened: string[] = []
    const historyId = 'c7c7c7c7-c7c7-47c7-87c7-c7c7c7c7c7c7'
    const stamp = Date.now()
    const historyRow = {
      id: historyId, kind: { kind: 'root' }, title: { text: 'claude history session', source: 'prompt' },
      cwd: process.cwd(), createdAt: stamp - 60_000, updatedAt: stamp - 30_000, bytes: 2048, hasPrompt: true,
      agentPreset: 'standard', model: 'claude-opus', label: undefined, branch: 'main', childCount: 0, backendId: 'fake',
    }
    const claude = await mountSplitChat(freshSession({}), {
      model: 'claude-opus',
      provider: '',
      openSession: async target => {
        opened.push(`${target.kind}:${target.sessionId ?? target.cwd ?? ''}`)
        return freshSession({})
      },
      sessionCatalog: { list: async () => { catalogReads += 1; return [historyRow] } },
    })
    try {
      await sleep(300) // 固定窗:pacing the key handlers attach after the first frame.
      for (const char of '/resume') claude.write(char)
      await sleep(60) // 固定窗:pacing the prompt applies typed characters on its own render tick.
      claude.write('\r')
      check('/resume with the sidebar open lists the backend history', await settled(() => claude.text().includes('claude history session'), { timeoutMs: 6_000 }), claude.text())
      check('… reading the catalog rather than opening the workspace panel', catalogReads >= 1, String(catalogReads))
      check('… the workspace panel stayed closed', !claude.text().includes(t('panel-workspace-current')), claude.text())
      claude.write('\u001b[C')
      await sleep(60) // 固定窗:pacing 按键步间：焦点切换无可观测锚点
      claude.write('\u001b[B')
      await sleep(60) // 固定窗:pacing 让光标移动渲染一帧
      claude.write('\r')
      check('Enter on the history row really opens it through the backend', await settled(() => opened.includes(`resume:${historyId}`), { timeoutMs: 6_000 }), opened.join(' '))
    } finally { claude.unmount() }

    // The DSH shape keeps today's panel route (positive control).
    const stubAgentCtx = { on: () => () => undefined }
    const agent = {
      id: 'dsh-1', status: 'idle', session: { id: 'dsh-1', seq: 0, events: [] }, ctx: stubAgentCtx,
      followup: () => undefined, steer: () => undefined, inbox: { remove: () => true },
    }
    const dsh = await mountSplitChat(agent as never, { model: 'deepseek-chat', provider: 'deepseek' })
    try {
      await sleep(300) // 固定窗:pacing the key handlers attach after the first frame.
      for (const char of '/home') dsh.write(char)
      await sleep(60) // 固定窗:pacing the prompt applies typed characters on its own render tick.
      dsh.write('\r')
      check('a DSH /home with the sidebar open routes to the workspace panel', await settled(() => dsh.text().includes(t('panel-workspace-current')), { timeoutMs: 6_000 }), dsh.text())
      check('… and not to the full-screen supervisor', !dsh.text().includes('Sessions in'), dsh.text())
    } finally { dsh.unmount() }
  } finally {
    applySidePanelSplitEnabled(previousSplit)
    applySidePanelOpen(previousOpen)
    applySidePanelPanels(previousPanels)
  }
}

// ── backend-native permission modes: /permission + the footer mode chip ──
// The Claude shape over the fake-session harness: the typed `modes`
// capability is the whole surface. /permission behaves like the DSH preset
// pipeline (bare opens a picker, <id> sets directly, status reports the
// current mode), and the footer mode segment — hidden for a base mode on
// DSH — is always shown for backend modes and clicks into the same picker.
{
  const MODES = [
    { id: 'default', label: 'Default' },
    { id: 'acceptEdits', label: 'Accept edits' },
    { id: 'plan', label: 'Plan' },
  ]
  const sets: string[] = []
  // The stub's `current()` FOLLOWS `set()`, exactly like the real backend:
  // the live mode is what `modes.current()` reports (the translator updates
  // it from the same `mode.changed` frame this stub emits). A constant
  // `current: () => 'default'` made the footer assertion below vacuous — it
  // asked whether the footer follows the switch while the roster claimed
  // nothing had changed (fixtures must follow the runtime contract).
  let currentMode = 'default'
  const listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  const modeful: AgentSession = {
    ...freshSession({
      modes: {
        list: () => MODES,
        current: () => currentMode,
        set: id => { sets.push(id); currentMode = id; for (const listener of [...listeners]) listener([{ type: 'mode.changed', modeId: id }], { replay: false, wake: 'sync' }); return Promise.resolve() },
      },
    }),
  }
  modeful.subscribe = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const submits: AgentInput[] = []
  modeful.submit = input => { submits.push(input); return Promise.resolve({ accepted: true }) }
  const channel = createChannel(ctx, modeful, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent', statusBar: { mode: true } } as never)
  const COLS = 100
  const ROWS = 30
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class Out extends Writable { columns = COLS; rows = ROWS; isTTY = true; _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) } }
  class In extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
  const stdin = new In()
  const stdout = new Out()
  // AlternateScreen resolves its renderer through instances.get(process.stdout)
  // with a single-entry fallback: drop the earlier sections' stale (unmounted)
  // instances so this render is the one the alt-screen gate answers to.
  for (const key of [...instances.keys()]) instances.delete(key)
  const instance = await ui.render(
    React.createElement(ui.AlternateScreen, null, React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: true, trajectorySeen: true })),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  // AlternateScreen resolves its renderer through instances.get(process.stdout):
  // repoint the bridge at THIS render (earlier sections bridged theirs) so the
  // alt-screen gate and mouse dispatch answer to the live instance.
  instances.set(process.stdout, instances.get(stdout)!)
  const screen = (): string => viewportLines(term, ROWS).join('\n')
  const footer = (): string => {
    const lines = viewportLines(term, ROWS)
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
    return lines.slice(-4).join('\n')
  }
  const toasts = (): string => channel.notifications.map(item => item.text).join(' | ')
  const clearLineStdin = async (): Promise<void> => {
    for (let i = 0; i < 24; i += 1) stdin.write('\x7f')
    await sleep(60) // 固定窗:pacing backspaces land before the next keystroke batch.
  }
  try {
    await sleep(300) // 固定窗:pacing the key handlers attach after the first frame.
    check('the footer shows the base backend mode (always visible for backend modes)', await settled(() => footer().includes('Default')), footer())
    const hit = findText(term, 'Default')
    check('the footer mode segment is locatable', hit !== null)
    if (hit !== null) {
      const seq = (final: string): string => '\x1b[<0;' + (hit.col + 1) + ';' + (hit.row + 1) + final
      stdin.write(seq('M'))
      await sleep(30) // 固定窗:pacing 鼠标 press→release 步间
      stdin.write(seq('m'))
      check('clicking the mode segment opens the same /permission picker', await settled(() => screen().includes(t('permission-mode-picker-title')) && screen().includes('Accept edits')), screen())
      stdin.write('\x1b')
      await sleep(120) // 固定窗:pacing the picker closes before the next keystroke batch.
    }
    check('Esc closed the picker', await settled(() => !screen().includes(t('permission-mode-picker-title'))), screen())
    for (const char of '/permission') stdin.write(char)
    await sleep(60) // 固定窗:pacing the prompt applies typed characters on its own render tick.
    stdin.write('\r')
    check('bare /permission opens the mode picker with the current row focused', await settled(() => screen().includes(t('permission-mode-picker-title')) && screen().includes('Plan')), screen())
    stdin.write('\x1b[B')
    await sleep(80) // 固定窗:pacing the arrow move lands before Enter.
    stdin.write('\r')
    await sleep(80) // 固定窗:pacing setMode resolves and the overlay closes.
    check('Enter applies exactly one mode switch (default → acceptEdits)', JSON.stringify(sets) === JSON.stringify(['acceptEdits']) && !screen().includes(t('permission-mode-picker-title')), JSON.stringify(sets) + ' | ' + screen())
    check('the switch is narrated', toasts().includes(t('mode-switched', { name: 'Accept edits' })), toasts())
    check('the footer follows the live mode', await settled(() => footer().includes('Accept edits')), footer())
    await clearLineStdin(stdin)
    for (const char of '/permission plan') stdin.write(char)
    await sleep(60) // 固定窗:pacing the prompt applies typed characters on its own render tick.
    stdin.write('\r')
    check('/permission <id> sets the mode directly', await settled(() => JSON.stringify(sets) === JSON.stringify(['acceptEdits', 'plan'])), JSON.stringify(sets))
    await clearLineStdin(stdin)
    for (const char of '/permission status') stdin.write(char)
    await sleep(60) // 固定窗:pacing the prompt applies typed characters on its own render tick.
    stdin.write('\r')
    check('/permission status reports the current mode', await settled(() => screen().includes(t('permission-mode-current', { name: '' }).trim()) && screen().includes('Plan')), screen())
    check('no permission line ever reached the model', submits.length === 0, JSON.stringify(submits.map(input => input.text)))
    await clearLineStdin(stdin)
    for (const char of '/permission bogus') stdin.write(char)
    await sleep(60) // 固定窗:pacing the prompt applies typed characters on its own render tick.
    stdin.write('\r')
    check('/permission <unknown-id> explains itself and reaches no model', await settled(() => toasts().includes(t('permission-mode-unknown', { id: 'bogus' }))) && submits.length === 0, toasts())
  } finally {
    instance.unmount()
    channel.releaseContributions()
    term.dispose()
  }

  // A backend WITHOUT modes keeps today's reachability: /permission is not
  // a command there, so the typed line falls through to the model as text.
  {
    const submits: AgentInput[] = []
    const session = freshSession({})
    session.submit = input => { submits.push(input); return Promise.resolve({ accepted: true }) }
    const channel = createChannel(ctx, session, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' } as never)
    const term = new XTerm({ cols: 100, rows: 30, scrollback: 0, allowProposedApi: true })
    class Out extends Writable { columns = 100; rows = 30; isTTY = true; _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) } }
    class In extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
    const stdin = new In()
    const instance = await ui.render(
      React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: false, trajectorySeen: true }),
      { stdout: new Out() as never, stdin: stdin as never, stderr: new Out() as never, exitOnCtrlC: false, patchConsole: false },
    )
    try {
      await sleep(300) // 固定窗:pacing the key handlers attach after the first frame.
      for (const char of '/permission') stdin.write(char)
      await sleep(60) // 固定窗:pacing the prompt applies typed characters on its own render tick.
      stdin.write('\r')
      check('without modes /permission still falls through to the model', await settled(() => submits.length === 1 && submits[0]!.text === '/permission'), JSON.stringify(submits.map(input => input.text)))
    } finally {
      instance.unmount()
      channel.releaseContributions()
      term.dispose()
    }
  }
}

// ── footer model + think-level segments click into /model · /effort ──
// Same contract as the mode segment: the capability bit (backendCapabilities
// .models / .effort) gates the click, the picker is the command's own, and a
// backend without the capability renders the segment but answers nothing.
// The effort fixture also carries levelsFallback — the slider must SAY the
// ladder is the CLI-standard compatibility offer, not the model's own list.
{
  const modelsCap = {
    list: () => Promise.resolve([{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }]),
    current: () => ({ model: 'fake-model' }),
    set: () => Promise.resolve({ kind: 'switched' as const }),
  }
  const effortSets: string[] = []
  const effortCap = {
    levelsFallback: true as const,
    levels: () => [
      { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra high' }, { id: 'max', label: 'Max' },
    ],
    current: () => 'medium',
    set: (id: string | null) => { effortSets.push(id ?? 'null'); return Promise.resolve() },
  }
  const capable = freshSession({ models: modelsCap, effort: effortCap })
  const channel = createChannel(ctx, capable, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' } as never)
  const COLS = 100
  const ROWS = 30
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class Out extends Writable { columns = COLS; rows = ROWS; isTTY = true; _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) } }
  class In extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
  const stdin = new In()
  const stdout = new Out()
  // AlternateScreen resolves its renderer through instances.get(process.stdout):
  // the earlier sections' (unmounted) instances must not answer for this render.
  for (const key of [...instances.keys()]) instances.delete(key)
  const instance = await ui.render(
    React.createElement(ui.AlternateScreen, null, React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: true, trajectorySeen: true })),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  instances.set(process.stdout, instances.get(stdout)!)
  const screen = (): string => viewportLines(term, ROWS).join('\n')
  const footer = (): string => {
    const lines = viewportLines(term, ROWS)
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
    return lines.slice(-4).join('\n')
  }
  // The empty transcript's splash ALSO prints the model name (capitalized
  // effort), so findText's top-down scan lands on the splash row, not the
  // footer segment. Locate segments bottom-up: the footer is the last
  // content row and its effort id is the raw lowercase one.
  const footerHit = (needle: string): { col: number; row: number } | null => {
    const lines = viewportLines(term, ROWS)
    for (let row = lines.length - 1; row >= 0; row--) {
      const col = lines[row]!.indexOf(needle)
      if (col >= 0) return { col, row }
    }
    return null
  }
  try {
    await sleep(300) // 固定窗:pacing the key handlers attach after the first frame.
    check('the footer shows the model and think-level segments', await settled(() => footer().includes('fake-model') && footer().includes('medium')), footer())
    const modelHit = footerHit('fake-model')
    check('the model segment is locatable', modelHit !== null)
    if (modelHit !== null) {
      const seq = (final: string): string => '\x1b[<0;' + (modelHit.col + 1) + ';' + (modelHit.row + 1) + final
      stdin.write(seq('M'))
      await sleep(30) // 固定窗:pacing 鼠标 press→release 步间
      stdin.write(seq('m'))
      // A single-provider catalog opens the picker's DIRECT list (no group
      // pane, no title row) — the catalog rows + the confirm hint are the
      // open-picker markers.
      check('clicking the model segment opens the /model picker with the catalog', await settled(() => screen().includes('Sonnet') && screen().includes('Opus') && screen().includes('Enter to confirm')), screen())
      stdin.write('\x1b')
      await sleep(120) // 固定窗:pacing the picker closes before the next click.
    }
    check('Esc closed the model picker', await settled(() => !screen().includes('Sonnet')), screen())
    const effortHit = footerHit('medium')
    check('the think-level segment is locatable', effortHit !== null)
    if (effortHit !== null) {
      const seq = (final: string): string => '\x1b[<0;' + (effortHit.col + 1) + ';' + (effortHit.row + 1) + final
      stdin.write(seq('M'))
      await sleep(30) // 固定窗:pacing 鼠标 press→release 步间
      stdin.write(seq('m'))
      check('clicking the think-level segment opens the /effort slider', await settled(() => screen().includes(t('picker-title-effort')) && screen().includes('Extra high')), screen())
      check('the slider marks the ladder as the CLI-standard compatibility offer', screen().includes(t('effort-fallback-tier-note')), screen())
      stdin.write('\x1b')
      await sleep(120) // 固定窗:pacing the slider closes before the next assertion.
    }
    check('Esc closed the slider without applying anything', await settled(() => !screen().includes(t('picker-title-effort'))) && effortSets.length === 0, screen() + ' :: ' + effortSets.join())
  } finally {
    instance.unmount()
    channel.releaseContributions()
    term.dispose()
  }

  // The same footer WITHOUT the capabilities: the model segment renders but
  // its click answers nothing, and the think-level segment stays away (no
  // reasoning effort to show).
  {
    const channel = createChannel(ctx, freshSession({}), { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' } as never)
    const term = new XTerm({ cols: 100, rows: 30, scrollback: 0, allowProposedApi: true })
    class Out extends Writable { columns = 100; rows = 30; isTTY = true; _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) } }
    class In extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
    const stdin = new In()
    const stdout = new Out()
    for (const key of [...instances.keys()]) instances.delete(key)
    const instance = await ui.render(
      React.createElement(ui.AlternateScreen, null, React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: true, trajectorySeen: true })),
      { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    instances.set(process.stdout, instances.get(stdout)!)
    const screen = (): string => viewportLines(term, 30).join('\n')
    const footer = (): string => {
      const lines = viewportLines(term, 30)
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
      return lines.slice(-4).join('\n')
    }
    try {
      await sleep(300) // 固定窗:pacing the key handlers attach after the first frame.
      check('without capabilities the model segment still renders', await settled(() => footer().includes('fake-model')), footer())
      check('… and the think-level segment stays away (no effort to show)', !footer().includes('medium'), footer())
      const modelHit = (() => {
        const lines = viewportLines(term, 30)
        for (let row = lines.length - 1; row >= 0; row--) {
          const col = lines[row]!.indexOf('fake-model')
          if (col >= 0) return { col, row }
        }
        return null
      })()
      if (modelHit !== null) {
        const seq = (final: string): string => '\x1b[<0;' + (modelHit.col + 1) + ';' + (modelHit.row + 1) + final
        stdin.write(seq('M'))
        await sleep(30) // 固定窗:pacing 鼠标 press→release 步间
        stdin.write(seq('m'))
        await sleep(200) // 固定窗:pacing a no-op click stays settled before asserting.
      }
      check('clicking the model segment without the capability opens nothing', !screen().includes(t('picker-title-model')) && !screen().includes(t('picker-title-effort')), screen())
    } finally {
      instance.unmount()
      channel.releaseContributions()
      term.dispose()
    }
  }
}

// ── the backend's own working line (the Claude shape): capability → store ──
// A backend that folds its own working activity publishes through the typed
// `workingActivity` capability; the channel forwards into the SAME store the
// DSH projection fills, and Chat's spinner slot shows the published line.
// Nothing published = the classic random-verb spinner, untouched.
{
  const activityListeners = new Set<(view: WorkingActivityView) => void>()
  const session = freshSession({
    workingActivity: { subscribe: listener => { activityListeners.add(listener); return () => { activityListeners.delete(listener) } } },
  })
  const listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  session.subscribe = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const emit = (events: readonly AgentEvent[]): void => {
    for (const listener of [...listeners]) listener(events, { replay: false, wake: 'sync' })
  }
  /** Push one view the way the Claude session's fold does. */
  const pushActivity = (view: WorkingActivityView): void => {
    for (const listener of [...activityListeners]) listener(view)
  }
  const activityStore = new ActivityStore()
  const channel = createChannel(ctx, session, {
    model: 'fake-model', provider: '', cwd: process.cwd(),
    activity: true, backendLabel: 'Fake Agent',
    // The status bar's activity field is default-off; the done card's resting
    // place is that row, so this block turns it on (a user preference).
    statusBar: { activity: true },
    publishActivity: (sessionId, view) => activityStore.update(sessionId, view),
    clearActivity: sessionId => activityStore.clear(sessionId),
  } as never)
  const term = new XTerm({ cols: 100, rows: 30, scrollback: 0, allowProposedApi: true })
  // The spinner frames are emoji: measure them the way a real terminal does
  // (lib/modern-widths.mjs), or in-place repaints of that row land a cell off.
  activateModernEmojiWidths(term)
  class Out extends Writable { columns = 100; rows = 30; isTTY = true; _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) } }
  class In extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
  const stdin = new In()
  const screen = (): string => viewportLines(term, 30).join('\n')
  const instance = await ui.render(
    React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), activityStore, onExit: () => undefined, fullscreen: false, trajectorySeen: true }),
    { stdout: new Out() as never, stdin: stdin as never, stderr: new Out() as never, exitOnCtrlC: false, patchConsole: false },
  )
  try {
    await sleep(300) // 固定窗:pacing the key handlers attach after the first frame.
    emit([{ type: 'turn.start', turn: 1, origin: 'user', time: Date.now() }])
    await settled(() => channel.working)
    const occurrences = (needle: string): number => screen().split(needle).length - 1
    check('nothing published: the classic random-verb spinner keeps the slot',
      occurrences('⏵') === 0 && screen().includes('…'),
      screen())
    pushActivity({ phase: 'thinking', line: '⏵Fixing the login bug', live: false, toolCount: 0, phrase: '⏵Fixing the login bug', phaseStartedAt: Date.now(), turnStartedAt: Date.now(), updatedAt: Date.now(), lang: 'en' })
    check('the published ⏵ line takes the spinner slot', await settled(() => occurrences('Fixing the login bug') === 1), screen())
    // The narration contract: the transcript strips the ⏵ line at render
    // (MessageList), so the SAME text streaming into the transcript must not
    // double it on screen.
    emit([{ type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 }])
    emit([{ type: 'assistant.delta', attemptId: 'a1', index: 0, time: Date.now(), delta: { kind: 'text', text: '⏵Fixing the login bug\nand the details follow' } }])
    await sleep(120) // 固定窗:pacing the streaming row paints.
    check('the ⏵ line shows exactly once (transcript strips its copy)',
      occurrences('Fixing the login bug') === 1,
      screen())
    pushActivity({ phase: 'tool', line: 'Read src/login.tsx', live: false, label: 'Read', detail: 'src/login.tsx', toolCount: 0, phaseStartedAt: Date.now(), turnStartedAt: Date.now(), updatedAt: Date.now(), lang: 'en' })
    check('a running tool replaces the line with label + detail', await settled(() => occurrences('Read src/login.tsx') === 1 && occurrences('Fixing the login bug') === 0), screen())
    emit([{ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: Date.now() }])
    await settled(() => !channel.working)
    pushActivity({ phase: 'done', line: 'Done · 1 tool', live: false, toolCount: 1, phaseStartedAt: Date.now(), turnStartedAt: Date.now(), updatedAt: Date.now(), lang: 'en' })
    check('turn end settles on the done line and frees the spinner slot',
      await settled(() => occurrences('Done · 1 tool') === 1 && occurrences('Read src/login.tsx') === 0),
      screen())
  } finally {
    instance.unmount()
    channel.releaseContributions()
    term.dispose()
  }
}
console.log(`\nverify-backend-chat OK (${passed} checks)`)
process.exit(0)
