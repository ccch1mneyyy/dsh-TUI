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
 *  H2. 状态栏 cache 字段：两个口径在同一行，且 hover 不改变页脚高度——
 *     明细恒为一行（本次/累计并列 + 成对分项）；为零/缺席的缓存分项不冒充
 *     数字（某侧无值显示 `–`，两侧全无则整段不出现）。
 *  I. 上下文进度条：条上不再有任何文字（内容类型只由颜色表达，唯一的
 *     文本是最右占比）；整条一个悬停目标，悬停任意位置弹【全部内容类型
 *     + free】的色块+数字明细——条没有标签，这行就是它的 legend。
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
// 组 I 断言条上各段的底色（进度条去掉标签后，颜色是唯一表达），必须开色。
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, tooltip, termTest, metrics] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/Tooltip.js'),
  import('./lib/term-test.mjs'),
  import('../src/screens/StatusMetrics.js'),
])

const { sleep, settled, screenHas, findText, viewportLines } = termTest
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
const { formatTokens } = await import('../src/terminal-utils/format.js')

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
  await sleep(600) // 固定窗:pacing 等首帧上屏，无单一可轮询锚点
  check('场景 F 就绪：长路径行已截断（尾段不在屏）', await settled(() => !screenHas(term, 'DeepLongFileName.tsx')))
  hoverText(stdin, term, 'src/components/messages')
  check('F 截断路径悬停后弹出完整路径', await settled(() => screenHas(term, 'DeepLongFileName.tsx')))
  // 浮层盖住下方行：先移开再找短路径行的悬停目标。
  hover(stdin, 1, 1)
  check('F 移开后长路径浮层消失', await settled(() => !screenHas(term, 'DeepLongFileName.tsx')))
  // 短路径行：名字完整可见 → 悬停不弹浮层（直查 tooltip store，排除
  // 「卡片内容恰好与可见文本同字」的歧义）。
  hoverText(stdin, term, 'README.md')
  await sleep(900) // 固定窗:探针 完整可见路径不得弹浮层；条件本就成立，轮询立即返回等于没测
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
    minimalUi: false,
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

  // --- H2. cache 字段悬停：两口径同一行 + 页脚零位移 ----------------------
  // 2026-11-24 UAT-C 裁决（格式 A）：两行明细把页脚 3→4 行、正文上移一行，鼠标
  // 进出时来回闪。现在明细恒为一行：`cache <本次率> · session <累计率> ·
  // read <本次>/<累计> · write <本次>/<累计> · input <本次>/<累计>`；某侧无值
  // （未上报或为 0）显示 `–`，两侧都无值整段不出现；累计率不可算时退回旧的
  // 本次单值形态（无 session、无斜杠）。实证（本机 500 个会话日志、133 个
  // provider 会话）：官方 deepseek-official 与第三方 commandcode 两条 DeepSeek
  // 路由的 cacheWriteTokens 恒为 0 或整键缺席（官方 4368 条记录里 0 条为正）。
  const CACHE_USAGE = { input: 2_217, output: 325, cacheRead: 18_432, cacheWrite: 0 }
  // The field pairs the two scopes ('both'), so an all-zero cumulative triple
  // hides it by contract and leaves no hover target at all. These totals are
  // the AC-1 / AC-6 fixture from the real session b7b38b27 (write stays 0
  // here: the negative case is "cumulative zero must not print write").
  const CACHE_TOKENS = { input: 30_562_681, output: 0, cacheRead: 213_180_668, cacheWrite: 0 }
  // The cold-start case keeps cumulative read/write at zero too: a 0.0% session
  // line (input > 0) is what keeps the field rendered without inventing a
  // read/write number.
  const COLD_CACHE_TOKENS = { input: 27_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  // The app renders the footer last (the transcript grows above it), so the
  // fixture anchors it at the bottom too — only then does a taller footer
  // shift the field/hint rows up, which is exactly the UAT-C symptom. The
  // context bar + working hint make this a real 3-row footer; 100 columns
  // keep the whole single line on screen (50 would truncate its tail).
  const cacheTree = (
    lastUsage: typeof CACHE_USAGE,
    tokens: typeof CACHE_TOKENS = CACHE_TOKENS,
    statusBar: Record<string, unknown> = { cache: true, cacheScope: 'both' },
  ) => (
    <AlternateScreen>
      <Box flexDirection="column" flexGrow={1}>
        <Box flexGrow={1} />
        <KeySink />
        <StatusLine
          channel={{ ...channelStub, contextBarEnabled: true, working: true, statusBar, lastUsage, tokens } as never}
        />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>
  )
  // Unmount the F–H instance before opening another AlternateScreen: two live
  // instances lose the bar row on the newcomer's first frame (same note as the
  // I rig below).
  instance.unmount()
  await sleep(150) // 固定窗:pacing 等第一个实例完全卸载，第二个实例首帧才完整
  const cacheRig = makeRig(100, 12)
  const CACHE_ROWS = 12
  const { term: cacheTerm, stdin: cacheStdin } = cacheRig
  const cacheInstance = await render(cacheTree(CACHE_USAGE), {
    stdout: cacheRig.stdout,
    stdin: cacheRig.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  /** The detail line (it is the only row that starts with `cache `). */
  const detailLine = (): string => {
    const at = viewportLines(cacheTerm).findIndex(line => line.trimStart().startsWith('cache '))
    return at < 0 ? '' : viewportLines(cacheTerm)[at] ?? ''
  }
  /**
   * Footer anatomy in viewport rows: field row (`缓存`), the supplemental row
   * (idle hint / hover detail), and the footer's height. The spacer puts the
   * footer flush with the bottom, so its height is everything below the row
   * above the field (the context bar) — a reserved blank row counts, which is
   * what a grown supplemental row leaves behind.
   */
  const footerRows = () => {
    const lines = viewportLines(cacheTerm)
    const field = lines.findIndex(line => line.includes('缓存'))
    const hint = lines.findIndex(line => line.includes('esc 中断'))
    const detail = lines.findIndex(line => line.trimStart().startsWith('cache '))
    return { field, hint, detail, height: field < 0 ? 0 : CACHE_ROWS - (field - 1) }
  }
  check('场景 H2 就绪：cache 字段（命中率）在屏', await settled(() => screenHas(cacheTerm, '缓存')))
  const before = footerRows()
  check('H2 就绪：底栏是 3 行（条 + 字段 + 提示），字段行与提示行紧邻视口底部',
    before.height === 3 && before.field === CACHE_ROWS - 2 && before.hint === CACHE_ROWS - 1,
    `field=${before.field} hint=${before.hint} height=${before.height}`)
  hoverText(cacheStdin, cacheTerm, '缓存')
  {
    const readPair = `read ${formatTokens(CACHE_USAGE.cacheRead)}/${formatTokens(CACHE_TOKENS.cacheRead)}`
    const inputPair = `input ${formatTokens(CACHE_USAGE.input)}/${formatTokens(CACHE_TOKENS.input)}`
    check('H2 同一行：以 cache 开头且含 session（两个口径不再各占一行）',
      await settled(() => {
        const line = detailLine()
        return line.trimStart().startsWith('cache ') && line.includes('session ') && line.includes('%')
      }), detailLine())
    check('H2 同一行带成对 read 与 input（本次/累计）',
      await settled(() => detailLine().includes(readPair) && detailLine().includes(inputPair)),
      `${readPair} / ${inputPair}`)
    check('H2 累计 cacheWrite=0 时同一行不出现 write',
      await settled(() => detailLine() !== '' && !detailLine().includes('write')),
      JSON.stringify(detailLine()))
  }
  {
    // 零位移（AC-6 布局）：hover 只换提示行的文字——字段行与提示行槽位不动、
    // 页脚仍是 3 行。撤掉单行实现（height 改回 2）这两条会同时红。
    const after = footerRows()
    check('H2 零位移：字段行与提示行行号不变（提示行槽位 hover 后承载明细）',
      after.field === before.field && after.detail === before.hint && after.hint === -1,
      `field ${before.field}→${after.field}, supplemental ${before.hint}→${after.detail}`)
    check('H2 零位移：页脚恒 3 行（hover 前后一致）',
      after.height === 3 && before.height === after.height,
      `${before.height}→${after.height}`)
  }
  {
    const WRITE_USAGE = { ...CACHE_USAGE, cacheWrite: 6_000 }
    cacheInstance.rerender(cacheTree(WRITE_USAGE))
    check('场景 H2b 就绪：cache 字段仍在屏', await settled(() => screenHas(cacheTerm, '缓存')))
    hoverText(cacheStdin, cacheTerm, '缓存')
    // 本次有值、累计为 0：成对形态给 `6k/–`（旧的本次单值 `write 6k` 仍是它的前缀）。
    const write = `write ${formatTokens(WRITE_USAGE.cacheWrite)}/–`
    check('H2b cacheWrite>0 时同一行给出成对 write（本次/累计）',
      await settled(() => detailLine().includes(write)), write)
  }
  {
    const COLD_USAGE = { input: 4_228, output: 15, cacheRead: 0, cacheWrite: 0 }
    cacheInstance.rerender(cacheTree(COLD_USAGE, COLD_CACHE_TOKENS))
    check('场景 H2c 就绪：cache 字段仍在屏', await settled(() => screenHas(cacheTerm, '缓存')))
    hoverText(cacheStdin, cacheTerm, '缓存')
    const input = `input ${formatTokens(COLD_USAGE.input)}/${formatTokens(COLD_CACHE_TOKENS.input)}`
    check('H2 冷启动（本次 read/write 皆 0）同一行只给成对 input，无 read/write',
      await settled(() => detailLine().includes(input)
        && !detailLine().includes('read') && !detailLine().includes('write')),
      input)
  }
  {
    // 累计三桶全零 ⇒ 累计率不可算：退回本次单值形态（无 session、无斜杠、无 `–`）。
    // `cacheScope:'request'` 让该夹具即使累计为空也仍渲染字段（both 在窄屏降级为
    // session，累计为空会把字段整个藏掉，没有 hover 目标）。
    const COLD_USAGE = { input: 4_228, output: 15, cacheRead: 0, cacheWrite: 0 }
    cacheInstance.rerender(cacheTree(COLD_USAGE, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      { cache: true, cacheScope: 'request' }))
    check('场景 H2c2 就绪：累计为空时 cache 字段仍在屏', await settled(() => screenHas(cacheTerm, '缓存')))
    hoverText(cacheStdin, cacheTerm, '缓存')
    const input = `input ${formatTokens(COLD_USAGE.input)}`
    check('H2c2 累计率不可算时明细退回本次单值形态（无 session / 斜杠 / –）',
      await settled(() => {
        const line = detailLine()
        return line.trimStart().startsWith('cache ')
          && line.includes(input)
          && !line.includes('session')
          && !line.includes('/') && !line.includes('–')
          && !line.includes('read') && !line.includes('write')
      }), detailLine())
  }
  {
    // 正例：累计 cacheWrite > 0 必须出现在同一行——只测「不出现 write」
    // 会让「永不显示 write」的实现也通过（AC-6 边界二）。本次侧无值用 `–`。
    const WRITE_TOKENS = { ...CACHE_TOKENS, cacheWrite: 860_000 }
    cacheInstance.rerender(cacheTree(CACHE_USAGE, WRITE_TOKENS))
    check('场景 H2d 就绪：cache 字段仍在屏', await settled(() => screenHas(cacheTerm, '缓存')))
    hoverText(cacheStdin, cacheTerm, '缓存')
    const write = `write –/${formatTokens(WRITE_TOKENS.cacheWrite)}`
    check('H2d 累计 cacheWrite>0 时同一行给出成对 write（本次无值 → –）',
      await settled(() => detailLine().includes(write)), write)
  }
  hover(cacheStdin, 1, 1)
  cacheInstance.unmount()
  await sleep(100) // 固定窗:pacing 换实例前等上一个卸载收尾

  // --- I. 上下文进度条：无标签 + 整条悬停给全量明细 ----------------------
  // I0：纯函数层。ANSI 路径是 ContextBarView 的字符串孪生（同一套列分配与
  // 读出阶梯），先在这里钉死「条上没有类型名」、读出阶梯、压力分档与明细的
  // 宽度阶梯。
  const SEGMENTS = { system: 1200, prompt: 300, assistant: 4000, thinking: 5000, tools: 2000 }
  const USED = 12_500 // input 12000 + cacheRead 500
  {
    const plain = metrics.renderContextBar(SEGMENTS, USED, 64_000, 60).replace(/\x1b\[[0-9;]*m/g, '')
    check('I0 条上无类型名：去 ANSI 只剩空格与最右读数',
      /^\s*13k\/64k 19\.5%$/.test(plain), `plain=${JSON.stringify(plain)}`)
    const ansi = metrics.renderContextBar(SEGMENTS, USED, 64_000, 60)
    check('I0 条仍按内容类型着色', ansi.includes('48;2;34;48;95m') && ansi.includes('48;2;90;124;255m'),
      'system/tools fills present')
    check('I0 读数阶梯：先给总数+占比，窄了只剩占比',
      metrics.contextBarReadout(USED, 64_000).join(' | ') === '13k/64k 19.5% | 19.5%',
      JSON.stringify(metrics.contextBarReadout(USED, 64_000)))
    // 压力分档与 ctx 悬停量表同阈值（amber ≥ 80 / red ≥ 95）。
    check('I0 压力分档 80/95 与 ctx 量表一致',
      metrics.contextPressureStep(79.9) === undefined
      && metrics.contextPressureStep(80) === 'warning'
      && metrics.contextPressureStep(94.9) === 'warning'
      && metrics.contextPressureStep(95) === 'error',
      [79.9, 80, 94.9, 95].map(p => `${p}:${metrics.contextPressureStep(p) ?? 'none'}`).join(' '))
    const warm = metrics.renderContextBar(SEGMENTS, 53_760, 64_000, 60) // 84.0%
    const hot = metrics.renderContextBar(SEGMENTS, 61_440, 64_000, 60) // 96.0%
    check('I0 压力染色：84% 琥珀 / 96% 红（ANSI 路径）',
      warm.includes('38;2;202;138;4') && hot.includes('38;2;255;107;128'),
      `warm=${warm.includes('38;2;202;138;4')} hot=${hot.includes('38;2;255;107;128')}`)
    const wide = metrics.contextBarBreakdown(SEGMENTS, USED, 64_000, 120)
    check('I0 宽终端明细用可读名 + 圆点分隔',
      wide.entries.map(e => e.label).join(wide.separator)
        === 'system 1.2k · prompt 300 · assistant 4.0k · thinking 5.0k · tools 2.0k · free 52k',
      `got=${JSON.stringify(wide.entries.map(e => e.label).join(wide.separator))}`)
    const narrow = metrics.contextBarBreakdown(SEGMENTS, USED, 64_000, 50)
    check('I0 窄终端明细退化到短名（仍逐项给数）',
      narrow.entries.map(e => e.label).join(narrow.separator)
        === 'sys 1.2k pr 300 ast 4.0k th 5.0k tl 2.0k free 52k',
      `got=${JSON.stringify(narrow.entries.map(e => e.label).join(narrow.separator))}`)
    const empty = metrics.contextBarBreakdown(
      { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, 0, 64_000, 120)
    check('I0 零占用段不进明细（与条上不给列数一致）',
      empty.entries.length === 1 && empty.entries[0]?.label === 'free 64k',
      `got=${JSON.stringify(empty.entries.map(e => e.label))}`)
    check('I0 明细色块用各段填充色（颜色↔名字的对应关系）',
      wide.entries[0]?.color === '#22305F' && wide.entries[3]?.color === '#4D6BFE',
      JSON.stringify(wide.entries.map(e => e.color)))
  }

  // I：真机渲染 + 鼠标。120 列让宽终端阶梯成立（可读名），12 行够放下
  // 条+状态行+明细行。（H2 已先卸载它的实例：同进程里两个 AlternateScreen
  // 实例并存时，后者的首帧会漏掉条那行。）
  const barRig = makeRig(120, 12)
  const barStub = {
    ...channelStub,
    contextBarEnabled: true,
    contextSegments: SEGMENTS,
    lastUsage: { input: 12_000, output: 0, cacheRead: 500, cacheWrite: 0 },
  }
  const barInstance = await render(
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <StatusLine channel={barStub as never} />
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>,
    { stdout: barRig.stdout, stdin: barRig.stdin, exitOnCtrlC: false, patchConsole: false },
  )
  const barTerm = barRig.term
  const barStdin = barRig.stdin
  check('场景 I 就绪：进度条读数在屏', await settled(() => screenHas(barTerm, '19.5%')))
  {
    // 条自身那一行：最右读数（总数 + 占比）是全部文字，没有任何类型名。
    const barRow = findText(barTerm, '19.5%')?.row ?? -1
    const line = (barRow < 0 ? '' : barTerm.buffer.active.getLine(barRow)?.translateToString(true) ?? '')
    check('I 条行只有最右读数、无任何类型名',
      /^\s*13k\/64k 19\.5%$/.test(line), `line=${JSON.stringify(line)}`)
    // 各段仍是纯色填充：无子节点的 Box 只靠自己的底色铺满（去掉标签后唯一
    // 的表达方式），底色不画就等于整条消失。
    const bgAt = (x: number): number =>
      (barTerm.buffer.active.getLine(barRow)?.getCell(x)?.getBgColor() ?? 0) & 0xffffff
    check('I 内容类型段仍是实色块（空 Box 由底色铺满）', bgAt(1) === 0x22305f,
      `system bg=${bgAt(1).toString(16)}`)
    check('I free 段铺到条尾', [0x2e3440, 0xe8e8e8].includes(bgAt(116)),
      `free bg=${bgAt(116).toString(16)}`)
  }
  // 悬停条最右（free 区）：明细是「全部内容类型」，不只是 free。
  hoverText(barStdin, barTerm, '19.5%')
  check('I 悬停条尾弹全量明细（含 system 与 thinking）',
    await settled(() => screenHas(barTerm, 'system 1.2k') && screenHas(barTerm, 'thinking 5.0k')))
  check('I 明细同一行带 free 项', screenHas(barTerm, 'free 52k'))
  {
    // 色块是这一行的全部意义：数字前的 1 格底必须就是该段在条上的填充色，
    // 否则「哪个颜色是哪类」无从对应。
    const chipBg = (needle: string): number => {
      const at = findText(barTerm, needle)
      if (at === null || at.col === 0) return 0
      return (barTerm.buffer.active.getLine(at.row)?.getCell(at.col - 1)?.getBgColor() ?? 0) & 0xffffff
    }
    check('I 明细色块 = 条上该段填充色（system/thinking）',
      chipBg('system 1.2k') === 0x22305f && chipBg('thinking 5.0k') === 0x4d6bfe,
      `system=${chipBg('system 1.2k').toString(16)} thinking=${chipBg('thinking 5.0k').toString(16)}`)
    check('I free 明细色块 = 条上 free 段填充色（暗色主题覆盖）', chipBg('free 52k') === 0x2e3440,
      `free=${chipBg('free 52k').toString(16)}`)
  }
  // 悬停条首（system 段）：仍是同一条全量明细 —— 整条一个悬停目标，明细
  // 不随段落切换而变化（逐段明细是这次去掉的旧行为）。
  {
    const barRow = findText(barTerm, '19.5%')?.row ?? 0
    hover(barStdin, 2, barRow + 1)
    check('I 悬停条首同样是全量明细（整条一个目标）',
      await settled(() => screenHas(barTerm, 'tools 2.0k') && screenHas(barTerm, 'free 52k')))
  }
  hover(barStdin, 1, 1)
  check('I 移开条即撤下明细', await settled(() => !screenHas(barTerm, 'thinking 5.0k')))

  // I2：只知占用、不知构成时，两处悬停都报实测已用量，不列五个 0。
  // 分别覆盖 meter 构成全零，以及旧 meter 缺席且本地估算为空。
  for (const sample of [
    { model: 'ZERO-METER', contextSegments: SEGMENTS, contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } },
    { model: 'NO-METER', contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, contextBreakdown: undefined },
  ]) {
    barInstance.rerender(
      <AlternateScreen>
        <Box flexDirection="column">
          <KeySink />
          <StatusLine
            channel={{
              ...barStub,
              ...sample,
              statusBar: { contextBar: true, contextUsage: true, cache: false },
            } as never}
          />
          <tooltip.TooltipLayer />
        </Box>
      </AlternateScreen>,
    )
    check(`I2 ${sample.model} 已上屏`, await settled(() => screenHas(barTerm, sample.model)))
    hoverText(barStdin, barTerm, '19.5%')
    check(`I2 ${sample.model} 条悬停沿用已用量兜底`, await settled(() => screenHas(barTerm, '已用 13k')))
    hoverText(barStdin, barTerm, 'ctx')
    check(`I2 ${sample.model} ctx 悬停沿用已用量兜底`,
      await settled(() => screenHas(barTerm, '已用 12.5k') && !screenHas(barTerm, 'sys 0')),
      JSON.stringify(viewportLines(barTerm).filter(line => line !== '')))
    hover(barStdin, 1, 1)
  }

  // 压力染色上屏：同一实例改用 84% 占用重渲染，读数文字应转成主题 warning。
  const { ThemeProvider } = ui
  barInstance.rerender(
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <ThemeProvider theme="dark">
          <StatusLine
            channel={{ ...barStub, lastUsage: { input: 54_000, output: 0, cacheRead: 0, cacheWrite: 0 } } as never}
          />
        </ThemeProvider>
      </Box>
    </AlternateScreen>,
  )
  check('I 高压占用读数在屏（84.4%）', await settled(() => screenHas(barTerm, '84.4%')))
  {
    const at = findText(barTerm, '84.4%')
    const fg = at === null
      ? 0
      : (barTerm.buffer.active.getLine(at.row)?.getCell(at.col)?.getFgColor() ?? 0) & 0xffffff
    check('I 读数转琥珀（主题 warning #D8B270）', fg === 0xd8b270, `fg=${fg.toString(16)}`)
  }
  barInstance.unmount()
  await sleep(100) // 固定窗:pacing unmount 收尾输出 flush，无可观测完成条件

  // --- K. 底栏权限模式段：后端原生权限模式（Claude 等）------------------
  // 契约（Chat 侧装配 backendMode 后）：
  //   · 存在 → 该段恒显示（不再看 modeMarked/基础模式）、文本＝后端给的
  //     可读名、点击＝onOpen；颜色只由后端 id 决定——bypassPermissions/
  //     dontAsk → warning，plan → planMode，其余 → inactiveShimmer（DSH
  //     的 plan/marked 规则一概不参与）。
  //   · 缺席 → DSH 语义逐字节不变：下表的金标准是**改动前**的 src 渲染结果
  //     （字符 + 逐格前景色/背景色），钉住「DSH 会话渲染零变化」。
  // 交互面（悬停详情、点击）在同一个 rig 上按后端模式验收。
  const K_COLS = 60
  const K_ROWS = 12
  /** 空行签名：金标准只钉状态行那一行，其余行必须仍是这张白纸。 */
  const K_BLANK_SIG = '60@ffffff/ffffff'
  const K_STUB = {
    minimalUi: false,
    statusBar: { mode: true },
    model: 'TM',
    provider: 'test-provider',
    contextWindow: 64_000,
    gitBranch: 'main',
    displayCwd: 'D:\\work\\dsh-tui',
    cwd: 'D:\\work\\dsh-tui',
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
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
  type ModeSegment = { readonly id: string, readonly name: string, readonly onOpen: () => void }
  const modeScreen = (channel: unknown, backendMode?: ModeSegment) => (
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <ui.ThemeProvider theme="dark">
          <StatusLine channel={channel as never} {...(backendMode === undefined ? {} : { backendMode })} />
        </ui.ThemeProvider>
        <tooltip.TooltipLayer />
      </Box>
    </AlternateScreen>
  )
  /** 字符行（去尾空格）+ 每行「等色行程」签名：改了字或改了色都算漂移。 */
  const dumpMode = (term: XTerm) => {
    const lines: string[] = []
    const sigs: string[] = []
    for (let y = 0; y < K_ROWS; y++) {
      const line = term.buffer.active.getLine(y)
      lines.push(line ? line.translateToString(true) : '')
      let sig = ''
      let runColor: string | null = null
      let runLen = 0
      for (let x = 0; x < K_COLS; x++) {
        const cell = line?.getCell(x)
        const colour = ((cell?.getFgColor() ?? 0) & 0xffffff).toString(16)
          + '/' + ((cell?.getBgColor() ?? 0) & 0xffffff).toString(16)
        if (colour === runColor) { runLen++ } else {
          if (runColor !== null) sig += runLen + '@' + runColor + ' '
          runColor = colour
          runLen = 1
        }
      }
      if (runColor !== null) sig += runLen + '@' + runColor
      sigs.push(sig.trim())
    }
    return { lines: lines.filter(l => l !== ''), sigs }
  }
  const fgAt = (term: XTerm, col: number, row: number): number =>
    (term.buffer.active.getLine(row)?.getCell(col)?.getFgColor() ?? 0) & 0xffffff
  /** 后端模式段的颜色断言：等到名字在屏、且它首格前景色就是期望值。 */
  const modeColourSettles = (term: XTerm, name: string, expected: number) =>
    settled(() => {
      const at = findText(term, name)
      return at !== null && fgAt(term, at.col, at.row) === expected
    })

  const openModeRig = async (channel: unknown, backendMode?: ModeSegment) => {
    const rig = makeRig(K_COLS, K_ROWS)
    const instance = await render(modeScreen(channel, backendMode), {
      stdout: rig.stdout, stdin: rig.stdin, exitOnCtrlC: false, patchConsole: false,
    })
    return { rig, instance }
  }

  // K1. 后端模式：基础模式也显示 + 悬停详情 + 点击 + 三种颜色。
  {
    let opened = 0
    const segment = (id: string, name: string): ModeSegment => ({ id, name, onOpen: () => { opened++ } })
    const { rig, instance } = await openModeRig(K_STUB, segment('acceptEdits', '自动接受编辑'))
    const { term, stdin } = rig
    check('K1 后端模式名在屏（DSH 基础模式也会显示）',
      await settled(() => screenHas(term, '自动接受编辑')), 'name=自动接受编辑')
    check('K1 acceptEdits → inactiveShimmer #AAB2C2',
      await modeColourSettles(term, '自动接受编辑', 0xaab2c2),
      'fg=' + fgAt(term, findText(term, '自动接受编辑')?.col ?? 0, findText(term, '自动接受编辑')?.row ?? 0).toString(16))
    hoverText(stdin, term, '自动接受编辑')
    check('K1 悬停详情用后端模式名 + 既有 affordance 文案',
      await settled(() => screenHas(term, 'mode 自动接受编辑 · 点击或 /permission 切换权限模式')))
    hover(stdin, 1, 1)
    check('K1 移开后详情行撤下', await settled(() => !screenHas(term, '切换权限模式')))
    {
      const at = findText(term, '自动接受编辑')
      if (at === null) check('K1 点击目标仍在屏', false)
      else {
        stdin.write('\x1b[<0;' + (at.col + 1) + ';' + (at.row + 1) + 'M')
        stdin.write('\x1b[<0;' + (at.col + 1) + ';' + (at.row + 1) + 'm')
      }
      check('K1 点击模式段调用 onOpen', await settled(() => opened === 1), 'opened=' + opened)
    }
    instance.rerender(modeScreen(K_STUB, segment('bypassPermissions', '跳过权限')))
    check('K1 bypassPermissions → warning #D8B270',
      await modeColourSettles(term, '跳过权限', 0xd8b270))
    instance.rerender(modeScreen(K_STUB, segment('dontAsk', '不询问')))
    check('K1 dontAsk → warning #D8B270', await modeColourSettles(term, '不询问', 0xd8b270))
    instance.rerender(modeScreen(K_STUB, segment('plan', '计划模式')))
    check('K1 后端 plan → planMode #7FAE99', await modeColourSettles(term, '计划模式', 0x7fae99))
    // DSH 自身的 plan 标记不得泄进后端模式的颜色：id 不认识就是 inactiveShimmer。
    instance.rerender(modeScreen(
      { ...K_STUB, mode: { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' } },
      segment('default', '默认'),
    ))
    check('K1 DSH 标记不泄漏进后端模式颜色（default → inactiveShimmer）',
      await modeColourSettles(term, '默认', 0xaab2c2))
    instance.unmount()
    await sleep(150) // 固定窗:pacing 换实例前等上一个卸载收尾
  }

  // K2. 缺席（DSH 会话）：渲染逐字节等于改动前的输出。
  const DSH_GOLDEN = [
    {
      key: '基础模式（不显示 mode 段）',
      channel: { ...K_STUB, modeIndex: 0 },
      line: ' TM · dsh-tui',
      sig: '1@ffffff/ffffff 2@aab2c2/ffffff 3@8d95a6/ffffff 7@aab2c2/ffffff 47@ffffff/ffffff',
    },
    {
      key: '标记模式（Shift+Tab 到第 2 档）',
      channel: { ...K_STUB, modeIndex: 1 },
      line: ' TM · 默认 · dsh-tui',
      sig: '1@ffffff/ffffff 2@aab2c2/ffffff 3@8d95a6/ffffff 4@d8b270/ffffff 3@8d95a6/ffffff 7@aab2c2/ffffff 40@ffffff/ffffff',
    },
    {
      key: '计划模式',
      channel: { ...K_STUB, mode: { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' } },
      line: ' TM · 计划模式 · dsh-tui',
      sig: '1@ffffff/ffffff 2@aab2c2/ffffff 3@8d95a6/ffffff 8@7fae99/ffffff 3@8d95a6/ffffff 7@aab2c2/ffffff 36@ffffff/ffffff',
    },
    {
      key: '完全访问（danger-full-access + approval never）',
      channel: { ...K_STUB, mode: { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' } },
      line: ' TM · 完全访问 · dsh-tui',
      sig: '1@ffffff/ffffff 2@aab2c2/ffffff 3@8d95a6/ffffff 8@d8b270/ffffff 3@8d95a6/ffffff 7@aab2c2/ffffff 36@ffffff/ffffff',
    },
  ]
  for (const golden of DSH_GOLDEN) {
    const { rig, instance } = await openModeRig(golden.channel)
    const { term } = rig
    check('K2 就绪：' + golden.key, await settled(() => screenHas(term, 'dsh-tui')))
    await sleep(250) // 固定窗:探针 末帧落定：金标准比对的是「整行字节」，不能比对半帧
    const dump = dumpMode(term)
    check('K2 ' + golden.key + ' 字符行逐字节不变',
      dump.lines.join('\n') === golden.line, 'got=' + JSON.stringify(dump.lines))
    check('K2 ' + golden.key + ' 状态行配色逐格不变',
      dump.sigs[0] === golden.sig, 'got=' + JSON.stringify(dump.sigs[0]))
    check('K2 ' + golden.key + ' 其余行仍是空屏',
      dump.sigs.slice(1).every(s => s === K_BLANK_SIG))
    instance.unmount()
    await sleep(120) // 固定窗:pacing 换实例前等上一个卸载收尾
  }



  // K3. 优先级：安全读数压过字段开关，但压不过极简界面。
  {
    const seg: ModeSegment = { id: 'acceptEdits', name: '自动接受编辑', onOpen: () => undefined }
    // (a) statusBar.mode=false + backendMode → 段仍然显示（安全读数压过字段开关）。
    {
      const { rig, instance } = await openModeRig({ ...K_STUB, statusBar: { mode: false } }, seg)
      check('K3a statusBar.mode=false 时后端模式段仍显示',
        await settled(() => screenHas(rig.term, '自动接受编辑')), rig.term.buffer.active.getLine(0)?.translateToString(true) ?? '')
      instance.unmount()
      await sleep(120) // 固定窗:pacing 换实例前等上一个卸载收尾
    }
    // (b) minimalUi=true + backendMode → 段不显示：极简界面是用户显式选的
    // 「只要模型 + 目录」，不能被安全读数顶掉。
    {
      const { rig, instance } = await openModeRig({ ...K_STUB, minimalUi: true }, seg)
      check('K3b minimalUi 就绪', await settled(() => screenHas(rig.term, 'dsh-tui')))
      await sleep(250) // 固定窗:探针 末帧落定：金标准比对的是「整行字节」，不能比对半帧
      const dump = dumpMode(rig.term)
      check('K3b minimalUi：底栏只剩模型+目录（模式段不显示）',
        dump.lines.join('\n') === ' TM · dsh-tui', 'got=' + JSON.stringify(dump.lines))
      check('K3b minimalUi：屏上无后端模式名', !dump.lines.join('\n').includes('自动接受编辑'))
      instance.unmount()
      await sleep(120) // 固定窗:pacing 换实例前等上一个卸载收尾
    }
    // (c) DSH（backendMode 缺席）+ statusBar.mode=false → 与改动前逐字节
    // 一致：标记模式照样藏起，行内容等于基础模式金标准。
    {
      const { rig, instance } = await openModeRig({ ...K_STUB, statusBar: { mode: false }, modeIndex: 1 })
      check('K3c DSH mode:false 就绪', await settled(() => screenHas(rig.term, 'dsh-tui')))
      await sleep(250) // 固定窗:探针 末帧落定：金标准比对的是「整行字节」，不能比对半帧
      const dump = dumpMode(rig.term)
      check('K3c DSH 关掉字段开关时标记模式不显示（逐字节同基础模式）',
        dump.lines.join('\n') === ' TM · dsh-tui', 'got=' + JSON.stringify(dump.lines))
      check('K3c 状态行配色逐格不变',
        dump.sigs[0] === DSH_GOLDEN[0].sig, 'got=' + JSON.stringify(dump.sigs[0]))
      check('K3c 其余行仍是空屏', dump.sigs.slice(1).every(s => s === K_BLANK_SIG))
      instance.unmount()
      await sleep(120) // 固定窗:pacing 换实例前等上一个卸载收尾
    }
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error(err)
  process.exit(1)
}
