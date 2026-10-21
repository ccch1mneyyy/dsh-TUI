/**
 * Split-diff scenarios (side-by-side two-pane view):
 * 1. 120 cols: an Edit card renders two aligned panes separated by │ — no
 *    unified `- `/`+ ` rows; change pairs share one screen row; removed
 *    rows leave the right pane blank
 * 2. changed rows carry the dimmed row backgrounds; changed words use the
 *    bright word palette
 * 3. 70 cols (below SPLIT_DIFF_MIN_COLS): the card falls back to the
 *    unified view
 * 4. one-sided Write/delete files use the full body width without a divider
 * 5. expanded (Ctrl+O / verbose) long lines wrap inside each pane instead of
 *    being clipped, the collapsed card reports how many characters it
 *    clipped, and the expanded body stays inside its 400-visual-row window
 *
 * Exits non-zero on the first failed assertion (CI convention).
 *
 * Each covered fix has a one-line negative control rather than an in-suite
 * switch (restore the line with `git checkout` afterwards); every revert turns
 * only its own cases red, out of 56 assertions:
 * - dropping the `<= budget` guard in clippedGraphemes → 3 FAILED (the 54- and
 *   55-cell counts and the NFD cluster count);
 * - `take = height` in its paint loop → 2 FAILED (the giant single line, which
 *   then paints all 742 visual rows);
 * - segmenting each run on its own instead of the joined line → 3 FAILED (the
 *   cluster cases, including the folded count reading code points);
 * - the window notice back on `tool-card-window-shown` → 2 FAILED (its unit).
 */
process.env.FORCE_COLOR = '3'
// This script asserts English UI copy; pin the language before any
// module import resolves the startup lang (env > persisted > locale).
process.env.DSH_TUI_LANG = 'en'

const [{ Writable }, React, { Terminal: XTerm }, { render }, { AssistantToolUseMessage }, { getCliHighlightPromise }, { parseAnsiRuns, chalkFromToken, highlightLines }, { sleep }, { stringWidth }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/terminal-utils/cliHighlight.js'),
  import('../src/components/SplitDiffView.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/stringWidth.js'),
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

/** Boot one headless terminal at the given width and render the card.
 *  `verbose` is the Ctrl+O / click-to-expand state the card receives; `rows`
 *  grows the viewport for the expanded visual-row window (the default 30
 *  would clip it); `settleMs` widens the fixed window for frames far larger
 *  than an ordinary card. */
async function renderAt(cols, tool, diffLayout = 'auto', toolBackground = 'none', options = {}) {
  const { verbose = false, fullscreen = false, rows = 30, settleMs = 900 } = options
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk, _e, cb) { term.write(String(chunk), cb) }
  }
  const app = await render(
    React.createElement(AssistantToolUseMessage, { tool, marginTopOnTurn: false, verbose, fullscreen, diffLayout, toolBackground }),
    { stdout: new FakeStdout(), debug: true, exitOnCtrlC: false },
  )
  // 固定窗:pacing cli-highlight 首次使用才懒加载，其后的补色重绘没有
  // 调用方可观测的完成条件，只能留出落地时间再读色。
  await sleep(settleMs)
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

// ---- 4. New file: no empty old pane or middle divider
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
  check('new file starts at the body left edge without an empty pane', helloRow >= 0 && lines[helloRow]!.indexOf('hello') < 12)
  check('new file has no middle divider', helloRow >= 0 && !lines[helloRow]!.includes('│'))
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

// ---- 7. Expanded two-pane wrapping: long lines become readable without
//          losing the row alignment the two panes depend on.
// Geometry at 120 cols, as this fixture measures it: the card hands
// SplitDiffView `columns - 4` = 116, which splits into two
// floor((116 - 1) / 2) = 57-cell panes around a 1-cell divider; after the
// status gutter the left pane holds 55 cells of text and the right 54. The
// fixture lengths below are chosen against those two budgets.
const diffTool = (oldText, newText, path) => ({
  ...editTool,
  callId: `c-${path}`,
  callView: { card: 'diff', title: `Edit ${path}`, diffs: [{ path, oldText, newText }] },
})

// One-sided widths are chosen per file, not from the current visible slice.
for (const cols of [70, 120]) for (const layout of ['auto', 'split']) for (const fullscreen of [false, true]) {
  const content = 'const value = "' + 'x'.repeat(24) + '" // FULL_WIDTH_TAIL'
  for (const oldText of [null, '']) {
    const fresh = (await renderAt(cols, diffTool(oldText, content, '/tmp/new.ts'), layout, 'none', { fullscreen })).screen()
    check(`one-sided addition ${cols}/${layout}/${fullscreen}/${oldText}: full line and no divider`,
      fresh.includes('FULL_WIDTH_TAIL') && !fresh.includes('│'), fresh)
  }
  const removed = (await renderAt(cols, diffTool(content, '', '/tmp/gone.ts'), layout, 'none', { fullscreen })).screen()
  check(`one-sided deletion ${cols}/${layout}/${fullscreen}: full line and no divider`,
    removed.includes('FULL_WIDTH_TAIL') && !removed.includes('│'), removed)
}
{
  const tool = { ...editTool, callView: { card: 'diff', title: 'Mixed', diffs: [
    { path: '/tmp/new.txt', oldText: null, newText: 'ONE_SIDE_FILE' },
    { path: '/tmp/edit.txt', oldText: 'OLD_SIDE_FILE', newText: 'NEW_SIDE_FILE' },
  ] } }
  const { lines } = await renderAt(120, tool, 'split', 'none', { verbose: true })
  check('mixed files: addition has no divider', lines.some(line => line.includes('ONE_SIDE_FILE') && !line.includes('│')))
  check('mixed files: ordinary edit stays split', lines.some(line => line.includes('OLD_SIDE_FILE') && line.includes('NEW_SIDE_FILE') && line.includes('│')))
  const hiddenOld = Array.from({ length: 20 }, (_, i) => `new_${i}`).join('\n') + '\nOLD_TAIL'
  const folded = (await renderAt(120, diffTool('OLD_TAIL', hiddenOld, '/tmp/late.txt'), 'split')).screen()
  check('folded opposite side still reserves split layout', folded.includes('│'))
  const unicode = '新'.repeat(50) + '👨‍👩‍👧e\u0301FULL_WIDTH_UNICODE'
  const expanded = (await renderAt(70, diffTool(null, unicode, '/tmp/new.txt'), 'split', 'none', { verbose: true })).screen()
  check('one-sided expanded wrap preserves Unicode and tail', expanded.includes('👨‍👩‍👧e\u0301') && expanded.includes('FULL_WIDTH_UNICODE') && !expanded.includes('│'))
}

// Both states of one 200-char change pair: expanded, both tails are
// readable and still separated by │ on one visual row; collapsed, the tail
// stays clipped but the card says how much it clipped.
{
  const longTool = diffTool(`${'o'.repeat(188)}TAIL_OLD_ZZZ`, `${'n'.repeat(188)}TAIL_NEW_ZZZ`, '/tmp/long.py')
  const foldedScreen = (await renderAt(120, longTool)).screen()
  // Collapsed keeps 1 logical line = 1 terminal row (#245). Without this the
  // expanded assertion below could pass on a card that never clipped.
  check('折叠态长行仍截断（两栏 tail 都不可见）',
    !foldedScreen.includes('TAIL_OLD_ZZZ') && !foldedScreen.includes('TAIL_NEW_ZZZ'))
  // The hint reuses the existing fold copy (tool-card-lines-hidden +
  // tool-card-chars-unit); the counts are the implementation's business.
  check('折叠态截断提示：出现 folded … chars 计数',
    foldedScreen.includes('folded') && foldedScreen.includes('chars'))
  const { lines, screen } = await renderAt(120, longTool, 'auto', 'none', { verbose: true })
  const expanded = screen()
  check('展开态长行：左栏尾部可读', expanded.includes('TAIL_OLD_ZZZ'))
  check('展开态长行：右栏尾部可读', expanded.includes('TAIL_NEW_ZZZ'))
  const tailRow = lines.findIndex(line => line.includes('TAIL_OLD_ZZZ'))
  check('展开态长行：尾部视觉行仍以 │ 分隔两栏',
    tailRow >= 0 && lines[tailRow]!.includes('TAIL_NEW_ZZZ') && lines[tailRow]!.includes('│'),
    `tailRow=${tailRow}`)
}

// Negative control for that hint: nothing was clipped, so no hint may show.
// Without this the assertion above also passes on a hint that is always on.
{
  const shortTool = diffTool('a = 1\nb = 2\n# tail', 'a = 1\nb = 22\n# tail', '/tmp/short.py')
  const s = (await renderAt(120, shortTool)).screen()
  check('折叠态未截断时无 folded/chars 提示', !s.includes('folded') && !s.includes('chars'))
}

// The hint must report what the renderer actually dropped: `truncate` paints a
// line that fits its budget whole and only cuts past it, keeping `budget - 1`
// cells. The pane text budgets at 120 cols are 55 (old) and 54 (new) cells, so
// 53- and 54-cell lines are painted whole — a 54-cell line exactly fills the
// right pane's budget, so it must not be reported as folded — while 55 and 56
// lose 2 and 5 cells between the two panes.
for (const [cells, expected] of [[53, 0], [54, 0], [55, 2], [56, 5]] as const) {
  const line = 'a'.repeat(cells)
  const s = (await renderAt(120, diffTool(line, line, '/tmp/full.py'))).screen()
  const hint = s.split('\n').find(row => row.includes('folded'))?.trim() ?? 'no hint'
  check(`折叠态折叠计数：${cells} cell 行 → ${expected === 0 ? '无提示' : `folded ${expected} chars`}`,
    expected === 0 ? !s.includes('folded') : s.includes(`folded ${expected} chars`), hint)
}

// Alignment: one logical row is max(left, right) visual rows tall, so the next
// logical row starts right after it — neither pane can run ahead.
{
  // Left: one visual row. Right: 123 cells in ONE unbroken token, which wraps
  // into exactly 3 visual rows for any pane budget in [41, 61] cells (both
  // budgets sit in that band), so no word boundary can shift the count.
  const alignTool = diffTool('LEFT_ANCHOR\n# tail', `${'r'.repeat(123)}\n# tail`, '/tmp/align.py')
  const { lines } = await renderAt(120, alignTool, 'auto', 'none', { verbose: true })
  const pairY = lines.findIndex(line => line.includes('LEFT_ANCHOR'))
  const ctxY = lines.findIndex(line => line.includes('# tail'))
  check('展开态换行：改动对与上下文行都定位到', pairY >= 0 && ctxY >= 0, `pairY=${pairY} ctxY=${ctxY}`)
  check('展开态换行：上下文行落在改动对首行 + 3',
    pairY >= 0 && ctxY >= 0 && ctxY === pairY + 3, `pairY=${pairY} ctxY=${ctxY}`)
  const pairRows = pairY >= 0 ? lines.slice(pairY, pairY + 3) : []
  check('展开态换行：改动对的 3 个视觉行都带 │ 分隔',
    pairRows.length === 3 && pairRows.every(line => line.includes('│')), `rows=${pairRows.length}`)
}

// The expanded body walks a bounded VISUAL-row window (400, the same
// constant the unified body uses). A row that would cross the edge is clipped
// to the rows left rather than admitted whole, so the painted count is the
// window itself — the giant-line case below covers that clipping.
{
  const EXPANDED_WINDOW = 400
  // 300 logical rows x 2 visual rows = 600, comfortably past the window.
  const many = side => Array.from(
    { length: 300 },
    (_, index) => `${side}${String(index).padStart(3, '0')}${side.repeat(95)}`,
  ).join('\n')
  const bigTool = diffTool(many('o'), many('n'), '/tmp/big.py')
  // A ~400-row frame measured ~950ms to settle here; 3000 keeps that margin
  // on a loaded CI runner without paying it on the ordinary cards above.
  const { lines, screen } = await renderAt(120, bigTool, 'auto', 'none', { verbose: true, rows: 460, settleMs: 3000 })
  const bodyRows = lines.filter(line => line.includes('│')).length
  check('展开态视觉行窗口：正文行数不超过 400',
    bodyRows > 0 && bodyRows <= EXPANDED_WINDOW, `bodyRows=${bodyRows}`)
  // The unit is the point: the split view counts WRAPPED rows, so a source
  // line that wraps into many screen rows must not read as "N lines".
  check('展开态视觉行窗口：提示按换行后的屏幕行计，400 起',
    screen().includes('showing the first 400/') && screen().includes('wrapped rows'))
}

// A single logical line carries no height bound of its own: 40000 cells wrap
// into ~740 visual rows. The window edge has to cut that row instead of
// admitting it whole — pre-fix the body painted all 742 rows and, since they
// all counted as painted, said nothing about it.
{
  const huge = `const blob = '${'z'.repeat(40000)}' ENDOFHUGE`
  const { lines, screen } = await renderAt(120, diffTool(huge, `${huge}_B`, '/tmp/huge.py'), 'auto', 'none', { verbose: true, rows: 900, settleMs: 3000 })
  const bodyRows = lines.filter(line => line.includes('│')).length
  check('展开态巨型单行：正文行数不超过 400 视觉行', bodyRows > 0 && bodyRows <= 400, `bodyRows=${bodyRows}`)
  check('展开态巨型单行：提示按换行后的屏幕行计，400 起',
    screen().includes('showing the first 400/') && screen().includes('wrapped rows'))
}

// Width: wrapping counts DISPLAY CELLS, so a CJK + emoji line breaks between
// graphemes instead of splitting one (U+FFFD on screen is the tell).
{
  const cjkTool = diffTool(`${'旧'.repeat(40)}🚀TAIL_CJK_OLD`, `${'新'.repeat(40)}🚀TAIL_CJK_NEW`, '/tmp/wide.py')
  const { lines } = await renderAt(120, cjkTool, 'auto', 'none', { verbose: true })
  const s = lines.join('\n')
  check('宽字符：屏幕不出现 U+FFFD（未把宽字符切半）', !s.includes('\uFFFD'))
  // Cheap upper bound only — the exact pane budget belongs to the unit-level
  // surface; 120 is this fixture's terminal width.
  const overflowing = lines.filter(line => stringWidth(line) > 120)
  check('宽字符：每行屏幕文本不超过终端物理列数', overflowing.length === 0, `over=${overflowing.length}`)
  check('宽字符：展开态两栏尾部标记可读', s.includes('TAIL_CJK_OLD') && s.includes('TAIL_CJK_NEW'))
}

// Grapheme clusters must survive the word diff's run boundaries. jsdiff
// tokenizes non-Latin text per code point, so an edited family emoji leaves a
// run ending on a bare ZWJ and an edited combining mark leaves the accent in
// the next run; segmenting each run on its own would let the wrap split the
// cluster across two rows.
{
  // 53 padding cells + a 2-cell cluster: the left pane's 55-cell budget ends
  // right after the cluster, which is where a per-run segmentation tears it.
  const familyOld = `${'a'.repeat(53)}👨‍👩‍👧`
  const familyNew = `${'a'.repeat(53)}👨‍👩‍👦`
  const { lines } = await renderAt(120, diffTool(familyOld, familyNew, '/tmp/family.txt'), 'auto', 'none', { verbose: true, rows: 20 })
  const body = lines.filter(line => line.includes('│'))
  const joined = lines.join('\n')
  check('组合字符簇：家族 emoji 不被 run 边界拆开（两栏各自完整成形）',
    joined.includes('👨‍👩‍👧') && joined.includes('👨‍👩‍👦'))
  const danglingZwij = body.find(line => line.trimEnd().endsWith('\u200D'))
  check('组合字符簇：没有视觉行以悬空 ZWJ 收尾', danglingZwij === undefined, danglingZwij ?? '')
}

// Same hazard with a combining mark: editing only the accent makes the word
// diff hand the base letter and the mark to different runs. The collapsed hint
// counts what the renderer drops, so a per-run segmentation would report three
// characters where two cells were cut.
{
  const accentOld = `${'b'.repeat(54)}e\u0301`
  const accentNew = `${'b'.repeat(54)}e\u0302`
  const { lines } = await renderAt(120, diffTool(accentOld, accentNew, '/tmp/accent.txt'), 'auto', 'none', { verbose: true, rows: 20 })
  const body = lines.filter(line => line.includes('│'))
  const leadingMark = body.find(line => /^\s*[\u0300-\u036F]/u.test(line))
  check('组合字符簇：视觉行不以组合附标开头', leadingMark === undefined, leadingMark ?? '')
  const folded = (await renderAt(120, diffTool(accentOld, accentNew, '/tmp/accent.txt'))).screen()
  check('组合字符簇：折叠态计数按簇而不是按码点（NFD 行）',
    folded.includes('folded 2 chars'), folded.split('\n').find(line => line.includes('folded')) ?? 'no hint')
}


console.log(failures === 0 ? 'repro-diff-split: all assertions passed' : `repro-diff-split: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
