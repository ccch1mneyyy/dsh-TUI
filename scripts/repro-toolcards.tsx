/**
 * Tool-card presentation scenarios: the channel captures dsh-tools
 * presentCall/presentResult views and AssistantToolUseMessage renders them
 * as indented tool bodies (`  ⎿  ` gutter) — diff hunks in red/green,
 * terminal output, envelope-stripped read content — instead of the raw
 * tool-message dump. Exercises the pure component with fabricated ToolRows
 * (no channel needed: views are plain data on the row).
 *
 * The background section reads cell backgrounds from the same terminal: a
 * collapsed card and the same card expanded must keep the configured
 * tool-card surface across header, body and right edge, including the two
 * split-diff panes. Hover is the one treatment this screen cannot trigger.
 */
process.env.FORCE_COLOR = '3'
// 固定英文 UI：本脚本的断言全部针对 en 文案（折叠/退出码/工具名），
// 不 pin 会随宿主 locale 漂移（zh 机器上这些串已本地化，见 verify-toolcard-i18n）。
process.env.DSH_TUI_LANG = 'en'

const [{ Writable }, React, { Terminal: XTerm }, { render }, { AssistantToolUseMessage }, { settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 90
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
const stdout = new FakeStdout()
/** The real terminal screen, line by line (colors stripped). */
function lines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out
}
function screen(): string {
  return lines().join('\n')
}
/** Foreground rgb (0xRRGGBB) of the cell at (x, y), or 0 when unset. */
function fgAt(x: number, y: number): number {
  const cell = term.buffer.active.getLine(y)?.getCell(x)
  if (!cell) return 0
  return cell.getFgColor() & 0xffffff
}
/** Background rgb (0xRRGGBB) of the cell at (x, y), or null for the terminal default. */
function bgAt(x: number, y: number): number | null {
  const cell = term.buffer.active.getLine(y)?.getCell(x)
  return cell === undefined || cell.isBgDefault() ? null : cell.getBgColor() & 0xffffff
}
/** Locate the screen row containing `needle`; -1 when absent. */
function rowOf(needle: string): number {
  const rows = lines()
  for (let y = 0; y < rows.length; y++) {
    if (rows[y]!.includes(needle)) return y
  }
  return -1
}

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures++
}

const base = {
  callId: 'c1',
  argsText: '{"file_path":"/tmp/a.ts"}',
  status: 'ok' as const,
  startedAt: 0,
  durationMs: 12,
}

/** Presentation state one card render gets; mirrors the props MessageList passes. */
type CardOptions = {
  verbose?: boolean
  foldTerminalCommand?: boolean
  isExpanded?: boolean
  isSelected?: boolean
  diffLayout?: 'auto' | 'split' | 'unified'
  toolBackground?: 'none' | 'subtle' | 'strong'
}

function card(key: string, tool: Record<string, unknown>, options: CardOptions = {}): React.ReactElement {
  return React.createElement(AssistantToolUseMessage, {
    key,
    tool: { ...base, ...tool },
    marginTopOnTurn: false,
    verbose: false,
    ...options,
  })
}

const editTool = {
  name: 'edit',
  callView: {
    card: 'diff',
    title: 'Edit /tmp/a.ts',
    diffs: [{ path: '/tmp/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
  },
  resultView: {
    card: 'diff',
    title: 'Edit /tmp/a.ts',
    diffs: [{ path: '/tmp/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
  },
  resultFull: 'ok',
}

const app = await render(card('edit', editTool), { stdout, debug: true, exitOnCtrlC: false })

/**
 * Swap the rendered card; key forces a clean remount per scenario. Each
 * scenario's checks poll their own full condition via settled（等待与断言
 * 共用同一谓词），so no separate ready predicate is needed here.
 */
function show(key: string, tool: Record<string, unknown>, options: CardOptions = {}): void {
  app.rerender(card(key, tool, options))
}

// 1. Settled Edit: diff body, red `- ` / green `+ ` lines under the ⎿ gutter.
check('编辑卡片标题为「Edit /tmp/a.ts」（非 JSON args）', await settled(() => screen().includes('Edit /tmp/a.ts') && !screen().includes('{"file_path"')))
check('删除行带 ⎿ 缩进', await settled(() => { const r = rowOf('- const a = 1'); return r >= 0 && lines()[r]!.startsWith(' ⎿ - const a = 1') }))
check('新增行延续缩进', await settled(() => { const r = rowOf('+ const a = 2'); return r >= 0 && lines()[r]!.startsWith('   + const a = 2') }))
check('删除行为红色系', await settled(() => { const r = rowOf('- const a = 1'); return r >= 0 && fgAt(7, r) === 0xb26671 }))
check('新增行为绿色系', await settled(() => { const r = rowOf('+ const a = 2'); return r >= 0 && fgAt(7, r) === 0x57956b }))

// 2. Write 新建（oldText null）只有 + 行。
show('write', {
  name: 'write',
  callView: {
    card: 'diff',
    title: 'Write /tmp/new.ts',
    diffs: [{ path: '/tmp/new.ts', oldText: null, newText: 'hello\nworld' }],
  },
})
check('新建文件标题为「Write /tmp/new.ts」', await settled(() => screen().includes('Write /tmp/new.ts')))
check('新建只有新增行', await settled(() => screen().includes('+ hello') && screen().includes('+ world') && !screen().includes('- hello')))

// 3. Bash 终端卡：命令作标题，输出缩进。
show('bash', {
  name: 'bash',
  argsText: '{"command":"ls -la"}',
  callView: { card: 'terminal', title: 'ls -la' },
  resultView: { card: 'terminal', output: 'total 8\nfile1\nfile2', exitCode: 0 },
  resultFull: 'total 8\nfile1\nfile2',
})
check('终端卡标题为「Bash(ls -la)」', await settled(() => screen().includes('Bash(ls -la)')))
check('终端输出带 ⎿ 缩进', await settled(() => { const r = rowOf('total 8'); return r >= 0 && lines()[r]!.startsWith(' ⎿ total 8') }))

// 4. Bash 非零退出：追加 Exit code 行。
show('bash-err', {
  name: 'bash',
  callView: { card: 'terminal', title: 'false' },
  resultView: { card: 'terminal', output: '', exitCode: 1 },
  resultFull: '',
})
check('非零退出显示 Exit code 行', await settled(() => rowOf('Exit code 1') >= 0))

// 5. Read 卡：正文剥离 <path>/<content> 信封。
show('read', {
  name: 'read',
  callView: { card: 'generic', title: 'Read /tmp/x.ts' },
  resultView: {
    card: 'read',
    path: '/tmp/x.ts',
    content: [{ type: 'text', text: 'line one\nline two' }],
  },
  resultFull: '<path>/tmp/x.ts</path>\n<content>\nline one\nline two\n</content>',
})
check('Read 正文无信封标签', await settled(() => screen().includes('line one') && !screen().includes('<content>') && !screen().includes('<path>')))
check('Read 正文带 ⎿ 缩进', await settled(() => { const r = rowOf('line one'); return r >= 0 && lines()[r]!.startsWith(' ⎿ line one') }))

// 6. 无 presenter 的工具：回退到 Name(args) + 原始结果（仍然缩进）。
show('fallback', {
  name: 'read',
  resultFull: 'raw output here',
})
check('无视图时回退 Name(args) 标题', await settled(() => screen().includes('Read({"file_path":"/tmp/a.ts"})')))
check('无视图时结果仍缩进', await settled(() => { const r = rowOf('raw output here'); return r >= 0 && lines()[r]!.startsWith(' ⎿ raw output here') }))

// 7. 折叠上限：文本正文超过 3 行折叠 + 提示；Ctrl+O 展开。
show('cap', {
  name: 'bash',
  callView: { card: 'terminal', title: 'seq 6' },
  resultView: { card: 'terminal', output: '1\n2\n3\n4\n5\n6', exitCode: 0 },
  resultFull: '1\n2\n3\n4\n5\n6',
})
check('文本正文折叠为 3 行 + 提示', await settled(() => screen().includes('… +3 lines (ctrl+o to expand)') && rowOf('4') === -1))
show('cap-open', {
  name: 'bash',
  callView: { card: 'terminal', title: 'seq 6' },
  resultView: { card: 'terminal', output: '1\n2\n3\n4\n5\n6', exitCode: 0 },
  resultFull: '1\n2\n3\n4\n5\n6',
}, { verbose: true })
check('verbose 不折叠', await settled(() => rowOf('6') >= 0 && !screen().includes('ctrl+o to expand')))

// 8. 错误卡：errorText 红色缩进。
show('error', {
  name: 'read',
  status: 'error',
  errorText: 'Error: ENOENT',
})
check('错误行带 ⎿ 缩进', await settled(() => { const r = rowOf('Error: ENOENT'); return r >= 0 && lines()[r]!.startsWith(' ⎿ Error: ENOENT') }))
check('错误行有颜色', await settled(() => { const r = rowOf('Error: ENOENT'); return r >= 0 && fgAt(7, r) !== 0 }))

// 9. 运行中的 Edit：挂起期间就展示待定 diff。
show('running-diff', {
  name: 'edit',
  status: 'running',
  callView: {
    card: 'diff',
    title: 'Edit /tmp/a.ts',
    diffs: [{ path: '/tmp/a.ts', oldText: 'old', newText: 'new' }],
  },
})
check('运行中展示待定 diff', await settled(() => rowOf('- old') >= 0 && rowOf('+ new') >= 0))

// 10. 状态点：分类定色、失败红 ✗。
show('dot-bash', { name: 'bash', argsText: '{"command":"ls"}' })
check('bash 点为鼠尾草绿小点', await settled(() => { const r = rowOf('Bash'); return r >= 0 && lines()[r]!.includes('•') && fgAt(lines()[r]!.indexOf('•'), r) === 0x7fae99 }))
show('dot-read', { name: 'read' })
check('read 点为青蓝小点', await settled(() => { const r = rowOf('Read'); return r >= 0 && lines()[r]!.includes('•') && fgAt(lines()[r]!.indexOf('•'), r) === 0x82b8c7 }))
show('dot-edit', { name: 'edit' })
check('edit 点为雾紫小点', await settled(() => { const r = rowOf('Edit'); return r >= 0 && lines()[r]!.includes('•') && fgAt(lines()[r]!.indexOf('•'), r) === 0xb3a0d4 }))
show('dot-error', { name: 'bash', status: 'error', errorText: 'boom' })
check('失败点变红 ✗', await settled(() => { const r = rowOf('Bash'); return r >= 0 && lines()[r]!.includes('✗') && fgAt(lines()[r]!.indexOf('✗'), r) === 0xda8a93 }))

// 10. 多 hunk 编辑（settled contextual diff）：同文件相邻 hunk 用 ⋯ 分隔。
show('multi-hunk', {
  name: 'edit',
  callView: {
    card: 'diff',
    title: 'Edit /tmp/a.ts',
    diffs: [{ path: '/tmp/a.ts', oldText: 'x', newText: 'y' }],
  },
  resultView: {
    card: 'diff',
    title: 'Edit /tmp/a.ts',
    diffs: [
      { path: '/tmp/a.ts', oldText: 'l1', newText: 'l1c' },
      { path: '/tmp/a.ts', oldText: 'l9', newText: 'l9c' },
    ],
  },
})
check('多 hunk 用 ⋯ 分隔', await settled(() => rowOf('⋯') >= 0 && rowOf('- l1') >= 0 && rowOf('+ l9c') >= 0))

// 11. Grep 搜索卡：按文件分组的 matches。
show('grep', {
  name: 'grep',
  callView: { card: 'generic', title: 'Grep TODO in src' },
  resultView: {
    card: 'search',
    shape: 'matches',
    files: [{ path: 'src/a.ts', matches: [{ lineNumber: 12, line: '// TODO fix' }] }],
    truncated: true,
    total: 7,
  },
  resultFull: 'src/a.ts:12: // TODO fix',
})
check('搜索卡标题回退到 call 标题', await settled(() => screen().includes('Grep TODO in src')))
check('搜索卡按文件分组 + 截断计数', await settled(() => rowOf('src/a.ts') >= 0 && rowOf('12: // TODO fix') >= 0 && rowOf('(7 total)') >= 0))

// 12. Glob 搜索卡：paths 形状。
show('glob', {
  name: 'glob',
  callView: { card: 'generic', title: 'Glob **/*.ts' },
  resultView: {
    card: 'search',
    shape: 'paths',
    paths: ['src/a.ts', 'src/b.ts'],
    truncated: false,
    total: 2,
  },
  resultFull: 'src/a.ts\nsrc/b.ts',
})
check('Glob paths 逐行列出', await settled(() => rowOf('src/a.ts') >= 0 && rowOf('src/b.ts') >= 0))

// 13. 终端命令折叠（dsh-tui.foldTerminalCommand）：多行脚本标题收起为
//     首行 + `… +N lines` 提示；提示与正文折叠提示（capLines）同格式。
const pwshTool = {
  name: 'powershell',
  callView: { card: 'terminal', title: '$items = Get-ChildItem -Recurse\n$items | Where-Object { $_.Length -gt 1kb }\n$items | Sort-Object Length\n$items | Select-Object -First 10 Name' },
  resultView: { card: 'terminal', output: '', exitCode: 0 },
  resultFull: '',
}
await show('fold-on', pwshTool, { foldTerminalCommand: true })
check('折叠时标题仅保留命令首行', await settled(() => screen().includes('PowerShell($items = Get-ChildItem -Recurse)')))
check('折叠时显示 +N 行提示', await settled(() => screen().includes('… +3 lines') && screen().includes('ctrl+o')))
check('折叠时后续脚本行不出现', await settled(() => rowOf('Sort-Object') === -1 && rowOf('Select-Object') === -1))

// 13b. 尾随换行是终止符不是行（sideLines 同规则）：'cd /tmp\nls\n' 计 +1 不 +2。
await show('fold-trailing', {
  name: 'bash',
  callView: { card: 'terminal', title: 'cd /tmp\nls\n' },
  resultView: { card: 'terminal', output: '', exitCode: 0 },
  resultFull: '',
}, { foldTerminalCommand: true })
check('尾随换行不计入折叠行数', await settled(() => screen().includes('… +1 lines') && screen().includes('Bash(cd /tmp)')))

// 14. Ctrl+O（verbose）在折叠开启时仍展开完整脚本。
await show('fold-open', pwshTool, { verbose: true, foldTerminalCommand: true })
check('verbose 展开完整命令', await settled(() => rowOf('Sort-Object') >= 0 && rowOf('Select-Object') >= 0 && !screen().includes('… +3 lines')))

// 15. 默认关闭：多行标题完整渲染（现有行为保持不变）。
await show('fold-off', pwshTool)
check('默认关闭时完整渲染多行命令', await settled(() => rowOf('Sort-Object') >= 0 && !screen().includes('… +3 lines')))

// 16. 单行命令：折叠开启时不加提示（与关闭时渲染一致）。
await show('fold-single', {
  name: 'bash',
  callView: { card: 'terminal', title: 'seq 6' },
  resultView: { card: 'terminal', output: '1\n2\n3\n4\n5\n6', exitCode: 0 },
  resultFull: '1\n2\n3\n4\n5\n6',
}, { foldTerminalCommand: true })
check('单行命令折叠开启时不加提示', await settled(() => screen().includes('Bash(seq 6)') && !screen().includes('… +1 lines')))

// 17. 背景：展开不改变卡面（toolBackground 的展开语义）。
//     断言写成「展开 == 折叠 且非终端默认」：主题色值漂移时同色比较仍成立，
//     而修复回退会让展开侧回落到终端默认，从等式的另一侧变红。
/** Title convention for {@link surfaceOf}: unique per scenario key. */
const readTitleOf = (key: string): string => `Read /tmp/${key}.ts`

/** The read card painted at `title`. Each background scenario passes a title of
 *  its own so the text wait can only succeed on the freshly painted frame:
 *  identical text could still be the previous frame, and its surface would
 *  then pass for the new one's. */
function bgReadCard(title: string) {
  return {
    name: 'read',
    callView: { card: 'generic', title },
    resultView: {
      card: 'read',
      path: '/tmp/bg.ts',
      content: [{ type: 'text', text: 'first line\nsecond line' }],
    },
    resultFull: '<path>/tmp/bg.ts</path>\n<content>\nfirst line\nsecond line\n</content>',
  }
}

/** One card's painted surface: header row, body row and the card's right edge. */
type CardSurface = { header: number | null; body: number | null; right: number | null }

const surfaceLabel = (value: number | null): string =>
  value === null ? 'default' : `#${value.toString(16).padStart(6, '0')}`

const sameSurface = (a: CardSurface, b: CardSurface): boolean =>
  a.header === b.header && a.body === b.body && a.right === b.right

/** The three sample points are one surface, not three coincidences. */
const oneSurface = (surface: CardSurface): boolean =>
  surface.header !== null && surface.header === surface.body && surface.body === surface.right

/** Render the read card with `options` and sample its background surface. */
async function surfaceOf(key: string, options: CardOptions): Promise<CardSurface> {
  const title = readTitleOf(key)
  show(key, bgReadCard(title), options)
  await settled(() => rowOf(title) >= 0 && rowOf('first line') >= 0)
  const header = rowOf(title)
  const body = rowOf('first line')
  return { header: bgAt(0, header), body: bgAt(0, body), right: bgAt(COLS - 1, header) }
}

const folded: Record<string, CardSurface> = {}
for (const [tier, label] of [['subtle', '轻微'], ['strong', '明显']] as const) {
  folded[tier] = await surfaceOf(`bg-${tier}-folded`, { toolBackground: tier })
  const unfolded = await surfaceOf(`bg-${tier}-unfolded`, { toolBackground: tier, verbose: true, isExpanded: true })
  check(
    `展开「${label}」卡与折叠同底色（卡头 / 正文 / 右缘）`,
    oneSurface(folded[tier]) && sameSurface(folded[tier], unfolded),
    `folded=${surfaceLabel(folded[tier].body)} unfolded=${surfaceLabel(unfolded.header)}/${surfaceLabel(unfolded.body)}/${surfaceLabel(unfolded.right)}`,
  )
}

const unfoldedNone = await surfaceOf('bg-none-unfolded', { toolBackground: 'none', verbose: true, isExpanded: true })
check('展开「无」卡保持透明', unfoldedNone.header === null && unfoldedNone.body === null && unfoldedNone.right === null,
  `header/body/right=${surfaceLabel(unfoldedNone.header)}/${surfaceLabel(unfoldedNone.body)}/${surfaceLabel(unfoldedNone.right)}`)

const verboseOnly = await surfaceOf('bg-verbose-only', { toolBackground: 'subtle', verbose: true })
check('仅用 Ctrl+O 展开时保持设置底色', oneSurface(folded.subtle) && sameSurface(folded.subtle, verboseOnly),
  `folded=${surfaceLabel(folded.subtle.body)} verbose=${surfaceLabel(verboseOnly.body)}`)

const selectedFolded = await surfaceOf('bg-selected-folded', { toolBackground: 'subtle', isSelected: true })
const selectedUnfolded = await surfaceOf('bg-selected-unfolded', { toolBackground: 'subtle', isSelected: true, verbose: true, isExpanded: true })
check('选中并展开仍显示选择高亮',
  oneSurface(selectedFolded) && sameSurface(selectedFolded, selectedUnfolded)
    && selectedUnfolded.body !== folded.subtle.body,
  `selected=${surfaceLabel(selectedUnfolded.body)} ordinary=${surfaceLabel(folded.subtle.body)}`)

/** The split-diff edit card painted at `title` (same unique-title rule). */
function bgSplitCard(title: string) {
  const diff = {
    path: '/tmp/split.ts',
    oldText: 'top line\nremoved alpha\ntail line',
    newText: 'top line\nadded beta\ntail line',
  }
  return {
    name: 'edit',
    callView: { card: 'diff', title, diffs: [diff] },
    resultView: { card: 'diff', title, diffs: [diff] },
    resultFull: 'ok',
  }
}

/** Sample columns inside the two panes at this terminal width: the 3-cell
 *  gutter plus a 42-cell pane put the divider at column 45. */
const LEFT_PANE_COL = 10
const RIGHT_PANE_COL = 50

/** Two-pane sample: the unchanged row's surface on both panes, plus the tinted
 *  changed row (left = removed, right = added). */
type SplitSurface = { context: [number | null, number | null]; removed: number | null; added: number | null }

async function splitSurfaceOf(key: string, options: CardOptions): Promise<SplitSurface> {
  const title = `Edit /tmp/${key}.ts`
  show(key, bgSplitCard(title), { ...options, diffLayout: 'split' })
  await settled(() => rowOf(title) >= 0 && rowOf('top line') >= 0 && rowOf('removed alpha') >= 0)
  const contextRow = rowOf('top line')
  const changedRow = rowOf('removed alpha')
  return {
    context: [bgAt(LEFT_PANE_COL, contextRow), bgAt(RIGHT_PANE_COL, contextRow)],
    removed: bgAt(LEFT_PANE_COL, changedRow),
    added: bgAt(RIGHT_PANE_COL, changedRow),
  }
}

const splitFolded = await splitSurfaceOf('bg-split-folded', { toolBackground: 'subtle' })
const splitUnfolded = await splitSurfaceOf('bg-split-unfolded', { toolBackground: 'subtle', verbose: true, isExpanded: true })
check('双栏 diff 展开后未改动行沿用设置底色',
  splitFolded.context[0] !== null && splitFolded.context[1] !== null
    && splitUnfolded.context[0] === splitFolded.context[0] && splitUnfolded.context[1] === splitFolded.context[1],
  `folded=${surfaceLabel(splitFolded.context[0])} unfolded=${surfaceLabel(splitUnfolded.context[0])}/${surfaceLabel(splitUnfolded.context[1])}`)
check('双栏 diff 删 / 增行语义色不随展开改变',
  splitFolded.removed !== null && splitFolded.added !== null
    && splitUnfolded.removed === splitFolded.removed && splitUnfolded.added === splitFolded.added,
  `folded=${surfaceLabel(splitFolded.removed)}/${surfaceLabel(splitFolded.added)} unfolded=${surfaceLabel(splitUnfolded.removed)}/${surfaceLabel(splitUnfolded.added)}`)

// 已展开的同一张卡（key 不变）：改设置后卡面立即跟随，不用折叠再展开。
await surfaceOf('bg-follow', { toolBackground: 'subtle', verbose: true, isExpanded: true })
show('bg-follow', bgReadCard(readTitleOf('bg-follow')), { toolBackground: 'strong', verbose: true, isExpanded: true })
const strongBody = folded.strong.body
// 文本不变，这一帧的完成条件只能是「新底色出现」；等待与断言共用同一谓词。
const followed = await settled(() => strongBody !== null && bgAt(0, rowOf('first line')) === strongBody)
check('展开中切换档位，卡片立即跟随', followed,
  `expected=${surfaceLabel(strongBody)} actual=${surfaceLabel(bgAt(0, rowOf('first line')))}`)

app.unmount()
// 固定窗:pacing unmount 后输出 flush 无可观测条件。
await sleep(100)
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
