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
 *
 * Run: node --import tsx/esm scripts/verify-smooth-reveal.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../src/ui.js'
import { MessageList } from '../src/components/MessageList.js'
import { AssistantThinkingMessage } from '../src/components/messages/AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from '../src/components/messages/AssistantToolUseMessage.js'
import type { ChatRow, ToolRow } from '../src/dsh-adapter/channel.js'
import {
  REVEAL_MIN_STEP,
  getRevealVersion,
  isRevealTimerRunning,
  revealLengthOf,
  revealLinesOf,
  revealListenerCountForTest,
  revealStep,
  resetRevealForTest,
} from '../src/components/smoothReveal.js'

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
/** Catch-up sleep budget: sized for the ~20fps reveal cadence (REVEAL_FRAME_MS
 *  50ms — a 2400-char burst needs ~48 ticks ≈ 2.4s) plus CI-load margin. */
const CATCHUP_SLEEP_MS = 3600

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
  await sleep(120)
  const mid = revealLengthOf('a1', grown, { enabled: true, active: true })
  check(mid > 0 && mid < grown.length, 'A2 partial reveal mid-flight', `len=${mid}/${grown.length}`)
  // Exponential decay over the backlog (~1/8 per frame) + MIN_STEP tail: a
  // 1200-char target needs ~2s to fully land at the ~20fps cadence.
  await sleep(CATCHUP_SLEEP_MS)
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
  await sleep(120)
  check(getRevealVersion() > before, 'A3 ticks bump the version store')
  await sleep(CATCHUP_SLEEP_MS)
  check(!isRevealTimerRunning(), 'A3 timer retires once every cursor caught up')
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
      await sleep(80)
      const early = screen()
      check(!early.includes('omega-end'), 'B1 streaming row: tail hidden early in the reveal')
      check(early.includes('alpha-start'), 'B1 streaming row: head visible early')
      await sleep(CATCHUP_SLEEP_MS)
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
      await sleep(80)
      check(!screen().includes('omega-end'), 'B2 settled-fresh row: tail hidden early (non-streaming becomes smooth)')
      await sleep(CATCHUP_SLEEP_MS)
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
      await sleep(80)
      check(screen().includes('omega-end'), 'B4 smoothStreaming=false: full text paints immediately')
    },
  )
}

// B5: transcript generations reuse row ids; a completed cursor from the old
// generation must not make the new fresh row skip its reveal.
{
  resetRevealForTest()
  const oldText = LONG_TEXT.replace('omega-end', 'old-generation-omega')
  const newText = LONG_TEXT.replace('omega-end', 'new-generation-omega')
  let rows: ChatRow[] = [
    { id: 7, kind: 'assistant', text: oldText, streaming: false, fresh: true },
  ]
  await withTerminal(
    () => <MessageList rows={rows} rowsGeneration={1} smoothStreaming {...listProps} />,
    async (screen, rerender) => {
      await sleep(CATCHUP_SLEEP_MS)
      check(screen().includes('old-generation-omega'), 'B5 old generation reveal completes')
      rows = [{ id: 7, kind: 'assistant', text: newText, streaming: false, fresh: true }]
      rerender(<MessageList rows={rows} rowsGeneration={2} smoothStreaming {...listProps} />)
      await sleep(80)
      check(!screen().includes('new-generation-omega'), 'B5 reused id in a new generation reveals again')
      await sleep(CATCHUP_SLEEP_MS)
      check(screen().includes('new-generation-omega'), 'B5 new generation reveal completes')
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
      <AssistantThinkingMessage thinking={slice} textFull={full} addMargin={false} verbose={false} preview streaming />
    ),
    async screen => {
      await sleep(120)
      const text = screen()
      check(text.includes('think line 11'), 'C1 preview ticker follows the ARRIVED text (not the reveal)')
    },
  )
  await withTerminal(
    () => (
      <AssistantThinkingMessage thinking={slice} textFull={full} addMargin={false} verbose streaming />
    ),
    async screen => {
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
    () => <AssistantToolUseMessage tool={runningTool} addMargin={false} verbose={false} smoothReveal fresh />,
    async (screen, rerender) => {
      // Mid-reveal must be SAMPLED, not slept past: CI tick cadence can
      // finish a short body inside one 160ms window, but the FIRST sample
      // where the head is visible always lands inside the reveal window on
      // any machine speed (the cursor starts at zero and the first tick
      // only lands ~50ms after mount).
      let early: string | null = null
      const c2Deadline = Date.now() + 3000
      while (Date.now() < c2Deadline && early === null) {
        const sample = screen()
        if (sample.includes('old line 0')) early = sample
        else await sleep(10)
      }
      check(early !== null, 'C2 running card: body head visible early', early ?? 'timeout')
      check(early !== null && !early.includes('lines (ctrl+o to expand)'), 'C2 running card: capped tail row hidden early in the reveal', early ?? 'timeout')
      await sleep(CATCHUP_SLEEP_MS)
      check(screen().includes('lines (ctrl+o to expand)'), 'C2 running card: body complete after catch-up')
      // C3: result arriving mid/after reveal snaps complete.
      rerender(<AssistantToolUseMessage tool={doneTool} addMargin={false} verbose={false} smoothReveal fresh />)
      await sleep(80)
      check(screen().includes('settled-result-marker'), 'C3 settled result paints complete (no reveal)')
      // A new transcript may reuse the same tool call id. Generation scope
      // prevents the completed cursor above from suppressing the new reveal.
      rerender(
        <AssistantToolUseMessage
          tool={{ ...runningTool, startedAt: Date.now() }}
          addMargin={false}
          verbose={false}
          smoothReveal
          fresh
          revealGeneration={2}
        />,
      )
      // Same sampling discipline as C2: the rerender recreates the cursor
      // at zero, so the first sample where the new body head is showing
      // (and the settled marker is gone) is inside the fresh reveal.
      let midRegen: string | null = null
      const c4Deadline = Date.now() + 3000
      while (Date.now() < c4Deadline && midRegen === null) {
        const sample = screen()
        if (sample.includes('old line 0') && !sample.includes('settled-result-marker')) midRegen = sample
        else await sleep(10)
      }
      check(midRegen !== null && !midRegen.includes('lines (ctrl+o to expand)'), 'C4 reused call id reveals in a new generation', midRegen ?? 'timeout')
      await sleep(CATCHUP_SLEEP_MS)
      check(screen().includes('lines (ctrl+o to expand)'), 'C4 new-generation tool reveal completes')
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
      await sleep(120)
      check(revealListenerCountForTest() === 1,
        'D1 MessageList owns the only production reveal subscription',
        `listeners=${revealListenerCountForTest()}`)
      check(screen().includes('old line 0'), 'D1 active tool remains visible with many history cards')
      await sleep(CATCHUP_SLEEP_MS)
      check(screen().includes('lines (ctrl+o to expand)'), 'D1 active tool reveal completes without nested store updates')
    },
  )
}

// E: inline (main-screen) scrollback is immutable — only the transcript TAIL
// may reveal there. A fresh row that stops being the tail mid-reveal must
// snap complete in the same commit: native scrollback cannot rewrite a
// partially revealed row, so a lingering cursor would permanently truncate
// it once it scrolls up (E1, the inline-truncation regression). A fresh row
// that is never the tail paints complete from its first frame (E2).
console.log('--- E: inline scrollback tail-only reveal ---')
{
  resetRevealForTest()
  const mk = (id: number, head: string, tail: string): ChatRow => ({
    id,
    kind: 'assistant',
    text: [head, 'body line one', 'body line two', 'body line three', tail].join('\n'),
    streaming: false,
    fresh: true,
  })
  const rows: ChatRow[] = [
    mk(1, 'inline-head-early', 'inline-tail-early'),
    mk(2, 'inline-head-late', 'inline-tail-late'),
  ]
  await withTerminal(
    () => <MessageList rows={rows} smoothStreaming historyPaintEnabled rowsGeneration={1} {...listProps} />,
    async (screen, rerender) => {
      await sleep(80)
      const early = screen()
      check(early.includes('inline-tail-early'), 'E2 non-tail fresh row paints complete immediately (inline tail-only)')
      check(!early.includes('inline-tail-late'), 'E1 tail row reveals gradually')
      rows.push({ id: 3, kind: 'user', text: 'follow-up question' })
      rerender(<MessageList rows={rows} smoothStreaming historyPaintEnabled rowsGeneration={1} {...listProps} />)
      await sleep(120)
      check(screen().includes('inline-tail-late'), 'E1 mid-reveal row snaps complete when it stops being the tail')
    },
  )
}

console.log('')
if (failures > 0) {
  console.error(`verify-smooth-reveal: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('verify-smooth-reveal: all checks passed')
