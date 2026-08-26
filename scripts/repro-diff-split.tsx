/**
 * Split-diff scenarios (side-by-side two-pane view):
 * 1. 120 cols: an Edit card renders two aligned panes separated by │ — no
 *    unified `- `/`+ ` rows; change pairs share one screen row; removed
 *    rows leave the right pane blank
 * 2. changed rows carry the dimmed row backgrounds; changed words use the
 *    bright word palette
 * 3. 70 cols (below SPLIT_DIFF_MIN_COLS): the card falls back to the
 *    unified view
 * 4. a new-file Write (oldText null) fills only the right pane
 *
 * Exits non-zero on the first failed assertion (CI convention).
 */
process.env.FORCE_COLOR = '3'
// This script asserts English UI copy; pin the language before any
// module import resolves the startup lang (env > persisted > locale).
process.env.DSH_TUI_LANG = 'en'

const [{ Writable }, React, { Terminal: XTerm }, { render }, { AssistantToolUseMessage }, { getCliHighlightPromise }, { parseAnsiRuns, chalkFromToken, highlightLines }, { sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/cc/cliHighlight.js'),
  import('../src/components/SplitDiffView.js'),
  import('./lib/term-test.mjs'),
])

let failures = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failures++
}

const editTool = {
  callId: 'c1',
  name: 'edit',
  argsText: '{"file_path":"/tmp/utils.py"}',
  status: 'ok',
  startedAt: 0,
  durationMs: 12,
  callView: {
    card: 'diff',
    title: 'Edit /tmp/utils.py',
    diffs: [{
      path: '/tmp/utils.py',
      oldText: 'def shout(text):\n    return text.upper()\n# tail',
      newText: 'def shout(text, mark="!"):\n    return text.upper() + mark\n# tail',
    }],
  },
}

/** Boot one headless terminal at the given width and render the card. */
async function renderAt(cols, tool, diffLayout = 'auto', toolBackground = 'none') {
  const rows = 30
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk, _e, cb) { term.write(String(chunk), cb) }
  }
  const app = await render(
    React.createElement(AssistantToolUseMessage, { tool, addMargin: false, verbose: false, diffLayout, toolBackground }),
    { stdout: new FakeStdout(), debug: true, exitOnCtrlC: false },
  )
  // cli-highlight loads lazily on first use; give it room to land so the
  // syntax-color assertions see the settled frame.（懒加载后的补色重绘无
  // 调用方无关的可观测条件，保留固定窗口。）
  await sleep(900)
  const buf = term.buffer.active
  const lines = []
  for (let y = 0; y < rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  const bgAt = (x, y) => (buf.getLine(y)?.getCell(x)?.getBgColor() ?? 0) & 0xffffff
  const fgAt = (x, y) => (buf.getLine(y)?.getCell(x)?.getFgColor() ?? 0) & 0xffffff
  app.unmount()
  return { lines, bgAt, fgAt, screen: () => lines.join('\n') }
}

// ---- 1&2. Wide terminal: two panes, aligned rows, word highlight
{
  const { lines, screen, bgAt, fgAt } = await renderAt(120, editTool)
  const s = screen()
  check('宽屏不出现统一式 - /+ 行', !lines.some(line => line.startsWith(' ⎿ - ') || line.startsWith(' ⎿ + ')))
  const pairRow = lines.findIndex(line => line.includes('def shout(text):') && line.includes('def shout(text, mark="!"):'))
  check('改动对在同行双栏呈现', pairRow >= 0)
  check('双栏以 │ 分隔', pairRow >= 0 && lines[pairRow]!.includes('│'))
  const ctxRow = lines.findIndex(line => line.includes('# tail'))
  check('上下文行双栏都有内容', ctxRow >= 0 && lines[ctxRow]!.split('│').length === 2)
  if (pairRow >= 0) {
    const dividerX = lines[pairRow]!.indexOf('│')
    check('左栏（old）改动行底色为暗红系', bgAt(6, pairRow) === 0x362b2c, `bg=${bgAt(6, pairRow).toString(16)}`)
    check('右栏（new）改动行底色为暗绿系', bgAt(dividerX + 2, pairRow) === 0x2b352c, `bg=${bgAt(dividerX + 2, pairRow).toString(16)}`)
    const markX = lines[pairRow]!.indexOf('mark="!"')
    check('右栏改动词组使用亮绿词色', markX > 0 && fgAt(markX, pairRow) === 0x57956b, `fg=${fgAt(Math.max(markX, 0), pairRow).toString(16)}`)
    const defX = lines[pairRow]!.indexOf('def')
    check('关键字使用语法色（syntaxKeyword）', defX > 0 && fgAt(defX, pairRow) === 0x78a0d6, `fg=${fgAt(Math.max(defX, 0), pairRow).toString(16)}`)
  }
  if (ctxRow >= 0) {
    check('默认 none 档：上下文行无卡片底色', bgAt(6, ctxRow) === 0xffffff, `bg=${bgAt(6, ctxRow).toString(16)}`)
  }
}

// ---- 1b. toolBackground 档位：subtle/strong 给上下文行上浅/深卡片底色
{
  const { lines, bgAt } = await renderAt(120, editTool, 'auto', 'subtle')
  const row = lines.findIndex(line => line.includes('# tail'))
  if (row >= 0) {
    check('subtle 档：上下文行为浅档卡片底色', bgAt(6, row) === 0x1c2330, `bg=${bgAt(6, row).toString(16)}`)
  }
}
{
  const { lines, bgAt } = await renderAt(120, editTool, 'auto', 'strong')
  const row = lines.findIndex(line => line.includes('# tail'))
  if (row >= 0) {
    check('strong 档：上下文行为深档卡片底色', bgAt(6, row) === 0x242b3a, `bg=${bgAt(6, row).toString(16)}`)
  }
}

// ---- 3. Narrow terminal: unified fallback
{
  const { lines, screen, bgAt } = await renderAt(70, editTool)
  const s = screen()
  check('窄屏回退统一式 - 行', s.includes('- def shout(text):'))
  check('窄屏回退统一式 + 行', s.includes('+ def shout(text, mark="!"):'))
  check('窄屏不出现 │ 分隔', !s.includes('│'))
  const bodyRow = lines.findIndex(line => line.includes('# tail'))
  if (bodyRow >= 0) {
    check('默认 none 档：统一式卡体无底色（文本处）', bgAt(lines[bodyRow]!.indexOf('# tail'), bodyRow) === 0xffffff,
      `bg=${bgAt(lines[bodyRow]!.indexOf('# tail'), bodyRow).toString(16)}`)
    check('默认 none 档：统一式卡体无底色（行尾）', bgAt(69, bodyRow) === 0xffffff,
      `bg=${bgAt(69, bodyRow).toString(16)}`)
  }
}

// ---- 4. New file: only the right pane fills
{
  const writeTool = {
    ...editTool,
    callId: 'c2',
    name: 'write',
    callView: {
      card: 'diff',
      title: 'Write /tmp/new.py',
      diffs: [{ path: '/tmp/new.py', oldText: null, newText: 'hello\nworld' }],
    },
  }
  const { lines } = await renderAt(120, writeTool)
  const helloRow = lines.findIndex(line => line.includes('hello'))
  check('新建文件的行落在右栏', helloRow >= 0 && lines[helloRow]!.includes('│') && lines[helloRow]!.indexOf('hello') > lines[helloRow]!.indexOf('│'))
  check('新建文件左栏留空', helloRow >= 0 && lines[helloRow]!.slice(5, lines[helloRow]!.indexOf('│')).trim() !== 'hello')
}

// ---- 5. diffLayout preference overrides the width heuristic
{
  const { screen } = await renderAt(120, editTool, 'unified')
  check('unified 偏好下 120 列也是统一式', screen().includes('- def shout(text):'))
}
{
  const { screen } = await renderAt(90, editTool, 'split')
  check('split 偏好下 90 列也强制双栏', screen().includes('│'))
}

// ---- 6. issue #250 regression assertions
{
  // P1-1: 256-color SGR (tmux / FORCE_COLOR=2) must parse, not drop.
  const runs256 = parseAnsiRuns('\x1b[38;5;147mdef\x1b[39m')
  check('256 色 SGR 解析出 ansi256 run', runs256.some(run => run.color === 'ansi256(147)' && run.text === 'def'))

  // P2-5: every documented color form produces a styling function.
  for (const token of ['#abc', '#AABBCCDD', 'rgb( 1, 2, 3 )', 'ansi256(123)']) {
    const styled = chalkFromToken(token)('x')
    check(`颜色格式 ${token} 产出 SGR`, styled.includes('\x1b[') && styled !== 'x', JSON.stringify(styled))
  }

  // P2-4: unequal replacement block pairs via ci-LCS, not index zip.
  const lcsTool = {
    ...editTool,
    callId: 'c3',
    callView: {
      card: 'diff',
      title: 'Edit /tmp/m.py',
      diffs: [{ path: '/tmp/m.py', oldText: 'foo\nbar', newText: 'insert\nFOO\nbar' }],
    },
  }
  const { lines: lcsLines } = await renderAt(120, lcsTool)
  const insertRow = lcsLines.findIndex(line => line.includes('insert'))
  const pairRow = lcsLines.findIndex(line => line.includes('foo') && line.includes('FOO'))
  check('不等长块：insert 为独立新增行', insertRow >= 0 && !lcsLines[insertRow]!.includes('foo'))
  check('不等长块：foo ↔ FOO 成对', pairRow >= 0 && pairRow > insertRow)

  // P2-7: multi-line string keeps the lexer state on later lines.
  const mlTool = {
    ...editTool,
    callId: 'c4',
    callView: {
      card: 'diff',
      title: 'Edit /tmp/s.py',
      diffs: [{ path: '/tmp/s.py', oldText: null, newText: 'x = """hello\nworld\nend"""' }],
    },
  }
  const { lines: mlLines, fgAt: mlFg } = await renderAt(120, mlTool)
  const worldRow = mlLines.findIndex(line => line.includes('world'))
  const worldX = worldRow >= 0 ? mlLines[worldRow]!.indexOf('world') : -1
  check('多行字符串后续行带字符串色', worldX > 0 && mlFg(worldX, worldRow) === 0x79ad91, `fg=${worldX > 0 ? mlFg(worldX, worldRow).toString(16) : 'n/a'}`)

  // Shared helper regressions: JSON args, multiline TS state, and safe unknown fallback.
  const hl = await getCliHighlightPromise()
  const jsonRuns = highlightLines('{"file_path":"src/a.ts","line":2}', 'json', hl, {
    string: chalkFromToken('#82B89D'), number: chalkFromToken('#D19A66'),
  }, 'json-dark')
  check('JSON 参数产生字符串/数字 token', jsonRuns?.flat().some(run => run.color === 'rgb(130,184,157)') === true && jsonRuns.flat().some(run => run.color === 'rgb(209,154,102)') === true)
  const tsRuns = highlightLines('const value = `first\nsecond`', 'ts', hl, { string: chalkFromToken('#82B89D') }, 'ts-dark')
  check('TypeScript 多行字符串保持 lexer 状态', tsRuns?.[1]?.some(run => run.color === 'rgb(130,184,157)') === true)
  check('未知语言安全回退', highlightLines('plain output', 'future-agent-language', hl, {}, 'unknown') === undefined)

  // P1-2: the syntax cache keys on the theme signature — a palette change
  // must not serve stale colors.
  const chDark = { keyword: chalkFromToken('#8FA8E8') }
  const chLight = { keyword: chalkFromToken('#4A63A8') }
  const darkRuns = highlightLines('def f():', 'py', hl, chDark, 'sig-dark')
  const lightRuns = highlightLines('def f():', 'py', hl, chLight, 'sig-light')
  const darkColor = darkRuns?.[0]?.find(run => run.text === 'def')?.color
  const lightColor = lightRuns?.[0]?.find(run => run.text === 'def')?.color
  check('主题签名不同缓存不串色', darkColor !== undefined && lightColor !== undefined && darkColor !== lightColor,
    `dark=${darkColor} light=${lightColor}`)
}

console.log(failures === 0 ? 'repro-diff-split: all assertions passed' : `repro-diff-split: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
