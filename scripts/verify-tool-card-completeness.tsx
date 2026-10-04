/**
 * Tool-card completeness regression (info-display design §B):
 *
 * The card keeps its structured preview by default, but the information
 * the design calls "permanently visible" must survive every fold:
 *
 *  - a terminal call's non-zero exit code / kill signal rides OUTSIDE the
 *    line cap (a long output used to fold the failure verdict away — the
 *    hover tooltip was the only remaining place to read it);
 *  - the line-fold hint aggregates the characters the fold hid when the
 *    hidden rows were also long-line clipped (lines-only folds keep the
 *    historical hint byte-identical);
 *  - verbose (Ctrl+O / expanded) bodies render through a bounded line
 *    window and SAY what they are showing — the retained source keeps all;
 *  - an expanded card whose SOURCE was folded by the transcript window
 *    discloses preview-only instead of passing the preview off as full;
 *  - an expanded card with only a structured view (no raw full result)
 *    says so; one with a full result says nothing (no noise).
 *
 * zh is pinned (shipping default): every assertion targets rendered copy.
 * Exits non-zero on any failure (CI convention).
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ Writable }, React, { Terminal: XTerm }, { render }, { AssistantToolUseMessage }, { settled }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('./lib/term-test.mjs'),
])

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

function makeRig(cols: number, rows = 40) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  return { term, stdout: new FakeStdout() }
}
function screenOf(term: XTerm): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out.join('\n')
}

const base = {
  callId: 'c1',
  name: 'bash',
  argsText: '',
  status: 'ok' as const,
  startedAt: 0,
  durationMs: 5,
}

// One FRESH terminal per scenario: several assertions are absence checks
// (exit 0 renders no verdict line), and a shared screen would keep the
// previous scenario's pixels around and fail them for the wrong reason.
let scenarioId = 0
async function paint(tool: Record<string, unknown>, opts: { verbose?: boolean, sourceFolded?: boolean, rows?: number } = {}): Promise<string> {
  scenarioId++
  const rig = makeRig(90, opts.rows ?? 40)
  const app = await render(
    React.createElement(AssistantToolUseMessage, {
      key: `scene-${scenarioId}`,
      tool: { ...base, ...tool },
      marginTopOnTurn: false,
      verbose: opts.verbose ?? false,
      ...(opts.sourceFolded === undefined ? {} : { sourceFolded: opts.sourceFolded }),
    }),
    { stdout: rig.stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  await settled((): boolean => screenOf(rig.term).includes('Bash') || screenOf(rig.term).includes('读取') || screenOf(rig.term).includes('编辑'))
  const screen = screenOf(rig.term)
  app.unmount()
  return screen
}

// ── 1. Terminal verdict pinned outside the line cap ──────────────────────
{
  const output = Array.from({ length: 6 }, (_, i) => `out-line-${i + 1}`).join('\n')
  const screen = await paint({
    callView: { card: 'terminal', title: 'build.sh' },
    resultView: { card: 'terminal', output, exitCode: 1 },
    resultFull: output,
  })
  check('1a. 长输出折叠提示仍在', screen.includes('… +3 行（ctrl+o 展开）'))
  check('1b. 非零退出码不被行预算折叠', screen.includes('退出码 1'))
  check('1c. 前三行输出可见', screen.includes('out-line-3'))
}
{
  const output = Array.from({ length: 5 }, (_, i) => `sig-line-${i + 1}`).join('\n')
  const screen = await paint({
    callView: { card: 'terminal', title: 'sleep 9' },
    resultView: { card: 'terminal', output, signal: 'SIGKILL' },
    resultFull: output,
  })
  check('2a. 信号行不被行预算折叠', screen.includes('被信号 SIGKILL 终止'))
  check('2b. 折叠提示与信号行共存', screen.includes('… +2 行（ctrl+o 展开）'))
}
{
  const screen = await paint({
    callView: { card: 'terminal', title: 'true' },
    resultView: { card: 'terminal', output: 'ok', exitCode: 0 },
    resultFull: 'ok',
  })
  check('3. 退出码 0 不渲染（零不是信息）', !screen.includes('退出码'))
}

// ── 4. Fold hint aggregates clipped characters of hidden rows ────────────
{
  const long = 'x'.repeat(1200)
  const result = `short-a\nshort-b\nshort-c\n${long}\n${long}`
  const screen = await paint({
    name: 'read',
    callView: { card: 'generic', title: 'Read /tmp/blob.txt' },
    resultFull: result,
  })
  check('4a. 行+字符组合折叠提示', screen.includes('已折叠 2 行 · 400 字符（ctrl+o 展开）'))
  check('4b. 纯行折叠的旧提示形态不被误用', !screen.includes('… +2 行（ctrl+o 展开）'))
}
{
  // Lines-only fold keeps the historical hint byte-identical.
  const screen = await paint({ name: 'read', resultFull: 'l1\nl2\nl3\nl4\nl5' })
  check('5. 纯行折叠保持既有提示', screen.includes('… +2 行（ctrl+o 展开）'))
}

// ── 6. Verbose window: bounded rows + honest marker ───────────────────────
{
  const big = Array.from({ length: 500 }, (_, i) => `w-line-${i + 1}`).join('\n')
  const screen = await paint({
    name: 'read',
    callView: { card: 'generic', title: 'Read /tmp/big.log' },
    resultFull: big,
  }, { verbose: true, rows: 520 })
  check('6a. 窗口告知上屏', screen.includes('只显示前 400/500 行（全文仍保留）'))
  check('6b. 窗口内行可见', screen.includes('w-line-10'))
  check('6c. 窗口外行不上屏', !screen.includes('w-line-450'))
}

// ── 7/8. Expanded disclosures: folded source / structured-only ───────────
{
  const screen = await paint({
    name: 'read',
    resultText: 'preview-only',
  }, { verbose: true, sourceFolded: true })
  check('7. 源折叠的展开卡披露「原始数据已折叠」', screen.includes('原始数据已折叠'))
  check('7b. 源折叠披露优先于全文缺失披露', !screen.includes('整理后的视图'))
}
{
  const screen = await paint({
    name: 'edit',
    callView: { card: 'diff', title: 'Edit /tmp/a.ts', diffs: [{ path: '/tmp/a.ts', oldText: null, newText: 'hello' }] },
    resultView: { card: 'diff', title: 'Edit /tmp/a.ts', diffs: [{ path: '/tmp/a.ts', oldText: null, newText: 'hello' }] },
  }, { verbose: true })
  check('8. 仅结构化视图的展开卡如实标注', screen.includes('整理后的视图'))
}
{
  const screen = await paint({
    name: 'read',
    callView: { card: 'generic', title: 'Read /tmp/full.txt' },
    resultFull: 'the full text',
  }, { verbose: true })
  check('9. 有全文的展开卡不加任何披露', !screen.includes('整理后的视图') && !screen.includes('原始数据已折叠'))
}

// ── 10. Long error body: preview folds, verbose shows everything ─────────
{
  const errorText = Array.from({ length: 6 }, (_, i) => `err-line-${i + 1}`).join('\n')
  const collapsed = await paint({ status: 'error', errorText })
  check('10a. 错误长文折叠提示', collapsed.includes('… +3 行（ctrl+o 展开）'))
  check('10b. 错误首行可见', collapsed.includes('err-line-1'))
  const expanded = await paint({ status: 'error', errorText }, { verbose: true })
  check('10c. 展开显示全部错误行', expanded.includes('err-line-6'))
  check('10d. 展开无窗口告知（未超窗）', !expanded.includes('只显示前'))
}

console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
