/**
 * Tool-card i18n regression (issue #980): the card cluster —
 * AssistantToolUseMessage + SplitDiffView — must render every piece of
 * interface copy through the i18n dictionary in BOTH shipped languages:
 * tool display names, per-line fold hints, exit/signal error lines, the
 * running placeholder, and search-result truncation. These used to be
 * hardcoded English that leaked into the zh UI.
 *
 * Belt and suspenders with scripts/verify-i18n.ts: that gate bans the
 * English literals at the SOURCE level (they may only live in the dict);
 * this fixture proves the RENDERED output actually localizes — a t() call
 * that is never reached, or keyed to the wrong entry, still fails here.
 *
 * zh is pinned below (the shipping default); the en pass switches via
 * setLang() and remounts every scenario with a fresh key so memos
 * (foldTerminalTitle caches by title ref + lang) re-resolve.
 *
 * Exits non-zero on any failed assertion (CI convention).
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ Writable }, React, { Terminal: XTerm }, { render }, { AssistantToolUseMessage }, { setLang }, { settled }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

function makeRig(cols: number, rows = 30) {
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
  argsText: '',
  status: 'ok' as const,
  startedAt: 0,
  durationMs: 5,
}

type Scenario = {
  id: string
  tool: Record<string, unknown>
  opts?: { foldTerminalCommand?: boolean }
  zh: string[]
  en: string[]
}

// Interface copy only — model/protocol-produced text (titles like
// `Edit /tmp/a.ts`, output bodies) is out of scope by design (issue #980).
const SCENARIOS: Scenario[] = [
  {
    id: 'name-read',
    tool: { name: 'read', argsText: '{"file_path":"/tmp/a.ts"}' },
    zh: ['读取({"file_path"'],
    en: ['Read({"file_path"'],
  },
  {
    id: 'name-bash-proper-noun',
    tool: { name: 'bash', callView: { card: 'terminal', title: 'ls' }, resultView: { card: 'terminal', output: 'ok', exitCode: 0 }, resultFull: 'ok' },
    zh: ['Bash(ls)'],
    en: ['Bash(ls)'],
  },
  {
    id: 'name-unmapped-fallback',
    tool: { name: 'frobnicate', argsText: '{"x":1}' },
    zh: ['Frobnicate'],
    en: ['Frobnicate'],
  },
  {
    id: 'body-fold-hint',
    tool: { name: 'read', resultFull: 'l1\nl2\nl3\nl4\nl5' },
    zh: ['… +2 行（ctrl+o 展开）'],
    en: ['… +2 lines (ctrl+o to expand)'],
  },
  {
    id: 'terminal-title-fold-hint',
    tool: {
      name: 'bash',
      callView: { card: 'terminal', title: 'cd /tmp\nls\npwd' },
      resultView: { card: 'terminal', output: '', exitCode: 0 },
      resultFull: '',
    },
    opts: { foldTerminalCommand: true },
    zh: ['Bash(cd /tmp)', '… +2 行（ctrl+o 展开）'],
    en: ['Bash(cd /tmp)', '… +2 lines (ctrl+o to expand)'],
  },
  {
    id: 'exit-code-line',
    tool: {
      name: 'bash',
      callView: { card: 'terminal', title: 'false' },
      resultView: { card: 'terminal', output: '', exitCode: 1 },
      resultFull: '',
    },
    zh: ['退出码 1'],
    en: ['Exit code 1'],
  },
  {
    id: 'signal-line',
    tool: {
      name: 'bash',
      callView: { card: 'terminal', title: 'sleep 9' },
      resultView: { card: 'terminal', output: '', signal: 'SIGKILL' },
      resultFull: '',
    },
    zh: ['被信号 SIGKILL 终止'],
    en: ['Killed by signal SIGKILL'],
  },
  {
    id: 'running-placeholder',
    tool: { name: 'read', status: 'running', startedAt: Date.now() - 4000 },
    zh: ['运行中…（'],
    en: ['Running… ('],
  },
  {
    id: 'search-total',
    tool: {
      name: 'glob',
      callView: { card: 'generic', title: 'Glob **/*.ts' },
      resultView: { card: 'search', shape: 'paths' as const, paths: ['src/a.ts'], truncated: true, total: 7 },
      resultFull: 'src/a.ts',
    },
    zh: ['…（共 7 条）'],
    en: ['… (7 total)'],
  },
]

// ── Pass 1 (zh, pinned): 90 cols — unified diffs, all card scenarios ─────
const rig = makeRig(90)
const app = await render(
  React.createElement(AssistantToolUseMessage, {
    key: 'boot-zh',
    tool: { ...base, ...SCENARIOS[0]!.tool },
    marginTopOnTurn: false,
    verbose: false,
  }),
  // patchConsole: false——双实例都 patch 全局 console 会把结果路由进
  // 已卸载实例的假 stdout（验证脚本的标准选项）。
  { stdout: rig.stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
)

// ── Pass 1a (zh): split diff at 120 cols — hidden-rows hint localizes ────
// Count-free assertion (jsdiff alignment decides the exact row total).
const splitRig = makeRig(120)
const splitTool = {
  ...base,
  name: 'edit',
  callView: {
    card: 'diff',
    title: 'Edit /tmp/big.ts',
    diffs: [{
      path: '/tmp/big.ts',
      oldText: Array.from({ length: 12 }, (_, i) => `old line ${i + 1}`).join('\n'),
      newText: Array.from({ length: 12 }, (_, i) => `new line ${i + 1}`).join('\n'),
    }],
  },
}
const splitApp = await render(
  React.createElement(AssistantToolUseMessage, { key: 'split-boot-zh', tool: splitTool, marginTopOnTurn: false, verbose: false }),
  { stdout: splitRig.stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
)

async function runPass(lang: 'zh' | 'en') {
  setLang(lang)
  for (const scenario of SCENARIOS) {
    app.rerender(React.createElement(AssistantToolUseMessage, {
      key: `${scenario.id}-${lang}`,
      tool: { ...base, ...scenario.tool },
      marginTopOnTurn: false,
      verbose: false,
      foldTerminalCommand: scenario.opts?.foldTerminalCommand ?? false,
    }))
    for (const expected of scenario[lang]) {
      check(`[${lang}] ${scenario.id}: 「${expected}」上屏`, await settled(() => screenOf(rig.term).includes(expected)))
    }
  }
  splitApp.rerender(React.createElement(AssistantToolUseMessage, {
    key: `split-${lang}`,
    tool: splitTool,
    marginTopOnTurn: false,
    verbose: false,
  }))
  const splitExpected = lang === 'zh' ? '行（ctrl+o 展开）' : 'lines (ctrl+o to expand)'
  check(`[${lang}] split-diff 隐藏行提示本地化`, await settled(() => screenOf(splitRig.term).includes(splitExpected)))
  // The other language's copy must never leak into this pass's screen.
  const splitForbidden = lang === 'zh' ? 'lines (ctrl+o' : '行（ctrl+o'
  check(`[${lang}] split-diff 无对方语言残留`, !screenOf(splitRig.term).includes(splitForbidden))
}

await runPass('zh')
await runPass('en')

app.unmount()
splitApp.unmount()
await new Promise(resolve => setTimeout(resolve, 100)) // 固定窗:unmount 后 flush 无可观测条件
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
// exitCode（而非 exit()）：重定向下立即 exit 会截断尚未 flush 的 stdout
process.exitCode = failures === 0 ? 0 : 1
