/**
 * PluginsPanel side-panel regression:
 *
 * Part A (SidePanelLayout + SidePanelColumn + PanelHost + XTerm):
 *  - loading -> grouped list (Installed / Experimental / collapsed Base);
 *  - focus skips decorative Dividers and starts on the first bundle;
 *  - narrow (28 cols) omits version and keeps the divider/title/status inside
 *    the sidebar; wide (40 cols) renders version;
 *  - left-click on a bundle row selects it and expands detail; second left-click
 *    collapses detail;
 *  - left-click on `▸ Base (N)` expands/collapses Base rows;
 *  - no `e`/`d`/`r` keyboard shortcuts on rows;
 *  - right-click or `m` opens the bundle context menu (Enable/Disable, Remove);
 *    keyboard ↑/↓/Enter/Esc & mouse click inside menu drive actions;
 *  - real lone Esc (\x1b = {escape:true, meta:true}) closes context menu first,
 *    then collapses visible detail, then returns focus to chat; stale
 *    expandedBundle (after collapsing Base) never eats an extra Esc;
 *  - channel.version bumps do NOT refetch; subscribePluginBundles triggers
 *    background refresh without flashing LoadingState or resetting focus;
 *  - expanding BundleDetail near the bottom scrolls it into view;
 *  - rejected pluginPanelBundles() renders error state (not empty state);
 *    recovery renders the fresh list while restoring the focused row and detail;
 *  - a host without the plugin service renders the centered explanation instead
 *    of loading/empty, never fetches the list, and `d`/click opens the report;
 *  - a partial channel omitting both plugin capabilities degrades to that card
 *    without a panel error, while a data-only stub still loads the list;
 *  - empty list renders empty hint and `i` invokes installPlugin when wired.
 *
 * Part B (real Chat + createChannel + createPluginManageEntry):
 *  - starts with sidebar CLOSED (`applySidePanelOpen(false)`):
 *    - `/plugin list` keeps original transcript text report (does NOT open sidebar);
 *    - `/plugin diagnostics` prints the full report while a split is available;
 *    - bare `/plugin` opens & focuses `plugins` side panel when `splitAvailable`;
 *  - right-clicking bundle opens context menu -> Enable -> Enter confirms
 *    PluginManagePane (not stolen by sidePanel.handleKey), updates service, and
 *    refreshes panel row to ✓;
 *  - right-click Remove -> Esc cancels cleanly -> repeat & Enter removes bundle;
 *  - pressing `i` focuses chat and prefills `/plugin install `.
 *
 * Run: node --import tsx/esm scripts/verify-plugins-panel.tsx
 */
import './lib/fake-home.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import type { PluginPanelBundle } from '../src/adapter/ports/channel-ui.js'
import type { PluginManagerView } from '../src/dsh-adapter/plugin-manager.js'
import type { BundleInfo, ChangeResult, PluginEntryId, PluginInfo } from '@deepseek-ai/dsh-plugin-manager/types'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  ui,
  { SidePanelLayout },
  { SidePanelColumn },
  { useSidePanel },
  { registerBuiltinPanels },
  { panelStore },
  prefs,
  { t, setLang },
  { stringWidth },
  termTest,
  { Chat },
  { QuestionStore },
  { ApprovalStore },
  { createChannel },
  { kernelEntriesOf },
  { listBackends },
  { createPluginManageEntry },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/components/sidePanel/builtinPanels.js'),
  import('../src/components/sidePanel/PanelStore.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/i18n.js'),
  import('../src/ink/stringWidth.js'),
  import('./lib/term-test.mjs'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/components/kernelCatalog.js'),
  import('../src/dsh-adapter/backend-registry.js'),
  import('../src/dsh-adapter/plugin-manage.js'),
])

const { render, AlternateScreen, Box, Text, useInput } = ui
const { applySidePanelOpen, applySidePanelPanels, applySidePanelRatio, applySidePanelSplitEnabled } = prefs
const { findText, settled, sleep, viewportLines } = termTest

setLang('en')
registerBuiltinPanels()

let failed = 0
let passed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (ok ? '' : '  (' + extra + ')'))
  if (ok) passed += 1
  else failed += 1
}

class FakeStdout extends Writable {
  columns: number
  rows: number
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal, cols: number, rows: number) {
    super()
    this.term = term
    this.columns = cols
    this.rows = rows
  }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

function sendLeftClick(stdin: FakeStdin, col0: number, row0: number): void {
  const c = col0 + 1
  const r = row0 + 1
  stdin.write(`\x1b[<0;${c};${r}M\x1b[<0;${c};${r}m`)
}

function sendRightClick(stdin: FakeStdin, col0: number, row0: number): void {
  const c = col0 + 1
  const r = row0 + 1
  stdin.write(`\x1b[<2;${c};${r}M\x1b[<2;${c};${r}m`)
}

const SAMPLE_BUNDLES: PluginPanelBundle[] = [
  {
    name: 'my-plugin',
    title: 'My Plugin',
    version: '1.2.3',
    enabled: true,
    installed: true,
    removable: true,
    optional: false,
    readOnlyReason: undefined,
    error: undefined,
    group: 'extra',
    rows: 2,
    overrides: 1,
  },
  {
    name: 'locked-plugin',
    title: 'Locked Plugin With A Very Long Title That Must Truncate',
    version: '0.5.0',
    enabled: false,
    installed: true,
    // Removable by itself, but the read-only reason wins: the management guard
    // refuses before it ever reads `removable`, so the menu must not offer Remove.
    removable: true,
    optional: false,
    readOnlyReason: 'management-required',
    error: { code: 'bundle-in-use' },
    group: 'extra',
    rows: 1,
    overrides: 0,
  },
  {
    name: '@deepseek-ai/dsh-experimental-auto-review',
    title: 'Auto review',
    version: '0.2.2-rc.3',
    enabled: false,
    installed: false,
    removable: false,
    optional: true,
    readOnlyReason: undefined,
    error: undefined,
    group: 'experimental',
    rows: 1,
    overrides: 0,
  },
  {
    name: '@deepseek-ai/dsh-base',
    title: 'dsh-base',
    version: '0.2.2-rc.3',
    enabled: true,
    installed: false,
    removable: false,
    optional: false,
    readOnlyReason: undefined,
    error: undefined,
    group: 'base',
    rows: 4,
    overrides: 2,
  },
  {
    name: '@deepseek-harness-tui/dsh-tui',
    title: 'dsh-tui',
    version: '0.20.1',
    enabled: true,
    installed: true,
    removable: false,
    optional: false,
    readOnlyReason: undefined,
    error: undefined,
    group: 'base',
    rows: 1,
    overrides: 0,
  },
]

// ── Part A: SidePanelColumn + PanelHost + PluginsPanel ───────────────────────
{
  const COLS = 120
  const ROWS = 26
  applySidePanelSplitEnabled(true)
  applySidePanelOpen(true)
  applySidePanelPanels('todo,plugins')
  applySidePanelRatio(0.68)

  let bundleFetchCount = 0
  let subscribeCalls = 0
  let currentBundles: PluginPanelBundle[] = [...SAMPLE_BUNDLES]
  let failNextFetch = false
  let pendingResolve: ((list: readonly PluginPanelBundle[]) => void) | undefined
  let holdNextFetch = true
  const bundleSubscribers = new Set<() => void>()
  const channelListeners = new Set<() => void>()
  let channelVer = 0
  const manageCalls: string[] = []
  let installCalls = 0
  let diagnosticsCalls = 0
  let pluginServiceAvailable = true

  const channelStub: Record<string, unknown> = {
    get version() { return channelVer },
    rows: [],
    status: 'idle',
    working: false,
    todos: [],
    subagents: [],
    goal: undefined,
    agentBindingGeneration: 1,
    configuredLang: 'en',
    displayCwd: '/tmp/demo',
    cwd: '/tmp/demo',
    gitBranch: 'main',
    sessionTitle: 'plugins-test',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    model: 'deepseek-chat',
    provider: 'deepseek',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    mode: { plan: false },
    notifications: [],
    backgroundJobs: [],
    subscribe(fn: () => void) { channelListeners.add(fn); return () => { channelListeners.delete(fn) } },
    notify() { return () => {} },
    pluginPanelAvailable: () => pluginServiceAvailable,
    pluginPanelBundles() {
      bundleFetchCount += 1
      if (holdNextFetch) {
        holdNextFetch = false
        return new Promise<readonly PluginPanelBundle[]>(resolve => { pendingResolve = resolve })
      }
      if (failNextFetch) return Promise.reject(new Error('host plugin service crashed'))
      return Promise.resolve([...currentBundles])
    },
    subscribePluginBundles(fn: () => void) {
      subscribeCalls += 1
      bundleSubscribers.add(fn)
      return () => { bundleSubscribers.delete(fn) }
    },
  }

  let spController: ReturnType<typeof useSidePanel> | undefined

  function ColumnHarness(): React.ReactNode {
    const [channelTick, setChannelTick] = React.useState(0)
    React.useEffect(() => (channelStub.subscribe as (fn: () => void) => () => void)(() => setChannelTick(n => n + 1)), [])
    void channelTick
    const sp = useSidePanel({ columns: COLS, fullscreen: true, editorOpen: false })
    spController = sp
    useInput((input, key, event) => {
      sp.handleKey(input, key, event)
    })
    return (
      <SidePanelLayout
        geometry={sp.geometry}
        focus={sp.focus}
        onActivateChat={sp.focusChat}
        onActivatePanel={sp.focusPanel}
        onResize={sp.resize}
        side={
          <SidePanelColumn
            width={sp.panelColumns}
            controller={sp}
            channel={channelStub as never}
            managePlugin={(action, name) => { manageCalls.push(`${action}:${name}`) }}
            showPluginDiagnostics={() => { diagnosticsCalls += 1 }}
            installPlugin={() => { installCalls += 1 }}
          />
        }
      >
        <Box flexDirection="column">
          <Text>{`CHAT focus=${sp.focus} active=${sp.activePanelId ?? 'none'}`}</Text>
        </Box>
      </SidePanelLayout>
    )
  }

  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term, COLS, ROWS)
  const stdin = new FakeStdin()
  const app = await render(
    <AlternateScreen mouseTracking><ColumnHarness /></AlternateScreen>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const view = () => viewportLines(term).join('\n')

  await settled(() => spController !== undefined)
  spController!.openPanel('plugins', { focus: true })
  check('A1: initial mount shows loading state',
    await settled(() => view().includes(t('plugins-panel-loading'))), view())

  pendingResolve!(currentBundles)
  check('A2: renders grouped bundles after load',
    await settled(() => view().includes('My Plugin') && view().includes('Auto review') && view().includes('Base (2)')), view())
  check('A3: initial focus lands on first bundle (❯ My Plugin), not divider',
    await settled(() => view().split('\n').some(line => line.includes('❯') && line.includes('My Plugin'))), view())
  check('A4: footer hint shows m/right-click:menu',
    await settled(() => panelStore.get('plugins')?.hint === 'm/right-click:menu'), String(panelStore.get('plugins')?.hint))
  check('A5: wide column (38 cols) shows version column',
    view().includes('1.2.3') && view().includes('0.2.2-rc.3'), view())

  // Narrow ratio / width: panel < 36 hides version column and keeps each bundle on one row
  applySidePanelRatio(0.76) // ~28 panel cols
  check('A6: narrow panel hides version column and keeps long title on a single row',
    await settled(() => {
      if (view().includes('1.2.3') || !view().includes('My Plugin')) return false
      const myRow = findText(term, 'My Plugin')?.row
      const lockedRow = findText(term, 'Locked Plugin')?.row
      return myRow !== undefined && lockedRow !== undefined && lockedRow === myRow + 1
    }), view())
  // A clipped terminal row never reports an over-wide string (XTerm writes into
  // a fixed grid), so check the divider column itself: panel content that
  // overdraws the divider replaces the vertical bar, and an overflowing status
  // column would land outside the panel. Both are visible in the grid.
  const panelColumns = spController!.geometry?.panel ?? 0
  const dividerColumn = COLS - panelColumns - 1
  const dividerColumns = new Set<number>()
  for (const line of viewportLines(term)) {
    const at = line.indexOf('│')
    if (at >= 0) dividerColumns.add(at)
  }
  check('A6b: divider stays at its computed column in the narrow panel',
    dividerColumns.size === 1 && dividerColumns.has(dividerColumn),
    `found ${[...dividerColumns].join(',')} expected ${dividerColumn}`)
  const rowStaysInPanel = (pos: { row: number } | null, status: string): boolean => {
    if (pos === null) return false
    const line = viewportLines(term)[pos.row] ?? ''
    const panelPart = line.slice(dividerColumn + 1)
    return line[dividerColumn] === '│' && stringWidth(panelPart) <= panelColumns && panelPart.trimEnd().endsWith(status)
  }
  check('A6b2: title and status stay inside the sidebar (divider not overdrawn)',
    rowStaysInPanel(findText(term, 'My Plugin'), '✓') && rowStaysInPanel(findText(term, 'Locked Plugin'), '✗'),
    view())
  applySidePanelRatio(0.68)
  await settled(() => view().includes('1.2.3'))
  // Switching away from plugins unmounts PluginsPanel (mountPolicy='active') and clears its hint
  spController!.openPanel('todo', { focus: true })
  check('A6c: unmounting PluginsPanel on panel switch clears panelStore hint',
    await settled(() => spController!.activePanelId === 'todo' && panelStore.get('plugins')?.hint === ''),
    String(panelStore.get('plugins')?.hint))
  spController!.openPanel('plugins', { focus: true })
  await settled(() => view().includes('1.2.3') && panelStore.get('plugins')?.hint === 'm/right-click:menu')

  // Mouse left-click on Auto review (even while chat is focused!) selects AND expands it immediately
  spController!.focusChat()
  await settled(() => view().includes('focus=chat'))
  const autoPos = findText(term, 'Auto review')
  check('A7a: located Auto review row for mouse click', autoPos !== null, view())
  sendLeftClick(stdin, autoPos!.col, autoPos!.row)
  check('A7b: left-click on bundle row selects it, focuses panel, and expands BundleDetail',
    await settled(() => view().includes('focus=panel') && view().split('\n').some(line => line.includes('❯') && line.includes('Auto review')) && view().includes('@deepseek-ai/dsh-experimental-') && view().includes('1 rows · 0 overrides')), view())

  // Clicking the same expanded bundle row collapses BundleDetail
  sendLeftClick(stdin, autoPos!.col + 3, autoPos!.row)
  check('A7c: second left-click on expanded bundle collapses BundleDetail',
    await settled(() => !view().includes('1 rows · 0 overrides')), view())

  // Left-click on Base (2) expands Base section, second left-click (offset col) collapses it
  const basePos = findText(term, 'Base (2)')
  check('A8a: located Base (2) row for mouse click', basePos !== null, view())
  sendLeftClick(stdin, basePos!.col, basePos!.row)
  check('A8b: left-click on Base (2) expands base rows',
    await settled(() => view().includes('▾ Base (2)') && view().includes('dsh-base') && view().includes('dsh-tui')), view())
  sendLeftClick(stdin, basePos!.col + 3, basePos!.row)
  check('A8c: second left-click on Base (2) collapses base rows',
    await settled(() => view().includes('▸ Base (2)') && !view().includes('dsh-base')), view())

  // No e/d/r single-letter shortcuts on rows
  const myPos = findText(term, 'My Plugin')
  sendLeftClick(stdin, myPos!.col, myPos!.row)
  await settled(() => view().split('\n').some(line => line.includes('❯') && line.includes('My Plugin')) && view().includes('2 rows · 1 overrides'))
  // Collapse My Plugin detail before testing Esc / menu
  stdin.write('\x1b')
  await settled(() => !view().includes('2 rows · 1 overrides'))
  stdin.write('e')
  await sleep(30) // 固定窗:pacing 分隔单字符键确认不触发旧快捷键
  stdin.write('d')
  await sleep(30) // 固定窗:pacing 分隔单字符键确认不触发旧快捷键
  stdin.write('r')
  await sleep(60) // 固定窗:探针 验证已移除 e/d/r 键盘快捷键，不会调用 managePlugin
  check('A9: e/d/r letter keys do NOT invoke managePlugin', manageCalls.length === 0, JSON.stringify(manageCalls))

  // `m` opens the same menu from the keyboard (no mouse), then Esc closes it
  stdin.write('m')
  check('A9b: m opens the focused row context menu from the keyboard',
    await settled(() => view().includes('Disable') && view().includes('Remove')), view())
  stdin.write('\x1b')
  check('A9c: Esc closes the keyboard-opened menu and keeps panel focus',
    await settled(() => !view().includes('Disable') && view().includes('focus=panel')), view())

  // Right-click on Auto review opens context menu (Enable only — no Remove, no Details)
  sendRightClick(stdin, autoPos!.col, autoPos!.row)
  check('A10: right-click on Auto review opens context menu with Enable',
    await settled(() => view().includes('Enable') && !view().includes('Remove') && !view().includes('Details')), view())
  // Press Enter on first menu item (Enable) -> invokes managePlugin enable & closes menu
  stdin.write('\r')
  check('A11: menu Enable triggers managePlugin enable and closes menu',
    await settled(() => manageCalls.length === 1 && manageCalls[0] === 'enable:@deepseek-ai/dsh-experimental-auto-review' && !view().includes('Enable')),
    JSON.stringify(manageCalls) + '\n' + view())

  // Right-click on My Plugin -> menu has Disable, Remove
  sendRightClick(stdin, myPos!.col, myPos!.row)
  check('A12: right-click on removable My Plugin shows Disable and Remove',
    await settled(() => view().includes('Disable') && view().includes('Remove') && !view().includes('Details')), view())
  // Click Remove item in context menu
  const removeItem = findText(term, 'Remove')
  sendLeftClick(stdin, removeItem!.col, removeItem!.row)
  check('A13: clicking Remove in context menu triggers managePlugin remove and closes menu',
    await settled(() => manageCalls.length === 2 && manageCalls[1] === 'remove:my-plugin' && !view().includes('Disable')),
    JSON.stringify(manageCalls) + '\n' + view())

  // Right-click Locked Plugin -> no context menu (readOnly wins over removable)
  const lockedPos = findText(term, 'Locked Plugin')
  sendRightClick(stdin, lockedPos!.col, lockedPos!.row)
  await sleep(60) // 固定窗:探针 确认只读行右键不弹出空菜单（即使 removable=true）
  check('A14: right-click on readOnly Locked Plugin (removable=true) opens no menu',
    !view().includes('Enable') && !view().includes('Disable') && !view().includes('Remove'), view())

  // Open menu on My Plugin then test Esc Layer 1 closing menu without blurring panel
  sendRightClick(stdin, myPos!.col, myPos!.row)
  await settled(() => view().includes('Disable'))
  stdin.write('\x1b')
  check('A15: first Esc closes context menu and keeps focus in panel',
    await settled(() => !view().includes('Disable') && view().includes('focus=panel')), view())

  // Open menu on My Plugin, then background refresh flips enabled -> menu closes instead of flipping action under cursor
  sendRightClick(stdin, myPos!.col, myPos!.row)
  check('A15b-open: context menu is open before the refresh',
    await settled(() => view().includes('Disable')), view())
  currentBundles = SAMPLE_BUNDLES.map(b => b.name === 'my-plugin' ? { ...b, enabled: false } : b)
  for (const fn of bundleSubscribers) fn()
  check('A15b: background refresh changing bundle menu actions closes stale context menu',
    await settled(() => !view().includes('Disable') && !view().includes('Enable') && panelStore.get('plugins')?.hint === 'm/right-click:menu'
      && view().split('\n').some(line => line.includes('My Plugin') && line.includes('·'))), view())
  currentBundles = [...SAMPLE_BUNDLES]
  for (const fn of bundleSubscribers) fn()
  await settled(() => view().split('\n').some(l => l.includes('My Plugin') && l.includes('✓')))

  // Enter opens BundleDetail on My Plugin
  stdin.write('\r')
  check('A16: Enter opens inline BundleDetail',
    await settled(() => view().includes('my-plugin') && view().includes('2 rows · 1 overrides')), view())
  stdin.write('\x1b')
  check('A17: Esc collapses BundleDetail and keeps focus in panel',
    await settled(() => !view().includes('2 rows · 1 overrides') && view().includes('focus=panel')), view())
  stdin.write('\x1b')
  check('A18: second Esc returns focus to chat',
    await settled(() => view().includes('focus=chat')), view())

  // Stale expandedBundle cleanup when Base collapses
  spController!.openPanel('plugins', { focus: true })
  await settled(() => view().includes('focus=panel'))
  sendLeftClick(stdin, basePos!.col, basePos!.row)
  await settled(() => view().includes('dsh-base'))
  const baseRowPos = findText(term, 'dsh-base')
  sendLeftClick(stdin, baseRowPos!.col, baseRowPos!.row)
  await settled(() => view().split('\n').some(line => line.includes('❯') && line.includes('dsh-base')) && view().includes('4 rows · 2 overrides'))
  sendLeftClick(stdin, basePos!.col, basePos!.row)
  await settled(() => !view().includes('4 rows · 2 overrides'))
  stdin.write('\x1b')
  check('A19: stale expandedBundle cleared on collapse so single Esc yields to chat',
    await settled(() => view().includes('focus=chat')), view())
  // Collapsing already makes the detail disappear; the stale state only shows
  // up when the group is expanded again without selecting a bundle.
  spController!.openPanel('plugins', { focus: true })
  await settled(() => view().includes('focus=panel')
    && view().split('\n').some(line => line.includes('❯') && line.includes('Base (2)')))
  stdin.write('\r')
  check('A19b: re-expanding Base does not resurrect the stale bundle detail',
    await settled(() => view().includes('dsh-base') && !view().includes('4 rows · 2 overrides')), view())

  // channel.version bump must NOT trigger bundle refetch
  spController!.openPanel('plugins', { focus: true })
  await settled(() => view().includes('focus=panel'))
  const fetchesBeforeChannelBump = bundleFetchCount
  channelVer += 1
  for (const fn of channelListeners) fn()
  await sleep(80) // 固定窗:探针 确认 channel.version 递增不会触发 pluginPanelBundles 重拉
  check('A20: unrelated channel.version bump does not refetch pluginPanelBundles',
    bundleFetchCount === fetchesBeforeChannelBump, `${fetchesBeforeChannelBump} -> ${bundleFetchCount}`)

  // subscribePluginBundles background refresh keeps focus and does not flash LoadingState while held
  currentBundles = [
    ...SAMPLE_BUNDLES,
    {
      name: 'third-plugin', title: 'Third Plugin', version: '0.1.0',
      enabled: true, installed: true, removable: true, optional: false,
      readOnlyReason: undefined, error: undefined, group: 'extra', rows: 0, overrides: 0,
    },
  ]
  holdNextFetch = true
  const fetchesBeforeBg = bundleFetchCount
  for (const fn of bundleSubscribers) fn()
  await settled(() => bundleFetchCount === fetchesBeforeBg + 1)
  // The counter moves synchronously from the subscription callback; wait one
  // frame so a stray setLoading(true) would have painted before the assertion.
  await sleep(30) // 固定窗:探针 确认后台刷新已提交后再断言没有加载态
  check('A21a: in-flight background refresh keeps existing list on screen without LoadingState',
    !view().includes(t('plugins-panel-loading'))
    && view().includes('My Plugin')
    && view().split('\n').some(line => line.includes('❯') && line.includes('Base (2)')),
    view())
  pendingResolve!(currentBundles)
  check('A21b: resolved background refresh updates list and preserves Base (2) focus',
    await settled(() => view().includes('Third Plugin') && view().split('\n').some(line => line.includes('❯') && line.includes('Base (2)'))),
    view())

  // Deferred adoption / session rebind (agentBindingGeneration increment) re-subscribes subscribePluginBundles
  const subsBeforeRebind = subscribeCalls
  channelStub.agentBindingGeneration = 2
  channelVer += 1
  for (const fn of channelListeners) fn()
  check('A21c: agentBindingGeneration bump re-subscribes subscribePluginBundles',
    await settled(() => subscribeCalls === subsBeforeRebind + 1), `${subsBeforeRebind} -> ${subscribeCalls}`)
  // A re-subscribe must replace the old listener, not add a second one. Emitting
  // one notification would otherwise start two reads.
  check('A21c2: rebind leaves exactly one bundle subscriber',
    bundleSubscribers.size === 1, `subscribers=${bundleSubscribers.size}`)
  const fetchesBeforeRebindNotify = bundleFetchCount
  for (const fn of bundleSubscribers) fn()
  check('A21c3: one notification after rebind starts exactly one read',
    await settled(() => bundleFetchCount === fetchesBeforeRebindNotify + 1)
    && bundleFetchCount === fetchesBeforeRebindNotify + 1,
    `${fetchesBeforeRebindNotify} -> ${bundleFetchCount}`)

  // Scroll follow test: load 26 items to overflow the ScrollBox, navigate to bottom and expand detail
  currentBundles = Array.from({ length: 26 }, (_, idx) => ({
    name: `scroll-plugin-${idx}`,
    title: `Scroll Plugin ${idx}`,
    version: '1.0.0',
    enabled: true,
    installed: true,
    removable: true,
    optional: false,
    readOnlyReason: undefined,
    error: undefined,
    group: 'extra',
    rows: idx + 1,
    overrides: 0,
  }))
  for (const fn of bundleSubscribers) fn()
  await settled(() => view().includes('Scroll Plugin 0'))
  for (let i = 0; i < 25; i += 1) stdin.write('\x1b[B')
  check('A22: down navigation scrolls last bundle (Scroll Plugin 25) into view',
    await settled(() => view().split('\n').some(line => line.includes('❯') && line.includes('Scroll Plugin 25'))), view())
  stdin.write('\r')
  check('A23: expanding detail on last row scrolls BundleDetail into view',
    await settled(() => view().includes('scroll-plugin-25') && view().includes('26 rows · 0 overrides')), view())

  // Error state: open context menu on last row, then fail background refresh -> menu closes,
  // hint clears, Enter does not fire hidden menu action, and single Esc returns focus to chat.
  const lastRowPos = findText(term, 'Scroll Plugin 25')
  sendRightClick(stdin, lastRowPos!.col, lastRowPos!.row)
  check('A24a: context menu opened on last row before refresh failure',
    await settled(() => view().includes('Disable')), view())
  const manageBeforeError = manageCalls.length
  failNextFetch = true
  for (const fn of bundleSubscribers) fn()
  const panelText = () => viewportLines(term).map(l => {
    const idx = l.indexOf('│')
    return idx >= 0 ? l.slice(idx + 1).trim() : l.trim()
  }).join(' ')
  check('A24: rejected pluginPanelBundles renders error state and clears menu/hint',
    await settled(() => panelText().includes('Failed to load: host plugin service crashed') && panelStore.get('plugins')?.hint === ''), view())
  stdin.write('\r')
  await sleep(40) // 固定窗:探针 确认错误态下按 Enter 不会触发隐藏菜单的 managePlugin
  stdin.write('\x1b')
  check('A24b: error state ignores Enter on hidden menu and single Esc returns focus to chat',
    await settled(() => view().includes('focus=chat')) && manageCalls.length === manageBeforeError, view())
  spController!.openPanel('plugins', { focus: true })
  await settled(() => view().includes('focus=panel'))

  // Recover a changed inventory: the selected index and expanded bundle stay,
  // but the version proves the rendered row comes from the fresh response, not
  // the list that was on screen before the failure.
  failNextFetch = false
  currentBundles = currentBundles.map(bundle => bundle.name === 'scroll-plugin-25' ? { ...bundle, version: '1.0.1' } : bundle)
  holdNextFetch = true
  const fetchesBeforeRecovery = bundleFetchCount
  for (const fn of bundleSubscribers) fn()
  await settled(() => bundleFetchCount === fetchesBeforeRecovery + 1)
  await sleep(30) // 固定窗:探针 确认恢复请求在飞时不会先恢复旧列表
  check('A24c1: the error view stays up until the recovery response lands',
    panelText().includes('Failed to load'), view())
  pendingResolve!(currentBundles)
  check('A24c: recovery renders the fresh list and restores the focused last row and detail',
    await settled(() => view().split('\n').some(line => line.includes('❯') && line.includes('Scroll Plugin 25')
      && line.includes('1.0.1'))
      && view().includes('scroll-plugin-25') && view().includes('26 rows · 0 overrides')), view())
  stdin.write('\x1b[A')
  check('A24d: navigation after recovery continues from the retained last bundle',
    await settled(() => view().split('\n').some(line => line.includes('❯') && line.includes('Scroll Plugin 24'))), view())

  // A normal successful refresh must not undo the user's wheel position just
  // to reveal the retained keyboard selection. The visible version proves the
  // response was rendered before checking that the viewport stayed at the top.
  for (let i = 0; i < 8; i += 1) stdin.write(`\x1b[<64;${COLS - 3};6M`)
  check('A24e: wheel can scroll away from the retained keyboard selection',
    await settled(() => view().includes('Scroll Plugin 0') && !view().includes('Scroll Plugin 24')), view())
  currentBundles = currentBundles.map(bundle => bundle.name === 'scroll-plugin-0' ? { ...bundle, version: '1.0.1' } : bundle)
  for (const fn of bundleSubscribers) fn()
  check('A24f: ordinary background refresh keeps the user-selected wheel position',
    await settled(() => view().split('\n').some(line => line.includes('Scroll Plugin 0') && line.includes('1.0.1')))
      && !view().includes('Scroll Plugin 24'), view())

  // Empty state + i key
  currentBundles = []
  for (const fn of bundleSubscribers) fn()
  check('A25: empty list renders empty message and i:install hint',
    await settled(() => view().includes('No registered plugins') && panelStore.get('plugins')?.hint === 'i:install'), view())
  stdin.write('i')
  await settled(() => installCalls === 1)
  check('A26: pressing i invokes installPlugin', installCalls === 1, String(installCalls))

  // 宿主没有插件服务：居中说明 + d 出口；不是加载态，也不是“服务在但零 bundle”
  const fetchesBeforeUnavailable = bundleFetchCount
  pluginServiceAvailable = false
  spController!.openPanel('todo', { focus: true })
  await settled(() => spController!.activePanelId === 'todo')
  spController!.openPanel('plugins', { focus: true })
  check('A27: missing plugin service renders the centered explanation, not loading or empty list',
    await settled(() => view().includes('Plugin service absent')
      && view().includes('No plugin service here.')
      && view().includes('Full diagnostics')
      && !view().includes(t('plugins-panel-loading'))
      && !view().includes('No registered plugins')), view())
  check('A27b: missing service does not fetch pluginPanelBundles and shows the d hint',
    bundleFetchCount === fetchesBeforeUnavailable && panelStore.get('plugins')?.hint === 'd:diagnostics',
    `${fetchesBeforeUnavailable} -> ${bundleFetchCount} · ${panelStore.get('plugins')?.hint}`)
  stdin.write('d')
  check('A27c: d opens the full diagnostics', await settled(() => diagnosticsCalls === 1), String(diagnosticsCalls))
  const diagAction = findText(term, 'Full diagnostics')
  sendLeftClick(stdin, diagAction!.col, diagAction!.row)
  check('A27d: clicking the action opens the full diagnostics too',
    await settled(() => diagnosticsCalls === 2), String(diagnosticsCalls))
  stdin.write('\x1b')
  check('A27e: Esc from the unavailable state returns focus to chat',
    await settled(() => view().includes('focus=chat')), view())
  spController!.openPanel('plugins', { focus: true })
  const dividerColumnNow = (): number => {
    for (const line of viewportLines(term)) {
      const at = line.indexOf('│')
      if (at >= 0) return at
    }
    return -1
  }
  applySidePanelRatio(0.76)
  check('A27f: narrow (28 cols) keeps the title, body and action on screen',
    await settled(() => dividerColumnNow() === COLS - 28 - 1
      && view().includes('Plugin service absent')
      && view().includes('are unavailable.')
      && view().includes('Full diagnostics')), view())
  applySidePanelRatio(0.68)
  pluginServiceAvailable = true
  spController!.openPanel('todo', { focus: true })
  await settled(() => spController!.activePanelId === 'todo')
  spController!.openPanel('plugins', { focus: true })
  check('A27g: service becoming available restores the empty list and i hint',
    await settled(() => view().includes('No registered plugins') && panelStore.get('plugins')?.hint === 'i:install'), view())

  // A28: partial channel stubs can omit BOTH capabilities. That must read as
  // "service absent" (centered card), not call a missing method and trip
  // PanelErrorBoundary. This is the shape used by verify-side-panel-registry's
  // thin channelStub.
  const availableMethod = channelStub.pluginPanelAvailable
  const bundlesMethod = channelStub.pluginPanelBundles
  const panelErrorsBefore = panelStore.get('plugins')?.lastError ?? null
  delete channelStub.pluginPanelAvailable
  delete channelStub.pluginPanelBundles
  spController!.openPanel('todo', { focus: true })
  await settled(() => spController!.activePanelId === 'todo')
  spController!.openPanel('plugins', { focus: true })
  check('A28: channel without plugin capabilities degrades to the unavailable card',
    await settled(() => view().includes('Plugin service absent')
      && !view().includes(t('panel-error-title'))), view())
  check('A28b: that path records no panel error',
    panelStore.get('plugins')?.lastError === panelErrorsBefore,
    String(panelStore.get('plugins')?.lastError?.message ?? panelStore.get('plugins')?.lastError))

  // A29: an older stub that only implements the data method still loads the
  // list: availability falls back to pluginPanelBundles being callable.
  channelStub.pluginPanelBundles = bundlesMethod
  currentBundles = [...SAMPLE_BUNDLES]
  spController!.openPanel('todo', { focus: true })
  await settled(() => spController!.activePanelId === 'todo')
  spController!.openPanel('plugins', { focus: true })
  check('A29: channel exposing only pluginPanelBundles still loads the list',
    await settled(() => view().includes('My Plugin') && !view().includes(t('panel-error-title'))), view())
  channelStub.pluginPanelAvailable = availableMethod

  await app.unmount()
}

// ── Part B: Real Chat + /plugin (from closed sidebar) + /plugin list + right-click menu ──
{
  const COLS = 120
  const ROWS = 36
  applySidePanelSplitEnabled(true)
  applySidePanelOpen(false)
  applySidePanelPanels('*')
  applySidePanelRatio(0.68)

  const changedListeners = new Set<() => void>()
  let bundles: BundleInfo[] = [
    {
      name: 'demo-plugin',
      version: '1.0.0',
      enabled: false,
      installed: true,
      optional: false,
      removable: true,
      meta: { title: { en: 'Demo Plugin', zh: '示例插件' } },
      rows: [{ rowId: 'demo-row', moduleName: 'demo-plugin' }],
      overrides: [],
    },
    {
      name: '@deepseek-ai/dsh-base',
      version: '0.2.2-rc.3',
      enabled: true,
      installed: false,
      optional: false,
      removable: false,
      rows: [],
      overrides: [],
    },
    {
      name: '@deepseek-ai/dsh-experimental-tool-worktree',
      version: '0.2.2-rc.3',
      enabled: false,
      installed: false,
      optional: true,
      removable: false,
      rows: [],
      overrides: [],
    },
    {
      name: '@deepseek-ai/dsh-experimental-auto-review',
      version: '0.2.2-rc.3',
      enabled: false,
      installed: false,
      optional: true,
      removable: false,
      rows: [],
      overrides: [],
    },
  ]
  const plugins: PluginInfo[] = [
    { entryId: 'entry-base' as PluginEntryId, moduleName: '@deepseek-ai/dsh-base', enabled: true, fiberPhase: 'active', patchId: 'base' },
  ]
  const okResult = (changed = true): ChangeResult => ({
    changed,
    application: 'applied',
    generationId: 'gen-2',
    failures: [],
    warnings: [],
    restarts: [],
  })

  let removeBundleCalls = 0
  const manager: PluginManagerView = {
    listBundles: () => Promise.resolve(bundles.map(b => ({ ...b }))),
    listPlugins: () => Promise.resolve(plugins.map(p => ({ ...p }))),
    registries: async () => ({ registry: 'https://registry.npmjs.org', fallbackRegistries: [], resolved: 'https://registry.npmjs.org' }),
    inspect: async () => ({ status: 'refused', problem: 'not-found', reason: 'mock' }),
    installBundle: async () => okResult(false),
    cancelInstall: async () => ({ status: 'not-found' }),
    setBundleEnabled: async (name, enabled) => {
      bundles = bundles.map(b => b.name === name ? { ...b, enabled } : b)
      for (const fn of [...changedListeners]) fn()
      return okResult(true)
    },
    setPluginEnabled: async () => okResult(false),
    removeBundle: async (name) => {
      removeBundleCalls += 1
      bundles = bundles.filter(b => b.name !== name)
      // Deliberately do NOT fire changedListeners here: B7 verifies that Chat's
      // usePluginWriteFlow onDone -> pluginWriteRevision refreshes the panel on its own.
      return okResult(true)
    },
    listVersionExemptions: () => ({ exemptions: {}, warnings: [] }),
    setVersionExemption: async () => okResult(false),
  }

  let managerVisible = true
  const ctx = {
    on: (name: string, fn: () => void) => {
      if (name === 'plugin-manager/changed') {
        changedListeners.add(fn)
        return () => { changedListeners.delete(fn) }
      }
      return () => undefined
    },
    get: (name: string) => managerVisible && name === 'pluginManager' ? manager : undefined,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
  } as never

  const agent = {
    id: 'plugin-panel-chat',
    status: 'idle',
    session: { id: 's-plugin-panel-chat', seq: 0, events: [], header: { cwd: process.cwd() } },
    ctx: { on: () => () => undefined },
    followup() {},
    steer() {},
    cancel() {},
    inbox: { remove: () => true },
  }

  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term, COLS, ROWS)
  const stdin = new FakeStdin()
  const channel = createChannel(ctx, agent as never, { model: 'deepseek-chat', provider: '', cwd: process.cwd(), activity: false })

  const instance = await render(
    <AlternateScreen mouseTracking>
      {React.createElement(Chat, {
        channel: channel as never,
        questionStore: new QuestionStore(),
        approvalStore: new ApprovalStore(),
        onExit: () => undefined,
        fullscreen: true,
        trajectorySeen: true,
        kernelEntries: kernelEntriesOf(listBackends()),
        onPluginManage: createPluginManageEntry(ctx, { profileName: 'dsh-tui' }),
      })}
    </AlternateScreen>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  const screen = () => viewportLines(term).join('\n')
  const runCmd = async (cmd: string) => {
    stdin.write(cmd)
    await sleep(60) // 固定窗:pacing 命令文本与提交 Enter 分属两个 chunk
    stdin.write('\r')
  }

  await sleep(250) // 固定窗:pacing 等 Chat 首帧键盘监听挂载

  const sidebarHas = (needle: string): boolean =>
    viewportLines(term).some(l => {
      const idx = l.indexOf('│')
      return idx >= 0 && l.slice(idx + 1).includes(needle)
    })
  const findInSidebar = (needle: string): { col: number; row: number } | null => {
    const lines = viewportLines(term)
    for (let row = 0; row < lines.length; row += 1) {
      const line = lines[row]!
      const divider = line.indexOf('│')
      if (divider < 0) continue
      const col = line.indexOf(needle, divider + 1)
      if (col >= 0) return { col, row }
    }
    return null
  }

  // Experimental ordering across non-experimental entries + B1 `/plugin list` keeps sidebar closed
  const projectedExp = (await channel.pluginPanelBundles()).filter(b => b.group === 'experimental').map(b => b.name)
  check('B0: pluginPanelBundles sorts experimental entries in product order even across non-experimental rows',
    projectedExp[0] === '@deepseek-ai/dsh-experimental-auto-review' && projectedExp[1] === '@deepseek-ai/dsh-experimental-tool-worktree',
    JSON.stringify(projectedExp))

  // `/plugin list` keeps original transcript report and does NOT open sidebar
  await runCmd('/plugin list')
  check('B1: /plugin list keeps transcript text report without opening sidebar',
    await settled(() => screen().includes('Plugins you added') && prefs.getSidePanelOpen() === false), screen())

  // The explicit diagnostics form must reach the full report even while a split
  // is available; recovery messages in the grant flows point at it.
  await runCmd('/plugin diagnostics')
  check('B1b: /plugin diagnostics prints the full report instead of opening the sidebar',
    await settled(() => screen().includes('Plugins run in-process') && screen().includes('Grant matrix')
      && screen().includes('Installed bundles') && prefs.getSidePanelOpen() === false), screen())

  // Bare `/plugin` opens sidebar from closed state and focuses plugins panel
  await runCmd('/plugin')
  check('B2: bare /plugin opens closed sidebar and focuses plugins panel',
    await settled(() => sidebarHas('Demo Plugin') && panelStore.get('plugins')?.hint === 'm/right-click:menu' && screen().includes('Esc chat')), screen())

  // Runtime language switch refreshes localized bundle titles and panel hint
  setLang('zh')
  channel.emit()
  check('B2b: runtime setLang(zh) refreshes bundle title to 示例插件 and hint to m/右键:操作',
    await settled(() => sidebarHas('示例插件') && panelStore.get('plugins')?.hint === 'm/右键:操作'),
    `${panelStore.get('plugins')?.hint} | ${screen()}`)
  setLang('en')
  channel.emit()
  await settled(() => sidebarHas('Demo Plugin') && panelStore.get('plugins')?.hint === 'm/right-click:menu')

  // The host loses the profile plugin service: the panel keeps its explanation,
  // and `d` still reaches the full report (the recovery route).
  managerVisible = false
  channel.emit()
  check('B2c: missing plugin service renders the centered explanation in the real Chat sidebar',
    await settled(() => sidebarHas('Plugin service absent') && sidebarHas('Full diagnostics')
      && !sidebarHas('Demo Plugin')), screen())
  stdin.write('d')
  check('B2d: d prints the full diagnostics and hands focus back to chat',
    await settled(() => screen().includes('ctx.pluginManager') && !screen().includes('Esc chat')), screen())
  managerVisible = true
  channel.emit()
  check('B2e: restoring the service returns the bundle list',
    await settled(() => sidebarHas('Demo Plugin')), screen())

  // Right-click Demo Plugin -> open context menu -> choose Enable -> confirms PluginManagePane
  const demoPos = findInSidebar('Demo Plugin')
  check('B3a: located Demo Plugin row in real Chat sidebar', demoPos !== null, screen())
  sendRightClick(stdin, demoPos!.col, demoPos!.row)
  check('B3b: right-click opens context menu with Enable',
    await settled(() => screen().includes('Enable') && screen().includes('Remove')), screen())
  stdin.write('\r')
  check('B3c: selecting Enable opens PluginManagePane confirmation overlay',
    await settled(() => screen().includes('About to enable: demo-plugin')), screen())
  await sleep(100) // 固定窗:pacing 避开 Chat 80ms 模态 Enter 防抖窗口
  stdin.write('\r')
  check('B4: Enter confirms enable, updates service, and refreshes Demo Plugin to ✓',
    await settled(() => bundles[0]?.enabled === true && screen().split('\n').some(l => l.includes('Demo Plugin') && l.includes('✓'))), screen())

  // Right-click Demo Plugin -> Remove -> Esc cancels -> repeat & Enter removes
  sendRightClick(stdin, demoPos!.col, demoPos!.row)
  await settled(() => screen().includes('Disable') && screen().includes('Remove'))
  stdin.write('\x1b[B')
  await sleep(20) // 固定窗:pacing 菜单项下移到 Remove
  stdin.write('\r')
  check('B5: selecting Remove from right-click menu opens remove confirmation',
    await settled(() => screen().includes('About to remove: demo-plugin')), screen())
  await sleep(100) // 固定窗:pacing 确认浮层就绪后再按 Esc
  stdin.write('\x1b')
  check('B6: Esc cancels remove confirmation without calling removeBundle',
    await settled(() => !screen().includes('About to remove: demo-plugin'))
    && removeBundleCalls === 0
    && bundles.some(b => b.name === 'demo-plugin'),
    `removeBundleCalls=${removeBundleCalls}\n${screen()}`)

  sendRightClick(stdin, demoPos!.col, demoPos!.row)
  await settled(() => screen().includes('Remove'))
  stdin.write('\x1b[B')
  await sleep(20) // 固定窗:pacing 菜单项下移到 Remove
  stdin.write('\r')
  await settled(() => screen().includes('About to remove: demo-plugin'))
  await sleep(100) // 固定窗:pacing 避开 Chat 80ms 模态 Enter 防抖窗口
  stdin.write('\r')
  check('B7: confirming remove refreshes panel via pluginWriteRevision even without plugin-manager/changed',
    await settled(() => removeBundleCalls === 1 && bundles.every(b => b.name !== 'demo-plugin') && !sidebarHas('Demo Plugin')), screen())

  // Press `i` -> focuses chat and prefills `/plugin install `, typing appends to chat input
  stdin.write('i')
  await settled(() => screen().includes('/plugin install '))
  stdin.write('x')
  check('B8: pressing i focuses chat and prefills /plugin install (subsequent typing lands in chat)',
    await settled(() => screen().includes('/plugin install x')), screen())

  let releaseNotifyCount = 0
  channel.subscribePluginBundles(() => { releaseNotifyCount += 1 })
  const hostListenersBeforeRelease = [...changedListeners]
  for (const fn of [...changedListeners]) fn()
  check('B9a: subscriber is notified before releaseContributions',
    releaseNotifyCount === 1, `releaseNotifyCount=${releaseNotifyCount}`)
  await instance.unmount()
  channel.releaseContributions()
  for (const fn of hostListenersBeforeRelease) fn()
  check('B9: subscribePluginBundles stops notifying after releaseContributions',
    releaseNotifyCount === 1, `releaseNotifyCount=${releaseNotifyCount}`)
}

console.log(`verify-plugins-panel: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
