/**
 * Tool-card presentation scenarios: the channel captures dsh-tools
 * presentCall/presentResult views and AssistantToolUseMessage renders them
 * as CC-style indented bodies (`  ⎿  ` gutter) — diff hunks in red/green,
 * terminal output, envelope-stripped read content — instead of the raw
 * tool-message dump. Exercises the pure component with fabricated ToolRows
 * (no channel needed: views are plain data on the row).
 */
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { Terminal: XTerm }, { render }, { AssistantToolUseMessage }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
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
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const base = {
  callId: 'c1',
  argsText: '{"file_path":"/tmp/a.ts"}',
  status: 'ok' as const,
  startedAt: 0,
  durationMs: 12,
}

function card(key: string, tool: Record<string, unknown>, verbose = false): React.ReactElement {
  return React.createElement(AssistantToolUseMessage, {
    key,
    tool: { ...base, ...tool },
    addMargin: false,
    verbose,
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
await sleep(250)

/** Swap the rendered card; key forces a clean remount per scenario. */
async function show(key: string, tool: Record<string, unknown>, verbose = false): Promise<void> {
  app.rerender(card(key, tool, verbose))
  await sleep(250)
}

// 1. Settled Edit: diff body, red `- ` / green `+ ` lines under the ⎿ gutter.
{
  const s = screen()
  check('编辑卡片标题为「Edit /tmp/a.ts」（非 JSON args）', s.includes('Edit /tmp/a.ts') && !s.includes('{"file_path"'))
  const delRow = rowOf('- const a = 1')
  const addRow = rowOf('+ const a = 2')
  check('删除行带 ⎿ 缩进', delRow >= 0 && lines()[delRow]!.startsWith('  ⎿  - const a = 1'))
  check('新增行延续缩进', addRow >= 0 && lines()[addRow]!.startsWith('     + const a = 2'))
  check('删除行为红色系', delRow >= 0 && fgAt(7, delRow) === 0xb26671)
  check('新增行为绿色系', addRow >= 0 && fgAt(7, addRow) === 0x57956b)
}

// 2. Write 新建（oldText null）只有 + 行。
await show('write', {
  name: 'write',
  callView: {
    card: 'diff',
    title: 'Write /tmp/new.ts',
    diffs: [{ path: '/tmp/new.ts', oldText: null, newText: 'hello\nworld' }],
  },
})
{
  const s = screen()
  check('新建文件标题为「Write /tmp/new.ts」', s.includes('Write /tmp/new.ts'))
  check('新建只有新增行', s.includes('+ hello') && s.includes('+ world') && !s.includes('- hello'))
}

// 3. Bash 终端卡：命令作标题，输出缩进。
await show('bash', {
  name: 'bash',
  argsText: '{"command":"ls -la"}',
  callView: { card: 'terminal', title: 'ls -la' },
  resultView: { card: 'terminal', output: 'total 8\nfile1\nfile2', exitCode: 0 },
  resultFull: 'total 8\nfile1\nfile2',
})
{
  const s = screen()
  check('终端卡标题为「Bash(ls -la)」', s.includes('Bash(ls -la)'))
  const outRow = rowOf('total 8')
  check('终端输出带 ⎿ 缩进', outRow >= 0 && lines()[outRow]!.startsWith('  ⎿  total 8'))
}

// 4. Bash 非零退出：追加 Exit code 行。
await show('bash-err', {
  name: 'bash',
  callView: { card: 'terminal', title: 'false' },
  resultView: { card: 'terminal', output: '', exitCode: 1 },
  resultFull: '',
})
check('非零退出显示 Exit code 行', rowOf('Exit code 1') >= 0)

// 5. Read 卡：正文剥离 <path>/<content> 信封。
await show('read', {
  name: 'read',
  callView: { card: 'generic', title: 'Read /tmp/x.ts' },
  resultView: {
    card: 'read',
    path: '/tmp/x.ts',
    content: [{ type: 'text', text: 'line one\nline two' }],
  },
  resultFull: '<path>/tmp/x.ts</path>\n<content>\nline one\nline two\n</content>',
})
{
  const s = screen()
  check('Read 正文无信封标签', s.includes('line one') && !s.includes('<content>') && !s.includes('<path>'))
  const row = rowOf('line one')
  check('Read 正文带 ⎿ 缩进', row >= 0 && lines()[row]!.startsWith('  ⎿  line one'))
}

// 6. 无 presenter 的工具：回退到 Name(args) + 原始结果（仍然缩进）。
await show('fallback', {
  name: 'read',
  resultFull: 'raw output here',
})
{
  const s = screen()
  check('无视图时回退 Name(args) 标题', s.includes('Read({"file_path":"/tmp/a.ts"})'))
  const row = rowOf('raw output here')
  check('无视图时结果仍缩进', row >= 0 && lines()[row]!.startsWith('  ⎿  raw output here'))
}

// 7. 折叠上限：文本正文超过 3 行折叠 + 提示；Ctrl+O 展开。
await show('cap', {
  name: 'bash',
  callView: { card: 'terminal', title: 'seq 6' },
  resultView: { card: 'terminal', output: '1\n2\n3\n4\n5\n6', exitCode: 0 },
  resultFull: '1\n2\n3\n4\n5\n6',
})
{
  const s = screen()
  check('文本正文折叠为 3 行 + 提示', s.includes('… +3 lines (ctrl+o to expand)') && rowOf('4') === -1)
}
await show('cap-open', {
  name: 'bash',
  callView: { card: 'terminal', title: 'seq 6' },
  resultView: { card: 'terminal', output: '1\n2\n3\n4\n5\n6', exitCode: 0 },
  resultFull: '1\n2\n3\n4\n5\n6',
}, true)
check('verbose 不折叠', rowOf('6') >= 0 && !screen().includes('ctrl+o to expand'))

// 8. 错误卡：errorText 红色缩进。
await show('error', {
  name: 'read',
  status: 'error',
  errorText: 'Error: ENOENT',
})
{
  const row = rowOf('Error: ENOENT')
  check('错误行带 ⎿ 缩进', row >= 0 && lines()[row]!.startsWith('  ⎿  Error: ENOENT'))
  check('错误行有颜色', row >= 0 && fgAt(7, row) !== 0)
}

// 9. 运行中的 Edit：挂起期间就展示待定 diff。
await show('running-diff', {
  name: 'edit',
  status: 'running',
  callView: {
    card: 'diff',
    title: 'Edit /tmp/a.ts',
    diffs: [{ path: '/tmp/a.ts', oldText: 'old', newText: 'new' }],
  },
})
check('运行中展示待定 diff', rowOf('- old') >= 0 && rowOf('+ new') >= 0)

// 10. 多 hunk 编辑（settled contextual diff）：同文件相邻 hunk 用 ⋯ 分隔。
await show('multi-hunk', {
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
check('多 hunk 用 ⋯ 分隔', rowOf('⋯') >= 0 && rowOf('- l1') >= 0 && rowOf('+ l9c') >= 0)

// 11. Grep 搜索卡：按文件分组的 matches。
await show('grep', {
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
{
  const s = screen()
  check('搜索卡标题回退到 call 标题', s.includes('Grep TODO in src'))
  check('搜索卡按文件分组 + 截断计数', rowOf('src/a.ts') >= 0 && rowOf('12: // TODO fix') >= 0 && rowOf('(7 total)') >= 0)
}

// 12. Glob 搜索卡：paths 形状。
await show('glob', {
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
check('Glob paths 逐行列出', rowOf('src/a.ts') >= 0 && rowOf('src/b.ts') >= 0)

app.unmount()
await sleep(100)
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
