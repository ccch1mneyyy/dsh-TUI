/**
 * Trajectory source three-state regression (an unsupported source must not
 * read as an empty session):
 * supported / empty / unsupported must be ONE contract across every state
 * and every entry — /trace, Ctrl+T, the sidebar tab and the ⤢ outlet.
 *
 *  - composition: the backend-neutral core mounts the AgentEvent fold and
 *    reports 'empty' / 'supported' as events flow; the DSH extension
 *    replaces it with its raw history — never a backendId lookup, and
 *    'unsupported' stays the structural report of a composition that
 *    mounted no source at all (asserted through a hand-built state, the
 *    way an extension-less future composition would produce it);
 *  - panel: unsupported renders the honest not-adapted copy (no
 *    "appears once this session has turns" promise, no ⤢ hint line); the
 *    claude backend gets its specifically-worded line; supported-empty
 *    keeps the existing copy; supported renders the ledger;
 *  - scene: unsupported renders the honest copy and still exits (q);
 *    supported-empty keeps the golden chrome (no unsupported copy);
 *  - /trace and Ctrl+T over a REAL unsupported channel OPEN the honest
 *    scene — no capability notice, no refusal (four-entry parity);
 *  - the ⤢ outlet leaves the bar for an unsupported trajectory while the
 *    tab itself stays rendered and clickable (not silently hidden).
 *
 * Run: node --import tsx/esm scripts/verify-trajectory-source-states.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { TrajectoryPanel }, { TrajectoryScene }, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, contexts, { setLang, t }, trajApi, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/TrajectoryPanel.js'),
  import('../src/screens/TrajectoryScene.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/components/sidePanel/SidePanelRuntimeContext.js'),
  import('../src/i18n.js'),
  import('../src/dsh-adapter/trajectory/index.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput } = ui
const { SidePanelRuntimeContext, PanelContext } = contexts
const { buildTrajectory } = trajApi
const { settled, sleep } = termTest
setLang('en')

/** Long empty-state copy is clipped to the panel width (truncateWidth), so
 * the display assertions match the copy's HEAD, never its full length. */
const head = (text: string): string => text.slice(0, 30)
/** Tolerant read so a tree WITHOUT the capability surface still runs every
 * display assertion below (and fails every composition one on 'absent'). */
const sourceOf = (channel: { trajectorySource?: () => string }): string =>
  (typeof channel.trajectorySource === 'function' ? channel.trajectorySource() : 'absent')

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// ─── shared harness ─────────────────────────────────────────────────────────

function makeTerminalHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  const writes: string[] = []
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { writes.push(String(chunk)); term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() } }
  class FakeStdin extends PassThrough {
    isTTY = true
    isRaw = false
    setRawMode(next: boolean) { this.isRaw = next; return this }
    setEncoding() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const lines = (): string[] => {
    const buf = term.buffer.active
    return Array.from({ length: rows }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(false) ?? '')
  }
  const screen = (): string => lines().join('\n')
  return { term, writes, stdin, lines, screen, stdout: new FakeStdout(), stderr: new FakeStderr() }
}

/** stdin 双写合并坑：一个键写完让出一轮事件循环再写下一个。 */
const writeKey = async (stdin: PassThrough, data: string): Promise<void> => {
  stdin.write(data)
  await new Promise(resolve => setImmediate(resolve))
}

// A DSH-shaped event stream (same trimmed shape verify-trajectory-panel uses).
const T0 = 1_700_000_000_000
let seq = 0
const ev = (type: string, data: unknown): Record<string, unknown> =>
  ({ type, seq: ++seq, time: T0 + ++seq * 250, data })
const DSH_EVENTS: Record<string, unknown>[] = [
  ev('turn/start', { turn: 1 }),
  ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt' }] }),
  ev('step/start', { turn: 1, step: 1 }),
  ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'reply' }] } }),
  ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{}' }),
  ev('tool/result', { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'out' }] } }),
  ev('step/end', { turn: 1, step: 1 }),
  ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
]

try {
  // ── 1. composition states (real createChannel, no backendId lookup) ──────
  {
    const ctx = {
      on: () => () => undefined,
      effect: () => () => undefined,
      get: () => undefined,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    } as never
    const coreListeners = new Set<(batch: readonly unknown[], meta: unknown) => void>()
    const fakeSession = {
      ref: { backendId: 'fake', sessionId: '33333333-3333-4333-8333-333333333333' },
      cwd: process.cwd(),
      status: 'idle',
      capabilities: { native: {} },
      history: () => Promise.resolve([]),
      subscribe(listener: (batch: readonly unknown[], meta: unknown) => void) { coreListeners.add(listener); return () => { coreListeners.delete(listener) } },
      submit: () => Promise.resolve({ accepted: true }),
      removePending: () => false,
      cancel: () => Promise.resolve({ stillQueued: [] }),
      dispose: () => Promise.resolve(),
    }
    const plain = createChannel(ctx, fakeSession as never, { model: 'm', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' })
    check('compose: non-DSH core mounts the AgentEvent fold (empty)', sourceOf(plain) === 'empty', sourceOf(plain))
    check('compose: fold reports no events yet', plain.traceEvents().length === 0)
    for (const listener of coreListeners) {
      listener([{ type: 'turn.start', turn: 1, origin: 'user', time: 1 }, { type: 'step.start', turn: 1, step: 1 }], { replay: false })
    }
    check('compose: fold reports supported once events flow', sourceOf(plain) === 'supported')
    check('compose: folded raw events are readable', plain.traceEvents().length > 0)
    plain.releaseContributions()
    // 'unsupported' remains the structural report of a composition that
    // mounted no source at all; sections 2-3 drive it through explicit
    // reports, the way a source-less composition would publish it.

    // A raw agent is wrapped as a DSH session (channel.ts), so the DSH
    // extension attaches and the source report flips to empty/supported.
    const agent = {
      id: 'src-agent',
      status: 'idle',
      session: { id: 'src-session', seq: 0, events: [] as Record<string, unknown>[] },
      ctx: { on: () => () => undefined },
      followup() {}, steer() {}, cancel() {},
      inbox: { remove: () => true },
    }
    const dsh = createChannel(ctx, agent as never, { model: 'm', provider: '', cwd: '/tmp', activity: false })
    check('compose: DSH extension reports empty before the first event', sourceOf(dsh) === 'empty')
    agent.session.events.push({ type: 'turn/start', turn: 1, origin: 'user', time: 1 })
    check('compose: DSH extension reports supported once events exist', sourceOf(dsh) === 'supported')
    dsh.releaseContributions()
  }

  // ── 2. panel display states ───────────────────────────────────────────────
  const panelProps = { width: 44, height: 20, focused: true, visible: true, trajectory: undefined as undefined | ReturnType<typeof buildTrajectory> }
  let panelSource: string | undefined = 'unsupported'
  let panelBackendId: string | undefined = undefined
  // The panel registers its keys through the runtime dispatcher
  // (usePanelInput → runtime.registerInput): a stub with the same shape the
  // v2.1 contract documents (see verify-trajectory-panel's harness).
  const panelRuntime = {
    registerInput(id: string, handler: (input: string, key: Record<string, boolean | undefined>) => boolean | void, enabled: boolean) {
      registeredPanelHandlers.set(id, { handler, enabled })
      return () => { registeredPanelHandlers.delete(id) }
    },
  }
  const registeredPanelHandlers = new Map<string, { handler: (input: string, key: Record<string, boolean | undefined>) => boolean | void; enabled: boolean }>()
  function PanelHarness(): React.ReactNode {
    // stdin keeper: without a useInput consumer ink never reads stdin, and
    // the mount is not a faithful panel form.
    useInput(() => {}, { isActive: true })
    const channel = {
      sessionTitle: 'probe',
      cwd: 'C:/code/demo',
      traceEvents: () => [],
      ...(panelSource === undefined ? {} : { trajectorySource: () => panelSource }),
      ...(panelBackendId === undefined ? {} : { backendCapabilities: { backendId: panelBackendId, backendLabel: panelBackendId, commands: [] } }),
      subscribe: () => () => {},
    }
    return (
      <SidePanelRuntimeContext.Provider value={{ runtime: panelRuntime as never, channel: channel as never, trajectory: panelProps.trajectory }}>
        <PanelContext.Provider value={{ panelId: 'trajectory' }}>
          <Box width={panelProps.width} height={panelProps.height}>
            <TrajectoryPanel width={panelProps.width} height={panelProps.height} focused={panelProps.focused} visible={panelProps.visible} mode="split" />
          </Box>
        </PanelContext.Provider>
      </SidePanelRuntimeContext.Provider>
    )
  }
  const mountPanel = async (): Promise<ReturnType<typeof makeTerminalHarness>> => {
    const h = makeTerminalHarness(50, 22)
    const app = await render(<ThemeProvider theme="dark"><PanelHarness /></ThemeProvider>, {
      stdout: h.stdout as unknown as NodeJS.WriteStream,
      stdin: h.stdin as unknown as NodeJS.ReadStream,
      stderr: h.stderr as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    ;(h as unknown as { app: typeof app }).app = app
    return h
  }

  {
    panelSource = 'unsupported'; panelBackendId = undefined; panelProps.trajectory = undefined
    const h = await mountPanel()
    check('panel/unsupported: honest copy renders (generic backend)', await settled(() => h.screen().includes(head(t('trajectory-unsupported')))))
    check('panel/unsupported: no first-message promise', !h.screen().includes(t('panel-trajectory-empty')))
    check('panel/unsupported: no ⤢ hint line', !h.screen().includes(t('panel-trajectory-hint')))
    check('panel/unsupported: explains the disabled outlet', h.screen().includes(t('trajectory-unsupported-fullscreen').replace('⤢ ', '').slice(0, 24)))
    ;(h as unknown as { app: { unmount(): Promise<void> } }).app.unmount(); h.term.dispose()
  }
  {
    panelSource = 'unsupported'; panelBackendId = 'claude'; panelProps.trajectory = undefined
    const h = await mountPanel()
    check('panel/unsupported-claude: claude-worded line renders', await settled(() => h.screen().includes(head(t('trajectory-unsupported-claude')))))
    check('panel/unsupported-claude: still no first-message promise', !h.screen().includes(t('panel-trajectory-empty')))
    ;(h as unknown as { app: { unmount(): Promise<void> } }).app.unmount(); h.term.dispose()
  }
  {
    panelSource = 'empty'; panelBackendId = undefined; panelProps.trajectory = undefined
    const h = await mountPanel()
    check('panel/supported-empty: existing empty copy kept', await settled(() => h.screen().includes(head(t('panel-trajectory-empty')))))
    check('panel/supported-empty: no unsupported copy', !h.screen().includes(t('trajectory-unsupported')))
    ;(h as unknown as { app: { unmount(): Promise<void> } }).app.unmount(); h.term.dispose()
  }
  {
    panelSource = 'supported'; panelBackendId = undefined; panelProps.trajectory = buildTrajectory(DSH_EVENTS as never)
    const h = await mountPanel()
    check('panel/supported: ledger rows render', await settled(() => h.screen().includes('read_file')))
    ;(h as unknown as { app: { unmount(): Promise<void> } }).app.unmount(); h.term.dispose()
  }

  // ── 3. scene display states ───────────────────────────────────────────────
  {
    let closed = false
    const h = makeTerminalHarness(90, 24)
    const channel = { sessionTitle: 'scene probe', cwd: 'C:/code/demo', traceEvents: () => [], trajectorySource: () => 'unsupported', subscribe: () => () => {} }
    const app = await render(
      <ThemeProvider theme="dark">
        <TrajectoryScene channel={channel as never} build={buildTrajectory([] as never)} onClose={() => { closed = true }} />
      </ThemeProvider>,
      { stdout: h.stdout as unknown as NodeJS.WriteStream, stdin: h.stdin as unknown as NodeJS.ReadStream, stderr: h.stderr as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
    )
    check('scene/unsupported: honest copy renders', await settled(() => h.screen().includes(t('trajectory-unsupported'))))
    check('scene/unsupported: no first-message promise copy', !h.screen().includes(t('panel-trajectory-empty')))
    await writeKey(h.stdin, 'q')
    check('scene/unsupported: q still exits', await settled(() => closed))
    await app.unmount(); h.term.dispose()
  }
  {
    // supported-empty keeps the golden scene chrome (DSH regression lock).
    const h = makeTerminalHarness(90, 24)
    const channel = { sessionTitle: 'scene probe', cwd: 'C:/code/demo', traceEvents: () => [], subscribe: () => () => {} }
    const app = await render(
      <ThemeProvider theme="dark">
        <TrajectoryScene channel={channel as never} build={buildTrajectory([] as never)} onClose={() => {}} />
      </ThemeProvider>,
      { stdout: h.stdout as unknown as NodeJS.WriteStream, stdin: h.stdin as unknown as NodeJS.ReadStream, stderr: h.stderr as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
    )
    check('scene/supported-empty: title chrome renders (golden)', await settled(() => h.screen().includes(t('traj-title'))))
    check('scene/supported-empty: no unsupported copy (golden)', !h.screen().includes(t('trajectory-unsupported')))
    await app.unmount(); h.term.dispose()
  }

  // ── 4. /trace + Ctrl+T entries over a REAL core channel (fold mounted) ──
  {
    const listeners = new Set<(batch: readonly unknown[], meta: unknown) => void>()
    const session = {
      ref: { backendId: 'fake', sessionId: '55555555-5555-4555-8555-555555555555' },
      cwd: process.cwd(),
      status: 'idle',
      capabilities: { native: {} },
      history: () => Promise.resolve([]),
      subscribe(listener: (batch: readonly unknown[], meta: unknown) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      submit: () => Promise.resolve({ accepted: true }),
      removePending: () => false,
      cancel: () => Promise.resolve({ stillQueued: [] }),
      dispose: () => Promise.resolve(),
    }
    const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
    const channel = createChannel(ctx, session as never, { model: 'm', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' })
    const toasts = (): string => channel.notifications.map(item => item.text).join(' | ')
    const h = makeTerminalHarness(100, 30)
    const app = await render(
      React.createElement(Chat, {
        channel: channel as never,
        questionStore: new QuestionStore() as never,
        approvalStore: new ApprovalStore() as never,
        onExit: () => undefined,
        fullscreen: false,
        trajectorySeen: true,
      }),
      { stdout: h.stdout as unknown as NodeJS.WriteStream, stdin: h.stdin as unknown as NodeJS.ReadStream, stderr: h.stderr as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
    )
    check('entries: /trace is offered on the fold-backed backend', channel.commandList.some(command => command.name === 'trace'))
    await sleep(300) // 固定窗:pacing Chat 的按键处理器在首帧后才挂载
    // /trace entry
    for (const char of '/trace') h.stdin.write(char)
    await sleep(120) // 固定窗:pacing 输入按自身渲染 tick 应用，回车须另起一个 stdin chunk
    await writeKey(h.stdin, '\r')
    check('entries//trace: opens the scene in the empty state (fold mounted)', await settled(() => h.screen().includes(t('traj-title')) && !h.screen().includes(t('trajectory-unsupported'))))
    check('entries//trace: no capability notice', !toasts().includes(t('capability-unavailable-backend', { name: 'trace' })), toasts())
    check('entries//trace: no unavailable-command notice', !toasts().includes(t('cmd-unavailable-backend', { cmd: 'trace', backend: 'Fake Agent' })), toasts())
    await writeKey(h.stdin, 'q')
    check('entries//trace: q returns to the conversation', await settled(() => !h.screen().includes(t('traj-title'))))
    // Ctrl+T entry — now over a session with folded events: the scene must
    // render the LEDGER (the Claude mapping's whole point), not chrome.
    for (const listener of listeners) {
      listener([
        { type: 'turn.start', turn: 1, origin: 'user', time: 1_000 },
        { type: 'step.start', turn: 1, step: 1 },
        { type: 'tool.call', seq: 3, anchor: 'c1', turn: 1, step: 1, callId: 'c1', name: 'Grep', argsJson: '{"q":"states"}', time: 1_100 },
        { type: 'tool.result', seq: 4, turn: 1, step: 1, callId: 'c1', isError: false, time: 1_200, content: [{ type: 'text', text: 'hit' }], text: 'hit' },
      ], { replay: false })
    }
    await writeKey(h.stdin, '\x14')
    check('entries/Ctrl+T: folded ledger rows render over live events', await settled(() => h.screen().includes('Grep')), h.screen().split('\n').slice(0, 6).join(' / '))
    check('entries/Ctrl+T: no capability notice', !toasts().includes(t('capability-unavailable-backend', { name: 'trace' })), toasts())
    await writeKey(h.stdin, 'q')
    check('entries/Ctrl+T: q returns to the conversation', await settled(() => !h.screen().includes(t('traj-title'))))
    await app.unmount()
    channel.releaseContributions()
    h.term.dispose()
  }

  // ── 5. sidebar tab + ⤢ outlet (SidePanelColumn) ──────────────────────────
  {
    const [{ SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, prefs] = await Promise.all([
      import('../src/components/sidePanel/SidePanelLayout.js'),
      import('../src/components/sidePanel/SidePanelColumn.js'),
      import('../src/components/sidePanel/useSidePanel.js'),
      import('../src/tuiDisplayPrefs.js'),
    ])
    const { applySidePanelOpen, applySidePanelPanels, applySidePanelRatio } = prefs
    const COLS = 120
    const ROWS = 30
    let source: string | undefined = 'unsupported'
    function ColumnHarness(): React.ReactNode {
      const sp = useSidePanel({ columns: COLS, fullscreen: true, editorOpen: false })
      useInput(() => {}, { isActive: true })
      const channel = {
        version: 0, rows: [], status: 'idle', working: false, todos: [], subagents: [], goal: undefined,
        displayCwd: '/tmp/demo', gitBranch: 'main', sessionTitle: 'states',
        sessionId: 'abcd1234-5678-90ab-cdef-1234567890ab', agentId: 'states-agent',
        model: 'deepseek-chat-v4', reasoningEffort: 'high', mode: { plan: false },
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextSegments: [], contextWindow: 128_000,
        lastUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        tps: undefined, tpsSamples: [],
        subscribe() { return () => {} },
        notify() {},
        traceEvents: () => [],
        ...(source === undefined ? {} : { trajectorySource: () => source }),
      }
      return (
        <SidePanelLayout geometry={sp.geometry} focus={sp.focus}
          side={<SidePanelColumn width={sp.panelColumns} controller={sp} channel={channel as never} onExpand={() => {}} />}>
          <Box flexDirection="column"><Text>{'chat-body'}</Text></Box>
        </SidePanelLayout>
      )
    }
    const mountColumn = async (): Promise<{ h: ReturnType<typeof makeTerminalHarness>; app: Awaited<ReturnType<typeof render>> }> => {
      const h = makeTerminalHarness(COLS, ROWS)
      const app = await render(<AlternateScreen><ThemeProvider theme="dark"><ColumnHarness /></ThemeProvider></AlternateScreen>, {
        stdout: h.stdout as unknown as NodeJS.WriteStream,
        stdin: h.stdin as unknown as NodeJS.ReadStream,
        stderr: h.stderr as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
      })
      return { h, app }
    }
    const barRow = (h: ReturnType<typeof makeTerminalHarness>): string => (h.lines()[0] ?? '').slice(Math.floor(COLS * 0.6))
    const findText = (h: ReturnType<typeof makeTerminalHarness>, s: string): { col: number; row: number } | null => {
      const ls = h.lines()
      for (let row = 0; row < ls.length; row++) {
        const col = ls[row]!.indexOf(s)
        if (col >= 0) return { col, row }
      }
      return null
    }
    const click = (h: ReturnType<typeof makeTerminalHarness>, c: number, r: number) => {
      h.stdin.write('\x1b[<0;' + (c + 1) + ';' + (r + 1) + 'M')
      h.stdin.write('\x1b[<0;' + (c + 1) + ';' + (r + 1) + 'm')
    }

    applySidePanelRatio(0.68)
    applySidePanelPanels('todo,trajectory')
    applySidePanelOpen(true)

    source = 'unsupported'
    {
      const { h, app } = await mountColumn()
      check('tab: the inactive trajectory title is represented by a dot', await settled(() => barRow(h).includes('○') && barRow(h).includes('◀') && barRow(h).includes('▶')), barRow(h).trim())
      const tab = findText(h, '○')
      if (tab !== null) click(h, tab.col + 1, tab.row)
      check('tab: clicking the trajectory dot centers its title', await settled(() => barRow(h).includes('Trajectory') && !barRow(h).includes('Todo')), barRow(h).trim())
      check('tab: honest generic unsupported copy remains in the panel', await settled(() => h.screen().includes(head(t('trajectory-unsupported')))))
      check('outlet/unsupported: ⤢ stays hidden while carousel navigation remains', !barRow(h).includes('⤢') && barRow(h).includes('Trajectory') && barRow(h).includes('◀') && barRow(h).includes('▶'), barRow(h).trim())
      await app.unmount(); h.term.dispose()
    }
    source = 'supported'
    {
      const { h, app } = await mountColumn()
      // 固定窗:pacing 两次用例在完全相同的坐标点击 ∿——必须跨过 ink 的
      // 500ms 双击窗，否则第二次点击被当作 double-click 吞掉（面板不切换）。
      await sleep(600)
      const tab = findText(h, '○')
      if (tab !== null) click(h, tab.col + 1, tab.row)
      check('outlet/supported: trajectory dot centers the title', await settled(() => barRow(h).includes('Trajectory') && !barRow(h).includes('Todo')), barRow(h).trim())
      check('outlet/supported: ⤢ stays beside the carousel', await settled(() => barRow(h).includes('⤢') && barRow(h).includes('◀') && barRow(h).includes('▶')), barRow(h).trim())
      await app.unmount(); h.term.dispose()
    }
    // Restore the in-process defaults so later harnesses in the same process
    // (none today, but the script may grow) start from the user defaults.
    applySidePanelOpen(false)
    applySidePanelPanels('todo,jobs,agents')
  }
} finally {
  // (每个用例段自己 unmount；这里没有共享 app。)
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: trajectory source states all checks passed.')
process.exit(0)
