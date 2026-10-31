/**
 * sidePanel.panels 勾选式面板多选回归（用户实测反馈：kind:'text' + 教学文案
 * 不可用）。设置屏对该字段渲染 checkbox 行列表，值仍是 `*` 或逗号分隔字符串
 * （schema/契约零变化）。
 *
 * Locked behavior:
 *  r. 纯解析器：`*` = 全部已注册面板（内置按默认顺序、其余按注册表顺序）；
 *     显式列表原样返回（含未注册占位 id）；空/非法归一为 `*`；`*` 是整值
 *     形式（`*,todo` 非法）。
 *  p. 勾选↔值映射：行序固定为默认顺序（内置默认顺序 + 插件注册顺序），不随存储
 *     列表顺序或勾选移动；勾选态由同一解析器派生；Enter 与真 SGR 鼠标点击都走
 *     同一 toggle（点击即勾选/取消）。
 *  o. 顺序：已有 id 保持现有相对顺序（PanelBar 顺序是用户数据），新勾选**插回**
 *     它在固定默认顺序里的位置（不追加到尾部），取消即移除——写入的字符串逐字断言；
 *     `*` 下取消一行会先物化完整列表，绝不丢插件 id（issue #1662）。
 *  u. 「格式合法但尚无面板认领」的 id 在显式列表里显示为已勾选的占位行，
 *     不被静默丢弃；取消即移除。
 *  l. 活注册表：设置屏打开期间插件面板（plugin:panel 命名空间）注册即
 *     出现行、撤下即退场——撤下后已写入的 id 退化为占位行（扩展故事的
 *     两半：先占位、插件到位自动认领）。
 *  s. issue #1662 原场景：`*` 下插件面板显示为已勾选；取消任一内置行写回的
 *     显式列表仍含插件 id；高级行显示 `*`，编辑时展开成真实列表，未改动
 *     确认仍写回 `*`（不把展开结果钉进设置）。
 *  t. 高级行确认对照「打开编辑器时的快照」而非重算：编辑期间注册的新面板
 *     不会让未改动的确认退化成显式列表（否则刚到的面板会被关掉）。
 *  g. 至少一个面板：取消最后一个勾选被拒绝（空串在持久化契约里不可
 *     表示，会静默回落默认值），给出错误通知且零写入。
 *  a. 高级逃生：列表尾部的原始文本行进既有草稿编辑器（可改顺序/手填
 *     未来 id）；非法草稿按既有 invalid 语义拒绝。
 *  h. hint 点明插件面板默认出现、取消后才写成显式列表；kind 保持 'text'
 *     （持久化格式与发布 schema 不变）。
 *  n. 反向域名插件 id（manifest 语法，`com.example.echo:main`）：解析/归一化
 *     往返不变、畸形命名空间（`com..x`、`x.`）仍被拒；勾选写出该 id，以它存下
 *     的值重开仍是已勾选的常驻行（不是「仅本次运行」的临时行）；旧短名照旧。
 *
 * Run: node --import tsx/esm scripts/verify-panel-settings-picker.tsx
 */
export {}

process.env.FORCE_COLOR = '3'
// English UI copy is asserted below; pin the language before any module
// import resolves the startup lang (env > persisted > locale).
process.env.DSH_TUI_LANG = 'en'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Settings },
  { panelStore },
  { registerBuiltinPanels },
  { SETTING_DEFINITIONS },
  { ALL_SIDE_PANELS, getHiddenTemporarySidePanels, getSidePanelPanels, isTemporarySidePanelId, normalizeSidePanelPanels, parseSidePanelPanels, resolveSidePanelIds, setTemporarySidePanelHidden },
  { t },
  { settled, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Settings.js'),
  import('../src/components/sidePanel/PanelStore.js'),
  import('../src/components/sidePanel/builtinPanels.js'),
  import('../src/settings/definitions.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 30

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// The real definition's static part (label/hint) — the fixture field mirrors
// what plugin.ts assembles via settingField('sidePanel.panels').
const DEFINITION = SETTING_DEFINITIONS['sidePanel.panels']!

// In-memory settings host: one namespace, the dsh-tui section shape.
const writes: { ns: string; ops: readonly { op: string; path: readonly string[]; value?: unknown }[] }[] = []
const docs: Record<string, { revision: number; value: Record<string, unknown>; user: Record<string, unknown> }> = {}
const host = {
  listNamespaces: () => Object.entries(docs).map(([ns, doc]) => ({
    ns,
    revision: doc.revision,
    applies: 'live' as const,
    value: { ...doc.value },
    user: { ...doc.user },
  })),
  write: (ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
    writes.push({ ns, ops })
    const doc = docs[ns]
    if (doc === undefined) return Promise.reject(new Error(`unknown namespace ${ns}`))
    doc.revision += 1
    for (const op of ops) {
      let parent = doc.value
      for (const segment of op.path.slice(0, -1)) {
        const child = parent[segment]
        if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
          parent = child as Record<string, unknown>
        } else {
          parent[segment] = {}
          parent = parent[segment] as Record<string, unknown>
        }
      }
      if (op.op === 'unset') delete parent[op.path[op.path.length - 1]!]
      else parent[op.path[op.path.length - 1]!] = op.value
    }
    return Promise.resolve()
  },
  credentialConfigured: () => Promise.resolve(false),
  writeCredential: () => Promise.resolve(),
}

function makeChannel(): unknown {
  return {
    settingsHost: () => host,
    settingsSections: () => [{
      ns: 'dsh-tui',
      title: 'TUI',
      groups: [{ id: 'side-panel', title: 'Side panel' }],
      fields: [{
        path: ['sidePanel', 'panels'],
        label: DEFINITION.label,
        hint: DEFINITION.hint,
        kind: 'text' as const,
        group: 'side-panel',
        // The real field's strict gate lives in plugin.ts's parse (mirrored
        // here): the same `parseSidePanelPanels`, so a draft that does not
        // round-trip is refused instead of saved as something else.
        parse(text: string) {
          const parsed = parseSidePanelPanels(text)
          if (parsed.mode === 'empty') return { kind: 'clear' as const }
          if (parsed.mode === 'all') return { kind: 'set' as const, value: ALL_SIDE_PANELS }
          if (parsed.mode === 'invalid') return undefined
          return { kind: 'set' as const, value: parsed.ids.join(',') }
        },
      }],
    }],
    subscribeSettingsSections: () => () => {},
  }
}

class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

/** One rendered screen fixture: its own xterm buffer, stdout, stdin. */
async function openScreen(stored: string) {
  docs['dsh-tui'] = { revision: 1, value: { sidePanel: { panels: stored } }, user: {} }
  writes.length = 0
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 20, allowProposedApi: true })
  class Stdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  const stdin = new FakeStdin()
  // AlternateScreen: the SGR mouse plumbing only flows under the app's
  // alternate-screen host (same harness shape as verify-side-panel-registry).
  const instance = await render(
    <AlternateScreen>
      <Settings channel={makeChannel() as never} onClose={() => {}} />
    </AlternateScreen>,
    { stdout: new Stdout() as never, stdin: stdin as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  const view = (): string => viewportLines(term, ROWS).join('\n')
  const has = (s: string): boolean => view().includes(s)
  const find = (s: string): { col: number; row: number } | null => {
    const lines = viewportLines(term, ROWS)
    for (let row = 0; row < lines.length; row++) {
      const col = lines[row]!.indexOf(s)
      if (col >= 0) return { col, row }
    }
    return null
  }
  const click = (col: number, row: number): void => {
    stdin.write('\x1b[<0;' + (col + 1) + ';' + (row + 1) + 'M')
    stdin.write('\x1b[<0;' + (col + 1) + ';' + (row + 1) + 'm')
  }
  return { stdin, view, has, find, click, close: async () => { await instance.unmount() } }
}

/** The set ops this scenario wrote for sidePanel.panels, in order. */
const panelSetWrites = (): string[] =>
  writes.filter(w => w.ns === 'dsh-tui')
    .flatMap(w => w.ops)
    .filter(op => op.op === 'set' && op.path.join('.') === 'sidePanel.panels')
    .map(op => String(op.value))

let cursor = 0
async function arrow(stdin: FakeStdin, direction: 'down' | 'up', times: number, from: number): Promise<number> {
  const key = direction === 'down' ? '\x1b[B' : '\x1b[A'
  for (let i = 0; i < times; i++) {
    stdin.write(key)
    await sleep(110) // 固定窗:pacing 焦点步进只改颜色无文本锚点，无可 settle 条件
  }
  return direction === 'down' ? from + times : from - times
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Open the Side panel subpage; the focus lands on the first checkbox row. */
async function openPicker(stored: string) {
  const screen = await openScreen(stored)
  screen.stdin.write('\r')
  if (!await settled(() => screen.has('Enabled panels'), { timeoutMs: 4000 })) return null
  cursor = 0
  return screen
}

/** Row index of one picker row in focus order: rows are exactly one line
 *  each, so the distance from the first checkbox row is the index. */
function rowOf(screen: { view(): string }, needle: string): number {
  const lines = screen.view().split('\n')
  const first = lines.findIndex(line => /\[[✓ ] \]/.test(line))
  const target = lines.findIndex(line => line.includes(needle))
  return first >= 0 && target >= first ? target - first : -1
}

// Rows always render in the documented default order (the order the value
// ships with), independent of the stored list order: todo, jobs, agents,
// info, trajectory, workspace, btw, companion — plugin panels appended in
// registry order. Toggling or registering must never reshuffle this list.
const ROW_JOBS = 1, ROW_COMPANION = 7

// ── r. the pure resolver: the one source both the picker and PanelBar read ──
{
  // `*` follows the built-in DEFAULT order (builtins by their documented
  // order, not registry order), then appends everything else in registry
  // order — exactly the tail the old registration-time append produced.
  check('r *: built-ins keep the documented default order',
    resolveSidePanelIds(ALL_SIDE_PANELS, ['todo', 'info', 'jobs']).join(',') === 'todo,jobs,info')
  check('r *: plugin panels append after the built-ins',
    resolveSidePanelIds(ALL_SIDE_PANELS, ['demo:md', 'todo']).join(',') === 'todo,demo:md')
  check('r *: unregistered built-ins are dropped',
    !resolveSidePanelIds(ALL_SIDE_PANELS, ['todo']).includes('jobs'))
  check('r explicit: ids survive verbatim, unknown placeholders included',
    resolveSidePanelIds('todo,demo:future', ['todo']).join(',') === 'todo,demo:future')
  check('r empty/undefined normalizes to the * default',
    normalizeSidePanelPanels(undefined) === ALL_SIDE_PANELS
    && normalizeSidePanelPanels('') === ALL_SIDE_PANELS
    && normalizeSidePanelPanels('BAD!') === ALL_SIDE_PANELS)
  check('r malformed tokens are dropped, usable ones kept',
    normalizeSidePanelPanels(' todo, BAD!, , jobs ') === 'todo,jobs')
  check('r strict parse: the sentinel is a whole-value form',
    parseSidePanelPanels('*,todo').mode === 'invalid'
    && parseSidePanelPanels('*').mode === 'all'
    && parseSidePanelPanels('').mode === 'empty'
    && parseSidePanelPanels(',').mode === 'invalid'
    && parseSidePanelPanels('todo,,jobs').mode === 'list')
}

// ── p. checkbox rows + mapping + o. toggle semantics (append/remove) ────────
{
  const screen = await openPicker('todo,jobs,agents')
  if (screen === null) { check('p opens the picker subpage', false); process.exit(1) }
  check('p builtin rows enumerated with icons', screen.has('[✓ ] ≡') && screen.has('[✓ ] ▸') && screen.has('[✓ ] ◆'))
  check('p unchecked rows render empty boxes', screen.has('[  ] ♥') && screen.has('[  ] ∿') && screen.has('[  ] ⌗') && screen.has('[  ] ?'))
  check('p descriptions render beside the titles', screen.has(t('panel-desc-companion')))

  cursor = await arrow(screen.stdin, 'down', ROW_COMPANION, cursor)
  screen.stdin.write('\r')
  check('o Enter checks Companion -> inserted at its default position (the tail)',
    await settled(() => screen.has('[✓ ] ♥'), { timeoutMs: 4000 })
    && await settled(() => panelSetWrites().includes('todo,jobs,agents,companion'), { timeoutMs: 4000 }),
    panelSetWrites().join(' | '))

  cursor = await arrow(screen.stdin, 'up', ROW_COMPANION - ROW_JOBS, cursor)
  screen.stdin.write('\r')
  check('o Enter unchecks Jobs -> removed, others keep order',
    await settled(() => screen.has('[  ] ▸'), { timeoutMs: 4000 })
    && await settled(() => panelSetWrites().includes('todo,agents,companion'), { timeoutMs: 4000 }),
    panelSetWrites().join(' | '))

  // 点击即勾选/取消：真 SGR 鼠标点在 Companion 行上（当前已勾选 → 取消）。
  await settled(() => screen.has('[✓ ] ♥'), { timeoutMs: 4000 })
  const cell = screen.find('[✓ ] ♥')
  if (cell === null) {
    check('p click target row visible', false)
  } else {
    screen.click(cell.col + 1, cell.row)
    check('o SGR click unchecks Companion',
      await settled(() => screen.has('[  ] ♥'), { timeoutMs: 4000 })
      && await settled(() => panelSetWrites().includes('todo,agents'), { timeoutMs: 4000 }),
      panelSetWrites().join(' | '))
  }
  await screen.close()
}

// ── o. existing order is user data: a custom order survives a new tick ─────
{
  const screen = await openPicker('agents,todo')
  if (screen === null) { check('o custom order scenario opened', false); process.exit(1) }
  // The stored order is `agents,todo`, but the list keeps the default order
  // (todo 0, jobs 1, ...). Ticking Jobs inserts it after its displayed
  // predecessor (Todo), which happens to be the tail here; the rows never move.
  cursor = await arrow(screen.stdin, 'down', ROW_JOBS, cursor)
  screen.stdin.write('\r')
  check('o custom order kept, tick inserted after its displayed predecessor',
    await settled(() => panelSetWrites().includes('agents,todo,jobs'), { timeoutMs: 4000 }),
    panelSetWrites().join(' | '))
  await screen.close()
}

// ── o. a new tick goes back to its displayed position, not the tail ────────
{
  const screen = await openPicker('todo,companion')
  if (screen === null) { check('o insert-at-position scenario opened', false); process.exit(1) }
  // Rows are in the fixed default order, so Jobs sits at row 1: ticking it must
  // write the id after Todo (its display predecessor), not after Companion.
  cursor = await arrow(screen.stdin, 'down', ROW_JOBS, cursor)
  screen.stdin.write('\r')
  check('o a new tick is inserted at its display position, not appended',
    await settled(() => panelSetWrites().includes('todo,jobs,companion'), { timeoutMs: 4000 }),
    panelSetWrites().join(' | '))
  await screen.close()
}

// ── u. well-formed but unclaimed ids stay as checked placeholder rows ───────
{
  const screen = await openPicker('todo,demo:future')
  if (screen === null) { check('u unclaimed scenario opened', false); process.exit(1) }
  check('u unclaimed id renders as a checked tail row', /[✓][^\n]*· demo:future/.test(screen.view()))
  check('u unclaimed row carries the waiting hint', screen.has(t('settings-panels-unclaimed')))
  // Row 8 = the unclaimed row: registered panels keep the default order and
  // unclaimed placeholders sit at the tail.
  cursor = await arrow(screen.stdin, 'down', 8, cursor)
  screen.stdin.write('\r')
  check('u unchecking the placeholder removes only it',
    await settled(() => !/[✓][^\n]*demo:future/.test(screen.view()), { timeoutMs: 4000 })
    && await settled(() => panelSetWrites().includes('todo'), { timeoutMs: 4000 }),
    panelSetWrites().join(' | '))
  await screen.close()
}

// ── l. live registry: plugin panels appear/disappear while the screen is open ─
{
  const screen = await openPicker('todo,jobs,agents')
  if (screen === null) { check('l live registry scenario opened', false); process.exit(1) }
  const dispose = panelStore.register({
    id: 'demo:notes',
    title: 'Notes',
    icon: '◉',
    order: 50,
    source: 'plugin',
    component: () => null,
  }, { pluginId: 'demo' })
  check('l plugin panel row appears without reopening', await settled(() => screen.has('Notes'), { timeoutMs: 4000 }))
  cursor = await arrow(screen.stdin, 'down', 8, cursor)
  screen.stdin.write('\r')
  check('l plugin panel id written on tick',
    await settled(() => panelSetWrites().includes('todo,jobs,agents,demo:notes'), { timeoutMs: 4000 }),
    panelSetWrites().join(' | '))
  dispose()
  check('l unloaded plugin row leaves, its id degrades to a placeholder',
    await settled(() => !screen.has('Notes') && /[✓][^\n]*· demo:notes/.test(screen.view()), { timeoutMs: 4000 }))
  await screen.close()
}

// ── n. reverse-DNS plugin namespaces are durable picker rows ────────────────
{
  check('n parse: a reverse-DNS plugin address is a list id',
    JSON.stringify(parseSidePanelPanels('todo,com.example.echo:main')) === JSON.stringify({ mode: 'list', ids: ['todo', 'com.example.echo:main'] }))
  check('n normalize: case-folded, de-duped, and a fixed point',
    normalizeSidePanelPanels(' todo, Com.Example.Echo:Main ,com.example.echo:main') === 'todo,com.example.echo:main'
    && normalizeSidePanelPanels('todo,com.example.echo:main') === 'todo,com.example.echo:main')
  check('n malformed dotted namespaces stay refused',
    ['com..x:main', 'x.:main', '.x:main', 'com.x.:main'].every(id => parseSidePanelPanels('todo,' + id).mode === 'invalid')
    && normalizeSidePanelPanels('todo,com..x:main,x.:main') === 'todo')
  check('n legacy slug ids parse exactly as before',
    normalizeSidePanelPanels('todo,my_plugin:main,demo:md') === 'todo,my_plugin:main,demo:md')
  check('n a reverse-DNS address is never a temporary one', !isTemporarySidePanelId('com.example.echo:main'))

  const dispose = panelStore.register({
    id: 'com.example.echo:main',
    title: 'Echo main',
    icon: 'E',
    order: 50,
    source: 'plugin',
    component: () => null,
  }, { pluginId: 'com.example.echo' })
  const screen = await openPicker('todo,jobs,agents')
  if (screen === null) { check('n reverse-DNS scenario opened', false); process.exit(1) }
  check('n the reverse-DNS panel is a durable unchecked row',
    /\[  \][^\n]*Echo main/.test(screen.view()) && !screen.has('this run only'))
  cursor = await arrow(screen.stdin, 'down', 8, cursor)
  screen.stdin.write('\r')
  check('n ticking it writes the reverse-DNS id',
    await settled(() => panelSetWrites().includes('todo,jobs,agents,com.example.echo:main'), { timeoutMs: 4000 }),
    panelSetWrites().join(' | '))
  await screen.close()
  const reopened = await openPicker('todo,jobs,agents,com.example.echo:main')
  if (reopened === null) { check('n reverse-DNS reopen scenario opened', false); process.exit(1) }
  check('n the saved value re-reads as the checked registered row (no placeholder)',
    /\[✓ \][^\n]*Echo main/.test(reopened.view()) && !reopened.has(t('settings-panels-unclaimed')))
  await reopened.close()
  dispose()
}

// ── s. issue #1662: `*` (the default) covers every registered panel ────────
// A plugin panel registered at runtime is actually enabled; the picker must
// agree. Toggling a row materializes the explicit list from the resolver, so
// it cannot silently drop the plugin ids that were never in the stored text.
{
  const disposeDemo = panelStore.register({
    id: 'demo:md',
    title: 'Markdown demo',
    icon: 'M',
    order: 50,
    source: 'plugin',
    component: () => null,
  }, { pluginId: 'demo' })
  const ROW_ADVANCED = 9 // 8 builtins in default order, then the plugin row

  // s1. checked state under `*`: every registered panel, plugin included.
  {
    const screen = await openPicker('*')
    if (screen === null) { check('s issue scenario opens', false); process.exit(1) }
    check('s plugin panel is checked under *',
      /\[✓ \][^\n]*Markdown demo/.test(screen.view()))
    check('s advanced row shows the * sentinel',
      screen.view().split('\n').some(line => line.includes(t('settings-panels-advanced')) && line.includes('*')))

    // s2. untick a builtin: the materialized list keeps the plugin id. Rows keep
    // the default order (only their checkbox flips), so the plugin row stays at
    // its display index; locate it by name anyway rather than by a hardcoded one.
    const moveTo = async (row: number): Promise<void> => {
      const delta = row - cursor
      if (delta === 0) return
      cursor = await arrow(screen.stdin, delta > 0 ? 'down' : 'up', Math.abs(delta), cursor)
    }
    await moveTo(rowOf(screen, 'Companion'))
    screen.stdin.write('\r')
    check('s unticking a builtin keeps plugin ids',
      await settled(() => panelSetWrites().includes('todo,jobs,agents,info,trajectory,workspace,btw,demo:md'), { timeoutMs: 4000 }),
      panelSetWrites().join(' | '))

    await moveTo(rowOf(screen, 'Markdown demo'))
    screen.stdin.write('\r')
    check('s unticking the plugin row removes it from the explicit list',
      await settled(() => panelSetWrites().includes('todo,jobs,agents,info,trajectory,workspace,btw'), { timeoutMs: 4000 }),
      panelSetWrites().join(' | '))
    await screen.close()
  }

  // s3. an explicit list that predates the plugin leaves it unchecked but
  // visible (the extension story; one tick brings it back).
  {
    const screen = await openPicker('todo,jobs,agents,info,trajectory,workspace,btw')
    if (screen === null) { check('s explicit-list scenario opens', false); process.exit(1) }
    check('s plugin panel renders unchecked under an explicit list',
      /\[  \][^\n]*Markdown demo/.test(screen.view()))
    await screen.close()
  }

  // s4. the advanced row expands `*` into the real list, and an untouched
  // confirm must NOT pin that expansion into settings.
  {
    const screen = await openPicker('*')
    if (screen === null) { check('s advanced sentinel scenario opens', false); process.exit(1) }
    cursor = await arrow(screen.stdin, 'down', ROW_ADVANCED, cursor)
    screen.stdin.write('\r')
    check('s advanced draft expands * to the effective list',
      await settled(() => screen.has('demo:md▌'), { timeoutMs: 4000 }))
    await sleep(150) // 固定窗:pacing 确认键须与开编辑的 Enter 分属两个 stdin chunk，否则被并进草稿
    screen.stdin.write('\r')
    // The confirm stages the sentinel, not the expansion: the write is `*`
    // (a no-op value that still pins "all"), never the materialized CSV.
    check('s untouched advanced confirm keeps * (not the expansion)',
      await settled(() => !screen.view().includes('▌'), { timeoutMs: 4000 })
      && panelSetWrites().length === 1 && panelSetWrites()[0] === '*',
      panelSetWrites().join(' | '))
    await screen.close()
  }

  // ── t. a mid-edit registration must not pin the expansion ─────────────────
  {
    const screen = await openPicker('*')
    if (screen === null) { check('t advanced-snapshot scenario opens', false); process.exit(1) }
    cursor = await arrow(screen.stdin, 'down', ROW_ADVANCED, cursor)
    screen.stdin.write('\r')
    check('t advanced draft expands * to the effective list (before the registration)',
      await settled(() => screen.has('demo:md▌'), { timeoutMs: 4000 }))
    // A panel lands while the editor is open: the registry half of the expansion
    // grows under the draft. The confirm must compare against the snapshot the
    // editor opened with, or the untouched save becomes an explicit list without
    // the new id — silently switching off the panel that just arrived.
    const disposeLate = panelStore.register({
      id: 'demo:late',
      title: 'Late demo',
      icon: 'L',
      order: 60,
      source: 'plugin',
      component: () => null,
    }, { pluginId: 'demo' })
    await sleep(150) // 固定窗:pacing 确认键须与开编辑的 Enter 分属两个 stdin chunk
    screen.stdin.write('\r')
    // The row list gains one entry, so the focused index now lands on the
    // newcomer and the `▌` marker goes with it; wait for the write, not the marker.
    check('t unchanged confirm survives a mid-edit registration (still *)',
      await settled(() => panelSetWrites().length === 1, { timeoutMs: 4000 })
      && panelSetWrites()[0] === '*',
      panelSetWrites().join(' | '))
    await screen.close()
    disposeLate()
  }

  disposeDemo()
}

// Temporary selections never enter the settings write path, even when
// another durable checkbox is saved while the same picker stays open. Under
// `*` the registry supplies them; hiding one is session state, so no stored
// value can name it and no replay can revive it.
{
  const id = 'session:act900:notes'
  const dispose = panelStore.register({ id, title: 'Scratch notes', icon: '◉', source: 'plugin', component: () => null }, { pluginId: 'session:act900' })
  const otherId = 'session:act901:notes'
  const disposeOther = panelStore.register({ id: otherId, title: 'Scratch notes', icon: '◉', source: 'plugin', component: () => null }, { pluginId: 'session:act901' })
  const screen = await openPicker('todo,act900:notes')
  if (screen === null) { check('temporary picker opens', false); process.exit(1) }
  check('temporary row is readable and explicitly not saved', screen.has('Scratch notes') && screen.has('this run only'))
  console.log('SCREEN temporary panels\n' + screen.view().split('\n').filter(line => line.trim()).join('\n'))
  check('legacy anonymous placeholder asks for reselection', screen.has('Old anonymous address'))
  const numbers = [...screen.view().matchAll(/Temporary panel #(\d+)/g)].map(match => match[1])
  check('duplicate readable titles have distinct run-local numbers', numbers.length === 2 && new Set(numbers).size === 2)
  cursor = await arrow(screen.stdin, 'down', 8, cursor)
  screen.stdin.write('\r')
  check('temporary Enter hides it for this run only',
    await settled(() => getHiddenTemporarySidePanels().includes(id)) && panelSetWrites().length === 0)
  check('same-title neighbor stays visible', !getHiddenTemporarySidePanels().includes(otherId))
  screen.stdin.write('\r')
  check('temporary Enter restores it without a write',
    await settled(() => !getHiddenTemporarySidePanels().includes(id)) && panelSetWrites().length === 0)
  const cell = screen.find('Scratch notes')
  if (cell !== null) screen.click(cell.col, cell.row)
  check('temporary mouse toggle also avoids persistence',
    await settled(() => getHiddenTemporarySidePanels().includes(id)) && panelSetWrites().length === 0)
  cursor = await arrow(screen.stdin, 'up', 6, 8)
  screen.stdin.write('\r')
  check('durable edit never serializes temporary id', await settled(() => panelSetWrites().length > 0) && panelSetWrites().every(csv => !csv.includes('session:')))
  await screen.close()
  setTemporarySidePanelHidden(id, false)
  dispose()
  disposeOther()
}

// Reserved-looking Component names keep runtime addresses while preferences
// distinguish an explicit current selection from an ambiguous legacy entry.
{
  const dispose = panelStore.register({ id: 'act1:notes', title: 'Verified notes', icon: '◉', source: 'plugin', component: () => null }, { pluginId: 'act1' })
  const screen = await openPicker('todo,act1:notes')
  if (screen === null) { check('reserved Component picker opens', false); process.exit(1) }
  check('legacy entry remains a separate unclaimed row', screen.has('Verified notes') && screen.has('Old anonymous address'))
  const cell = screen.find('Verified notes')
  if (cell !== null) screen.click(cell.col, cell.row)
  // The encoded preference names the panel the user actually ticked; the
  // bare actN entry survives untouched as its own placeholder, and the new
  // id lands at its default-order position rather than at the tail.
  check('explicit Component choice writes encoded preference',
    await settled(() => panelSetWrites().includes('todo,component:act1:notes,act1:notes')))
  check('public registry address is unchanged',
    panelStore.get('act1:notes') !== undefined && panelStore.get('component:act1:notes') === undefined)
  await screen.close()
  dispose()
}

// ── g. the last checked panel cannot be removed (empty is not storable) ─────
{
  const screen = await openPicker('todo')
  if (screen === null) { check('g min-one scenario opened', false); process.exit(1) }
  screen.stdin.write('\r') // cursor 0 = the only checked row (Todo)
  check('g removing the last panel is refused with a notice', await settled(() => screen.has(t('settings-panels-min-one')), { timeoutMs: 4000 }))
  check('g refusal writes nothing', panelSetWrites().length === 0, panelSetWrites().join(' | '))
  await screen.close()
}

// ── a. advanced raw editor: reorder / future ids by hand; invalid refused ───
{
  const screen = await openPicker('todo,jobs')
  if (screen === null) { check('a advanced scenario opened', false); process.exit(1) }
  cursor = await arrow(screen.stdin, 'down', 8, cursor) // advanced row after the 8 builtin rows
  screen.stdin.write('\r')
  check('a Enter opens the raw draft editor', await settled(() => screen.has('todo,jobs▌'), { timeoutMs: 4000 }))
  screen.stdin.write(',btw')
  await sleep(150) // 固定窗:pacing 打字与确认须分两个 stdin chunk——ink 单事件批处理会把确认键并进文本
  screen.stdin.write('\r')
  check('a confirmed raw draft saves as the comma string',
    await settled(() => panelSetWrites().includes('todo,jobs,btw'), { timeoutMs: 4000 }),
    panelSetWrites().join(' | '))

  cursor = 8
  screen.stdin.write('\r')
  await settled(() => screen.has('▌'), { timeoutMs: 4000 })
  screen.stdin.write(',BAD!')
  await sleep(150) // 固定窗:pacing 打字与确认须分两个 stdin chunk——ink 单事件批处理会把确认键并进文本
  screen.stdin.write('\r')
  check('a malformed draft is refused (invalid badge, editor stays)',
    await settled(() => screen.has(t('settings-field-invalid')), { timeoutMs: 4000 }) && screen.has('▌'))
  const before = panelSetWrites().length
  screen.stdin.write('\x1b') // Esc leaves without saving
  await settled(() => !screen.has('▌'), { timeoutMs: 4000 })
  check('a Esc on the editor writes nothing', panelSetWrites().length === before)
  check('a rejected draft leaves the previous checkbox selection intact',
    screen.has('[✓ ] ≡') && screen.has('[✓ ] ▸') && screen.has('[✓ ] ?')
    && screen.has('[  ] ◆') && screen.has('[  ] ♥'))
  cursor = await arrow(screen.stdin, 'up', 8 - ROW_JOBS, cursor)
  screen.stdin.write('\r')
  check('a toggle after cancelling an invalid draft only changes the selected panel',
    await settled(() => panelSetWrites().length > before, { timeoutMs: 4000 })
    && panelSetWrites().at(-1) === 'todo,btw',
    panelSetWrites().join(' | '))
  await screen.close()
}

// ── h. hint: short, checkbox-first, mentions plugin panels; kind stays text ─
{
  check('h hint stays a text field (persistence contract unchanged)', DEFINITION.kind === 'text')
  check('h teaching copy is gone', !DEFINITION.hint.includes('Comma-separated panel ids'))
  check('h hint mentions plugin panels appearing automatically', DEFINITION.hint.includes('plugin'))
  check('h zh hint mentions plugin panels', (DEFINITION.hintDescriptions?.zh ?? '').includes('插件'))
  const screen = await openPicker('todo,jobs,agents')
  if (screen === null) { check('h hint scenario opened', false); process.exit(1) }
  check('h hint bar shows the short hint on a checkbox row', screen.has(DEFINITION.hint.slice(0, 16)))
  await screen.close()
}

console.log(failed === 0 ? 'verify-panel-settings-picker: ALL PASS' : 'verify-panel-settings-picker: ' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
