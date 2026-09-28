/**
 * 状态栏 sub-agent 计数 chip 回归：
 *
 *  A. 无子代理 / 全部已结算：chip 不出现（静默的零不是信息）。
 *  B. 2 个运行中 + 1 个已完成的子代理：chip 显示 `2 sub-agents`
 *     （只数 running/starting；复数形式）。
 *  C. 恰 1 个运行中：chip 显示 `1 sub-agent`（单数形式）。
 *  D. 悬停 chip：明细行列出运行中子代理的 description + 已耗时，
 *     最多 3 个、其余记 `+N`；移开即撤下。
 *  E. jobs chip 共存：两 chip 同时在屏、互不顶替。
 *
 * Run: `node --import tsx/esm scripts/verify-statusline-subagents.tsx`
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'verify-statusline-subagents-data-'))
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

const { StatusLine } = await import('../src/screens/StatusLine.js')

const NOW = Date.now()
function subagent(agentId: string, status: string, description: string, startedAt = NOW - 65_000) {
  return {
    agentId,
    description,
    status,
    startedAt,
    output: [],
    outputEvents: [],
    toolCalls: [],
  }
}

const baseStub = {
  minimal: false,
  statusBar: { gitBranch: true },
  model: 'TM',
  provider: 'test-provider',
  contextWindow: 64_000,
  gitBranch: 'test-branch',
  displayCwd: 'D:\\work\\dsh-tui',
  cwd: 'D:\\work\\dsh-tui',
  mode: { plan: false, sandbox: 'workspace-write', approval: 'on-request' },
  modeIndex: 0,
  tokens: { input: 0, output: 0 },
  tpsSamples: [],
  backgroundJobs: [],
  contextSegments: {},
  working: false,
  activityFrames: [],
  goal: undefined,
  sessionTitle: undefined,
  agentId: 'abcdef0123456789',
  reasoningEffort: undefined,
  tps: undefined,
  lastUsage: undefined,
  contextBarEnabled: false,
}

try {
  const COLS = 100
  const ROWS = 12
  const rig = makeRig(COLS, ROWS)
  const { term, stdin } = rig

  const renderWith = (channel: Record<string, unknown>) => (
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <StatusLine channel={channel as never} />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>
  )

  const instance = await render(renderWith({ ...baseStub, subagents: [] }), {
    stdout: rig.stdout, stdin: rig.stdin, exitOnCtrlC: false, patchConsole: false,
  })
  check('场景 A 就绪：状态栏在屏', await settled(() => screenHas(term, 'TM')))
  await sleep(900) // 固定窗:探针 无子代理不得出现 chip；条件本就成立，轮询立即返回等于没测
  check('A 无子代理时无 chip', !screenHas(term, 'sub-agent'))

  // --- B. 2 running + 1 completed ----------------------------------------
  instance.rerender(renderWith({
    ...baseStub,
    subagents: [
      subagent('a1', 'running', 'explore channel structure'),
      subagent('a2', 'starting', 'probe upstream jobs API', NOW - 5_000),
      subagent('a3', 'completed', 'settled child', NOW - 300_000),
    ],
  }))
  check('B 运行中计数 chip 在屏（2 sub-agents）', await settled(() => screenHas(term, '2 sub-agents')))
  check('B 已结算子代理不计数（无 3 sub-agents）', !screenHas(term, '3 sub-agents'))

  // --- D. 悬停 chip 弹明细（在 B 状态下测，避免二次挂载首帧坑） ----------
  hoverText(stdin, term, '2 sub-agents')
  check('D 悬停 chip 弹明细（含两个运行中子代理的描述）', await settled(() =>
    screenHas(term, 'sub-agents') && screenHas(term, 'explore channel structure') && screenHas(term, 'probe upstream jobs API')))
  check('D 明细带已耗时', screenHas(term, '(1m'), 'a1 started 65s ago → 1mNs，秒数随运行时间漂移，只钉分钟前缀')
  check('D 明细不含已结算子代理', !screenHas(term, 'settled child'))
  hover(stdin, 1, 1)
  check('D 移开即撤下明细', await settled(() => !screenHas(term, 'explore channel structure')))

  // --- C. 恰 1 个运行中：单数形式 -----------------------------------------
  instance.rerender(renderWith({
    ...baseStub,
    subagents: [subagent('a1', 'running', 'lone child')],
  }))
  check('C 单子代理显示单数（1 sub-agent）', await settled(() =>
    screenHas(term, '1 sub-agent') && !screenHas(term, '1 sub-agents')))

  // --- A2. 全部结算后 chip 消失 -------------------------------------------
  instance.rerender(renderWith({
    ...baseStub,
    subagents: [subagent('a1', 'completed', 'done child'), subagent('a2', 'failed', 'failed child')],
  }))
  check('A2 全部结算后 chip 消失', await settled(() => !screenHas(term, 'sub-agent')))

  // --- E. 与 jobs chip 共存 -----------------------------------------------
  instance.rerender(renderWith({
    ...baseStub,
    subagents: [subagent('a1', 'running', 'child one'), subagent('a2', 'running', 'child two')],
    backgroundJobs: [{
      id: 'pwsh-1', kind: 'pwsh', label: 'pnpm build', status: 'running',
      startedAt: NOW - 10_000, outputLines: [],
    }],
  }))
  check('E jobs chip 与 sub-agents chip 同时在屏', await settled(() =>
    screenHas(term, '2 sub-agents') && findText(term, 'pwsh-1') === null /* jobs chip 只显计数 */ && screenHas(term, '● 1')))

  instance.unmount()
  await sleep(100) // 固定窗:pacing unmount 收尾输出 flush，无可观测完成条件

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error(err)
  process.exit(1)
}
