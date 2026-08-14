/**
 * Tool-card presentation scenarios: the channel captures dsh-tools
 * presentCall/presentResult views and AssistantToolUseMessage renders them
 * as CC-style indented bodies (`  ⎿  ` gutter) — diff hunks in red/green,
 * terminal output, envelope-stripped read content — instead of the raw
 * tool-message dump. Exercises the pure component with fabricated ToolRows
 * (no channel needed: views are plain data on the row).
 */
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { Terminal: XTerm }, { renderSync }, { AssistantToolUseMessage }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
])

const COLS = 90
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
/** Clear the headless screen so each scenario asserts its own paint. */
function clearScreen(): void {
  term.reset()
}
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
const stdout = new FakeStdout()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Snapshot of the last scenario's paint: joined text rows + per-cell fg. */
let lastScreen = ''
let lastFg: number[][] = []
/** Snapshot the headless screen: text rows + per-cell foreground colors. */
function snapshotScreen(): { text: string; fg: number[][] } {
  const buf = term.buffer.active
  const text: string[] = []
  const fg: number[][] = []
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(y)
    text.push(line?.translateToString(true) ?? '')
    const rowFg: number[] = []
    for (let x = 0; x < COLS; x++) rowFg.push((line?.getCell(x)?.getFgColor() ?? 0) & 0xffffff)
    fg.push(rowFg)
  }
  return { text: text.join('\n'), fg }
}
function screen(): string {
  return lastScreen
}
function fgAt(x: number, y: number): number {
  return lastFg[y]?.[x] ?? 0
}
/** Locate the snapshot row containing `needle`; -1 when absent. */
function rowOf(needle: string): number {
  const rows = lastScreen.split('\n')
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

/**
 * Render one scenario on a fresh Ink instance, snapshot the headless screen,
 * then tear down and reset. A single long-lived instance diffs same-geometry
 * frames to a no-op (nothing repaints after term.reset()), so each scenario
 * mounts clean — the paint is always a full first frame. `patchConsole: false`
 * keeps this script's console.log results visible.
 */
async function show(key: string, tool: Record<string, unknown>, verbose = false): Promise<void> {
  const instance = renderSync(card(key, tool, verbose), { stdout, debug: true, exitOnCtrlC: false, patchConsole: false })
  await sleep(300)
  const snap = snapshotScreen()
  lastScreen = snap.text
  lastFg = snap.fg
  instance.unmount()
  term.reset()
  await sleep(20)
}

await show('edit', editTool)

// 1. Settled Edit: diff body, red `- ` / green `+ ` lines under the ⎿ gutter.
{
  const s = lastScreen
  check('编辑卡片标题为「Edit /tmp/a.ts」（非 JSON args）', s.includes('Edit /tmp/a.ts') && !s.includes('{"file_path"'))
  check('diff 计数行 +1 -1', rowOf('⎿  +1 -1') >= 0)
  const delRow = rowOf('- const a = 1')
  const addRow = rowOf('+ const a = 2')
  check('删除行延续缩进', delRow >= 0 && lastScreen.split('\n')[delRow]!.startsWith('     - const a = 1'))
  check('新增行延续缩进', addRow >= 0 && lastScreen.split('\n')[addRow]!.startsWith('     + const a = 2'))
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
  const s = lastScreen
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
  const s = lastScreen
  check('终端卡标题为「Bash(ls -la)」', s.includes('Bash(ls -la)'))
  const outRow = rowOf('total 8')
  check('终端输出带 ⎿ 缩进', outRow >= 0 && lastScreen.split('\n')[outRow]!.startsWith('  ⎿  total 8'))
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
  const s = lastScreen
  check('Read 正文无信封标签', s.includes('line one') && !s.includes('<content>') && !s.includes('<path>'))
  const row = rowOf('line one')
  check('Read 正文带 ⎿ 缩进', row >= 0 && lastScreen.split('\n')[row]!.startsWith('  ⎿  line one'))
}

// 6. 无 presenter 的工具：回退到 Name(args) + 原始结果（仍然缩进）。
await show('fallback', {
  name: 'read',
  resultFull: 'raw output here',
})
{
  const s = lastScreen
  check('无视图时回退 Name(args) 标题', s.includes('Read({"file_path":"/tmp/a.ts"})'))
  const row = rowOf('raw output here')
  check('无视图时结果仍缩进', row >= 0 && lastScreen.split('\n')[row]!.startsWith('  ⎿  raw output here'))
}

// 7. 折叠上限：文本正文超过 3 行折叠 + 提示；Ctrl+O 展开。
await show('cap', {
  name: 'bash',
  callView: { card: 'terminal', title: 'seq 6' },
  resultView: { card: 'terminal', output: '1\n2\n3\n4\n5\n6', exitCode: 0 },
  resultFull: '1\n2\n3\n4\n5\n6',
})
{
  const s = lastScreen
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
  check('错误行带 ⎿ 缩进', row >= 0 && lastScreen.split('\n')[row]!.startsWith('  ⎿  Error: ENOENT'))
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
  const s = lastScreen
  check('搜索卡标题回退到 call 标题', s.includes('Grep TODO in src'))
  check('折叠态只剩 Found 摘要行', rowOf('Found 1 of 7 match across 1 file') >= 0 && rowOf('// TODO fix') === -1)
}

// 11b. Grep verbose：按文件分组 + 截断计数尾行。
await show('grep-open', {
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
}, true)
check('verbose 按文件分组 + 截断计数', rowOf('src/a.ts') >= 0 && rowOf('12: // TODO fix') >= 0 && rowOf('(7 total)') >= 0)

// 12. Glob 搜索卡：paths 形状。
await show('glob', {
  name: 'glob',
  callView: { card: 'generic', title: 'Glob **/*.ts' },
  resultView: {
    truncated: false,
    total: 2,
  },
  resultFull: 'src/a.ts\nsrc/b.ts',
})
check('Glob paths 逐行列出', rowOf('src/a.ts') >= 0 && rowOf('src/b.ts') >= 0)

const t0 = 1_700_000_000_000

// 13. 前台 SubAgent settled：Done (N tool uses · X tokens · dur) + 输出预览。
await show('subagent-done', {
  name: 'subagent',
  argsText: '{"description":"Refactor auth"}',
  argsFull: '{"description":"Refactor auth","prompt":"…"}',
  resultFull: 'The auth module was refactored into 3 files.',
  childStats: { toolUses: 14, totalTokens: 31200, firstEventAt: t0, endedAt: t0 + 43000, stopReason: 'completed' },
})
{
  const s = lastScreen
  check('SubAgent 标题用 description 而非原始 JSON', s.includes('SubAgent(Refactor auth)') && !s.includes('{"description"'))
  check('Task 旧名不再出现', !s.includes('Task('))
  check('Done 汇总行', rowOf('Done (14 tool uses · 31.2k tokens · 43s)') >= 0)
  check('输出前 2 行预览', rowOf('The auth module was refactored') >= 0)
}

// 14. 前台 SubAgent running：In progress live 行。
await show('subagent-running', {
  name: 'subagent',
  status: 'running',
  argsText: '{"description":"Refactor auth"}',
  argsFull: '{"description":"Refactor auth","prompt":"…"}',
  childStats: { toolUses: 6, totalTokens: 12400 },
})
check('In progress live 行', rowOf('In progress · 6 tool uses · 12.4k tokens') >= 0)

// 15. 后台 SubAgent：Done 行（jobId 关联，输出是 started ack）。
await show('subagent-bg', {
  name: 'subagent',
  argsText: '{"description":"Check CI logs"}',
  argsFull: '{"description":"Check CI logs","prompt":"…","run_in_background":true}',
  resultFull: 'started background subagent task subagent-1',
  jobId: 'subagent-1',
  childStats: { toolUses: 9, totalTokens: 18300, firstEventAt: t0, endedAt: t0 + 161000, stopReason: 'completed' },
})
check('后台 SubAgent Done 行', rowOf('Done (9 tool uses · 18.3k tokens · 2m 41s)') >= 0)

// 16. bash 后台 Job 卡：exit code 状态行 + 时长。
await show('bash-bg', {
  name: 'bash',
  argsText: '{"command":"npm run watch"}',
  argsFull: '{"command":"npm run watch","description":"dev server","run_in_background":true}',
  resultFull: 'started background job bash-3',
  jobId: 'bash-3',
  jobStatus: 'completed',
  jobDetail: 'exit code: 0',
  childStats: { toolUses: 0, totalTokens: 0, firstEventAt: t0, endedAt: t0 + 184000 },
})
check('后台 Job exit code 行', rowOf('exit code: 0 · 3m 4s') >= 0)

// 17. Job Output 卡：内容预览 + [✓ …] 徽记。
await show('job-output', {
  name: 'job_output',
  argsText: '{"job_id":"bash-3"}',
  argsFull: '{"job_id":"bash-3"}',
  resultFull: 'webpack 5.96 compiled\nassets by status\nchunks merged\n[status: completed, exit code: 0]',
  jobId: 'bash-3',
  childStats: { toolUses: 0, totalTokens: 0, firstEventAt: t0, endedAt: t0 + 184000 },
})
{
  const s = lastScreen
  check('Job Output 徽记', s.includes('[✓ exit code: 0 · 3m 4s]'))
  check('Job Output 内容截断为 3 行', s.includes('webpack 5.96 compiled') && !s.includes('chunks merged'))
}

// 18. Job List 卡：结构化 job 行。
await show('job-list', {
  name: 'job_list',
  argsText: '{}',
  argsFull: '{}',
  resultFull: 'bash-3 [bash] running — npm run watch\nsubagent-1 [subagent] completed — Refactor auth',
})
{
  const s = lastScreen
  check('Job List 状态符号', s.includes('● bash-3 running') && s.includes('◆ subagent-1 completed'))
  check('Job List label 保留', s.includes('npm run watch') && s.includes('Refactor auth'))
}

// 19. Job Kill quiet 卡：settled 后无 body。
await show('job-kill', {
  name: 'job_kill',
  argsText: '{"job_id":"bash-3"}',
  argsFull: '{"job_id":"bash-3"}',
  resultFull: 'requested cancellation of job bash-3',
})
check('Job Kill 静默（无 body）', rowOf('requested cancellation') === -1)

// The last scenario re-rendered fresh; give ink a beat then exit.
await sleep(150)
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
