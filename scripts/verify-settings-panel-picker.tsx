/**
 * /settings「启用的面板」二级菜单回归（sidePanel.panels）。
 *
 * 字段不再是「打字输入逗号分隔 id」的文本框，而是勾选列表，契约：
 * - 分组子页上仍是一行：chip 显示已勾选面板的本地化标题（含无主 id 原文）；
 * - Enter 打开勾选页：每个选项一行、✓/空 复选框、焦点在行间移动；
 * - 空格/Enter 勾选即保存，写出的 draft 是「选项顺序在前 + 无主 id 殿后」的
 *   CSV——所以标签栏顺序与列表顺序一致，格式仍由字段自己的 parse 把关；
 * - 选项由实时 provider 推：插件注册的面板随后出现（不必重注册 section），
 *   无主 id（合法但暂无面板认领）保持可见、可取消；
 * - Esc 返回列表页；列表页不再进入文本编辑态（旧的打字路径已不存在）。
 *
 * 用 fake stdin 走真实输入链路，屏幕断言读视口。
 * Run: node --import tsx/esm scripts/verify-settings-panel-picker.tsx
 */
process.env.FORCE_COLOR = '3'
// 本脚本断言英文 UI 文案；在任何模块解析启动语言之前钉住语言。
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Settings }, { settle, settled, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Settings.js'),
  import('./lib/term-test.mjs'),
])

/** 面板注册表替身：provider 每次渲染都读它，模拟真实 PanelStore。 */
const panels: { value: string; label: string }[] = [
  { value: 'todo', label: 'Todo' },
  { value: 'jobs', label: 'Jobs' },
  { value: 'agents', label: 'Agents' },
]

// ── 内存 settings host：一次 write 记一条，值就地更新（保存后屏幕重读）──
const stored: Record<string, unknown> = { sidePanel: { panels: 'plugin:later,todo,jobs' } }
const writes: { path: readonly string[]; value?: unknown }[] = []
const host = {
  listNamespaces: () => [{
    ns: 'dsh-tui',
    revision: writes.length + 1,
    applies: 'live' as const,
    value: stored,
    user: stored,
  }],
  write: (ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
    if (ns !== 'dsh-tui') return Promise.reject(new Error('unknown namespace ' + ns))
    for (const op of ops) {
      const parent = op.path.slice(0, -1).reduce<Record<string, unknown>>((node, key) => {
        const child = node[key]
        if (typeof child === 'object' && child !== null) return child as Record<string, unknown>
        const created: Record<string, unknown> = {}
        node[key] = created
        return created
      }, stored)
      writes.push({ path: op.path, value: op.value })
      const leaf = op.path.at(-1)
      if (leaf === undefined) continue
      if (op.op === 'set') parent[leaf] = op.value
      else delete parent[leaf]
    }
    return Promise.resolve()
  },
  credentialConfigured: () => Promise.resolve(false),
  writeCredential: () => Promise.resolve(),
}

const section = {
  ns: 'dsh-tui',
  title: 'dsh-tui',
  groups: [{ id: 'side-panel', mode: 'page' as const, title: 'Side panel' }],
  fields: [
    {
      path: ['sidePanel', 'panels'],
      label: 'Enabled panels',
      group: 'side-panel',
      kind: 'multi-select' as const,
      hint: 'Enter opens the panel list',
      optionsProvider: () => panels,
    },
    { path: ['sidePanel', 'ratio'], label: 'Chat column width', group: 'side-panel', kind: 'number' as const },
  ],
}
const sections = [section]
const sectionListeners = new Set<() => void>()
const channel = {
  settingsHost: () => host,
  // 新数组 = 新 state 引用，插件注册面板后由 section 事件触发的那次重渲染。
  settingsSections: () => sections.slice(),
  subscribeSettingsSections: (listener: () => void) => {
    sectionListeners.add(listener)
    return () => { sectionListeners.delete(listener) }
  },
}

class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }

const cols = 90, rows = 24
const term = new XTerm({ cols, rows, scrollback: 50, allowProposedApi: true })
class Stdout extends Writable {
  columns = cols
  rows = rows
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
const stdin = new FakeStdin()
const instance = await render(
  <Settings channel={channel as any} onClose={() => {}} />,
  { stdout: new Stdout(), stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)

const POINTER = '\u276f'
const screen = (): string => viewportLines(term, rows).join('\n')
/** 屏幕上第一行含该文本的行（没有则空串）。 */
const lineOf = (text: string): string => screen().split('\n').find(line => line.includes(text)) ?? ''
/** 当前焦点行的文本（指针所在行）。 */
const focusedLine = (): string => screen().split('\n').find(line => line.includes(POINTER)) ?? ''
/** 最近一次写入的面板 CSV。 */
const lastPanelWrite = (): unknown => writes.at(-1)?.value
const key = async (data: string, landed: () => boolean): Promise<void> => {
  stdin.write(data)
  await settle(landed)
}
/** 按 ↓ 直到焦点落到某行：每按一次等指针真移动，连击不会被解析器合并。 */
async function focusRow(label: string): Promise<void> {
  for (let step = 0; step < 8 && !focusedLine().includes(label); step++) {
    const before = focusedLine()
    stdin.write('\x1b[B')
    await settle(() => focusedLine() !== before)
  }
}
function assert(condition: boolean, label: string): void {
  console.log((condition ? 'ok' : 'FAIL') + ' — ' + label)
  if (!condition) { console.log('--- screen ---\n' + screen()); process.exit(1) }
}

// 1. 根页只有分组行；进入分组子页后是同一个字段行，chip 显示生效值。
assert(await settled(() => screen().includes('Side panel')), 'the side-panel group row sits on the root page')
assert(!screen().includes('Enabled panels'), 'the field itself stays on the group subpage')
await key('\r', () => screen().includes('Enabled panels'))
assert(lineOf('Enabled panels').includes('plugin:later, Todo, Jobs'),
  'the row chips the checked panels by title, an unclaimed id by its raw value')

// 2. Enter 打开勾选页：选项行 + 复选框，焦点在表头下第一行（不是文本编辑态）。
await key('\r', () => screen().includes('Agents'))
assert(!screen().includes('\u258c'), 'the multi-select does not open a text editor')
assert(['Todo', 'Jobs', 'Agents', 'plugin:later'].every(label => screen().includes(label)),
  'every option plus the unclaimed id is listed')
assert(lineOf('Todo').includes(POINTER), 'the focus starts on the first option')
assert(lineOf('Todo').includes('\u2713') && lineOf('Jobs').includes('\u2713'), 'checked panels show a tick')
assert(!lineOf('Agents').includes('\u2713'), 'an unchecked panel shows an empty box')

// 3. 空格勾选即保存：写出的 CSV 按选项顺序排列，无主 id 殿后。
await focusRow('Agents')
stdin.write(' ')
assert(await settled(() => lastPanelWrite() === 'todo,jobs,agents,plugin:later'),
  'Space checks the focused panel and auto-saves in option order')
assert(await settled(() => lineOf('Agents').includes('\u2713')), 'the tick appears on the checked row')

// 4. 再按一次取消勾选，草稿缩回原样。
stdin.write(' ')
assert(await settled(() => lastPanelWrite() === 'todo,jobs,plugin:later'),
  'Space again unchecks it and saves the shorter list')

// 5. 无主 id 也是一行：取消后它从列表里消失（不再有任何 UI 能看见它）。
await focusRow('plugin:later')
stdin.write(' ')
assert(await settled(() => lastPanelWrite() === 'todo,jobs'), 'the unclaimed id can be unchecked away')
assert(await settled(() => !screen().includes('plugin:later')), 'its row leaves the list with it')

// 6. 插件此刻注册了一个面板：provider 再读注册表，行随 section 事件出现；
//    Enter 同样勾选（空格与 Enter 两条路都要能开）。
panels.push({ value: 'companion', label: 'Companion' })
for (const listener of [...sectionListeners]) listener()
assert(await settled(() => screen().includes('Companion')),
  'a panel a plugin registers joins the list without re-registering the section')
await focusRow('Companion')
stdin.write('\r')
assert(await settled(() => lastPanelWrite() === 'todo,jobs,companion'), 'Enter checks it too')

// 7. Esc 回到列表页：勾选页消失（帮助行回到列表态），字段行 chip 反映新的勾选集合。
stdin.write('\x1b')
assert(await settled(() => screen().includes('Chat column width') && !screen().includes('Space toggle')),
  'Esc returns to the group subpage')
assert(lineOf('Enabled panels').includes('Todo, Jobs, Companion'), 'the row chip follows the new selection')

await instance.unmount()
console.log('verify-settings-panel-picker: all assertions passed')
