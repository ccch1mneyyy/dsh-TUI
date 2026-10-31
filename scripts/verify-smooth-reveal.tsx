/**
 * Smooth streaming reveal regression (settings `dsh-tui.smoothStreaming`).
 *
 * Group A — scheduler/cursor units (no rendering):
 *   step math, cursor creation (active gate), append vs replacement,
 *   catch-up timing, timer refcount, line-count semantics.
 * Group B — MessageList integration (headless xterm):
 *   a live streaming row reveals gradually; a freshly SETTLED row (one-shot
 *   non-streaming delivery) reveals too; replayed rows and disabled mode
 *   paint complete immediately.
 * Group C — component contracts:
 *   thinking preview ticker follows the ARRIVED text while the expanded body
 *   paints the revealed slice; a running tool card's diff body reveals line
 *   by line; the settled result view snaps complete.
 * Group D — long-session subscriber fanout:
 *   with 80 settled history cards, only the active card advances the reveal
 *   scheduler; settled cards do not each force a store rerender.
 * Group E — completed reveals survive remounts and session boundaries:
 *   a finished row does not re-reveal after thousands of later reveals, a
 *   session reset drops cross-session keys, and the Chat wiring that calls
 *   the reset exists in both the agent-id effect and the `/clear` branch.
 * Group F — replayed history is never marked fresh:
 *   a real projector replay (cold resume and replay-over-painted-rows) leaves
 *   no row claiming `fresh`, so the transcript never typewrites history.
 *
 * Run: node --import tsx/esm scripts/verify-smooth-reveal.tsx
 */
// 注意：静态 import 会提升执行，下面这行 env pin 对本脚本的 i18n 解析
// 其实无效（i18n.js 在赋值前就已按启动链解析 activeLang；本脚本断言的
// en 文案此前全靠「折叠提示硬编码英文」蒙混过关，issue #980 修复后暴露）。
// 权威 pin 是 body 首句的 setLang('en')；此行保留给动态 import 的消费方。
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

import { Writable, PassThrough } from 'node:stream'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import React from 'react'
import { render } from '../src/ui.js'
import { setLang } from '../src/i18n.js'
import { MessageList } from '../src/components/MessageList.js'
import { AssistantThinkingMessage } from '../src/components/messages/AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from '../src/components/messages/AssistantToolUseMessage.js'
import type { ChatRow, ToolRow } from '../src/dsh-adapter/channel.js'
import { createDshTranslator } from '../src/dsh-adapter/backend/translate.js'
import { createChannelReadView } from '../src/adapter/channel/read-view.js'
import { settled } from './lib/term-test.mjs'
import { createProjectorHarness } from './lib/projector-harness.js'
import {
  REVEAL_MIN_STEP,
  getRevealVersion,
  isRevealTimerRunning,
  revealLengthOf,
  revealLinesOf,
  revealStep,
  resetRevealForTest,
  resetRevealSession,
} from '../src/components/smoothReveal.js'

// env pin 因 import 提升而失效（见上），显式切换到 en——本脚本的断言
// 全部针对英文文案。
setLang('en')

const { Terminal: XTerm } = (await import('@xterm/headless')) as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.error(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Group A — scheduler/cursor units
// ---------------------------------------------------------------------------
console.log('--- A: scheduler/cursor units ---')
resetRevealForTest()
check(revealStep(0) === REVEAL_MIN_STEP, 'A1 revealStep floors at MIN_STEP')
check(revealStep(100) === 13, 'A1 revealStep(100) = ceil(100/8) = 13', `got ${revealStep(100)}`)
check(revealStep(24) === 3, 'A1 revealStep(24) = 3')
check(revealStep(25) === 4, 'A1 revealStep(25) = 4')

{
  const text = 'a'.repeat(1000)
  check(revealLengthOf('a1', text, { enabled: true, active: true }) === 0, 'A2 active first read starts at zero')
  const grown = text + 'b'.repeat(200)
  check(
    revealLengthOf('a1', grown, { enabled: true, active: true }) === 0,
    'A2 monotonic append keeps the cursor',
  )
  // 固定窗:墙钟 采样 reveal 动画中途（每帧消化 ~1/8 backlog）：轮询会一路
  // 推进游标直到揭完，测不到 mid-flight
  await sleep(120)
  const mid = revealLengthOf('a1', grown, { enabled: true, active: true })
  check(mid > 0 && mid < grown.length, 'A2 partial reveal mid-flight', `len=${mid}/${grown.length}`)
  // 固定窗:墙钟 exponential decay over the backlog (~1/8 per frame) +
  // MIN_STEP tail: a 1200-char target needs ~1.3s to fully land.
  await sleep(2200)
  check(
    revealLengthOf('a1', grown, { enabled: true, active: true }) === grown.length,
    'A2 catch-up completes (exponential decay + MIN_STEP tail)',
  )
  check(
    revealLengthOf('a1', 'completely different', { enabled: true, active: true }) === 'completely different'.length,
    'A2 non-prefix replacement snaps',
  )
  check(
    revealLengthOf('a2', text, { enabled: true, active: false }) === text.length,
    'A2 inactive first read never creates a cursor',
  )
  check(
    revealLengthOf('a3', text, { enabled: false, active: true }) === text.length,
    'A2 disabled switch returns full text',
  )
}

{
  resetRevealForTest()
  const text = 'z'.repeat(2000)
  const before = getRevealVersion()
  revealLengthOf('a4', text, { enabled: true, active: true })
  check(isRevealTimerRunning(), 'A3 cursor creation starts the shared timer')
  check(await settled(() => getRevealVersion() > before), 'A3 ticks bump the version store')
  check(await settled(() => !isRevealTimerRunning(), { timeoutMs: 6000 }),
    'A3 timer retires once every cursor caught up')
}

{
  resetRevealForTest()
  check(revealLinesOf('c1', 2, { enabled: true, active: true }) === 2, 'A4 tiny totals skip animation')
  check(revealLinesOf('c2', 30, { enabled: true, active: true }) === 0, 'A4 line cursor starts at zero')
  check(revealLinesOf('c2', 42, { enabled: true, active: true }) === 0, 'A4 growing totals keep the cursor')
  check(revealLinesOf('c2', 10, { enabled: true, active: true }) === 10, 'A4 shrinking totals snap')
}

// ---------------------------------------------------------------------------
// Terminal harness for the render groups
// ---------------------------------------------------------------------------
const COLS = 60
const ROWS = 24
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private term: XTerm.Terminal) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.term.write(String(chunk), callback)
  }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
async function withTerminal(
  make: () => React.ReactNode,
  run: (screen: () => string, rerender: (node: React.ReactNode) => void) => Promise<void>,
): Promise<void> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term) as unknown as NodeJS.WriteStream
  const instance = await render(make(), {
    stdout,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const screen = (): string =>
    Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  try {
    await run(screen, node => instance.rerender(node))
  } finally {
    await instance.unmount()
    term.dispose()
  }
}

const LONG_TEXT = [
  'alpha-start of the streamed reply',
  ...Array.from({ length: 30 }, (_, i) => `body paragraph ${i} with some words to wrap around the terminal width`),
  'omega-end of the streamed reply',
].join('\n\n')

const listProps = {
  expanded: false,
  expandedRows: new Set<number>(),
  selectedId: null as number | null,
  onToggleRow: (_rowId: number) => {},
  model: 'deepseek-chat',
  showAll: true,
  onToggleAll: () => {},
}

// ---------------------------------------------------------------------------
// Group B — MessageList integration
// ---------------------------------------------------------------------------
console.log('--- B: MessageList integration ---')

// B1: live streaming row reveals gradually.
{
  resetRevealForTest()
  const rows: ChatRow[] = [
    { id: 1, kind: 'user', text: 'question' },
    { id: 2, kind: 'assistant', text: LONG_TEXT, streaming: true, fresh: true },
  ]
  await withTerminal(
    () => <MessageList rows={rows} smoothStreaming {...listProps} />,
    async screen => {
      // 固定窗:墙钟 采样 reveal 动画早期（80ms 内尾巴还没揭到）
      await sleep(80)
      const early = screen()
      check(!early.includes('omega-end'), 'B1 streaming row: tail hidden early in the reveal')
      check(early.includes('alpha-start'), 'B1 streaming row: head visible early')
      await sleep(2600) // 固定窗:墙钟 等 reveal 动画把整段追平（指数衰减 + MIN_STEP 尾巴）
      check(screen().includes('omega-end'), 'B1 streaming row: tail visible after catch-up')
    },
  )
}

// B2: freshly SETTLED row (one-shot non-streaming delivery) still reveals.
{
  resetRevealForTest()
  const rows: ChatRow[] = [
    { id: 3, kind: 'assistant', text: LONG_TEXT, streaming: false, fresh: true },
  ]
  await withTerminal(
    () => <MessageList rows={rows} smoothStreaming {...listProps} />,
    async screen => {
      // 固定窗:墙钟 采样 reveal 动画早期（80ms 内尾巴还没揭到）
      await sleep(80)
      check(!screen().includes('omega-end'), 'B2 settled-fresh row: tail hidden early (non-streaming becomes smooth)')
      await sleep(2600) // 固定窗:墙钟 等 reveal 动画把整段追平
      check(screen().includes('omega-end'), 'B2 settled-fresh row: complete after catch-up')
    },
  )
}

// B3: replayed rows (no fresh flag) paint complete immediately.
{
  resetRevealForTest()
  const rows: ChatRow[] = [
    { id: 4, kind: 'assistant', text: LONG_TEXT, streaming: false },
  ]
  await withTerminal(
    () => <MessageList rows={rows} smoothStreaming {...listProps} />,
    async screen => {
      // 固定窗:探针 重放行不得逐字揭示：settled 会一直等到揭完也判过，
      // 遮蔽「开屏打字机」这个 bug；只能给一个短窗后断言已经完整
      await sleep(80)
      check(screen().includes('omega-end'), 'B3 replayed row: paints complete (no typewriting on open)')
    },
  )
}

// B4: disabled switch paints everything immediately.
{
  resetRevealForTest()
  const rows: ChatRow[] = [
    { id: 5, kind: 'assistant', text: LONG_TEXT, streaming: true, fresh: true },
  ]
  await withTerminal(
    () => <MessageList rows={rows} {...listProps} />,
    async screen => {
      // 固定窗:探针 关掉开关后不得有任何揭示动画：settled 等到揭完也判过，
      // 遮蔽 bug；只能给一个短窗后断言已经完整
      await sleep(80)
      check(screen().includes('omega-end'), 'B4 smoothStreaming=false: full text paints immediately')
    },
  )
}

// ---------------------------------------------------------------------------
// Group C — component contracts
// ---------------------------------------------------------------------------
console.log('--- C: component contracts ---')

// C1: thinking ticker follows ARRIVED text; expanded body paints the slice.
{
  resetRevealForTest()
  const full = Array.from({ length: 12 }, (_, i) => `think line ${i}`).join('\n')
  const slice = full.slice(0, 40)
  await withTerminal(
    () => (
      <AssistantThinkingMessage thinking={slice} textFull={full} marginTopOnTurn={false} verbose={false} preview streaming />
    ),
    async screen => {
      // 固定窗:探针 预览 ticker 不得被揭示节流：settled 等到揭完也判过，
      // 遮蔽「ticker 跟着 reveal 走」这个 bug
      await sleep(120)
      const text = screen()
      check(text.includes('think line 11'), 'C1 preview ticker follows the ARRIVED text (not the reveal)')
    },
  )
  await withTerminal(
    () => (
      <AssistantThinkingMessage thinking={slice} textFull={full} marginTopOnTurn={false} verbose streaming />
    ),
    async screen => {
      // 固定窗:探针 展开体不得越过已揭示切片（断言 think line 11 不出现）
      await sleep(120)
      const text = screen()
      check(!text.includes('think line 11'), 'C1 expanded body paints only the revealed slice')
      check(text.includes('think line 0'), 'C1 expanded body shows the slice head')
    },
  )
}

// C2/C3: tool card body reveal + result snap.
{
  resetRevealForTest()
  // 12 hunk lines → the diff-card cap folds to 8 + one "+N lines" hint = 9
  // rendered rows; the hint is the LAST rendered row, so its absence early
  // and presence late brackets the whole line reveal.
  const diffs = [
    {
      path: '/src/example.ts',
      oldText: Array.from({ length: 6 }, (_, i) => `old line ${i}`).join('\n'),
      newText: Array.from({ length: 6 }, (_, i) => `new line ${i}`).join('\n'),
    },
  ]
  const runningTool: ToolRow = {
    callId: 'call-1',
    name: 'edit',
    argsText: '{}',
    argsFull: '{}',
    status: 'running',
    callView: { card: 'diff', title: 'Edit /src/example.ts', diffs },
    startedAt: Date.now(),
  }
  const doneTool: ToolRow = {
    ...runningTool,
    status: 'done',
    resultView: { card: 'generic', title: 'Edited', content: [{ type: 'text', text: 'settled-result-marker' }] },
  }
  await withTerminal(
    () => <AssistantToolUseMessage tool={runningTool} marginTopOnTurn={false} verbose={false} smoothReveal fresh />,
    async (screen, rerender) => {
      // 固定窗:墙钟 采样逐行揭示的动画早期（60ms 内还没揭到被折叠的尾行）
      await sleep(60)
      const early = screen()
      check(early.includes('old line 0'), 'C2 running card: body head visible early', early)
      check(!early.includes('lines (ctrl+o to expand)'), 'C2 running card: capped tail row hidden early in the reveal', early)
      await sleep(2200) // 固定窗:墙钟 等逐行揭示动画把整张卡片追平
      check(screen().includes('lines (ctrl+o to expand)'), 'C2 running card: body complete after catch-up')
      // C3: result arriving mid/after reveal snaps complete.
      rerender(<AssistantToolUseMessage tool={doneTool} marginTopOnTurn={false} verbose={false} smoothReveal fresh />)
      // 固定窗:探针 结果视图不得走揭示动画：settled 等到揭完也判过，遮蔽 bug
      await sleep(80)
      check(screen().includes('settled-result-marker'), 'C3 settled result paints complete (no reveal)')
    },
  )
}

// D: long-session tool-card fanout — only MessageList may subscribe to the
// reveal store in the production path. A single active card is enough to
// advance the scheduler; settled cards must not each force a store rerender.
console.log('--- D: long-session reveal subscriber fanout ---')
{
  resetRevealForTest()
  const historyTools: ChatRow[] = Array.from({ length: 80 }, (_, i) => ({
    id: 1000 + i,
    kind: 'tool' as const,
    text: '',
    fresh: false,
    tool: {
      callId: `history-${i}`,
      name: 'edit',
      argsText: '{}',
      argsFull: '{}',
      status: 'done' as const,
      resultView: { card: 'generic' as const, title: 'Edited', content: [{ type: 'text' as const, text: 'done' }] },
      startedAt: Date.now() - 1000,
      durationMs: 1000,
    },
  }))
  const activeTool: ChatRow = {
    id: 2000,
    kind: 'tool',
    text: '',
    fresh: true,
    tool: {
      callId: 'active-long-session',
      name: 'edit',
      argsText: '{}',
      argsFull: '{}',
      status: 'running',
      callView: {
        card: 'diff',
        title: 'Edit /src/active.ts',
        diffs: [{
          path: '/src/active.ts',
          oldText: Array.from({ length: 8 }, (_, i) => `old line ${i}`).join('\n'),
          newText: Array.from({ length: 8 }, (_, i) => `new line ${i}`).join('\n'),
        }],
      },
      startedAt: Date.now(),
    },
  }
  await withTerminal(
    () => <MessageList rows={[...historyTools, activeTool]} smoothStreaming {...listProps} />,
    async screen => {
      await sleep(120) // 固定窗:墙钟 采样揭示动画早期（活动卡头部已出现）
      check(screen().includes('old line 0'), 'D1 active tool remains visible with many history cards')
      await sleep(2200) // 固定窗:墙钟 等揭示动画把活动卡追平
      check(screen().includes('lines (ctrl+o to expand)'), 'D1 active tool reveal completes without nested store updates')
    },
  )
}

// E: a completed reveal must outlive the row's mount. `fresh` is set when a
// live turn settles and never cleared, so a remounted history row (leaving a
// whole screen remounts the transcript tree; /resume repaints its history)
// still reads with active=true. If the completed memory is capped and evicted,
// that row typewrites itself again from the first character — the long-session
// re-reveal report (#1787). Row ids also restart at 0 across a session switch,
// so the memory must be dropped at that boundary and nowhere else.
console.log('--- E: completed reveals survive remounts ---')
{
  resetRevealForTest()
  const text = 'history row text'
  check(revealLengthOf('a1', text, { enabled: true, active: true }) === 0, 'E1 first live read starts at zero')
  await sleep(600) // 固定窗:墙钟 16 字符、步长 3 → 六帧内追平（600ms ≈ 18 帧）
  check(
    revealLengthOf('a1', text, { enabled: true, active: true }) === text.length,
    'E1 row catches up',
  )
  // A long session blows far past the old 2048-key cap; every one of these
  // settles on the next tick, which used to evict the oldest half.
  for (let i = 0; i < 2600; i++) revealLengthOf(`long${i}`, 'q', { enabled: true, active: true })
  await sleep(500) // 固定窗:墙钟 单字符游标一拍追平
  const afterChurn = revealLengthOf('a1', text, { enabled: true, active: true })
  check(
    afterChurn === text.length,
    'E1 completed row stays complete after thousands of later reveals (no replay on remount)',
    `len=${afterChurn}/${text.length}`,
  )
  // Session boundary: the same key names different content after an adopt.
  resetRevealSession()
  check(
    revealLengthOf('a1', text, { enabled: true, active: true }) === 0,
    'E2 session reset drops cross-session keys (new live row animates)',
  )
  // E1/E2 pin the primitive; neither fails if Chat stops calling the reset,
  // which is exactly how the cross-session leak would return silently. Walk
  // the real source's syntax tree for the call sites: a text regex would also
  // match the name inside the comments that sit between the two calls, and
  // a proximity window would go red the next time that comment is reworded
  // (verify-terminal-size-source walks the AST for the same reason).
  const chatSource = await readFile(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8')
  const chatAst = ts.createSourceFile('Chat.tsx', chatSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  // Count alone would pass with both calls inside one branch, so record the
  // enclosing construct. "Inside some effect" is still too weak: the reset has
  // to run in the effect that watches the agent id, and a check that only sees
  // an effect ancestor would stay green if the call drifted into any other
  // one. Keep the nearest effect's text and require the agent-id read in it.
  const resetSites: Array<{ effectText: string | undefined; inClear: boolean }> = []
  const scanResets = (node: ts.Node, effectText: string | undefined, inClear: boolean): void => {
    const effectName = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined
    const nextEffectText = effectName === 'useEffect' || effectName === 'useLayoutEffect'
      ? node.getText(chatAst)
      : effectText
    const nextInClear = inClear
      || (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'clear')
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'resetRevealSession') {
      resetSites.push({ effectText: nextEffectText, inClear: nextInClear })
    }
    ts.forEachChild(node, child => scanResets(child, nextEffectText, nextInClear))
  }
  scanResets(chatAst, undefined, false)
  check(
    resetSites.some(site => site.effectText?.includes('channel.agentId') === true),
    'E3a Chat resets reveal state in the effect that watches channel.agentId',
  )
  check(resetSites.some(site => site.inClear), 'E3b Chat resets reveal state in the /clear branch')
  check(
    resetSites.some(site => site.effectText?.includes('lastRevealGenerationRef') === true),
    'E3c Chat resets reveal state when the binding is replaced (re-resume)',
  )
  resetRevealForTest()
}

// F: `fresh` is a live-only claim (channel-view.ts). A replay batch — resume,
// rebind, a reattaching client — folds the session's own durable deltas
// through the same row factory a live turn uses, so an unguarded `fresh: true`
// there made every replayed row claim it had just arrived and the transcript
// typewrote its history on the first frame of a resume (#1787). Row ids stay
// stable across a replay, so the reuse path has to strip the flag too.
console.log('--- F: replayed history is never marked fresh ---')
{
  // Same boundary cast the golden pipeline uses (projection-golden.ts:129).
  const logText = await readFile(new URL('./fixtures/dsh/v3-turns.jsonl', import.meta.url), 'utf8')
  const log = logText.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown) as Parameters<ReturnType<typeof createDshTranslator>['translateReplay']>[0]
  const translator = createDshTranslator({ tools: () => undefined, scope: () => ({}), attachments: () => undefined })
  const live = createProjectorHarness({ agentPreset: 'ptc' })
  for (const event of log) live.apply(translator.translateEvent(event), false)
  live.projector.settleStreaming()
  const liveFresh = live.state.rows.filter(row => row.kind === 'assistant' && row.fresh === true).map(row => row.id)
  check(liveFresh.length > 0, 'F1 live assistant rows keep the fresh flag (live text still reveals)', `ids=${liveFresh.join(',')}`)

  live.apply(translator.translateReplay(log), true)
  live.projector.settleStreaming()
  const reusedStale = live.state.rows.filter(row => row.fresh === true).map(row => row.id)
  check(
    reusedStale.length === 0,
    'F2 replay over painted rows clears fresh (rebind repaints instead of re-types)',
    `ids=${reusedStale.join(',')}`,
  )

  const cold = createProjectorHarness({ agentPreset: 'ptc' })
  cold.apply(translator.translateReplay(log), true)
  cold.projector.settleStreaming()
  const coldStale = cold.state.rows.filter(row => row.fresh === true).map(row => row.id)
  check(
    cold.state.rows.length > 0 && coldStale.length === 0,
    'F3 a cold replay paints history without fresh (resume first frame)',
    `rows=${cold.state.rows.length} ids=${coldStale.join(',')}`,
  )
  const assistants = (h: typeof cold): number => h.state.rows.filter(row => row.kind === 'assistant').length
  check(assistants(live) === assistants(cold), 'F4 replay reuses painted assistant rows instead of duplicating them', `${assistants(live)} vs ${assistants(cold)}`)

  // F6: everything above reads the projector's mutable `state.rows`. The UI
  // sees frozen snapshots through the read view, which reuses the previous
  // array and row copies when their revisions did not move — so dropping
  // `fresh` without marking both would leave panels typewriting history while
  // every assertion above stays green.
  const viewer = createChannelReadView(() => {})
  const repaint = createProjectorHarness({ agentPreset: 'ptc' })
  for (const event of log) repaint.apply(translator.translateEvent(event), false)
  repaint.projector.settleStreaming()
  const before = viewer(repaint.state.rows, 1) as readonly ChatRow[]
  const beforeFresh = before.filter(row => row.fresh === true).length
  check(beforeFresh > 0, 'F6 the read view serves live rows with fresh', `fresh=${beforeFresh}`)
  repaint.apply(translator.translateReplay(log), true)
  repaint.projector.settleStreaming()
  const after = viewer(repaint.state.rows, 2) as readonly ChatRow[]
  const afterFresh = after.filter(row => row.fresh === true).length
  check(afterFresh === 0, 'F6 a snapshot taken after the replay no longer claims fresh', `fresh=${afterFresh}`)
}

// F5: a replayed row that a live turn continues must resume where the
// painted text ended. History paints full through the inactive branch, which
// used to leave no cursor behind; the live continuation then created one at
// zero and typewrote the already-visible row from its first character.
resetRevealForTest()
{
  const painted = 'replayed answer already on screen'
  check(
    revealLengthOf('a9', painted, { enabled: true, active: false }) === painted.length,
    'F5 a replayed row paints full',
  )
  const grown = `${painted} and a live tail`
  const resumed = revealLengthOf('a9', grown, { enabled: true, active: true })
  check(
    resumed >= painted.length,
    'F5 a live continuation resumes from the painted length instead of restarting',
    `len=${resumed}/${grown.length}`,
  )
  resetRevealForTest()
}

console.log('')
if (failures > 0) {
  console.error(`verify-smooth-reveal: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('verify-smooth-reveal: all checks passed')
