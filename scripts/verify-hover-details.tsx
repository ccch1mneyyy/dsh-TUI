/**
 * 悬停浮层第二批回归：「浮层只给屏幕上看不到、悬停马上想知道的信息」
 * 在另外三处的落地——
 *
 *  F. @ 文件补全面板：名称列固定 20 列 + 行宽截断，悬停被截断的长路径行
 *     弹出完整路径 + 类型；完整可见的短路径行不弹。
 *  G. 会话列表行：标题截断时悬停弹【完整标题 + 绝对时间 + cwd】；标题
 *     未截断时浮层不重复标题（只带时间 + cwd）。
 *  H. 状态栏 model/git 字段：悬停 model 弹 provider + ctx 窗口明细；
 *     悬停 git 弹完整分支名（原地明细行契约，与 tps/cost 同款）。
 *
 * Run: `node --import tsx/esm scripts/verify-hover-details.tsx`
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'verify-hover-details-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, tooltip, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/Tooltip.js'),
  import('./lib/term-test.mjs'),
])

const { sleep, settled, screenHas, findText } = termTest
const { render, AlternateScreen, Box } = ui

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

function KeySink(): React.ReactNode {
  ui.useInput(() => {})
  return null
}

function makeRig(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 50, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  return { term, stdout: new FakeStdout(), stdin: new FakeStdin() }
}

/** SGR mode-1003 motion with no buttons → dispatchHover. Coords 1-indexed. */
const hover = (stdin: PassThrough, col: number, row: number) =>
  stdin.write(`\x1b[<35;${col};${row}M`)

function hoverText(stdin: PassThrough, term: XTerm, needle: string): void {
  const at = findText(term, needle)
  if (at === null) throw new Error(`hover target not found: ${needle}`)
  hover(stdin, at.col + 1, at.row + 1)
}

const { FileSuggestions } = await import('../src/components/FileSuggestions.js')
const { SessionListRow } = await import('../src/components/sessions/SessionListRow.js')
const { StatusLine } = await import('../src/screens/StatusLine.js')
const { formatAbsolute } = await import('../src/sessions/format.js')

try {
  const COLS = 50
  const ROWS = 30
  const rig = makeRig(COLS, ROWS)
  const { term, stdin } = rig

  // --- F. @ 文件补全面板：长路径截断 → 悬停弹全路径 ----------------------
  // 路径宽 43：行内截断（5+43 > usable=46 边界内）且浮层单行放得下
  // （内宽 44），屏幕断言与浮层内容一一对应。
  const LONG_PATH = 'src/components/messages/DeepLongFileName.tsx'
  const files = [
    { id: 'f1', path: LONG_PATH, displayPath: LONG_PATH, name: 'DeepLongFileName.tsx', kind: 'file' as const, score: 1 },
    { id: 'f2', path: 'README.md', displayPath: 'README.md', name: 'README.md', kind: 'file' as const, score: 1 },
  ]
  const instance = await render(
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <FileSuggestions files={files} selectedIndex={0} columns={COLS} />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>,
    { stdout: rig.stdout, stdin: rig.stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  check('场景 F 就绪：长路径行已截断（尾段不在屏）', await settled(() => !screenHas(term, 'DeepLongFileName.tsx')))
  hoverText(stdin, term, 'src/components/messages')
  check('F 截断路径悬停后弹出完整路径', await settled(() => screenHas(term, 'DeepLongFileName.tsx')))
  // 浮层盖住下方行：先移开再找短路径行的悬停目标。
  hover(stdin, 1, 1)
  check('F 移开后长路径浮层消失', await settled(() => !screenHas(term, 'DeepLongFileName.tsx')))
  // 短路径行：名字完整可见 → 悬停不弹浮层（直查 tooltip store，排除
  // 「卡片内容恰好与可见文本同字」的歧义）。
  hoverText(stdin, term, 'README.md')
  await sleep(900)
  check('F 完整可见路径悬停不弹浮层', tooltip.getTooltipSnapshot() === null,
    `snapshot=${JSON.stringify(tooltip.getTooltipSnapshot()?.content ?? null)}`)

  // --- G. 会话列表行：标题截断 → 悬停弹完整标题+绝对时间+cwd ------------
  const NOW = Date.now()
  const session = {
    id: 'sess-1',
    kind: { kind: 'root' as const },
    title: { text: '修复一个非常长非常长需要被截断才能看到结尾标记END-OF-TITLE的标题', source: 'auto' as const },
    cwd: 'D:\\work\\dsh-tui',
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
    bytes: 2048,
    hasPrompt: true,
    agentPreset: undefined,
    model: 'deepseek-chat',
    label: undefined,
    branch: 'main',
    childCount: 0,
  }
  const sessionTree = (width: number) => (
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <SessionListRow session={session} width={width} depth={0} focused={false} pinned={false} now={NOW} />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>
  )
  instance.rerender(sessionTree(60))
  // 负值就绪探针会立即在旧帧上返回（term-test 的系统性坑）：先用正值
  // 等新树真正上屏，再断言截断。
  check('场景 G 就绪：会话行已渲染', await settled(() => screenHas(term, '修复')))
  check('场景 G 就绪：长标题已截断（结尾标记不在屏）', !screenHas(term, 'END-OF-TITLE'))
  hoverText(stdin, term, '修复')
  check('G 截断标题悬停后弹出完整标题', await settled(() => screenHas(term, 'END-OF-TITLE')))
  const absolute = formatAbsolute(session.updatedAt)
  check('G 浮层带绝对时间戳', await settled(() => screenHas(term, absolute)), `abs=${absolute}`)
  check('G 浮层带 cwd', await settled(() => screenHas(term, 'D:\\work\\dsh-tui')))
  hover(stdin, 1, 1)
  check('G 移开即隐藏工具提示', await settled(() => !screenHas(term, 'END-OF-TITLE')))

  // G2：标题完整可见（宽行）→ 浮层不重复标题，只带时间 + cwd。
  instance.rerender(sessionTree(120))
  check('场景 G2 就绪：宽行标题完整在屏', await settled(() => screenHas(term, 'END-OF-TITLE')))
  hoverText(stdin, term, '修复')
  check('G2 完整标题悬停弹浮层（时间+cwd）', await settled(() => tooltip.getTooltipSnapshot() !== null))
  {
    const content = tooltip.getTooltipSnapshot()?.content ?? ''
    check('G2 浮层不重复完整标题', !content.includes('END-OF-TITLE'), `content=${JSON.stringify(content)}`)
    check('G2 浮层仍带绝对时间与 cwd', content.includes(absolute) && content.includes('dsh-tui'))
  }
  hover(stdin, 1, 1)

  // --- H. 状态栏字段：model/git 悬停明细 ---------------------------------
  const channelStub = {
    minimal: false,
    statusBar: { gitBranch: true },
    model: 'TM',
    provider: 'test-provider',
    contextWindow: 64_000,
    gitBranch: 'test-branch-long',
    displayCwd: 'D:\\work\\dsh-tui',
    cwd: 'D:\\work\\dsh-tui',
    mode: { plan: false, sandbox: 'workspace-write', approval: 'on-request' },
    modeIndex: 0,
    tokens: { input: 0, output: 0 },
    tpsSamples: [],
    backgroundJobs: [],
    contextSegments: {},
    working: false,
    workingActivity: undefined,
    activityFrames: [],
    goal: undefined,
    sessionTitle: undefined,
    agentId: 'abcdef0123456789',
    reasoningEffort: undefined,
    tps: undefined,
    lastUsage: undefined,
    contextBarEnabled: false,
  }
  instance.rerender(
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <StatusLine channel={channelStub as never} />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>,
  )
  check('场景 H 就绪：状态栏 model/git 字段在屏',
    await settled(() => screenHas(term, 'TM') && screenHas(term, 'test-branch-long')))
  check('H 未悬停时无明细行', !screenHas(term, 'provider test-provider'))
  hoverText(stdin, term, 'TM')
  check('H 悬停 model 字段弹 provider/ctx 明细',
    await settled(() => screenHas(term, 'provider test-provider') && screenHas(term, 'ctx 64k')))
  hoverText(stdin, term, 'test-branch-long')
  check('H 悬停 git 字段弹完整分支明细',
    await settled(() => screenHas(term, 'git test-branch-long')))
  check('H 明细随悬停目标切换（model 明细已离开）',
    await settled(() => !screenHas(term, 'provider test-provider')))
  hover(stdin, 1, 1)

  instance.unmount()
  await sleep(100)
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error(err)
  process.exit(1)
}
