/**
 * Long transcript jumps: real ScrollBox + MessageList + gutter + stdin.
 * Cold and cached destinations must paint without a rescue wheel event;
 * Enter must mount only the tail, not the entire path to the bottom.
 * Work is bounded by mounted-row counts, not machine-dependent timings.
 * Run: node --import tsx/esm scripts/verify-scroll-jumps.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

import type { ChatRow } from '../src/dsh-adapter/channel.js'
import type { DOMElement } from '../src/ink/dom.js'
import type { ScrollBoxHandle } from '../src/ui.js'
import type { ReactNode } from 'react'
import assert from 'node:assert/strict'

const [React, { PassThrough, Writable }, { Terminal }, ui, { MessageList }, { ScrollbarGutter }, termTest] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'),
  import('../src/ui.js'), import('../src/components/MessageList.js'),
  import('../src/components/ScrollbarGutter.js'), import('./lib/term-test.mjs'),
])
const { Box, Text, ScrollBox, AlternateScreen, render, useInput, useTerminalSize } = ui
const { settled, sleep, viewportLines } = termTest
const columns = Number(process.env.DSH_TEST_COLUMNS ?? 100)
const height = 36
const term = new Terminal({ cols: columns, rows: height, allowProposedApi: true })
const frames: string[][] = []
class Stdout extends Writable {
  columns = columns
  rows = height
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    term.write(String(chunk), () => { frames.push(viewportLines(term)); callback() })
  }
}
class Stdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
const stdout = new Stdout()
const stdin = new Stdin()
const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
const rows: ChatRow[] = []
for (let turn = 0; turn < 200; turn++) {
  rows.push({ id: rows.length, kind: 'user', text: `USER ${turn}` })
  rows.push({ id: rows.length, kind: 'assistant', text: Array.from({ length: 12 }, (_, i) => `ANSWER ${turn} line ${i} 中文 e\u0301`).join('\n') })
  rows.push({ id: rows.length, kind: 'tool', text: '', tool: {
    callId: `call-${turn}`, name: 'Bash', argsText: 'echo result', status: 'ok',
    resultText: `RESULT ${turn}`, startedAt: 0, durationMs: 1,
  } })
}
let handle: ScrollBoxHandle | null = null
const mounted = new Map<number, DOMElement>()
let maxMounted = 0
const registerRowRef = (id: number, el: DOMElement | null): void => {
  if (el) mounted.set(id, el)
  else mounted.delete(id)
  maxMounted = Math.max(maxMounted, mounted.size)
}
const noop = (): void => {}
const expandedRows = new Set<number>()
function Harness(): ReactNode {
  const { columns: terminalWidth } = useTerminalSize()
  const [scroll, setScroll] = React.useState<ScrollBoxHandle | null>(null)
  const [, setTimeline] = React.useState<unknown>(null)
  handle = scroll
  useInput((_input, key) => { if (key.return) scroll?.scrollToBottom() })
  return <Box height={height} flexDirection="column">
    <Box height={height - 1} flexDirection="row">
      <ScrollBox ref={setScroll} flexGrow={1} flexShrink={1} flexDirection="column" stickyScroll>
        <MessageList rows={rows} expanded={false} expandedRows={expandedRows}
          selectedId={null} onToggleRow={noop} model="test" showAll onToggleAll={noop}
          historyPaintEnabled={false} scrollHandle={scroll} registerRowRef={registerRowRef} onTimeline={setTimeline} />
      </ScrollBox>
      <ScrollbarGutter handle={scroll} terminalWidth={terminalWidth} />
    </Box>
    <Text>COMPOSER</Text>
  </Box>
}
const instance = await render(<AlternateScreen><Harness /></AlternateScreen>, {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: stdin as unknown as NodeJS.ReadStream,
  stderr: stderr as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false, patchConsole: false,
})
const screen = (): string => viewportLines(term).join('\n')
const body = (): string => {
  const buffer = term.buffer.active
  return Array.from({ length: height - 1 }, (_, y) =>
    buffer.getLine(buffer.baseY + y)?.translateToString(true, 0, columns - 2) ?? '',
  ).join('\n')
}
try {
  assert.ok(await settled(() => screen().includes('RESULT 199') && screen().includes('██')), 'tail and clickable gutter ready')
  const scroll = handle as ScrollBoxHandle | null
  assert.ok(scroll)
  scroll.scrollTo(0)
  assert.ok(await settled(() => screen().includes('USER 0') && screen().includes('RESULT 0')), 'warm the head before jumping')

  // First visits change estimated heights. Check the rendered body, not just
  // user text (Chat's pinned prompt can survive an entirely blank transcript).
  for (const row of [9, 25, 4, 18]) {
    const oldTop = scroll.getScrollTop()
    const oldBody = body()
    stdin.write(`\x1b[<0;${columns};${row}M\x1b[<0;${columns};${row}m`)
    assert.ok(await settled(() => scroll.getScrollTop() !== oldTop && body() !== oldBody &&
      screen().includes('ANSWER') && screen().includes('RESULT')), `gutter row ${row} paints assistant and tool content`)
  }

  const warmRow = [...mounted].find(([id, el]) => rows[id]!.kind === 'assistant' &&
    el.yogaNode!.getComputedTop() >= scroll.getScrollTop())
  assert.ok(warmRow, 'a measured assistant row is available for a warm seek')
  const [warmId, warmEl] = warmRow
  const warmTop = warmEl.yogaNode!.getComputedTop()
  const warmMarker = `ANSWER ${Math.floor(warmId / 3)} line 0`
  for (let repeat = 0; repeat < 2; repeat++) {
    scroll.scrollTo(0)
    assert.ok(await settled(() => screen().includes('USER 0') && screen().includes('RESULT 0')), 'return to cached head')
    scroll.scrollTo(warmTop)
    assert.ok(await settled(() => screen().includes(warmMarker) && screen().includes('RESULT')), 'cached seek paints without a measurement tick or wheel')
  }

  // Clamp publication is itself paint state, even with no React/scroll
  // mutation. It must invalidate a clean ScrollBox and never notify its
  // React subscribers (which would form a window/paint feedback loop).
  let notifications = 0
  const unsubscribe = scroll.subscribe(() => { notifications++ })
  const clampedTop = warmTop + 4
  scroll.setClampBounds(clampedTop, clampedTop)
  assert.ok(await settled(() => viewportLines(term)[0]?.includes(`ANSWER ${Math.floor(warmId / 3)} line 3`) === true), 'changed clamp repaints clean content')
  const writes = frames.length
  scroll.setClampBounds(clampedTop, clampedTop)
  await sleep(80) // 固定窗:探针 相同边界不得重绘或通知，不能轮询已经成立的零增量
  assert.equal(frames.length, writes, 'unchanged bounds do not schedule paint')
  assert.equal(notifications, 0, 'clamp updates do not notify React subscribers')
  unsubscribe()

  scroll.scrollTo(0)
  assert.ok(await settled(() => screen().includes('USER 0') && screen().includes('RESULT 0')), 'far-jump baseline at head')
  maxMounted = mounted.size
  const from = frames.length
  const start = performance.now()
  stdin.write('\r')
  assert.ok(await settled(() => screen().includes('RESULT 199') && scroll.isSticky()), 'Enter reaches the actual bottom')
  const latency = Math.round(performance.now() - start)
  await sleep(80) // 固定窗:探针 已落底的终态不得被延迟测量或绘制清成空白
  assert.ok(screen().includes('RESULT 199') && scroll.isSticky(), 'idle tail remains painted')
  assert.equal(scroll.getPendingDelta(), 0, 'Enter cancels wheel debt instead of animating the whole distance')
  assert.ok(maxMounted <= 40, `far jump keeps a viewport-sized mount window, got ${maxMounted} of ${rows.length} rows`)
  assert.ok(frames.slice(from).every(frame => frame.slice(0, height - 1).some(line => /ANSWER|RESULT/.test(line))), 'no blank body frames during the jump')
  console.log(`PASS: scroll jumps (${columns} columns, ${rows.length} rows; Enter ${latency} ms, peak ${maxMounted} mounted rows)`)

  scroll.scrollTo(0)
  assert.ok(await settled(() => screen().includes('RESULT 0')), 'head before an unmeasured tail arrives')
  rows.push({ id: rows.length, kind: 'assistant', text: `${'NEW ANSWER\n'.repeat(60)}COLD TAIL` })
  maxMounted = mounted.size
  scroll.scrollBy(120)
  scroll.scrollToBottom()
  assert.equal(scroll.getPendingDelta(), 0, 'jump replaces an in-flight wheel burst')
  assert.ok(await settled(() => screen().includes('COLD TAIL') && scroll.isSticky()), 'new tail height settles at the real bottom')
  assert.ok(maxMounted <= 40, 'cold-tail measurement keeps virtualization bounded')
  scroll.scrollBy(-10)
  assert.ok(await settled(() => !scroll.isSticky() && !screen().includes('COLD TAIL')), 'wheel-up can break sticky after a jump')
  scroll.scrollToBottom()
  assert.ok(await settled(() => scroll.isSticky() && screen().includes('COLD TAIL')), 'can jump back after wheel-up')
  console.log('PASS: cold tail, pending-wheel cancellation and sticky recovery')

  // Width changes discard cached row heights. A manual position can then
  // exceed the entire estimated list; it must not unmount every row and
  // collapse scrollHeight to the viewport (which also hides the gutter).
  scroll.scrollBy(-10)
  assert.ok(await settled(() => !scroll.isSticky() && !screen().includes('COLD TAIL')), 'manual position before resize')
  for (const width of [59, columns]) {
    const before = frames.length
    stdout.columns = width
    term.resize(width, height)
    stdout.emit('resize')
    assert.ok(await settled(() => frames.length > before && mounted.size > 0 && screen().includes('ANSWER')), `resize to ${width} never leaves an empty virtual window`)
  }
  assert.ok(await settled(() => screen().includes('██')), 'gutter returns after narrow-to-wide resize')
  console.log('PASS: nonempty virtual window and gutter restoration across resize')
} finally {
  await instance.unmount()
  term.dispose()
}
