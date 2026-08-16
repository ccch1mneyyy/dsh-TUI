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

const [{ Writable }, React, { Terminal: XTerm }, { render }, { AssistantToolUseMessage }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
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
async function renderAt(cols, tool) {
  const rows = 30
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk, _e, cb) { term.write(String(chunk), cb) }
  }
  const app = await render(
    React.createElement(AssistantToolUseMessage, { tool, addMargin: false, verbose: false }),
    { stdout: new FakeStdout(), debug: true, exitOnCtrlC: false },
  )
  await sleep(300)
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
  check('宽屏不出现统一式 - /+ 行', !s.includes('- def shout') && !s.includes('+ def shout'))
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
  }
}

// ---- 3. Narrow terminal: unified fallback
{
  const { screen } = await renderAt(70, editTool)
  const s = screen()
  check('窄屏回退统一式 - 行', s.includes('- def shout(text):'))
  check('窄屏回退统一式 + 行', s.includes('+ def shout(text, mark="!"):'))
  check('窄屏不出现 │ 分隔', !s.includes('│'))
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

console.log(failures === 0 ? 'repro-diff-split: all assertions passed' : `repro-diff-split: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
