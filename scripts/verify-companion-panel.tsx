/**
 * Companion panel regression. Two layers:
 *
 * UNIT (no render): mood.ts smoothing pipeline + deepy.ts mapping tables.
 *  - all 20 kit animations are wired (mood/context/interaction/reaction/rotation);
 *  - context derivation: subagent/session counts -> music/conducting/building,
 *    compaction -> compacting (fake channel objects);
 *  - smoother timelines (anti-flicker rules):
 *      a) 200ms working<->idle jitter for 3s -> displayed stays 'typing';
 *      b) attention preempts within one step;
 *      c) tools stop -> typing held LEAVE_WORKING_SETTLE_MS then idle;
 *      d) same-mood re-derivation never resets the animation anchor;
 *      e) turn done -> 'happy' for ~CELEBRATE_DWELL_MS then back;
 *      f) idle rotation advances on the clock, not on signal edges;
 *  - notification tracker: first call silent, appends emit, rebuild-safe,
 *    silent option swallows backlog on visibility regain.
 *
 * RENDER (AlternateScreen fixture, xterm headless): mounts the REAL
 * SidePanelLayout/Column + useSidePanel controller with a fake channel.
 *  - bottom-anchored pet: art lives in the lowest panel rows, status block on
 *    top (mood + stats, now-playing with the kit title, interaction hint);
 *  - interactions through the REAL stdin path: SGR click on the pet's left /
 *    right half -> poke-left / poke-right; 3 rapid clicks -> tickle; drag
 *    sequence (motion 32) -> drag, release restores; mode-1003 motion (35)
 *    over the panel -> idle-look, over the pet -> idle-spout, leaving the
 *    panel restores the rotation;
 *  - notification bubbles: newest spoken by the pet in a rounded bubble above
 *    the art, error color swaps the pet to the error animation, a second push
 *    displaces the first, ~NOTIFICATION_BUBBLE_MS auto-dismiss, pushes while
 *    visible=false never replay;
 *  - activity narration bubble: while a turn runs the pet speaks the ⏵
 *    working line verbatim (runtimeCtx.activity.line, the same source the
 *    chat ActivityLine renders), text swaps follow live, a transient
 *    notification overrides and the narration returns after its expiry, and
 *    turn end collapses it;
 *  - Enter with the panel focused still shows the FULL activity.line;
 *  - whale skin fallback: click still arms the heart pass (WhaleSkin render
 *    probe — the deepy path no longer goes through DeepySkin.render, its
 *    clicks are asserted via the now-playing title instead);
 *  - narrow panel: compact form (no art) + hint row; ultra-narrow (below
 *    half the compact threshold) shows only the centered hiding slogan
 *    (companion-cramped) — no pet body, no compact rows, width demand intact;
 *  - visible=false: zero ClockContext keepAlive subscriptions AND zero
 *    stdout writes while hidden; subagent counts / compaction / git-branch
 *    flash render through the context layer (conducting / compacting /
 *    carrying titles);
 *  - drag residue: dragging across the status rows leaves no frozen stale
 *    cells above the held pet (liveness discriminator) and the swept region
 *    restores byte-identical after the release flyback (timer row exempt);
 *    left/right saturation pins the pet BOX flush to the panel borders
 *    (air-wall regression — multi-frame widest sampling, residual ≤ pose
 *    transparency margin);
 *  - left-column zero diff (design doc §16.6) across 50 channel bumps.
 *
 * Run: node --import tsx/esm scripts/verify-companion-panel.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { SidePanelRuntimeContext }, { useSidePanel }, prefs, { panelStore }, { ClockContext }, skins, { CompanionPanel }, mood, deepy, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/SidePanelRuntimeContext.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/components/sidePanel/PanelStore.js'),
  import('../src/ink/components/ClockContext.js'),
  import('../src/components/sidePanel/companion/skins.js'),
  import('../src/components/sidePanel/companion/CompanionPanel.js'),
  import('../src/components/sidePanel/companion/mood.js'),
  import('../src/components/sidePanel/companion/deepy.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput } = ui
const { applySidePanelOpen, applySidePanelRatio, applySidePanelPanels, applyCompanionSkin } = prefs
const { settled, sleep } = termTest
const { WhaleSkin } = skins
const {
  CELEBRATE_DWELL_MS, HOVER_ENTER_DWELL_MS, HOVER_LEAVE_SETTLE_MS, IDLE_ROTATE_MS,
  LEAVE_WORKING_SETTLE_MS, MIN_MOOD_DWELL_MS,
  NOTIFICATION_BUBBLE_MS, POKE_MS, TICKLE_WINDOW_MS,
  countRunningSubagents, countSessionsRunning, createNotificationTracker, deriveCompanionContext,
  idleRotationIndex, initialCompanionDisplayState, initialCompanionHoverState,
  notificationReactionKind, resolveTargetSemantic,
  stepCompanionDisplay, stepCompanionHover, stepNotificationTracker,
} = mood
const { DEEPY_CONTEXT_ANIMATION, DEEPY_IDLE_ROTATION, DEEPY_INTERACTION_ANIMATION,
  DEEPY_MOOD_ANIMATION, DEEPY_NOTIFICATION_REACTION, loadDeepyKit } = deepy

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// ============================ UNIT LAYER =================================

// --- all 20 animations wired ----------------------------------------------
const kit = loadDeepyKit()
check('unit: deepy kit loads (20 animations)', kit !== undefined && Object.keys(kit?.byKey ?? {}).length === 20,
  'keys=' + Object.keys(kit?.byKey ?? {}).length)
if (kit !== undefined) {
  const mapped = new Set<string>([
    ...Object.values(DEEPY_MOOD_ANIMATION),
    ...Object.values(deepy.DEEPY_SEMANTIC_ANIMATION),
    ...Object.values(DEEPY_CONTEXT_ANIMATION),
    ...Object.values(DEEPY_INTERACTION_ANIMATION),
    ...Object.values(DEEPY_NOTIFICATION_REACTION),
    ...DEEPY_IDLE_ROTATION,
  ])
  const missing = Object.keys(kit.byKey).filter(key => !mapped.has(key))
  check('unit: every kit animation is reachable (mood/context/interaction/reaction/rotation)', missing.length === 0, 'missing=' + missing.join(','))
  check('unit: deepyAnimationFor maps context + interaction semantics', deepy.deepyAnimationFor('conducting') === 'conducting' && deepy.deepyAnimationFor('look') === 'idle-look' && deepy.deepyAnimationFor('nope') === 'idle')
}

// --- context derivation ----------------------------------------------------
const sub = (status: string): { status: string } => ({ status })
check('unit: 1 running subagent -> music', deriveCompanionContext({ working: false, subagents: [sub('running')], backgroundJobs: [], compaction: undefined }) === 'music')
check('unit: working + 1 subagent (2 sessions) -> music', deriveCompanionContext({ working: true, subagents: [sub('running')], backgroundJobs: [], compaction: undefined }) === 'music')
check('unit: 2 subagents -> conducting', deriveCompanionContext({ working: true, subagents: [sub('starting'), sub('running')], backgroundJobs: [], compaction: undefined }) === 'conducting')
check('unit: working + 2 running jobs (3 sessions) -> building', deriveCompanionContext({ working: true, subagents: [], backgroundJobs: [sub('running'), sub('stopping')], compaction: undefined }) === 'building')
check('unit: compaction in flight -> compacting (beats counts)', deriveCompanionContext({ working: true, subagents: [sub('running'), sub('running')], backgroundJobs: [], compaction: { phase: 'prefill' } }) === 'compacting')
check('unit: settled jobs do not count', countRunningSubagents([sub('completed'), sub('failed'), sub('cancelled')]) === 0 && countSessionsRunning(false, 0, 0) === 0)

// --- smoother timelines (rules 2-4) ---------------------------------------
{
  const T0 = 1_000_000
  // a) 200ms working<->idle jitter for 3s: display must never leave 'typing'.
  let state = initialCompanionDisplayState
  state = stepCompanionDisplay(state, 'typing', T0)
  const seen = new Set<string>([state.semantic])
  let jitterClean = true
  for (let t = T0 + 200; t <= T0 + 3000; t += 200) {
    const target = ((t - T0) / 200) % 2 === 1 ? 'idle' : 'typing'
    state = stepCompanionDisplay(state, target, t)
    seen.add(state.semantic)
    if (state.semantic !== 'typing') { jitterClean = false; break }
  }
  check('unit a) 200ms working<->idle jitter keeps display === typing for 3s', jitterClean, 'seen=' + [...seen].join('|'))
  // ...and after the last idle target holds, settle flips it once.
  state = stepCompanionDisplay(state, 'idle', T0 + 3000 + LEAVE_WORKING_SETTLE_MS + 100)
  check('unit c) settle window elapses -> display switches to idle', state.semantic === 'idle')

  // b) attention preempts within one step (no dwell wait).
  let s2 = stepCompanionDisplay(initialCompanionDisplayState, 'typing', T0)
  s2 = stepCompanionDisplay(s2, 'notification', T0 + 100)
  check('unit b) attention preempts immediately', s2.semantic === 'notification' && s2.since === T0 + 100)
  s2 = stepCompanionDisplay(s2, 'error', T0 + 150)
  check('unit b) error preempts immediately too', s2.semantic === 'error')

  // c-bis) tools just stopped: typing held until settle, not before.
  let s3 = stepCompanionDisplay(initialCompanionDisplayState, 'typing', T0)
  s3 = stepCompanionDisplay(s3, 'idle', T0 + 50)
  check('unit c) fresh non-working target holds typing', s3.semantic === 'typing')
  s3 = stepCompanionDisplay(s3, 'idle', T0 + 50 + LEAVE_WORKING_SETTLE_MS - 10)
  check('unit c) still typing just before the settle boundary', s3.semantic === 'typing')
  s3 = stepCompanionDisplay(s3, 'idle', T0 + 50 + LEAVE_WORKING_SETTLE_MS + 10)
  check('unit c) switches to idle just after the settle boundary', s3.semantic === 'idle')

  // d) same-mood re-derivation keeps the anchor (no frame reset).
  let s4 = stepCompanionDisplay(initialCompanionDisplayState, 'typing', T0)
  for (let t = T0 + 160; t <= T0 + 5000; t += 160) s4 = stepCompanionDisplay(s4, 'typing', t)
  check('unit d) same-mood re-derivation never resets the animation anchor', s4.since === T0)

  // e) celebrate: immediate on the turn-done edge, dwells ~CELEBRATE_DWELL_MS.
  let s5 = stepCompanionDisplay(initialCompanionDisplayState, 'typing', T0)
  s5 = stepCompanionDisplay(s5, 'happy', T0 + 100)
  check('unit e) happy switches immediately on turn completion', s5.semantic === 'happy' && s5.since === T0 + 100)
  s5 = stepCompanionDisplay(s5, 'happy', T0 + 100 + CELEBRATE_DWELL_MS - 200)
  check('unit e) happy still showing inside its dwell', s5.semantic === 'happy')
  s5 = stepCompanionDisplay(s5, 'idle', T0 + 100 + CELEBRATE_DWELL_MS + 200)
  check('unit e) back to the smoothed mood after the dwell', s5.semantic === 'idle')

  // dwell gate: plain switch before MIN_MOOD_DWELL_MS is refused.
  let s6 = stepCompanionDisplay(initialCompanionDisplayState, 'notification', T0)
  s6 = stepCompanionDisplay(s6, 'idle', T0 + 50)
  check('unit 4) non-preemptive switch waits MIN_MOOD_DWELL_MS', s6.semantic === 'notification')
  s6 = stepCompanionDisplay(s6, 'idle', T0 + LEAVE_WORKING_SETTLE_MS + 50)
  check('unit 4) ...and passes once both gates open', s6.semantic === 'idle')

  // realign skips the gates.
  const s7 = stepCompanionDisplay(s6, 'typing', T0 + MIN_MOOD_DWELL_MS + 60, { realign: true })
  check('unit: realign (visible=false -> true) skips the gates', s7.semantic === 'typing')

  // target semantic wiring: attention/error/happy pass through, context rides working+idle.
  check('unit: resolveTargetSemantic priority + context',
    resolveTargetSemantic('attention', 'music') === 'notification' &&
    resolveTargetSemantic('error', 'music') === 'error' &&
    resolveTargetSemantic('working', 'music') === 'music' &&
    resolveTargetSemantic('responding', undefined) === 'typing' &&
    resolveTargetSemantic('idle', 'conducting') === 'conducting' &&
    resolveTargetSemantic('sleeping', undefined) === 'sleeping')

  // f) idle rotation advances on the clock only.
  const idx0 = idleRotationIndex(T0, T0 + 100, 4)
  const idx1 = idleRotationIndex(T0, T0 + IDLE_ROTATE_MS + 100, 4)
  const idx2 = idleRotationIndex(T0, T0 + 2 * IDLE_ROTATE_MS + 100, 4)
  check('unit f) idle rotation advances with time', idx0 !== idx1 && idx1 !== idx2, idx0 + '/' + idx1 + '/' + idx2)
  check('unit f) idle rotation is signal-independent (same clock, same answer)', idleRotationIndex(T0, T0 + IDLE_ROTATE_MS + 100, 4) === idx1)
}

// --- hover dwell (enter 驻留 / leave 迟滞，2026-10-03 悬停变脸修复) --------
{
  check('unit: hover dwell constants pinned (400 enter / 800 leave)',
    HOVER_ENTER_DWELL_MS === 400 && HOVER_LEAVE_SETTLE_MS === 800,
    HOVER_ENTER_DWELL_MS + '/' + HOVER_LEAVE_SETTLE_MS)
  const T0 = 5_000_000
  // enter dwell：未满窗不换脸；满窗即切，since 锚定切换时刻（动画从头播）。
  let s = stepCompanionHover(initialCompanionHoverState, 'look', T0)
  check('unit: hover enter keeps the prior animation before the dwell window',
    stepCompanionHover(s, 'look', T0 + HOVER_ENTER_DWELL_MS - 1).semantic === undefined)
  const entered = stepCompanionHover(s, 'look', T0 + HOVER_ENTER_DWELL_MS)
  check('unit: hover enter switches exactly at the dwell window',
    entered.semantic === 'look' && entered.since === T0 + HOVER_ENTER_DWELL_MS)
  // 快速划过：enter 未满窗就移开 → 全程未切换。
  let q = stepCompanionHover(initialCompanionHoverState, 'look', T0)
  q = stepCompanionHover(q, undefined, T0 + HOVER_ENTER_DWELL_MS - 200)
  check('unit: quick hover pass-through never switches', q.semantic === undefined)
  // leave settle：移开未满窗保持悬停动画、满窗切回；窗内折返无缝续播。
  let l = stepCompanionHover(entered, undefined, T0 + 1000)
  check('unit: hover leave holds the animation inside the settle window',
    stepCompanionHover(l, undefined, T0 + 1000 + HOVER_LEAVE_SETTLE_MS - 1).semantic === 'look')
  check('unit: hover leave restores exactly at the settle window',
    stepCompanionHover(l, undefined, T0 + 1000 + HOVER_LEAVE_SETTLE_MS).semantic === undefined)
  const back = stepCompanionHover(l, 'look', T0 + 1000 + HOVER_LEAVE_SETTLE_MS - 300)
  check('unit: re-entry inside the settle window resumes seamlessly (anchor kept)',
    back.semantic === 'look' && back.since === entered.since)
  // 换档（look→notice）同样要驻留满窗。
  const n = stepCompanionHover(entered, 'notice', T0 + 2000)
  check('unit: zone change look->notice waits for the dwell window',
    stepCompanionHover(n, 'notice', T0 + 2000 + HOVER_ENTER_DWELL_MS - 1).semantic === 'look')
  check('unit: zone change switches once the dwell window fills',
    stepCompanionHover(n, 'notice', T0 + 2000 + HOVER_ENTER_DWELL_MS).semantic === 'notice')
}

// --- notification tracker ---------------------------------------------------
{
  const tracker = createNotificationTracker()
  const a = { text: 'A' }
  const b = { text: 'B' }
  check('unit: first tracker call is silent (no history replay)', stepNotificationTracker(tracker, [a]) === undefined)
  check('unit: appended item emits', stepNotificationTracker(tracker, [a, b])?.text === 'B')
  check('unit: no emission without new items', stepNotificationTracker(tracker, [a, b]) === undefined)
  const rebuilt = [a, b] // same item objects, new array identity
  check('unit: rebuilt array with same items does not re-emit', stepNotificationTracker(tracker, rebuilt) === undefined)
  const c = { text: 'C', color: 'error' }
  check('unit: silent option swallows the backlog (visibility regain)', stepNotificationTracker(tracker, [a, b, c], { silent: true }) === undefined)
  check('unit: ...and the swallowed items never come back', stepNotificationTracker(tracker, [a, b, c]) === undefined)
  const d = { text: 'D' }
  check('unit: later appends still emit', stepNotificationTracker(tracker, [a, b, c, d])?.text === 'D')
  check('unit: reaction kinds follow color', notificationReactionKind('error') === 'error' && notificationReactionKind('success') === 'success' && notificationReactionKind('warning') === 'warning' && notificationReactionKind(undefined) === 'default')
}

// ============================ RENDER LAYER ================================

// --- fake channel + activity -----------------------------------------------
let channelVersion = 0
const channelListeners = new Set<() => void>()
const fakeChannel: Record<string, unknown> = {
  get version() { return channelVersion },
  working: true,
  spinnerMode: 'tool-use' as string,
  goal: undefined,
  todos: [] as unknown[],
  backgroundJobs: [] as unknown[],
  subagents: [] as unknown[],
  notifications: [] as Array<{ text: string; color?: string }>,
  compaction: undefined as unknown,
  gitBranch: undefined as string | undefined,
  notify(text: string) { (fakeChannel.notifications as Array<{ text: string }>).push({ text }) },
  subscribe(listener: () => void) {
    channelListeners.add(listener)
    return () => { channelListeners.delete(listener) }
  },
}
function bumpChannel(): void {
  channelVersion += 1
  for (const listener of [...channelListeners]) listener()
}
const NOW = Date.now()
const fakeActivity = {
  phase: 'tool' as const,
  line: '正在统计 42 项 心跳探针POKE-MARK',
  live: true,
  label: '统计',
  detail: '42 项',
  phrase: '⏵ 正在统计条目',
  toolCount: 3,
  phaseStartedAt: NOW - 8200,
  turnStartedAt: NOW - 30000,
  updatedAt: NOW,
  lang: 'zh' as const,
}

class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

interface Scene {
  app: { unmount: () => Promise<unknown> }
  term: import('@xterm/headless').Terminal
  stdin: FakeStdin
  controller: { openPanel: (id: string, opts?: { focus?: boolean }) => void } | undefined
  lines: () => string[]
  writes: { count: number }
}

async function scene(cols: number, rows: number, activity: unknown, attention: unknown, panels: string): Promise<Scene> {
  applySidePanelPanels(panels)
  applySidePanelOpen(true)
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  const writes = { count: 0 }
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    term: import('@xterm/headless').Terminal
    constructor(t: import('@xterm/headless').Terminal) { super(); this.term = t }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _write(chunk: any, _e: BufferEncoding, cb: () => void) { writes.count += 1; this.term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: Buffer.Encoding, cb: () => void) { cb() } }
  const stdin = new FakeStdin()
  let controller: Scene['controller'] = undefined
  function Harness(): React.ReactNode {
    const sp = useSidePanel({ columns: cols, fullscreen: true, editorOpen: false })
    const [, setV] = React.useState(0)
    controller = sp
    React.useEffect(
      () => (fakeChannel.subscribe as (listener: () => void) => () => void)(() => setV(previous => previous + 1)),
      [],
    )
    // 没有任何 useInput 消费者时 App 不挂 stdin 监听，注入的鼠标/按键会
    // 静默丢失（verify-jobs-transcript-group 的坑）——这里照 Chat 挂一层。
    useInput((input: string, key: Record<string, boolean | undefined>) => {
      const flags = { ...key, return_: key.return_ ?? ((key as Record<string, unknown>).return === true ? true : undefined) }
      sp.handleKey(input, flags as never)
      setV(previous => previous + 1)
    })
    return (
      <SidePanelLayout
        geometry={sp.geometry}
        focus={sp.focus}
        side={<SidePanelColumn width={sp.panelColumns} controller={sp} channel={fakeChannel as never} activity={activity as never} attention={attention as never} />}
      >
        <Box flexDirection="column" flexGrow={1}>
          <Text>{'聊天行甲：侧栏宠物不得扰动左栏 zero-diff'}</Text>
          <Text>{'chat-anchor v=0'}</Text>
          <Text>{'聊天行乙：第二行固定内容 0123456789 ABCDEFG'}</Text>
        </Box>
      </SidePanelLayout>
    )
  }
  const app = await render(
    <AlternateScreen mouseTracking={true}>
      <ThemeProvider theme="dark">
        <Box flexDirection="column" height={rows}><Harness /></Box>
      </ThemeProvider>
    </AlternateScreen>,
    {
      stdout: new FakeStdout(term) as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const lines = (): string[] => {
    const buf = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < rows; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(cols, ' '))
    return out
  }
  return { app, term, stdin, get controller() { return controller }, lines, writes }
}

const ART_RE = /[▀▄█▌▐]{6,}/
function artRows(lines: string[]): number[] {
  const rows: number[] = []
  for (let y = 0; y < lines.length; y += 1) if (ART_RE.test(lines[y]!)) rows.push(y)
  return rows
}
function findArtCell(lines: string[]): { col: number; row: number } | null {
  for (let y = 0; y < lines.length; y += 1) {
    const m = lines[y]!.match(ART_RE)
    if (m !== null && m.index !== undefined) return { col: m.index + 3, row: y }
  }
  return null
}
function artSpan(lines: string[], row: number): { start: number; end: number } | null {
  const m = lines[row]?.match(ART_RE)
  if (m === null || m.index === undefined) return null
  return { start: m.index, end: m.index + m[0].length - 1 }
}
/** 宠物本体的列范围：所有美术行里最宽的连块 run（动画姿势上下缘有空白行，
 *  单行 run 也可能只是鱼鳍——取最宽者近似本体）。 */
function widestArtSpan(lines: string[]): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null
  for (const row of artRows(lines)) {
    const span = artSpan(lines, row)
    if (span === null) continue
    if (best === null || span.end - span.start > best.end - best.start) best = span
  }
  return best
}
/** 左栏（divider 之前）文本：divider 列 = 每行最早出现的 │/├ 的最小列号。 */
function leftColumn(lines: string[], cols: number): string[] {
  let divider = cols
  for (const line of lines) {
    const idx = line.search(/[│├]/)
    if (idx >= 0 && idx < divider) divider = idx
  }
  return lines.map(line => line.slice(0, divider))
}
function sgr(button: number, col: number, row: number, release: boolean): string {
  return '\x1b[<' + button + ';' + (col + 1) + ';' + (row + 1) + (release ? 'm' : 'M')
}
function clickAt(s: Scene, col: number, row: number): void {
  s.stdin.write(sgr(0, col, row, false))
  s.stdin.write(sgr(0, col, row, true))
}
const NOW_PLAYING_PREFIX = '当前动作：'
function nowPlaying(lines: string[]): string {
  for (const line of lines) {
    const index = line.indexOf(NOW_PLAYING_PREFIX)
    if (index >= 0) return line.slice(index + NOW_PLAYING_PREFIX.length).trim()
  }
  return ''
}

try {
  // ================= scene A: wide 140x30, working, interactions =========
  applySidePanelRatio(0.55)
  applyCompanionSkin('deepy')
  fakeChannel.working = true
  fakeChannel.spinnerMode = 'tool-use'
  fakeChannel.subagents = []
  fakeChannel.backgroundJobs = []
  fakeChannel.compaction = undefined
  fakeChannel.gitBranch = undefined
  fakeChannel.notifications = []
  const a = await scene(140, 30, fakeActivity, { approvals: 0, questions: 0 }, 'todo,jobs,agents,companion')
  try {
    await settled(() => (a.lines()[0]?.match(/[○●]/g) ?? []).length === 3)
    check('enable: companion panel appears as an inactive carousel dot', (a.lines()[0]?.match(/[○●]/g) ?? []).length === 3)
    a.controller?.openPanel('companion', { focus: true })
    await settled(() => artRows(a.lines()).length > 0, { timeoutMs: 8000 })
    check('wide: deepy sprite frames render (half-block art rows)', artRows(a.lines()).length > 0)
    await settled(() => a.lines().some(l => l.includes('个工具')), { timeoutMs: 5000 })
    const statsLine = a.lines().find(l => l.includes('个工具')) ?? ''
    check('wide: working stats line carries the tool count', statsLine.includes('个工具') && statsLine.includes('3'), statsLine.trim())
    await settled(() => nowPlaying(a.lines()) === '敲代码', { timeoutMs: 5000 })
    check('wide: status block shows the now-playing title (敲代码)', nowPlaying(a.lines()) === '敲代码', nowPlaying(a.lines()))
    check('wide: interaction hint row rendered', a.lines().some(l => l.includes('点它戳一戳')))

    // --- bottom-anchored layout -----------------------------------------
    const rowsA = artRows(a.lines())
    check('layout: art rows found', rowsA.length >= 6, 'rows=' + rowsA.length)
    if (rowsA.length > 0) {
      const lowest = rowsA[rowsA.length - 1]!
      const highest = rowsA[0]!
      check('layout: pet is bottom-anchored (last art row within the bottom 4 screen rows)',
        lowest >= 30 - 4, 'lowest=' + lowest)
      check('layout: pet occupies the lower half (not floating mid-panel)', highest > 30 / 2, 'highest=' + highest)
      const titleRow = a.lines().findIndex(l => l.includes('当前动作：'))
      check('layout: status block sits above the pet', titleRow >= 0 && titleRow < highest, 'titleRow=' + titleRow + ' highestArt=' + highest)
    }

    // --- left column zero diff across ~50 render steps (§16.6) ----------
    const baseline = leftColumn(a.lines(), 140).map((line, i) => i === 1 ? '' : line) // 行1 是 chat anchor 行，恒定但按约定排除
    let drift: string | null = null
    for (let round = 0; round < 50; round += 1) {
      bumpChannel()
      await sleep(40) // 固定窗:pacing 等版本 bump 的重渲染落屏（左栏恒等断言在轮外逐轮比较）
      const left = leftColumn(a.lines(), 140)
      for (let i = 0; i < left.length; i += 1) {
        if (i === 1) continue
        if (left[i] !== baseline[i]) { drift = 'row ' + i + ': [' + baseline[i] + '] -> [' + left[i] + ']'; break }
      }
      if (drift !== null) break
    }
    check('left column: 50 working render steps keep chat rows byte-identical (§16.6)', drift === null, drift ?? '')
    // 本地动画 tick 生效：宠物区域帧在推进（两次采样不同）。
    const samplePet = (): string => artRows(a.lines()).map(r => a.lines()[r]!.slice(-70)).join('|')
    const pet1 = samplePet()
    await settled(() => samplePet() !== pet1, { timeoutMs: 3000 })
    check('anim: pet frames advance between ticks (local ticker works)', samplePet() !== pet1)

    // --- SGR click left/right half -> poke-left / poke-right ------------
    const cell = findArtCell(a.lines())
    check('click: art cell on screen', cell !== null)
    if (cell !== null) {
      const span = widestArtSpan(a.lines())
      check('click: art span measured', span !== null && span.end - span.start > 20,
        span === null ? 'null' : 'w=' + (span.end - span.start))
      if (span !== null) {
        clickAt(a, span.start + 3, cell.row)
        await settled(() => nowPlaying(a.lines()) === '戳左边', { timeoutMs: 4000 })
        check('click: left-half SGR click -> poke-left', nowPlaying(a.lines()) === '戳左边', nowPlaying(a.lines()))
        await settled(() => nowPlaying(a.lines()) === '敲代码', { timeoutMs: 5000 })
        check('click: poke reaction yields back to the smoothed mood', nowPlaying(a.lines()) === '敲代码', nowPlaying(a.lines()))
        await sleep(TICKLE_WINDOW_MS + 700) // 固定窗:墙钟 等上一轮点击滑出狂点窗口，避免污染 tickle 判定
        clickAt(a, span.end - 3, cell.row)
        await settled(() => nowPlaying(a.lines()) === '戳右边', { timeoutMs: 4000 })
        check('click: right-half SGR click -> poke-right', nowPlaying(a.lines()) === '戳右边', nowPlaying(a.lines()))
        await settled(() => nowPlaying(a.lines()) === '敲代码', { timeoutMs: 5000 })
        check('click: second poke yields back too', nowPlaying(a.lines()) === '敲代码')

        // --- 3 rapid clicks -> tickle ----------------------------------
        await sleep(TICKLE_WINDOW_MS + 700) // 固定窗:墙钟 清狂点窗口
        for (let i = 0; i < 3; i += 1) {
          clickAt(a, span.start + 5 + i * 3, cell.row)
          await sleep(120) // 固定窗:pacing 三连点保持在 900ms 窗口内
        }
        await settled(() => nowPlaying(a.lines()) === '被挠痒痒', { timeoutMs: 4000 })
        check('click: 3 rapid clicks -> tickle', nowPlaying(a.lines()) === '被挠痒痒', nowPlaying(a.lines()))
        await settled(() => nowPlaying(a.lines()) === '敲代码', { timeoutMs: 5000 })
        check('click: tickle window ends -> back to the smoothed mood', nowPlaying(a.lines()) === '敲代码')

        // --- drag sequence -> drag, release restores -------------------
        a.stdin.write(sgr(0, span.start + 10, cell.row, false))
        a.stdin.write(sgr(32, span.start + 16, cell.row - 1, false))
        await settled(() => nowPlaying(a.lines()) === '被拎起来', { timeoutMs: 4000 })
        check('drag: press + motion(32) -> drag animation', nowPlaying(a.lines()) === '被拎起来', nowPlaying(a.lines()))
        a.stdin.write(sgr(32, span.start + 24, cell.row - 2, false))
        a.stdin.write(sgr(0, span.start + 24, cell.row - 2, true))
        await settled(() => nowPlaying(a.lines()) === '敲代码', { timeoutMs: 5000 })
        check('drag: release restores the smoothed mood', nowPlaying(a.lines()) === '敲代码')

        // --- real drag: the BODY follows the pointer, release flies home --
        // 上一段拖动已松手：等弹回插值落定（PET_REBOUND_MS 量级）再取基线。
        await sleep(700) // 固定窗:墙钟 等上一段松手的弹回落定后再取 home 基线
        const panelColumnsA = ((a.controller as unknown as { panelColumns?: number } | undefined)?.panelColumns) ?? 62
        const panelLeftA = 140 - panelColumnsA
        // 宠物本体测量：所有美术行里半块连块 run 的联合包围盒（比「最宽单行
        // run」稳——姿势帧里单行 run 会左右漂；run 只认美术字符，宠物叠上
        // 状态区文字时也不把正文算进本体）。
        const petExtent = (lines: string[]): { start: number; end: number; top: number; bottom: number } | null => {
          const rows = artRows(lines)
          if (rows.length === 0) return null
          let start = 9999, end = -1
          for (const row of rows) {
            const runRe = /[▀▄█▌▐]{6,}/g
            const line = lines[row]!
            for (let m = runRe.exec(line); m !== null; m = runRe.exec(line)) {
              const at = m.index
              if (at < start) start = at
              if (at + m[0].length - 1 > end) end = at + m[0].length - 1
            }
          }
          if (end < 0) return null
          return { start, end, top: rows[0]!, bottom: rows[rows.length - 1]! }
        }
        const homeA = petExtent(a.lines())
        const titleRowA = a.lines().findIndex(l => l.includes('当前动作：'))
        const homeCenterA = homeA === null ? -99 : (homeA.start + homeA.end) / 2
        const expectCenterA = panelLeftA + Math.floor((panelColumnsA - 42) / 2) + 21
        check('drag-pos: pet rests at home (bottom-centered) before the drag',
          homeA !== null && Math.abs(homeCenterA - expectCenterA) <= 6,
          homeA === null ? 'extent=null' : 'center=' + homeCenterA + ' expect=' + expectCenterA)
        if (homeA !== null && titleRowA >= 0) {
          const leftBaseline = leftColumn(a.lines(), 140)
          const grabCol = Math.round((homeA.start + homeA.end) / 2)
          const grabRow = Math.round((homeA.top + homeA.bottom) / 2)
          // 拖住 + 向左上拖 20 列 / 15 行 → 本体跟手（渲染位置必须变）。
          // home 在面板内左缘只有 10 列余量，左移 20 会先撞左壁（clamp 本身
          // 就是被测行为）；上移 15 行把本体带进状态区文字行。
          a.stdin.write(sgr(0, grabCol, grabRow, false))
          a.stdin.write(sgr(32, grabCol - 20, grabRow - 15, false))
          await settled(() => {
            const ext = petExtent(a.lines())
            return ext !== null && ext.start <= homeA.start - 8 && ext.top <= homeA.top - 9
          }, { timeoutMs: 4000 })
          const upLeftA = petExtent(a.lines())
          // 空气墙量化（左钉位）：动画帧的姿势边距在 1-6 列间浮动，单帧
          // 采样会把姿势方差误当盒隙——跨 3 帧取最宽（min start）近似盒缘。
          let leftPinStart = upLeftA?.start ?? 9999
          for (let k = 0; k < 3; k += 1) {
            await sleep(220) // 固定窗:探针 跨动画帧采样最宽姿势
            const e = petExtent(a.lines())
            if (e !== null && e.start < leftPinStart) leftPinStart = e.start
          }
          check('drag-pos: held pet follows the pointer (art moves up-left)',
            upLeftA !== null && upLeftA.start <= homeA.start - 8 && upLeftA.top <= homeA.top - 9,
            upLeftA === null ? 'extent=null' : 'start ' + homeA.start + '->' + upLeftA.start + ' top ' + homeA.top + '->' + upLeftA.top)
          // 调皮是特性：宠物盒叠上状态区——被盖住的「当前动作」行从屏幕消失
          //（绝对定位层后画，空白行也会把正文擦掉）。
          const titleGone = !a.lines().some(l => l.includes('当前动作：'))
          check('drag-pos: displaced pet covers the status rows (now-playing row erased underneath)',
            titleGone,
            'titleRow=' + titleRowA + ' line=[' + (a.lines()[titleRowA] ?? '').trim() + ']')
          // §16.6：拖动位移期间左栏 + 分割线逐行恒等（列宽不受扰动）。
          const leftDuringDrag = leftColumn(a.lines(), 140)
          check('drag-pos: panel column width unchanged while dragging (§16.6)',
            leftDuringDrag.length === leftBaseline.length && leftDuringDrag.every((line, i) => line === leftBaseline[i]),
            'rows=' + leftDuringDrag.length)
          // clamp：指针拉出面板右/下边界（+200/+200）→ 本体钉在面板盒右下角
          //（start 抵住 maxLeft、底行不越过 home 底行），且右缘不出面板。
          a.stdin.write(sgr(32, grabCol + 200, grabRow + 200, false))
          await settled(() => {
            const ext = petExtent(a.lines())
            return ext !== null && ext.start >= panelLeftA + (panelColumnsA - 42) - 6
          }, { timeoutMs: 4000 })
          const farA = petExtent(a.lines())
          let rightPinEnd = farA?.end ?? -1
          for (let k = 0; k < 3; k += 1) {
            await sleep(220) // 固定窗:探针 跨动画帧采样最宽姿势
            const e = petExtent(a.lines())
            if (e !== null && e.end > rightPinEnd) rightPinEnd = e.end
          }
          check('drag-pos: clamped at the panel box (right edge never passes the panel)',
            farA !== null && farA.end <= panelLeftA + panelColumnsA - 1,
            farA === null ? 'extent=null' : 'end=' + farA.end + ' panelRight=' + (panelLeftA + panelColumnsA - 1))
          check('drag-pos: dragging below the floor cannot sink the pet (bottom stays at home band)',
            farA !== null && farA.bottom <= homeA.bottom + 2,
            farA === null ? 'extent=null' : 'bottom=' + farA.bottom + ' homeBottom=' + homeA.bottom)
          // 水平跟手的最强证据：左壁钉位 vs 右壁钉位（同姿势、同帧族），
          // 差值 = 面板内最大水平位移（maxLeft ≈ 20 列）。
          check('drag-pos: left-pinned vs right-pinned spans differ by the full clamp range',
            farA !== null && upLeftA !== null && farA.start - upLeftA.start >= 12,
            farA === null || upLeftA === null ? 'extent=null' : 'left ' + upLeftA.start + ' right ' + farA.start)
          // 空气墙回归（用户实测反馈）：左右饱和时**宠物盒**必须贴住面板盒
          // 边缘（clamp 基准 x=0 / x=width-petColumns，行内定宽 spacer 算术
          // 保证盒位）。可见美术与盒缘的残差只能来自姿势的透明边距——多帧
          // 最宽采样后 deepy 实测 1-3 列（阈值 4）；若 clamp 误用内容宽或
          // 被 padding 吃掉，每侧会恒定多出对应列数而红。（鲸娘皮肤可视边
          // 距更大——sprite 本体只占 42 格中部 ~21-25 格，属皮肤素材事实，
          // 不在面板侧修；见交付说明。）
          check('drag-wall: saturation pins the pet BOX flush to the panel borders (residual = pose margin only)',
            leftPinStart - panelLeftA <= 5 && (panelLeftA + panelColumnsA - 1) - rightPinEnd <= 5,
            'leftGap=' + (leftPinStart - panelLeftA) + ' rightGap=' + (panelLeftA + panelColumnsA - 1 - rightPinEnd))
          // 再收回到 +150/+180（仍越界）→ 饱和：同一 clamped 位置（±容差吃
          // 姿势帧差）。
          a.stdin.write(sgr(32, grabCol + 150, grabRow + 180, false))
          await sleep(450) // 固定窗:探针 等位移帧落屏后比较饱和位置是否一致
          const satA = petExtent(a.lines())
          check('drag-pos: beyond-the-edge drags saturate (same clamped spot)',
            satA !== null && farA !== null && Math.abs(satA.start - farA.start) <= 3 && Math.abs(satA.top - farA.top) <= 2,
            satA === null || farA === null ? 'extent=null' : 'start ' + farA.start + '->' + satA.start + ' top ' + farA.top + '->' + satA.top)
          // 松手 → 弹回原位（home 底部居中，被盖住的状态行恢复，±容差吃帧差）。
          a.stdin.write(sgr(0, grabCol + 150, grabRow + 180, true))
          await settled(() => {
            const ext = petExtent(a.lines())
            if (ext === null) return false
            return Math.abs((ext.start + ext.end) / 2 - homeCenterA) <= 4 && Math.abs(ext.top - homeA.top) <= 3
          }, { timeoutMs: 4000 })
          const backA = petExtent(a.lines())
          check('drag-pos: release springs the pet back home',
            backA !== null && Math.abs((backA.start + backA.end) / 2 - homeCenterA) <= 4 && Math.abs(backA.top - homeA.top) <= 3,
            backA === null ? 'extent=null' : 'center=' + (backA.start + backA.end) / 2 + '/' + homeCenterA + ' top=' + backA.top + '/' + homeA.top)
          check('drag-pos: covered status rows come back after the flyback',
            (a.lines()[titleRowA] ?? '').includes('当前动作：'), 'line=[' + (a.lines()[titleRowA] ?? '').trim() + ']')
          check('drag-pos: column width still identical after the flyback (§16.6)',
            leftColumn(a.lines(), 140).every((line, i) => line === leftBaseline[i]))

          // --- 残影回归：拖过状态区 → 悬停活性 → 松手恢复逐字节 ------------
          // 上一段已松手归位；重新拖一轮专测残影：(1) 压前快照 → 拖到中上
          // 部压住状态区 → 悬停两次采样（真残影 = 冻结不动的美术格；宠物
          // 自身的稀疏美术会随动画帧变化——「活性」判别）；(2) 松手弹回
          // 后，宠物盒顶以上的整片区域与压前快照逐字节一致（计时行除外）。
          // 前一段的回弹可能仍在抑制自述气泡——先等它回来再取基线，压前
          // 压后气泡都在屏，逐字节比较才公平。
          await settled(() => a.lines().some(l => l.includes('POKE-MARK')), { timeoutMs: 5000 })
          const upperSnapshot = a.lines().slice(1, 14).map(l => l.slice(panelLeftA))
          a.stdin.write(sgr(0, grabCol, grabRow, false))
          a.stdin.write(sgr(32, grabCol - 4, grabRow - 13, false))
          await settled(() => {
            const ext = petExtent(a.lines())
            return ext !== null && ext.top <= homeA.top - 8
          }, { timeoutMs: 4000 })
          const hold1 = a.lines()
          await sleep(700) // 固定窗:探针 悬停中跨动画帧的第二次采样
          const hold2 = a.lines()
          const bandChanged = (rows: number[]): number => {
            let changed = 0
            for (const r of rows) {
              const l1 = (hold1[r] ?? '').slice(panelLeftA, panelLeftA + panelColumnsA)
              const l2 = (hold2[r] ?? '').slice(panelLeftA, panelLeftA + panelColumnsA)
              for (let i = 0; i < l1.length; i += 1) if (l1[i] !== l2[i]) changed += 1
            }
            return changed
          }
          const holdExt = petExtent(hold1)
          const suspectRows = []
          for (let r = 7; r <= (holdExt?.top ?? 13) - 1; r += 1) suspectRows.push(r)
          const suspectChanged = bandChanged(suspectRows)
          const bodyChanged = bandChanged([13, 14, 15])
          check('drag-ghost: cells above the held pet stay live (no frozen stale art)',
            suspectChanged > 0 || bodyChanged === 0,
            'suspectΔ=' + suspectChanged + ' bodyΔ=' + bodyChanged + ' rows=[' + suspectRows.join(',') + ']')
          a.stdin.write(sgr(0, grabCol - 4, grabRow - 13, true))
          await settled(() => {
            const ext = petExtent(a.lines())
            if (ext === null) return false
            return Math.abs(ext.top - homeA.top) <= 3
          }, { timeoutMs: 5000 })
          await sleep(900) // 固定窗:探针 弹回落定后的收尾帧
          const restored = a.lines().slice(1, 14).map(l => l.slice(panelLeftA))
          let residue: string | null = null
          for (let i = 0; i < upperSnapshot.length; i += 1) {
            // 行 index 2（屏幕行 3）是「工作中 · Ns」计时行，秒数合法地变。
            if (i === 2) continue
            if (restored[i] !== upperSnapshot[i]) { residue = 'row ' + (i + 1) + ': [' + upperSnapshot[i].trim() + '] -> [' + restored[i].trim() + ']'; break }
          }
          check('drag-ghost: drag across the status rows then release restores byte-identical (no residue)', residue === null, residue ?? '')
          check('drag-ghost: column width unchanged through the ghost sweep (§16.6)',
            leftColumn(a.lines(), 140).every((line, i) => line === leftBaseline[i]))

          // --- 拖动抑制气泡：拖住/回弹期间两层气泡不显示，落定后恢复 -----
          // 前置：此刻 working=true 且 activity 有文案 → 自述气泡在屏。
          const bubbleBeforeDrag = a.lines().some(l => l.includes('POKE-MARK'))
          a.stdin.write(sgr(0, grabCol, grabRow, false))
          a.stdin.write(sgr(32, grabCol - 4, grabRow - 10, false))
          await settled(() => {
            const ext = petExtent(a.lines())
            return ext !== null && ext.top <= homeA.top - 6 && !a.lines().some(l => l.includes('POKE-MARK'))
          }, { timeoutMs: 4000 })
          check('drag-bubble: holding the pet mid-air suppresses the bubble',
            bubbleBeforeDrag && !a.lines().some(l => l.includes('POKE-MARK')))
          a.stdin.write(sgr(0, grabCol - 4, grabRow - 10, true))
          await settled(() => {
            const ext = petExtent(a.lines())
            if (ext === null) return false
            return Math.abs(ext.top - homeA.top) <= 3 && a.lines().some(l => l.includes('POKE-MARK'))
          }, { timeoutMs: 5000 })
          check('drag-bubble: the bubble returns after the flyback settles',
            a.lines().some(l => l.includes('POKE-MARK')))
        }
      }
    }

    // --- 活动自述气泡：working 回合的 ⏵ 工作行由头顶气泡逐字转述 -------
    // 数据源同源验证：宠物说的必须是 runtimeCtx.activity.line 原文（与聊天
    // 区 ActivityLine 同一字段），含夹具埋的探针标记。
    await settled(() => a.lines().some(l => l.includes('POKE-MARK')), { timeoutMs: 4000 })
    const artTop = artRows(a.lines())[0] ?? -1
    const narrationRow = a.lines().findIndex(l => l.includes('POKE-MARK'))
    check('narrate: working turn speaks the activity line verbatim in the bubble (above the art)',
      narrationRow >= 0 && narrationRow < artTop, 'row=' + narrationRow + ' artTop=' + artTop)
    check('narrate: status row keeps the short phrase alongside',
      a.lines().some(l => l.includes('正在统计条目')))
    // 换词跟随：activity.line 变 → 气泡同帧换词（派生层，无进出场重触发）。
    fakeActivity.line = '正在分析活动换词探针 ACTIVITY-SWAP'
    bumpChannel()
    await settled(() => a.lines().some(l => l.includes('ACTIVITY-SWAP')) && !a.lines().some(l => l.includes('POKE-MARK')), { timeoutMs: 4000 })
    check('narrate: line change follows live (text swap, same bubble)',
      a.lines().some(l => l.includes('ACTIVITY-SWAP')) && !a.lines().some(l => l.includes('POKE-MARK')))

    // --- 瞬态通知盖过活动自述；到期回落 -------------------------------
    ;(fakeChannel.notifications as Array<{ text: string }>).push({ text: 'NOTIFY-OLD-芝麻' })
    bumpChannel()
    await settled(() => a.lines().some(l => l.includes('NOTIFY-OLD-芝麻')), { timeoutMs: 4000 })
    check('notify: transient notification overrides the narration bubble (never both)',
      a.lines().some(l => l.includes('NOTIFY-OLD-芝麻')) && !a.lines().some(l => l.includes('ACTIVITY-SWAP')))
    const notifyRow = a.lines().findIndex(l => l.includes('NOTIFY-OLD-芝麻'))
    check('notify: bubble row is above the pet', notifyRow >= 0 && notifyRow < artTop, 'row=' + notifyRow + ' artTop=' + artTop)
    ;(fakeChannel.notifications as Array<{ text: string; color?: string }>).push({ text: 'NOTIFY-NEW-绿豆', color: 'error' })
    bumpChannel()
    await settled(() => a.lines().some(l => l.includes('NOTIFY-NEW-绿豆')), { timeoutMs: 4000 })
    check('notify: a second push displaces the first', a.lines().some(l => l.includes('NOTIFY-NEW-绿豆')) && !a.lines().some(l => l.includes('NOTIFY-OLD-芝麻')))
    await settled(() => nowPlaying(a.lines()) === '出错啦', { timeoutMs: 4000 })
    check('notify: error-colored notification swaps the pet to the error animation', nowPlaying(a.lines()) === '出错啦', nowPlaying(a.lines()))
    await settled(() => !a.lines().some(l => l.includes('NOTIFY-NEW-绿豆')), { timeoutMs: NOTIFICATION_BUBBLE_MS + 2500 })
    check('notify: bubble auto-dismisses after ~NOTIFICATION_BUBBLE_MS', !a.lines().some(l => l.includes('NOTIFY-NEW-绿豆')))
    await settled(() => a.lines().some(l => l.includes('ACTIVITY-SWAP')), { timeoutMs: 4000 })
    check('narrate: narration returns after the notification expires (still working)',
      a.lines().some(l => l.includes('ACTIVITY-SWAP')) && !a.lines().some(l => l.includes('NOTIFY-')))
    await settled(() => nowPlaying(a.lines()) === '敲代码', { timeoutMs: 6000 })
    check('notify: reaction yields back to the smoothed mood', nowPlaying(a.lines()) === '敲代码', nowPlaying(a.lines()))

    // --- 回合结束收起；Enter 戳一戳从收起态短暂重现 --------------------
    fakeChannel.working = false
    bumpChannel()
    await settled(() => !a.lines().some(l => l.includes('ACTIVITY-SWAP')), { timeoutMs: 5000 })
    check('narrate: turn end collapses the narration bubble', !a.lines().some(l => l.includes('ACTIVITY-SWAP')))
    a.stdin.write('\r')
    await settled(() => a.lines().some(l => l.includes('ACTIVITY-SWAP')), { timeoutMs: 4000 })
    const pokeRow = a.lines().findIndex(l => l.includes('ACTIVITY-SWAP'))
    check('poke: Enter speaks the FULL activity.line in the bubble (from collapsed state)',
      pokeRow >= 0 && pokeRow < artTop, 'pokeRow=' + pokeRow + ' artTop=' + artTop)
    await settled(() => !a.lines().some(l => l.includes('ACTIVITY-SWAP')), { timeoutMs: POKE_MS + 2500 })
    check('poke: bubble auto-dismisses (no narration underneath while not working)',
      !a.lines().some(l => l.includes('ACTIVITY-SWAP')))

    // --- 流式轰炸（#185 防复发）：activity.line ~16ms 换词 + version 同步
    // bump，持续 ~1.2s。面板必须全程存活且气泡跟着最新词（任何随
    // version/notifications/activity 身份变化而 setState 的 effect 都会把
    // 每个流式 chunk 变成一次提交链，连续 50 次嵌套更新即 #185 进程闪退
    // ——本场景在真实 SidePanelColumn/PanelHost 链路上红绿可判）。
    fakeChannel.working = true
    fakeActivity.line = '流式回归基线 STREAM-0'
    bumpChannel()
    await settled(() => a.lines().some(l => l.includes('STREAM-0')), { timeoutMs: 4000 })
    let streamN = 0
    const burst = setInterval(() => {
      streamN += 1
      fakeActivity.line = '流式回归换词 STREAM-' + streamN + ' 段'.repeat(1 + (streamN % 10))
      bumpChannel()
    }, 16)
    await sleep(1200) // 固定窗:墙钟 流式轰炸窗口（~70 轮换词+版本 bump）
    clearInterval(burst)
    await settled(() => a.lines().some(l => l.includes('STREAM-' + streamN)), { timeoutMs: 4000 })
    check('stream-185: ~16ms narration churn for 1.2s survives (no update-depth crash)',
      a.lines().some(l => l.includes('STREAM-' + streamN)), 'rounds=' + streamN)
  } finally {
    await a.app.unmount()
    a.term.dispose()
  }

  // ================= scene D: wide 140x32, idle — hover + wrap ===========
  applySidePanelRatio(0.55)
  fakeChannel.working = false
  fakeChannel.spinnerMode = 'thinking'
  fakeChannel.notifications = []
  const d = await scene(140, 32, undefined, { approvals: 0, questions: 0 }, 'todo,jobs,agents,companion')
  try {
    d.controller?.openPanel('companion', { focus: true })
    await settled(() => nowPlaying(d.lines()) !== '' && artRows(d.lines()).length > 0, { timeoutMs: 8000 })
    const idleTitle = nowPlaying(d.lines())
    check('hover: idle baseline captured', ['待机', '东张西望', '开心喷水', '游来游去'].includes(idleTitle), idleTitle)

    const cellD = findArtCell(d.lines())
    const spanD = widestArtSpan(d.lines())
    check('hover: art span measured', spanD !== null && spanD.end - spanD.start > 20)
    if (cellD !== null && spanD !== null) {
      // 指针从宠物左侧的面板空区进入（无按键 motion=35）→ idle-look。
      d.stdin.write(sgr(35, Math.max(1, spanD.start - 8), cellD.row, false))
      await settled(() => nowPlaying(d.lines()) === '东张西望', { timeoutMs: 4000 })
      check('hover: pointer inside the panel -> idle-look', nowPlaying(d.lines()) === '东张西望', nowPlaying(d.lines()))
      // 指针移到宠物本体 → idle-spout。
      d.stdin.write(sgr(35, spanD.start + 20, cellD.row - 2, false))
      await settled(() => nowPlaying(d.lines()) === '开心喷水', { timeoutMs: 4000 })
      check('hover: pointer over the pet body -> idle-spout', nowPlaying(d.lines()) === '开心喷水', nowPlaying(d.lines()))
      // 指针离开面板（聊天列）→ 回到轮换。
      d.stdin.write(sgr(35, 5, 5, false))
      await settled(() => nowPlaying(d.lines()) !== '开心喷水', { timeoutMs: 4000 })
      check('hover: leaving the panel restores the rotation', ['待机', '东张西望', '开心喷水', '游来游去'].includes(nowPlaying(d.lines())), nowPlaying(d.lines()))

      // --- 悬停驻留（enter 400ms / leave 800ms，2026-10-03 变脸修复）---------
      // 探针档选与当前轮换档不同的悬停语义（面板空区=东张西望、宠物本体=
      // 开心喷水）：划过不换脸、驻留满窗换脸、移开迟滞切回、悬停未落定时
      // 点击依旧即时。断言避开轮换基线值（8s 槽界可能中途推进）。
      const rotationFamily = ['待机', '东张西望', '开心喷水', '游来游去']
      const baselineTitle = nowPlaying(d.lines())
      const hoverFaceTitle = baselineTitle === '东张西望' ? '开心喷水' : '东张西望'
      const hoverTarget = hoverFaceTitle === '东张西望'
        ? { col: Math.max(1, spanD.start - 8), row: cellD.row }   // 面板空区（左 spacer）
        : { col: spanD.start + 20, row: cellD.row - 2 }            // 宠物本体
      // 快速划过：进→停在驻留窗内→出，全程不得换脸。
      d.stdin.write(sgr(35, hoverTarget.col, hoverTarget.row, false))
      await sleep(180) // 固定窗:墙钟 停在 enter 驻留窗内（180 < 400），断言尚未换脸
      check('hover: face unchanged inside the enter dwell window',
        nowPlaying(d.lines()) !== hoverFaceTitle, nowPlaying(d.lines()))
      d.stdin.write(sgr(35, 5, 5, false))
      await sleep(HOVER_LEAVE_SETTLE_MS + 300) // 固定窗:墙钟 覆盖 leave 迟滞窗，断言划过全程未切换
      check('hover: quick pass-through never switches the face',
        nowPlaying(d.lines()) !== hoverFaceTitle, nowPlaying(d.lines()))
      // 持续悬停 → 驻留满窗换脸。
      d.stdin.write(sgr(35, hoverTarget.col, hoverTarget.row, false))
      await settled(() => nowPlaying(d.lines()) === hoverFaceTitle, { timeoutMs: 2500 })
      check('hover: sustained pointer switches after the dwell window', nowPlaying(d.lines()) === hoverFaceTitle, nowPlaying(d.lines()))
      // 移开 → 迟滞窗内保持悬停脸、满窗切回轮换。
      d.stdin.write(sgr(35, 5, 5, false))
      await sleep(300) // 固定窗:墙钟 迟滞窗（800ms）内采样，断言仍持悬停脸
      check('hover: leaving holds the face inside the settle window', nowPlaying(d.lines()) === hoverFaceTitle, nowPlaying(d.lines()))
      await settled(() => nowPlaying(d.lines()) !== hoverFaceTitle, { timeoutMs: 2500 })
      check('hover: leaving restores the rotation after the settle window',
        rotationFamily.includes(nowPlaying(d.lines())), nowPlaying(d.lines()))
      // 悬停驻留未落定时点击 → poke 覆盖层即时（驻留不拖慢点击反馈）。
      d.stdin.write(sgr(35, hoverTarget.col, hoverTarget.row, false))
      await sleep(150) // 固定窗:墙钟 停在驻留窗内（150 < 400）再点击
      clickAt(d, cellD.col, cellD.row)
      await settled(() => nowPlaying(d.lines()) === '戳左边' || nowPlaying(d.lines()) === '戳右边', { timeoutMs: 1500 })
      check('hover: click poke stays instant while the hover dwell is still pending',
        nowPlaying(d.lines()) === '戳左边' || nowPlaying(d.lines()) === '戳右边', nowPlaying(d.lines()))
    }

    // --- long notification wraps to <=3 lines and truncates with … ------
    const long = '气泡换行探针'.repeat(18)
    ;(fakeChannel.notifications as Array<{ text: string }>).push({ text: long })
    bumpChannel()
    await settled(() => d.lines().some(l => l.includes('气泡换行探针')), { timeoutMs: 4000 })
    const bubbleLinesFound = d.lines().filter(l => l.includes('气泡换行探针') || (l.includes('…') && l.trimStart().startsWith('气泡')))
    const anyBubble = d.lines().filter(l => l.includes('气泡换行探针'))
    check('notify: long text wraps into the bubble', anyBubble.length >= 2, 'lines=' + anyBubble.length)
    check('notify: bubble never exceeds 3 text lines', anyBubble.length <= 3, 'lines=' + anyBubble.length)
    check('notify: truncated tail carries an ellipsis', d.lines().some(l => l.includes('…')), 'bubbleLines=' + bubbleLinesFound.length)
    void bubbleLinesFound
  } finally {
    await d.app.unmount()
    d.term.dispose()
  }

  // ================= scene F: context signals render through =============
  applySidePanelRatio(0.55)
  fakeChannel.working = false
  // 行对象按 SubagentState 契约补 output/toolCalls（SubagentCard 直读
  // output[output.length-1] 与 toolCalls.length，缺了炸进边界）。
  fakeChannel.subagents = [
    { status: 'running', description: 'a', output: [], toolCalls: [] },
    { status: 'running', description: 'b', output: [], toolCalls: [] },
  ]
  fakeChannel.notifications = []
  const f = await scene(140, 30, undefined, { approvals: 0, questions: 0 }, 'todo,jobs,agents,companion')
  try {
    f.controller?.openPanel('companion', { focus: true })
    await settled(() => nowPlaying(f.lines()) === '带领小鲸鱼分身', { timeoutMs: 8000 })
    check('context: 2 running subagents -> conducting renders', nowPlaying(f.lines()) === '带领小鲸鱼分身', nowPlaying(f.lines()))
    check('context: counts row shows subagents + sessions', f.lines().some(l => l.includes('子代理 ×2')) && f.lines().some(l => l.includes('会话 ×2')))
    fakeChannel.compaction = { startedAt: Date.now(), phase: 'prefill', outputChars: 0, cancellable: false }
    bumpChannel()
    await settled(() => nowPlaying(f.lines()) === '上下文清理', { timeoutMs: 6000 })
    check('context: compaction in flight -> compacting renders', nowPlaying(f.lines()) === '上下文清理', nowPlaying(f.lines()))
    fakeChannel.compaction = undefined
    fakeChannel.gitBranch = 'main'
    bumpChannel()
    await settled(() => nowPlaying(f.lines()) === '带领小鲸鱼分身', { timeoutMs: 6000 })
    fakeChannel.gitBranch = 'feat/companion'
    bumpChannel()
    await settled(() => nowPlaying(f.lines()) === '顶箱子', { timeoutMs: 6000 })
    check('context: git branch change flashes the carrying animation', nowPlaying(f.lines()) === '顶箱子', nowPlaying(f.lines()))
    await settled(() => nowPlaying(f.lines()) === '带领小鲸鱼分身', { timeoutMs: 6000 })
    check('context: carrying flash yields back', nowPlaying(f.lines()) === '带领小鲸鱼分身')
  } finally {
    fakeChannel.subagents = []
    fakeChannel.compaction = undefined
    fakeChannel.gitBranch = undefined
    await f.app.unmount()
    f.term.dispose()
  }

  // ========= scenes G/H: a NON-deepy skin receives interaction semantics ==
  // 观测点：包一层 WhaleGirlSkin.render 记录每次收到的 animationSemantic。
  // （设置管线 normalizeCompanionSkin 是白名单，自定义假皮肤 id 进不去——
  // 用真实的非 deepy 皮肤当探针，比假皮肤更强：连 semanticMap 落点一起测。）
  // 互动层（poke/tickle/drag/hover）与审批语义必须能到达任何皮肤。
  const semanticSeen: string[] = []
  const originalGirlRender = skins.WhaleGirlSkin.render
  skins.WhaleGirlSkin.render = function recordedGirl(input: Parameters<typeof originalGirlRender>[0]) {
    semanticSeen.push(input.animationSemantic ?? '<none>')
    return originalGirlRender(input)
  }
  applySidePanelRatio(0.55)
  applyCompanionSkin('whaleGirl')
  fakeChannel.working = false
  fakeChannel.spinnerMode = 'thinking'
  const g = await scene(140, 30, undefined, { approvals: 0, questions: 0 }, 'todo,jobs,agents,companion')
  try {
    g.controller?.openPanel('companion', { focus: true })
    await settled(() => artRows(g.lines()).length > 0, { timeoutMs: 8000 })
    check('probe: whaleGirl skin mounts and renders art', artRows(g.lines()).length > 0)
    // 几何定位：鲸娘素材的连块 run 比像素鲸窄；屏幕上还可能有两条竖线
    //（聊天滚动槽 + 真分割线），扫 │ 不可靠——以 useSidePanel 的
    // panelColumns 为权威：面板占右缘 [cols-panelColumns, cols-1]，宠物盒
    // 在面板内居中。
    const panelColumnsG = (g.controller as unknown as { panelColumns?: number } | undefined)?.panelColumns ?? 62
    const panelLeftG = 140 - panelColumnsG
    const petLeftG = panelLeftG + Math.floor((panelColumnsG - 42) / 2)
    const petRight = petLeftG + 41
    const petCenterG = petLeftG + 21
    const extentG = (() => {
      let start = 999, end = -1
      for (const row of artRows(g.lines())) {
        const line = g.lines()[row]!
        const slice = line.slice(panelLeftG).trimEnd()
        if (slice === '') continue
        const first = panelLeftG + slice.search(/\S/)
        const last = panelLeftG + slice.length - 1
        if (first < start) start = first
        if (last > end) end = last
      }
      return { start, end }
    })()
    const spriteCenter = extentG.end >= 0 ? (extentG.start + extentG.end) / 2 : -99
    check('probe: pet box geometry calibrated',
      petLeftG >= panelLeftG && extentG.start >= petLeftG && extentG.end <= petRight && Math.abs(spriteCenter - petCenterG) <= 4,
      'panel=[' + panelLeftG + ',139] box=[' + petLeftG + ',' + petRight + '] extent=[' + extentG.start + ',' + extentG.end + '] center=' + spriteCenter)
    {
      const midRow = artRows(g.lines())[7] ?? artRows(g.lines())[0] ?? 10
      semanticSeen.length = 0
      // 悬停：宠物左侧的面板空区（左 spacer）→ idle-look。
      g.stdin.write(sgr(35, Math.max(panelLeftG + 2, petLeftG - 8), midRow, false))
      await settled(() => semanticSeen.includes('idle-look'), { timeoutMs: 4000 })
      check('probe: hover in panel reaches a non-deepy skin (idle-look)', semanticSeen.includes('idle-look'),
        'seen=' + [...new Set(semanticSeen)].join(','))
      await sleep(TICKLE_WINDOW_MS + 700) // 固定窗:墙钟 清悬停判定对点击窗口的干扰
      semanticSeen.length = 0
      clickAt(g, petLeftG + 6, midRow)
      await settled(() => semanticSeen.includes('poke-left'), { timeoutMs: 4000 })
      check('probe: left-half click reaches a non-deepy skin (poke-left)', semanticSeen.includes('poke-left'),
        'seen=' + [...new Set(semanticSeen)].join(','))
      await settled(() => !semanticSeen.slice(-6).includes('poke-left'), { timeoutMs: 6000 })
      await sleep(TICKLE_WINDOW_MS + 700) // 固定窗:墙钟 清狂点窗口
      semanticSeen.length = 0
      for (let i = 0; i < 3; i += 1) {
        clickAt(g, petLeftG + 10 + i * 3, midRow)
        await sleep(120) // 固定窗:pacing 三连点保持在 900ms 窗口内
      }
      await settled(() => semanticSeen.includes('tickle'), { timeoutMs: 4000 })
      check('probe: 3 rapid clicks reach a non-deepy skin (tickle)', semanticSeen.includes('tickle'),
        'seen=' + [...new Set(semanticSeen)].join(','))
      await sleep(TICKLE_WINDOW_MS + 700) // 固定窗:墙钟 等 tickle 窗口结束
      semanticSeen.length = 0
      g.stdin.write(sgr(0, petCenterG, midRow, false))
      g.stdin.write(sgr(32, petCenterG + 6, midRow - 1, false))
      await settled(() => semanticSeen.includes('drag'), { timeoutMs: 4000 })
      check('probe: drag sequence reaches a non-deepy skin (drag)', semanticSeen.includes('drag'),
        'seen=' + [...new Set(semanticSeen)].join(','))
      g.stdin.write(sgr(32, petCenterG + 12, midRow - 2, false))
      g.stdin.write(sgr(0, petCenterG + 12, midRow - 2, true))
      await settled(() => !semanticSeen.slice(-6).includes('drag'), { timeoutMs: 6000 })
      check('probe: drag release restores the smoothed semantics', !semanticSeen.slice(-6).includes('drag'))
    }
  } finally {
    await g.app.unmount()
    g.term.dispose()
    applyCompanionSkin('deepy')
  }

  // scene H: approval semantic reaches the non-deepy skin too.
  applyCompanionSkin('whaleGirl')
  const h = await scene(140, 30, undefined, { approvals: 1, questions: 0 }, 'todo,jobs,agents,companion')
  try {
    h.controller?.openPanel('companion', { focus: true })
    await settled(() => semanticSeen.includes('notification'), { timeoutMs: 8000 })
    check('probe: approval pending reaches a non-deepy skin (notification)', semanticSeen.includes('notification'),
      'seen=' + [...new Set(semanticSeen)].slice(0, 6).join(','))
  } finally {
    await h.app.unmount()
    h.term.dispose()
    applyCompanionSkin('deepy')
  }
  skins.WhaleGirlSkin.render = originalGirlRender
  // ================= scene B: narrow (120 -> panel 38 < 44) ==============
  applySidePanelRatio(0.68)
  fakeChannel.working = false
  fakeChannel.spinnerMode = 'thinking'
  const b = await scene(120, 26, undefined, { approvals: 1, questions: 0 }, 'todo,jobs,agents,companion')
  try {
    b.controller?.openPanel('companion', { focus: true })
    await settled(() => b.lines().some(l => l.includes('需要你')), { timeoutMs: 6000 })
    const compactLine = b.lines().find(l => l.includes('需要你')) ?? ''
    check('narrow: compact row shows ♥ + mood label', compactLine.includes('♥') && compactLine.includes('需要你'), compactLine.trim())
    check('narrow: no skin art (no wide half-block runs)', artRows(b.lines()).length === 0)
    check('narrow: compact form still shows the interaction hint', b.lines().some(l => l.includes('点它戳一戳')))
  } finally {
    await b.app.unmount()
    b.term.dispose()
  }

  // ========= scene I: below PANEL_MIN_COLUMNS → cramped slogan ============
  // 分栏几何的列宽下限是 PANEL_MIN_COLUMNS（28），经 useSidePanel 造不出
  // 更窄的面板——直接挂 CompanionPanel（照 scene C 的探针思路，不走
  // PanelHost）测两档边界：<28 躲起来标语；=28 仍是紧凑形态。
  const crampedScene = async (panelWidth: number): Promise<{ lines: () => string[]; done: () => Promise<void> }> => {
    const term = new XTerm({ cols: panelWidth, rows: 10, scrollback: 0, allowProposedApi: true })
    class CrampedStdout extends Writable {
      columns = panelWidth
      rows = 10
      isTTY = true
      term: import('@xterm/headless').Terminal
      constructor(t: import('@xterm/headless').Terminal) { super(); this.term = t }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _write(chunk: any, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
    }
    class CrampedStderr extends Writable { isTTY = true; _write(_c: unknown, _e: Buffer.Encoding, cb: () => void) { cb() } }
    const app = await render(
      <AlternateScreen mouseTracking={true}>
        <ThemeProvider theme="dark">
          <SidePanelRuntimeContext.Provider value={{
            runtime: undefined,
            channel: fakeChannel as never,
            activity: undefined,
            attention: { approvals: 1, questions: 0 },
          }}>
            <Box width={panelWidth} height={10}>
              <CompanionPanel width={panelWidth} height={10} focused={true} visible={true} mode="split" />
            </Box>
          </SidePanelRuntimeContext.Provider>
        </ThemeProvider>
      </AlternateScreen>,
      {
        stdout: new CrampedStdout(term) as unknown as NodeJS.WriteStream,
        stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
        stderr: new CrampedStderr() as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )
    const lines = (): string[] => {
      const buf = term.buffer.active
      const out: string[] = []
      for (let y = 0; y < 10; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(panelWidth, ' '))
      return out
    }
    return { lines, done: async () => { await app.unmount(); term.dispose() } }
  }
  {
    applyCompanionSkin('deepy')
    fakeChannel.working = false
    fakeChannel.spinnerMode = 'thinking'
    const i = await crampedScene(20)
    try {
      await settled(() => i.lines().some(l => l.includes('好挤呀')), { timeoutMs: 6000 })
      check('cramped: below PANEL_MIN_COLUMNS the hiding slogan renders (companion-cramped)',
        i.lines().some(l => l.includes('好挤呀')) && i.lines().some(l => l.includes('…')),
        i.lines().find(l => l.includes('好挤呀'))?.trim() ?? '')
      check('cramped: pet body absent (no art, no compact mood/hint rows)',
        artRows(i.lines()).length === 0 && !i.lines().some(l => l.includes('需要你')) && !i.lines().some(l => l.includes('点它戳一戳')))
      check('cramped: slogan truncates inside the narrow box (width demand intact)',
        i.lines().every(l => l.length <= 20))
    } finally {
      await i.done()
    }
    const h = await crampedScene(26)
    try {
      await settled(() => h.lines().some(l => l.includes('Deepy')), { timeoutMs: 6000 })
      // 标语全文案约 33 列，cramped 档（<28）放不下是常态——名字可见即可。
      check('cramped: slogan names the active skin (Deepy)',
        h.lines().some(l => l.includes('好挤呀') && l.includes('Deepy')),
        h.lines().find(l => l.includes('好挤呀'))?.trim() ?? '')
    } finally {
      await h.done()
    }
    const j = await crampedScene(28)
    try {
      await settled(() => j.lines().some(l => l.includes('♥')), { timeoutMs: 6000 })
      check('cramped-boundary: exactly PANEL_MIN_COLUMNS still renders the compact form',
        j.lines().some(l => l.includes('需要你')) && !j.lines().some(l => l.includes('好挤呀')))
    } finally {
      await j.done()
    }
  }

  // ========= scene E: whale skin fallback keeps the heart pass ===========
  const whalePoses: Array<{ heart: number }> = []
  const originalWhaleRender = WhaleSkin.render
  WhaleSkin.render = function recordedWhale(input: Parameters<typeof originalWhaleRender>[0]) {
    whalePoses.push({ heart: input.pose.heart })
    return originalWhaleRender(input)
  }
  try {
    applySidePanelRatio(0.55)
    applyCompanionSkin('whale')
    fakeChannel.working = true
    fakeChannel.spinnerMode = 'tool-use'
    fakeChannel.notifications = []
    const e = await scene(140, 26, fakeActivity, { approvals: 0, questions: 0 }, 'todo,jobs,agents,companion')
    try {
      e.controller?.openPanel('companion', { focus: true })
      await settled(() => artRows(e.lines()).length > 0, { timeoutMs: 8000 })
      check('whale: fallback skin renders art', artRows(e.lines()).length > 0)
      const cellE = findArtCell(e.lines())
      if (cellE !== null) {
        whalePoses.length = 0
        clickAt(e, cellE.col, cellE.row)
        await settled(() => whalePoses.some(p => p.heart > 0), { timeoutMs: 4000 })
        check('whale: SGR click still arms the heart pass (pose.heart > 0)',
          whalePoses.some(p => p.heart > 0), 'maxHeart=' + Math.max(0, ...whalePoses.map(p => p.heart)))
      }
    } finally {
      await e.app.unmount()
      e.term.dispose()
    }
  } finally {
    WhaleSkin.render = originalWhaleRender
    applyCompanionSkin('deepy')
  }

  // ========= scene C: visible=false -> zero clock AND zero writes =======
  const clockCounts = { keepAlive: 0 }
  function CountingClock({ children }: { children: React.ReactNode }): React.ReactNode {
    const inner = React.useContext(ClockContext)
    const proxy = React.useMemo(() => {
      const delegate = inner ?? {
        subscribe: () => () => {},
        now: () => Date.now(),
        setTickInterval: () => {},
        suspend: () => {},
      }
      return {
        subscribe(onChange: () => void, keepAlive: boolean) {
          if (keepAlive) { clockCounts.keepAlive += 1 }
          const off = delegate.subscribe(onChange, keepAlive)
          return () => { if (keepAlive) { clockCounts.keepAlive -= 1 }; off() }
        },
        now: () => delegate.now(),
        setTickInterval: (ms: number) => delegate.setTickInterval(ms),
        suspend: (ms: number) => delegate.suspend(ms),
      }
    }, [inner])
    return <ClockContext.Provider value={proxy}>{children}</ClockContext.Provider>
  }
  function ClockProbePanel(props: { width: number; height: number; focused: boolean; visible: boolean; mode: string }): React.ReactNode {
    return <CountingClock><CompanionPanel {...(props as never)} /></CountingClock>
  }
  panelStore.register({
    id: 'companion-clock-probe',
    title: 'ClockProbe',
    icon: '♥',
    order: 45,
    source: 'plugin',
    pluginId: 'verify-companion-panel',
    mountPolicy: 'enabled',
    component: ClockProbePanel as never,
  }, { pluginId: 'verify-companion-panel' })
  applySidePanelRatio(0.55)
  fakeChannel.working = true
  fakeChannel.spinnerMode = 'tool-use'
  fakeChannel.notifications = []
  const c = await scene(140, 26, fakeActivity, { approvals: 0, questions: 0 }, 'todo,jobs,agents,companion-clock-probe')
  try {
    c.controller?.openPanel('companion-clock-probe', { focus: true })
    await settled(() => c.lines().some(l => l.includes('个工具')), { timeoutMs: 6000 })
    check('clock: probe panel mounted and visible (stats line rendered)', c.lines().some(l => l.includes('个工具')))
    c.controller?.openPanel('todo', { focus: true })
    await settled(() => !c.lines().some(l => l.includes('个工具')), { timeoutMs: 6000 })
    clockCounts.keepAlive = 0
    c.writes.count = 0
    // 隐藏期间推一条通知 + 一次版本 bump：不得点亮时钟、不得写屏、恢复后不得弹旧账。
    ;(fakeChannel.notifications as Array<{ text: string }>).push({ text: 'NOTIFY-HIDDEN-旧账' })
    bumpChannel()
    await sleep(600) // 固定窗:探针 display:none 下不得持有动画时钟/产生任何写流（观察窗后再断言）
    check('clock: visible=false holds ZERO clock subscriptions', clockCounts.keepAlive === 0, 'keepAlive=' + clockCounts.keepAlive)
    check('clock: visible=false produces ZERO stdout writes', c.writes.count === 0, 'writes=' + c.writes.count)
    c.controller?.openPanel('companion-clock-probe', { focus: true })
    await settled(() => c.lines().some(l => l.includes('个工具')), { timeoutMs: 6000 })
    check('hidden-notify: visibility regain does NOT replay the stale notification', !c.lines().some(l => l.includes('NOTIFY-HIDDEN-旧账')))
    check('hidden-notify: panel re-aligns to the live mood (stats back)', c.lines().some(l => l.includes('个工具')))
  } finally {
    await c.app.unmount()
    c.term.dispose()
  }
} catch (error) {
  check('fixture: no unexpected exception', false, (error as { stack?: string })?.stack ?? String(error))
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: companion panel all checks passed.')
process.exit(0)