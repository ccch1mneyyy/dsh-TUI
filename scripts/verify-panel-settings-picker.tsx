/**
 * sidePanel.panels 勾选式面板多选回归（用户实测反馈：kind:'text' + 教学文案
 * 不可用）。设置屏对该字段渲染 checkbox 行列表，值仍是逗号分隔字符串
 * （schema/契约零变化）。
 *
 * Locked behavior:
 *  p. 勾选↔字符串映射：内置面板行从 panelStore 注册表现场枚举（图标+名称+
 *     一句话描述），勾选态由存储字符串派生；Enter 与真 SGR 鼠标点击都走
 *     同一 toggle（点击即勾选/取消）。
 *  o. 顺序保真：已有 id 保持现有相对顺序（PanelBar 顺序是用户数据），
 *     新勾选追加到尾、取消即移除——写入的字符串逐字断言。
 *  u. 「格式合法但尚无面板认领」的 id 在列表尾部显示为已勾选的占位行，
 *     不被静默丢弃；取消即移除。
 *  l. 活注册表：设置屏打开期间插件面板（plugin:panel 命名空间）注册即
 *     出现行、撤下即退场——撤下后已写入的 id 退化为占位行（扩展故事的
 *     两半：先占位、插件到位自动认领）。
 *  g. 至少一个面板：取消最后一个勾选被拒绝（空串在持久化契约里不可
 *     表示，会静默回落默认值），给出错误通知且零写入。
 *  a. 高级逃生：列表尾部的原始文本行进既有草稿编辑器（可改顺序/手填
 *     未来 id）；非法草稿按既有 invalid 语义拒绝。
 *  h. hint 收缩为勾选即所得，并点明插件面板自动出现；kind 保持 'text'
 *     （持久化格式与发布 schema 不变）。
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
  { SIDE_PANEL_ID_PATTERN },
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
        // here): a draft that does not round-trip the id grammar is refused
        // instead of saved as something else.
        parse(text: string) {
          const draft = text.trim()
          if (draft === '') return { kind: 'clear' as const }
          const tokens = draft.split(',').map(token => token.trim().toLowerCase()).filter(token => token !== '')
          if (tokens.length === 0 || tokens.some(token => !SIDE_PANEL_ID_PATTERN.test(token))) return undefined
          return { kind: 'set' as const, value: tokens.join(',') }
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

// Builtin rows render in registry order (order: todo 10, info 15, jobs 20,
// btw 22, trajectory 25, agents 30, workspace 35, companion 40).
const ROW_TODO = 0, ROW_JOBS = 2, ROW_COMPANION = 7

// ── p. checkbox rows + mapping + o. toggle semantics (append/remove) ────────
{
  const screen = await openPicker('todo,jobs,agents')
  if (screen === null) { check('p opens the picker subpage', false); process.exit(1) }
  check('p builtin rows enumerated with icons', screen.has('[✓ ] ≡') && screen.has('[✓ ] ▸') && screen.has('[✓ ] ◆'))
  check('p unchecked rows render empty boxes', screen.has('[  ] ♥') && screen.has('[  ] ∿') && screen.has('[  ] ⌗') && screen.has('[  ] ?'))
  check('p descriptions render beside the titles', screen.has(t('panel-desc-companion')))

  cursor = await arrow(screen.stdin, 'down', ROW_COMPANION, cursor)
  screen.stdin.write('\r')
  check('o Enter checks Companion -> appended at the end',
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
  cursor = await arrow(screen.stdin, 'down', ROW_JOBS, cursor)
  screen.stdin.write('\r')
  check('o custom order kept, new id appended after it',
    await settled(() => panelSetWrites().includes('agents,todo,jobs'), { timeoutMs: 4000 }),
    panelSetWrites().join(' | '))
  await screen.close()
}

// ── u. well-formed but unclaimed ids stay as checked placeholder rows ───────
{
  const screen = await openPicker('todo,demo:future')
  if (screen === null) { check('u unclaimed scenario opened', false); process.exit(1) }
  check('u unclaimed id renders as a checked tail row', /[✓][^\n]*· demo:future/.test(screen.view()))
  check('u unclaimed row carries the waiting hint', screen.has(t('settings-panels-unclaimed')))
  // Row 8 = the unclaimed row (after the 8 builtin rows).
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