/**
 * 命令浮窗「影响当前对话」灰区回归（issue #1072）。
 *
 * 回合运行中，`/` 补全浮窗按命令对当前对话的影响分区：不影响的在上（原样式），
 * 会被门禁拦下 / 会打断或替换对话 / 会 steer 的沉底、整行变灰。灰区不阻止使用：
 * 选中执行后「该门禁的门禁、该 steer 的 steer」。
 *
 *   1. 分区顺序：正常区保持原序在上，灰区沉底（不插任何标题行、不多占显示行）；
 *   2. 灰区为空（空闲态）时保持目录原序，且不出现灰字；
 *   3. 灰区行整行一次 `subtle` 平铺（暗色 #5E6673），不做查询命中提亮；
 *   4. 点击映射：正常行 / 灰区行各选各自的命令（索引空间不变，不越界）；
 *   5. 窄终端（36 列）每行不越界、不换行（卡片每行仍是 │ … │）；
 *   6. 浏览型命令归正常区：`/resume`（只打开界面，切换是界面里另外确认的动作，
 *      且 DSH 下只停放）留在上方，同族的 `/rewind`（core 路径回合中直接拒绝）沉底。
 *
 * 运行：node --import tsx/esm scripts/verify-command-hold-overlay.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_THEME = 'dark'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen, Box },
  { PromptInput },
  { completeCommands },
  { settled, viewportLines },
  instances,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PromptInput.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/instances.js').then(module => module.default),
])

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const ROWS = 30
// 暗色主题 `subtle` = rgb('#5E6673')（src/theme.ts）；灰区整行用它平铺一次。
const SUBTLE = '\x1b[38;2;94;102;115m'

// 混合清单：正常区 status/theme（原序），灰区 model/new（门禁）+ audit（技能）。
const COMMANDS = [
  { name: 'status', description: 'Show session status' },
  { name: 'model', description: 'Show the active model' },
  { name: 'theme', description: 'Switch the color theme' },
  { name: 'new', description: 'Start a new conversation' },
  { name: 'audit', description: 'Audit the repository', external: true, skill: true },
]

function makeChannel(working: boolean, commands = COMMANDS) {
  const runs: string[] = []
  const submitted: string[] = []
  const steered: string[] = []
  return {
    working,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    commandList: commands,
    commandCompletions: (input: string) => completeCommands(input, commands),
    notifications: [],
    pending: [],
    contextWindow: undefined,
    notify() {},
    submit(text: string) { submitted.push(text) },
    steer(text: string) { steered.push(text) },
    removePending() { return false },
    cancel() {},
    interruptAndDeliver() { return 0 },
    listFiles: async () => [],
    runs,
    submitted,
    steered,
  }
}

async function boot(cols: number, working: boolean, commands = COMMANDS) {
  const term = new XTerm({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const frames: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(String(chunk))
      term.write(String(chunk), callback)
    },
  })
  stdout.columns = cols
  stdout.rows = ROWS
  stdout.isTTY = true
  const stderr = new Writable({ write(_c, _e, callback) { callback() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const channel = makeChannel(working, commands)
  // 浮窗向上生长（OverlayAbove bottom:'100%'），生产里 Chat 把输入框压到屏幕
  // 底部、上方留出转录区；裸渲染 PromptInput 会贴着屏幕顶边，浮窗被裁光。
  // 用 flexGrow 撑出同样的空间，让浮窗行落在可读的屏幕区域里。
  const tree = React.createElement(
    AlternateScreen,
    null,
    React.createElement(
      Box,
      { flexDirection: 'column', height: '100%' },
      React.createElement(Box, { flexGrow: 1 }),
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: (name: string) => { channel.runs.push(name); return true },
        selectionActive: false,
      }),
    ),
  )
  const instance = await render(tree, { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false })
  // 点击派发与 useSelection 都按 stdout 键找 Ink 实例：production 渲染到
  // process.stdout，这里渲染到假 stdout，别名后再 rerender 一次，并显式
  // 进入 alt-screen/鼠标跟踪（沿用 verify-copy-on-select 的做法）。
  const ink = instances.get(stdout)
  instances.set(process.stdout, ink)
  instance.rerender(tree)
  ink?.setAltScreenActive(true, true)
  const lines = () => viewportLines(term)
  return {
    stdin,
    channel,
    instance,
    lines,
    frames: () => frames.join(''),
    frameCount: () => frames.length,
  }
}

/** 卡片内的命令行行号：`│` 边框 + 名字紧跟留白/指针。 */
function rowOf(lines: readonly string[], name: string): number {
  return lines.findIndex(line => new RegExp(`^│\\s+(?:❯ )?${name}(?:\\s|$)`).test(line))
}

/** SGR 点击注入：同一单元格 press+release（1-indexed）。 */
function clickRow(stdin: { write(chunk: string): unknown }, lines: readonly string[], row: number, needle: string): void {
  const col = lines[row]!.indexOf(needle) + 2
  stdin.write(`\x1b[<0;${col};${row + 1}M`)
  stdin.write(`\x1b[<0;${col};${row + 1}m`)
}

async function run(): Promise<void> {
  // ── 1+3+4: 分区顺序、无标题行、灰区颜色、点击映射 ─────────────────────
  const wide = await boot(100, true)
  wide.stdin.write('/')
  check('working: 浮窗打开且灰区已沉底', await settled(() => rowOf(wide.lines(), 'model') >= 0))

  let lines = wide.lines()
  const statusRow = rowOf(lines, 'status')
  const themeRow = rowOf(lines, 'theme')
  const modelRow = rowOf(lines, 'model')
  const newRow = rowOf(lines, 'new')
  const auditRow = rowOf(lines, 'audit')
  check('分区：正常区两行在上、灰区三行沉底，内部各自保持原序',
    statusRow >= 0 && statusRow < themeRow && themeRow < modelRow && modelRow < newRow && newRow < auditRow,
    JSON.stringify({ statusRow, themeRow, modelRow, newRow, auditRow }))
  // 「不插标题行」由行数钉住：多一行标题就会多一条 `│` 边框行。原先这里还
  // 顺带断言渲染结果里不含已删的组标题文案，但那段文案只存在于
  // `CommandSuggestions.tsx` 的 JSDoc 里，渲染输出永不包含它——恒真子句，
  // 已删；真正的不变量是上面这个行数。
  check('分区不插标题行、不额外占显示行',
    lines.filter(line => /^│/.test(line)).length === 5
      && !lines.some(line => line.includes('↑') || line.includes('↓')),
    JSON.stringify(lines.filter(line => /^│/.test(line)).map(line => line.trim().slice(0, 14))))
  check('默认选中仍是正常区第一行（❯ status），索引空间未变',
    lines[statusRow]!.includes('❯') && !lines[themeRow]!.includes('❯') && !lines[modelRow]!.includes('❯'),
    (lines[statusRow] ?? '').trim().slice(0, 24))

  const frames = wide.frames()
  check('灰区行整行一次 subtle 平铺（名字没有被命中提亮切成两段）', frames.includes(`${SUBTLE}  new`))
  check('正常区行不吃 subtle',
    !frames.includes(`${SUBTLE}  status`) && !frames.includes(`${SUBTLE}  theme`))

  // ── 4: 点击映射（行索引与命令索引一一对应，不越界）────────────────────
  const frameCountBeforeModelClick = wide.frameCount()
  lines = wide.lines()
  clickRow(wide.stdin, lines, rowOf(lines, 'model'), 'model')
  check('点击灰区中段行派发该命令（不是相邻行）',
    await settled(() => wide.channel.runs.at(-1) === 'model'),
    JSON.stringify(wide.channel.runs))
  check('灰区命令点击后没有退化成 steer',
    wide.channel.steered.length === 0, JSON.stringify(wide.channel.steered))

  // Dispatch is recorded before Ink necessarily commits the cleared draft.
  // Wait for that frame so the next readiness check cannot reuse this card.
  const modelOverlayClosed = await settled(() =>
    wide.frameCount() > frameCountBeforeModelClick
      && rowOf(wide.lines(), 'status') < 0,
  )
  check('派发 /model 后等待浮窗关闭，再测试第二次打开', modelOverlayClosed)
  if (modelOverlayClosed) {
    const closedFrameCount = wide.frameCount()
    wide.stdin.write('/')
    const auditOverlayOpened = await settled(() =>
      wide.frameCount() > closedFrameCount
        && rowOf(wide.lines(), 'status') >= 0,
    )
    check('第二次输入 / 后等待新帧中的浮窗', auditOverlayOpened)
    if (auditOverlayOpened) {
      lines = wide.lines()
      clickRow(wide.stdin, lines, rowOf(lines, 'audit'), 'audit')
      check('点击灰区末尾行派发该命令（末尾不越界）',
        await settled(() => wide.channel.runs.at(-1) === 'audit'),
        JSON.stringify(wide.channel.runs))
    }
  }
  wide.instance.unmount()

  // ── 2: 灰区为空时保持目录原序、无灰字（空闲态）─────────────────────────
  const idle = await boot(100, false)
  idle.stdin.write('/')
  await settled(() => rowOf(idle.lines(), 'status') >= 0)
  check('空闲态：命令保持目录原序（status → model → theme）',
    rowOf(idle.lines(), 'status') < rowOf(idle.lines(), 'model')
      && rowOf(idle.lines(), 'model') < rowOf(idle.lines(), 'theme'),
    JSON.stringify(['status', 'model', 'theme'].map(name => rowOf(idle.lines(), name))))
  check('空闲态：没有灰区着色', !idle.frames().includes(SUBTLE))
  idle.instance.unmount()

  // ── 5: 窄终端不越界、不换行 ─────────────────────────────────────────────
  const narrow = await boot(36, true)
  narrow.stdin.write('/')
  await settled(() => rowOf(narrow.lines(), 'model') >= 0)
  const card = narrow.lines()
  const top = card.findIndex(line => line.includes('╭'))
  const bottom = card.findIndex((line, index) => index > top && line.includes('╰'))
  const body = card.slice(top + 1, bottom)
  check('36 列：卡片每行仍是 │ … │（截断而非换行溢出）',
    top >= 0 && bottom > top && body.length > 0 && body.every(line => line.startsWith('│') && line.endsWith('│')),
    `${top}..${bottom} rows=${body.length}`)
  check('36 列：每行显示宽度不越界',
    card.every(line => stringWidthOf(line) <= 36),
    JSON.stringify(card.map(line => stringWidthOf(line)).filter(width => width > 36)))
  narrow.instance.unmount()

  // ── 6: 浏览型命令归正常区（`/resume` 与 `/tree` 同类）──────────────────
  // `/resume` 只打开会话管理界面，真正的门禁在界面里的「确认切换」那一步
  // （DSH 停放、Claude 后端由 core 拒绝），所以命令行本身不沉灰；同族的
  // `/rewind` 仍是门禁命令（core 路径回合中直接拒绝），必须沉底。这一对
  // 「同族不同区」正是分区读 `workingHoldOf` 而不是读命令名的意义。
  const browse = await boot(100, true, [
    { name: 'resume', description: 'Open the session manager' },
    { name: 'rewind', description: 'Rewind the conversation' },
  ])
  browse.stdin.write('/')
  await settled(() => rowOf(browse.lines(), 'resume') >= 0 && rowOf(browse.lines(), 'rewind') >= 0)
  const browseLines = browse.lines()
  const resumeRow = rowOf(browseLines, 'resume')
  const rewindRow = rowOf(browseLines, 'rewind')
  check('浏览型 /resume 留在正常区（界面里的切换是另外确认的动作）',
    resumeRow >= 0 && resumeRow < rewindRow && !browse.frames().includes(`${SUBTLE}  resume`),
    JSON.stringify({ resumeRow, rewindRow }))
  check('同族的 /rewind 仍沉灰区（core 路径回合中直接拒绝）',
    rewindRow > resumeRow && browse.frames().includes(`${SUBTLE}  rewind`))
  browse.instance.unmount()

  console.log(failed === 0 ? 'verify-command-hold-overlay OK' : `verify-command-hold-overlay: ${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

/** 显示宽度：不依赖渲染器的最小实现（CJK 宽 2），ANSI 已由解析后的屏幕文本去掉。 */
function stringWidthOf(text: string): number {
  let width = 0
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, '')) {
    const code = char.codePointAt(0) ?? 0
    width += (code >= 0x1100 && (
      code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x20000 && code <= 0x3fffd)
    )) ? 2 : 1
  }
  return width
}

await run()
