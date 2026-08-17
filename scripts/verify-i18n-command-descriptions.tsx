/**
 * 斜杠命令描述 i18n 回归（issue #41 的汉化一半，CJK 截断一半由
 * verify-cjk-truncate.tsx 覆盖）：
 *   1. lang=zh 时 / 菜单（CommandSuggestions）与 ? 帮助菜单（HelpMenu）
 *      显示中文描述，lang=en 时回退 LOCAL_COMMANDS / 注册表原文；
 *   2. 已知外部命令（plan）在 zh 下走 cmd-desc 映射，未收录的外部命令
 *      任何语言都回退注册表原文；
 *   3. 窄终端下中文描述按显示宽度截断，不劈字、每行宽度不超限。
 * 运行：node --import tsx/esm scripts/verify-i18n-command-descriptions.tsx
 */
process.env.FORCE_COLOR = '3'

const [
  { Writable },
  React,
  { Terminal: XTerm },
  { render },
  { CommandSuggestions },
  { HelpMenu },
  { setLang },
  { LOCAL_COMMANDS },
  { stringWidth },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/CommandSuggestions.js'),
  import('../src/components/HelpMenu.js'),
  import('../src/i18n.js'),
  import('../src/commands.js'),
  import('../src/ink/stringWidth.js'),
])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failures = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}

function makeTerm(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  return { term, stdout: new FakeStdout() }
}

function screenText(term: InstanceType<typeof XTerm>, rows: number): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}

// 混合清单：内置命令 + 已收录外部命令（plan）+ 未收录外部命令。
const commands = [
  ...LOCAL_COMMANDS.filter(c => ['new', 'compact', 'rewind'].includes(c.name)),
  { name: 'plan', description: 'Toggle plan mode', external: true },
  { name: 'unlisted-ext', description: 'Registry fallback text', external: true },
]

// --- 1. / 菜单随语言切换 -----------------------------------------------------

console.log('CommandSuggestions 随 /lang 切换:')

{
  const COLS = 80
  const ROWS = 8
  const { term, stdout } = makeTerm(COLS, ROWS)
  const app = await render(
    React.createElement(CommandSuggestions, { commands, selectedIndex: 0, columns: COLS }),
    { stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(300)

  setLang('zh')
  app.rerender(React.createElement(CommandSuggestions, { commands, selectedIndex: 0, columns: COLS }))
  await sleep(200)
  let text = screenText(term, ROWS)
  assert(text.includes('新开会话'), 'zh：内置命令显示中文描述（新开会话）')
  assert(text.includes('压缩会话历史'), 'zh：compact 显示中文描述')
  assert(text.includes('切换计划模式'), 'zh：外部命令 plan 走 cmd-desc 中文映射')
  assert(text.includes('Registry fallback text'), 'zh：未收录外部命令回退注册表原文')
  assert(!text.includes('Toggle plan mode'), 'zh：已收录外部命令不再显示英文原文')

  setLang('en')
  app.rerender(React.createElement(CommandSuggestions, { commands, selectedIndex: 0, columns: COLS }))
  await sleep(200)
  text = screenText(term, ROWS)
  assert(text.includes('Start a new conversation'), 'en：内置命令回退 LOCAL_COMMANDS 英文原文')
  assert(text.includes('Toggle plan mode'), 'en：外部命令 plan 回退注册表英文原文')
  assert(!text.includes('新开会话'), 'en：不再残留中文描述')

  setLang('zh')
  app.unmount()
  await sleep(100)
}

// --- 2. ? 帮助菜单随语言切换 --------------------------------------------------

console.log('HelpMenu 随 /lang 切换:')

{
  const COLS = 110
  const ROWS = 20
  const { term, stdout } = makeTerm(COLS, ROWS)
  const app = await render(
    React.createElement(HelpMenu, { commands }),
    { stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(300)

  setLang('zh')
  app.rerender(React.createElement(HelpMenu, { commands }))
  await sleep(200)
  let text = screenText(term, ROWS)
  assert(text.includes('/new — 新开会话'), 'zh：帮助菜单显示 /new — 新开会话')
  assert(text.includes('/rewind — 打开会话树（/tree 的别名）'), 'zh：帮助菜单显示 rewind 中文描述')

  setLang('en')
  app.rerender(React.createElement(HelpMenu, { commands }))
  await sleep(200)
  text = screenText(term, ROWS)
  assert(text.includes('/new — Start a new conversation'), 'en：帮助菜单显示英文原文')

  setLang('zh')
  app.unmount()
  await sleep(100)
}

// --- 3. 窄终端中文截断不劈字 --------------------------------------------------

console.log('窄终端中文描述截断:')

{
  const COLS = 36
  const ROWS = 8
  const { term, stdout } = makeTerm(COLS, ROWS)
  setLang('zh')
  const app = await render(
    React.createElement(CommandSuggestions, { commands, selectedIndex: 0, columns: COLS }),
    { stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(300)
  app.unmount()
  await sleep(100)

  const buf = term.buffer.active
  let sawEllipsis = false
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(y)?.translateToString(true) ?? ''
    if (line.trim() === '') continue
    const w = stringWidth(line)
    assert(w <= COLS, `第 ${y} 行宽 ${w} ≤ 终端宽 ${COLS}：'${line.trimEnd()}'`)
    if (line.includes('…')) sawEllipsis = true
  }
  assert(sawEllipsis, '窄终端下超长中文描述被截断并带省略号')
}

// --- 结果 -------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
process.exit(0)
