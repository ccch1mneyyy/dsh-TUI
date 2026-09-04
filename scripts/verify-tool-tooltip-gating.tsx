/**
 * 工具卡头部 hover tooltip 内容回归（用户反馈 v2：旧行为——内容完全
 * 可见也弹「时刻/退出码」浮层——仍是噪音；浮层只该在内容真被隐藏时
 * 出现）。
 *
 * 断言：
 *  A. 单行标题完整可见（Edit 卡）→ 悬停**不弹任何浮层**（标题全屏只
 *     出现一次，无时刻框）。
 *  B. 终端脚本折叠（首行 + `… +N lines`，脚本真被隐藏）→ 悬停弹出
 *     完整脚本；移开即消失（tooltip 基础设施契约不变）。
 *  C. title 缺失、args 超出头部显示预算（HEADER_ARGS_BUDGET=480）→
 *     头部裁剪；悬停弹出完整 args（含 480 字符之后才出现的标记）。
 *  D. 运行中卡片、标题完整可见 → 悬停**不弹**（wrap 完整显示，无隐藏
 *     内容；时长已在头部 chip 与 body Running… 行）。
 *  E. 单行长标题被布局宽度截断（truncate-end，非 480 预算）→ 悬停弹出
 *     完整标题 + 元数据附注（回归：这是 tooltip 的原始用途）。
 *  F. 折叠脚本 + 非零退出码 → 悬停弹出完整脚本，附注带「退出码 N」
 *     （元数据只在内容真隐藏的浮层里作为附注出现）。
 *
 * Run: `node --import tsx/esm scripts/verify-tool-tooltip-gating.tsx`
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'verify-tool-tooltip-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir
// 元数据断言含本地化文案（耗时/运行中），钉住语言保证 CI（LANG=C）一致。
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, tooltip, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/Tooltip.js'),
  import('./lib/term-test.mjs'),
])

const { sleep, settled, screenHas, findText, viewportLines } = termTest
const { render, AlternateScreen, Box } = ui

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

/** The real Chat always mounts useInput consumers (PromptInput etc.); the
 *  app wires its stdin parser only when at least one subscriber exists, so
 *  the rig mirrors that condition instead of silently dropping input
 *  (hover SGR sequences die without it). */
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
  class FakeStderr extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  return { term, stdout, stdin }
}

/** SGR mode-1003 motion with no buttons → dispatchHover. Coords 1-indexed. */
const hover = (stdin: PassThrough, col: number, row: number) =>
  stdin.write(`\x1b[<35;${col};${row}M`)

/** Hover the cell holding `needle` (first occurrence), then move away. */
function hoverText(stdin: PassThrough, term: XTerm, needle: string): void {
  const at = findText(term, needle)
  if (at === null) throw new Error(`hover target not found: ${needle}`)
  hover(stdin, at.col + 1, at.row + 1)
}

/** Rows whose visible text contains `needle` (the tooltip repeats content in
 *  its own row, so "appears twice" is the old duplicate behavior). */
function rowCount(term: XTerm, needle: string): number {
  return viewportLines(term).filter(line => line.includes(needle)).length
}

const { AssistantToolUseMessage } = await import('../src/components/messages/AssistantToolUseMessage.js')

const base = {
  callId: 'c1',
  argsText: '{}',
  status: 'ok' as const,
  startedAt: 0,
  durationMs: 12,
}

/** Render one tool card as the whole tree (scenario swap via key). */
function cardTree(key: string, tool: Record<string, unknown>, foldTerminalCommand = false,
  onClick?: () => void): React.ReactElement {
  return (
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <AssistantToolUseMessage
          key={key}
          tool={{ ...base, ...tool }}
          addMargin={false}
          verbose={false}
          foldTerminalCommand={foldTerminalCommand}
          onClick={onClick}
        />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>
  )
}

try {
  const COLS = 100
  const ROWS = 30
  const rig = makeRig(COLS, ROWS)
  // 场景 A：settled Edit 卡，携带真实时刻（结束前 5s 起跑、耗时 5s）。
  const instance = await render(
    cardTree('edit', {
      name: 'edit',
      startedAt: Date.now() - 10_000,
      durationMs: 5_000,
      callView: { card: 'diff', title: 'Edit /tmp/a.ts (1 - 100)', diffs: [] },
    }),
    { stdout: rig.stdout, stdin: rig.stdin, stderr: new (class extends Writable {
      isTTY = true
      _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
    })(), exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)

  const { term, stdin } = rig

  // --- A. 完整可见的单行标题：悬停不弹任何浮层 --------------------------
  const TITLE_A = 'Edit /tmp/a.ts (1 - 100)'
  check('场景 A 就绪：标题在屏', await settled(() => rowCount(term, TITLE_A) === 1))
  hoverText(stdin, term, TITLE_A)
  await sleep(800) // 越过 600ms dwell：若会弹此刻已弹
  check('A 完整标题悬停后不弹浮层', tooltip.getTooltipSnapshot() === null)
  check('A 无时刻框上屏', !screenHas(term, '结束'))
  hover(stdin, 1, 1)
  await sleep(100)
  check('A 移开后仍无浮层', tooltip.getTooltipSnapshot() === null)

  // --- B. 折叠的终端脚本：真隐藏内容 → 悬停弹出完整脚本 ------------------
  const script = [
    '$items = Get-ChildItem -Recurse',
    '$items | Where-Object { $_.Length -gt 1kb }',
    '$items | Sort-Object Length',
    '$items | Select-Object -First 10 Name',
  ].join('\n')
  instance.rerender(cardTree('folded', {
    name: 'powershell',
    callView: { card: 'terminal', title: script },
    resultView: { card: 'terminal', output: '', exitCode: 0 },
    resultFull: '',
  }, true))
  check('场景 B 就绪：折叠标题首行可见', await settled(() => screenHas(term, 'Get-ChildItem -Recurse')))
  check('场景 B 就绪：脚本其余行未渲染', !screenHas(term, 'Sort-Object'))
  hoverText(stdin, term, '$items')
  check('B 折叠脚本悬停后弹出完整命令', await settled(() => screenHas(term, 'Sort-Object')))
  check('B 弹出内容含末行', await settled(() => screenHas(term, 'Select-Object -First 10 Name')))
  hover(stdin, 1, 1)
  check('B 移开即隐藏工具提示', await settled(() => !screenHas(term, 'Sort-Object')))

  // --- C. 无标题 + args 超预算：头部裁剪 → 悬停弹出完整 args ------------
  const hugeArgs = '{"padding":"' + 'p'.repeat(600) + '","marker":"END-MARKER-98765","file_path":"/tmp/x.ts"}'
  instance.rerender(cardTree('huge', { name: 'read', argsText: hugeArgs }))
  // 就绪探针：卡片头部已渲染（超长 args 标题在旧代码上就以跨行 wrap
  // 呈现——此处只断言卡片已上屏；「头部裁剪」由下方标记不可见断言覆盖）。
  check('场景 C 就绪：超预算 args 头部渲染', await settled(() => screenHas(term, 'Read{')))
  check('场景 C 就绪：480 字符后的标记未上屏', !screenHas(term, 'END-MARKER-98765'))
  hoverText(stdin, term, 'ppp')
  check('C 裁剪 args 悬停后弹出完整内容', await settled(() => screenHas(term, 'END-MARKER-98765')))
  hover(stdin, 1, 1)
  check('C 移开即隐藏工具提示', await settled(() => !screenHas(term, 'END-MARKER-98765')))

  // --- D. 运行中卡片、标题完整可见：悬停不弹任何浮层 ---------------------
  instance.rerender(cardTree('running', {
    name: 'bash',
    status: 'running',
    startedAt: Date.now() - 120_000,
    callView: { card: 'terminal', title: 'sleep 300' },
  }))
  check('场景 D 就绪：运行中卡片渲染', await settled(() => screenHas(term, 'sleep 300')))
  hoverText(stdin, term, 'sleep 300')
  await sleep(800)
  check('D 完整可见运行中标题不弹浮层', tooltip.getTooltipSnapshot() === null)
  check('D 无开始时刻框上屏', !screenHas(term, '开始'))
  hover(stdin, 1, 1)
  await sleep(100)
  check('D 移开后仍无浮层', tooltip.getTooltipSnapshot() === null)

  // --- E. 单行长标题被布局宽度截断：悬停弹完整标题（回归：宽截断是旧
  //       tooltip 的原始用途，布局截断 ≠ 480 预算截断）。真实 Chat 的
  //       工具卡是可点击行（hover 时 ▾ 指示器占位）——传 onClick 走交互
  //       预算（扣 ▾ 2 列），确保交互路径的截断判定也弹。
  const LONG_TITLE = 'Edit ' + 'x'.repeat(110) + ' TAIL-END-9900'
  instance.rerender(cardTree('wide', {
    name: 'edit',
    startedAt: Date.now() - 6_000,
    durationMs: 5_000,
    callView: { card: 'diff', title: LONG_TITLE, diffs: [] },
  }, false, () => {}))
  check('场景 E 就绪：宽截断卡片渲染', await settled(() => screenHas(term, 'xxx')))
  check('场景 E 就绪：宽截断标题尾部未上屏', !screenHas(term, 'TAIL-END-9900'))
  hoverText(stdin, term, 'Edit')
  check('E 宽截断标题悬停后弹出完整标题',
    await settled(() => (tooltip.getTooltipSnapshot()?.content.includes('TAIL-END-9900') ?? false)))
  check('E 完整标题浮层同时带元数据',
    await settled(() => (tooltip.getTooltipSnapshot()?.content.includes('结束') ?? false)))
  hover(stdin, 1, 1)
  check('E 移开即隐藏工具提示', await settled(() => tooltip.getTooltipSnapshot() === null))

  // --- F. 折叠脚本 + 非零退出码：悬停弹完整脚本，附注带退出码 ----------
  //     （元数据只在内容真隐藏的浮层里出现；完全可见时退出码由 body
  //       的 `Exit code N` 行本身呈现，不重复。）
  const scriptF = [
    '$items = Get-ChildItem -Recurse',
    '$items | Where-Object { $_.Length -gt 1kb }',
    '$items | Select-Object -First 10 Name',
  ].join('\n')
  instance.rerender(cardTree('exit7', {
    name: 'bash',
    startedAt: Date.now() - 3_000,
    durationMs: 3_000,
    callView: { card: 'terminal', title: scriptF },
    resultView: { card: 'terminal', output: '', exitCode: 7 },
    resultFull: '',
  }, true))
  check('场景 F 就绪：折叠脚本首行可见', await settled(() => screenHas(term, 'Get-ChildItem -Recurse')))
  check('场景 F 就绪：折叠隐藏了其余行', !screenHas(term, 'Select-Object -First 10 Name'))
  check('场景 F 就绪：body 直接呈现退出码', await settled(() => screenHas(term, 'Exit code 7')))
  hoverText(stdin, term, '$items')
  check('F 折叠脚本悬停弹完整命令（含末行）', await settled(() => screenHas(term, 'Select-Object -First 10 Name')))
  check('F 浮层附注带本地化退出码', await settled(() => screenHas(term, '退出码 7')))
  hover(stdin, 1, 1)
  check('F 移开即隐藏工具提示', await settled(() => !screenHas(term, '退出码 7')))

  instance.unmount()
  await sleep(100)
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error(err)
  process.exit(1)
}
