/**
 * Turn-usage row toggle + restyle regression (user feedback rework):
 *
 *  - settings `dsh-tui.turnUsageRow` (boolean, default OFF) gates ONLY the
 *    rendering: off filters the rows out of MessageList's visible window
 *    before virtualization (zero rows painted), while the projection keeps
 *    collecting the ledger — `state.turnUsage` still lands for /tokens,
 *    /status and the footer hover;
 *  - the ON shape is the quiet right-aligned emblem: no "this turn"
 *    prefix, dim-below-dim (theme subtle), separators in the footer's `·`
 *    vocabulary, and the model name ONLY when it differs from the previous
 *    turn (`noteModel`, decided at projection time) — first turn with a
 *    model shows it once, an unchanged repeat stays silent.
 *
 * Projection section drives the production reducer; render section mounts
 * the real MessageList (raw-mode holder per the App contract). Exits
 * non-zero on any failure.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.DSH_TUI_LANG = 'zh'

const [{ createProjectorHarness }, { default: React }, { render }, { Writable, PassThrough }, { Terminal: XTerm }, listMod, termTest, { setLang }] = await Promise.all([
  import('./lib/projector-harness.ts'),
  import('react'),
  import('../src/ui.js'),
  import('node:stream'),
  import('@xterm/headless'),
  import('../src/components/MessageList.js'),
  import('./lib/term-test.mjs'),
  import('../src/i18n.js'),
])
setLang('zh')

const { MessageList } = listMod as unknown as { MessageList: React.ComponentType<Record<string, unknown>> }
const { settled, viewportLines } = termTest as unknown as {
  settled(pred: () => boolean, opts?: { timeoutMs?: number }): Promise<boolean>
  viewportLines(term: InstanceType<typeof XTerm>, rows?: number): string[]
}
const { useInput } = await import('../src/ui.js') as unknown as { useInput: (handler: (input: string, key: unknown) => void, options?: { isActive?: boolean }) => void }

let failures = 0
const check = (name: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures += 1
}

// ── 1. Projection: noteModel + ledger survives regardless of any toggle ──
{
  const rig = createProjectorHarness()
  const turn = (n: number, model: string | undefined): void => {
    rig.apply([
      { type: 'turn.start', turn: n, origin: 'user', time: n * 10_000 },
      { type: 'assistant.message', seq: n, anchor: `a${n}`, turn: n, step: 1, attemptId: `a${n}`, time: n * 10_000 + 500, ...(model === undefined ? {} : { model }), blocks: [{ type: 'text', text: `t${n}` }], usage: { input: 10 + n, output: 2 }, canonical: true },
      { type: 'turn.end', turn: n, reason: { kind: 'completed' }, time: n * 10_000 + 900 },
    ] as never)
  }
  turn(1, 'glm-5.3')
  turn(2, 'glm-5.3')
  turn(3, 'glm-5.3-flash')
  const summaries = rig.state.rows.filter(row => row.kind === 'turn-summary')
  check('1a. 首个带模型的回合 noteModel=true（确立会话模型）', summaries[0]?.turnUsage?.noteModel === true)
  check('1b. 同模型下一轮不重复标注', summaries[1]?.turnUsage?.noteModel === undefined && summaries[1]?.turnUsage?.model === 'glm-5.3')
  check('1c. 换模型的那轮重新标注', summaries[2]?.turnUsage?.noteModel === true && summaries[2]?.turnUsage?.model === 'glm-5.3-flash')
  check('1d. 账本数据照采（与渲染开关无关）', rig.state.turnUsage?.input === 13)
}

// ── 2/3/4. Render: gate, shape, alignment, model silence ─────────────────
const COLS = 100
const ROWS = 30
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private term: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _e: unknown, cb: () => void): void { this.term.write(String(chunk), cb) }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
function RawMode(): null {
  useInput((): void => {}, { isActive: true })
  return null
}
const summaryRow = (id: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: 'turn-summary',
  text: '',
  turnUsage: { input: 0, output: 196, cacheRead: 0, cacheWrite: 0, cacheKnown: false, retries: 0, durationMs: 13_000, model: 'glm-5.3', noteModel: true, outcome: 'completed', ...over },
})
const listNode = (rows: Array<Record<string, unknown>>, turnUsageRow: boolean): React.ReactNode =>
  React.createElement(MessageList, {
    rows,
    expanded: false,
    expandedRows: new Set<number>(),
    selectedId: null,
    onToggleRow: (): void => {},
    model: 'glm-5.3',
    showAll: true,
    onToggleAll(): void {},
    onLoadOlder(): void {},
    turnUsageRow,
  })

{
  const rows = [
    { id: 1, kind: 'assistant', text: '回答正文', streaming: false },
    summaryRow(2),
  ]
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const instance = await render(
    React.createElement((): React.ReactNode => React.createElement(React.Fragment, null, RawMode(), listNode(rows, false))),
    { stdout: new FakeStdout(term) as unknown as NodeJS.WriteStream, stdin: new Input() as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false },
  )
  await settled((): boolean => viewportLines(term, ROWS).some(line => line.includes('回答正文')))
  const offLines = viewportLines(term, ROWS)
  check('2. 默认关：零回合摘要行上屏', offLines.every(line => !line.includes('↑') || !line.includes('↓')))
  instance.rerender(
    React.createElement((): React.ReactNode => React.createElement(React.Fragment, null, RawMode(), listNode(rows, true))),
  )
  const onOk = await settled((): boolean => viewportLines(term, ROWS).some(line => line.includes('↓196')))
  const onLines = viewportLines(term, ROWS)
  const rowLine = onLines.find(line => line.includes('↓196'))
  if (process.env.DEBUG_ROW === '1' && rowLine !== undefined) console.log('ROWLINE len=' + rowLine.trimEnd().length + ' [' + rowLine + ']')
  check('3a. 开：摘要行出现', onOk && rowLine !== undefined)
  check('3b. 无「本轮」前缀', rowLine !== undefined && !rowLine.includes('本轮'))
  // Right-alignment evidence: the emblem's last painted cell sits near the
  // RIGHT margin (a left-aligned row would end ~25 cols in; the 2-cell
  // gutter alone cannot explain a line that stretches past col 90).
  check('3c. 右对齐（徽记贴右缘，不抢阅读流）', rowLine !== undefined && rowLine.trimEnd().length >= COLS - 6)
  check('3d. 首轮 noteModel=true 显示模型名', rowLine !== undefined && rowLine.includes('glm-5.3'))
  await instance.unmount()
  term.dispose()
}
{
  // Same-model repeat stays silent; numbers still render.
  const rows = [summaryRow(1, { noteModel: undefined, input: 5, output: 7, durationMs: 2000 })]
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const instance = await render(
    React.createElement((): React.ReactNode => React.createElement(React.Fragment, null, RawMode(), listNode(rows, true))),
    { stdout: new FakeStdout(term) as unknown as NodeJS.WriteStream, stdin: new Input() as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false },
  )
  const ok = await settled((): boolean => viewportLines(term, ROWS).some(line => line.includes('↓7')))
  const line = viewportLines(term, ROWS).find(l => l.includes('↓7'))
  check('4. 同模型重复轮不显示模型名', ok && line !== undefined && !line.includes('glm'))
  await instance.unmount()
  term.dispose()
}

// ── 5. Wiring tripwires ──────────────────────────────────────────────────
{
  const chatSrc = readFileSync(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8')
  check('5a. Chat 透传 turnUsageRow（防重构拆线）', chatSrc.includes('turnUsageRow={channel.turnUsageRow}'))
  const defsSrc = readFileSync(new URL('../src/settings/definitions.ts', import.meta.url), 'utf8')
  check('5b. 定义表默认关（hint 明示默认）', defsSrc.includes("'turnUsageRow':") && defsSrc.includes('Off by default'))
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
