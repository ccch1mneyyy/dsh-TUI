/**
 * Scroll anchoring must return remeasured estimates without moving the reader.
 * Mixed Ctrl+O remeasures an unchanged offscreen prompt after a real fold;
 * near-bottom growth must not restore sticky against an obsolete maximum.
 * A header owning Home is not a message anchor, and large prefix growth must
 * not leave the paint clipped by the old virtual-window maximum.
 *
 * Expected positions use observed Yoga height changes, with every parsed
 * xterm write checked against the original body line. No implementation
 * offset helper or geometry trace calculates the expected values.
 * Run: node --import tsx/esm scripts/verify-scroll-anchor-remeasurement.tsx
 * Imports src/; DSH_TEST_COLUMNS=60 also exercises a narrow terminal.
 */
process.env.NODE_ENV = 'production'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

import assert from 'node:assert/strict'
import type { ReactNode } from 'react'
import type { ChatRow } from '../src/dsh-adapter/channel.js'
import type { DOMElement } from '../src/ink/dom.js'
import type { TimelineSnapshot } from '../src/ink/timeline-rail.js'
import type { ScrollBoxHandle } from '../src/ui.js'

const [React, { PassThrough, Writable }, { Terminal }, ui, { MessageList }, { settled, viewportLines }] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'),
  import('../src/ui.js'), import('../src/components/MessageList.js'),
  import('./lib/term-test.mjs'),
])
const { Box, Text, ScrollBox, AlternateScreen, render, useInput } = ui
const COLUMNS = Number(process.env.DSH_TEST_COLUMNS ?? 100), ROWS = 25
class Stdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
const noop = (): void => {}
const expandedRows = new Set<number>()

async function createHarness(rows: readonly ChatRow[], initiallyExpanded: boolean, headerHeights?: readonly [number, number]) {
  const term = new Terminal({ cols: COLUMNS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const mounted = new Map<number, DOMElement>()
  const mounts = new Map<number, number>()
  const measuredHeights = new Map<number, number>()
  const frames: string[][] = []
  const state: { handle: ScrollBoxHandle | null; header: DOMElement | null; timeline: TimelineSnapshot | null } = {
    handle: null, header: null, timeline: null,
  }
  const headerRef = (element: DOMElement | null): void => { state.header = element }
  // Public snapshots synchronize committed navigation, never calculate expected geometry.
  const onTimeline = (timeline: TimelineSnapshot): void => { state.timeline = timeline }
  class Stdout extends Writable {
    columns = COLUMNS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), () => { frames.push(viewportLines(term)); callback() })
    }
  }
  const stdout = new Stdout(), stdin = new Stdin()
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const registerRowRef = (id: number, element: DOMElement | null): void => {
    if (element) {
      mounted.set(id, element)
      mounts.set(id, (mounts.get(id) ?? 0) + 1)
      const measured = element.yogaNode?.getComputedHeight()
      if (measured !== undefined && measured > 0) measuredHeights.set(id, measured)
    } else mounted.delete(id)
  }
  const height = (id: number): number => mounted.get(id)?.yogaNode?.getComputedHeight() ?? -1
  const top = (id: number): number => mounted.get(id)?.yogaNode?.getComputedTop() ?? -1
  const headerHeight = (): number => state.header?.yogaNode?.getComputedHeight() ?? -1
  const screen = (): string[] => viewportLines(term)
  const parsed = (): boolean => stdout.writableLength === 0
  function Harness(): ReactNode {
    const [expanded, setExpanded] = React.useState(initiallyExpanded)
    const [scroll, setScroll] = React.useState<ScrollBoxHandle | null>(null)
    state.handle = scroll
    useInput((input, key) => {
      if (key.ctrl && input === 'o') setExpanded(previous => !previous)
      else if (key.home) scroll?.scrollTo(0)
    })
    return (
      <Box height={ROWS} flexDirection="column">
        <Box height={ROWS - 1} flexDirection="column" flexShrink={0}>
          <ScrollBox ref={setScroll} flexGrow={1} flexShrink={1} flexDirection="column" stickyScroll>
            {headerHeights !== undefined && (
              <Box height={headerHeights[expanded ? 1 : 0]} flexShrink={0} ref={headerRef}>
                <Text>HEADER-OWNER</Text>
              </Box>
            )}
            <MessageList rows={rows} expanded={expanded} expandedRows={expandedRows}
              selectedId={null} onToggleRow={noop} model="fixture" showAll onToggleAll={noop}
              historyPaintEnabled={false} scrollHandle={scroll} registerRowRef={registerRowRef} onTimeline={onTimeline} />
          </ScrollBox>
        </Box>
        <Text>{expanded ? 'STATE-EXPANDED' : 'STATE-COLLAPSED'}</Text>
      </Box>
    )
  }
  const instance = await render(<AlternateScreen><Harness /></AlternateScreen>, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
  })
  const dispose = async (): Promise<void> => { await instance.unmount(); term.dispose() }
  try {
    const footer = initiallyExpanded ? 'STATE-EXPANDED' : 'STATE-COLLAPSED'
    assert.ok(await settled(() => state.handle !== null && state.handle.getViewportHeight() === ROWS - 1 &&
      state.timeline !== null && parsed() && screen().some(line => line.includes(footer))),
    'real viewport, public timeline and initial footer are ready')
    const scroll = state.handle as ScrollBoxHandle | null
    assert.ok(scroll, 'ScrollBox handle is attached')
    return { scroll, stdin, mounted, mounts, measuredHeights, frames, height, top, headerHeight, screen, parsed,
      timeline: () => state.timeline, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

function assertAnchorFrames(frames: readonly (readonly string[])[], mark: number, row: number, anchor: string): void {
  const observed = frames.slice(mark)
  assert.ok(observed.length > 0, 'the toggle produced parsed terminal writes')
  assert.ok(anchor.trim() !== '', 'the body anchor is not a blank row')
  const drift = observed.findIndex(frame => (frame[row] ?? '').trimEnd() !== anchor)
  assert.equal(drift, -1, `painted anchor drift in write ${drift}/${observed.length}: expected=${JSON.stringify(anchor)}, ` +
    `actual=${JSON.stringify((observed[drift]?.[row] ?? '').trimEnd())}`)
}
const userText = (prefix: string, length: number): string =>
  Array.from({ length }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`).join('\n')
const mixedRows: ChatRow[] = [
  { id: 1, kind: 'user', text: userText('V', 7) },
  { id: 2, kind: 'assistant', text: 'J-BODY', time: 0 },
  { id: 3, kind: 'user', text: userText('K', 19) },
  ...Array.from({ length: 50 }, (_, i): ChatRow => ({ id: i + 4, kind: 'user', text: `TAIL-${i}` })),
]
async function mixedRemeasurement(): Promise<string> {
  const app = await createHarness(mixedRows, true)
  const { scroll, height, top, mounted, screen, parsed } = app
  try {
    const warmMark = app.frames.length
    scroll.scrollTo(0)
    assert.ok(await settled(() => app.frames.length > warmMark && parsed() &&
      !scroll.isSticky() && scroll.getPendingDelta() === 0 && app.timeline()?.activeId === 1 &&
      screen()[0]?.includes('V-01') === true && height(1) === 7 && height(2) === 4 && height(3) === 20 &&
      top(1) === 0 && top(2) === 7 && top(3) === 11),
    `warm V/J/K at real heights 7/4/20, got ${height(1)}/${height(2)}/${height(3)}`)
    const vHeight = height(1), jHeight = height(2), kHeight = height(3), kTop = top(3)
    const warmedVMounts = app.mounts.get(1) ?? 0, parkMark = app.frames.length
    scroll.scrollTo(16)
    assert.ok(await settled(() => app.frames.length > parkMark && parsed() && scroll.getScrollTop() === 16 &&
      !scroll.isSticky() && scroll.getPendingDelta() === 0 && !mounted.has(1) &&
      height(2) === jHeight && height(3) === kHeight && top(2) === 7 && top(3) === kTop &&
      app.timeline()?.activeId === 3 && screen()[0]?.includes('K-05') === true),
    'committed park excludes V, retains measured J/K, and paints K-05 at the viewport top')
    const beforeTop = scroll.getScrollTop()
    assert.ok(scroll.getScrollHeight() - scroll.getViewportHeight() > beforeTop + 10,
      'long tail keeps the reader far from bottom clamping')
    const anchorRow = screen().findIndex(line => /K-\d{2}/.test(line))
    assert.ok(anchorRow >= 0, 'K supplies a visible body-line anchor')
    const anchor = screen()[anchorRow]!.trimEnd(), frameMark = app.frames.length
    app.stdin.write('\x0f')
    assert.ok(await settled(() => app.frames.length > frameMark && parsed() &&
      screen().some(line => line.includes('STATE-COLLAPSED')) &&
      (app.mounts.get(1) ?? 0) > warmedVMounts &&
      height(1) === vHeight && height(2) === 2 && height(3) === kHeight),
    'real Ctrl+O folds J and remounts/re-measures unchanged V while K stays unchanged')
    const realShrink = jHeight - height(2), expectedTop = beforeTop - realShrink
    assert.equal(realShrink, 2, 'only the assistant metadata removed two actual rows')
    assert.equal(expectedTop, 14, 'fixture position minus its real shrink is 14')
    assert.ok(await settled(() => parsed() && !scroll.isSticky() && scroll.getPendingDelta() === 0 &&
      height(1) === vHeight && height(2) === 2 && height(3) === kHeight &&
      top(3) === kTop - realShrink && scroll.getScrollTop() === expectedTop &&
      (screen()[anchorRow] ?? '').trimEnd() === anchor),
    `fallback recovery: expected top=${expectedTop}, actual=${scroll.getScrollTop()}, ` +
    `K top=${top(3)}, expected=${kTop - realShrink}, ` +
    `anchor=${JSON.stringify(anchor)}, actual line=${JSON.stringify((screen()[anchorRow] ?? '').trimEnd())}`)
    assertAnchorFrames(app.frames, frameMark, anchorRow, anchor)
    return `PASS: mixed remeasurement (${COLUMNS} cols, ${beforeTop} -> ${scroll.getScrollTop()}, real shrink=${realShrink})`
  } finally { await app.dispose() }
}

const growthRows: ChatRow[] = [
  { id: 1, kind: 'assistant', text: userText('PREFIX', 8), time: 0 },
  { id: 2, kind: 'user', text: userText('K', 19) },
  ...Array.from({ length: 3 }, (_, i): ChatRow => ({ id: i + 3, kind: 'user', text: `TAIL-${i}` })),
]
async function nearBottomGrowth(): Promise<string> {
  const app = await createHarness(growthRows, false)
  const { scroll, height, top, screen, parsed } = app
  try {
    const warmMark = app.frames.length
    scroll.scrollTo(0)
    assert.ok(await settled(() => app.frames.length > warmMark && parsed() &&
      !scroll.isSticky() && scroll.getPendingDelta() === 0 && app.timeline()?.activeId === 2 &&
      app.timeline()?.downId === 2 && screen()[0]?.includes('PREFIX-01') === true &&
      height(1) === 8 && height(2) === 20 && [3, 4, 5].every(id => app.measuredHeights.get(id) === 2) &&
      top(1) === 0 && top(2) === 8 && scroll.getFreshScrollHeight() === 34 && scroll.getViewportHeight() === 24),
    'growth fixture measured all tails and committed the prefix-first 34-row content')
    const prefixHeight = height(1), kHeight = height(2), kTop = top(2)
    const oldMax = scroll.getFreshScrollHeight() - scroll.getViewportHeight(), parkMark = app.frames.length
    scroll.scrollTo(oldMax - 1)
    assert.ok(await settled(() => app.frames.length > parkMark && parsed() &&
      !scroll.isSticky() && scroll.getPendingDelta() === 0 && app.timeline()?.activeId === 2 &&
      app.timeline()?.downId === null && screen()[0]?.includes('K-01') === true &&
      scroll.getScrollTop() === oldMax - 1 && height(1) === prefixHeight &&
      top(1) + prefixHeight <= scroll.getScrollTop()),
    'committed reader is one row above bottom, with the mounted prefix wholly above K-01')
    const beforeTop = scroll.getScrollTop()
    const anchorRow = screen().findIndex(line => /K-\d{2}/.test(line))
    assert.ok(anchorRow >= 0, 'near-bottom K supplies a visible body-line anchor')
    const anchor = screen()[anchorRow]!.trimEnd(), frameMark = app.frames.length
    app.stdin.write('\x0f')
    assert.ok(await settled(() => app.frames.length > frameMark && parsed() &&
      screen().some(line => line.includes('STATE-EXPANDED')) && height(1) === 10 && height(2) === kHeight),
    'real Ctrl+O adds two metadata rows above the unchanged reader')
    const realGrowth = height(1) - prefixHeight, expectedTop = beforeTop + realGrowth
    assert.equal(realGrowth, 2, 'the prefix really grew by two rows')
    assert.equal(expectedTop, 11, 'one row above the newly measured bottom is 11')
    assert.ok(await settled(() => parsed() && !scroll.isSticky() && scroll.getPendingDelta() === 0 &&
      scroll.getScrollTop() === expectedTop && top(2) === kTop + realGrowth &&
      scroll.getScrollHeight() - scroll.getViewportHeight() - scroll.getScrollTop() === 1 &&
      (screen()[anchorRow] ?? '').trimEnd() === anchor),
    `growth must not restore sticky: expected top=${expectedTop}, actual=${scroll.getScrollTop()}, ` +
    `sticky=${scroll.isSticky()}, max=${scroll.getScrollHeight() - scroll.getViewportHeight()}`)
    assertAnchorFrames(app.frames, frameMark, anchorRow, anchor)
    return `PASS: near-bottom growth (${COLUMNS} cols, ${beforeTop} -> ${scroll.getScrollTop()}, sticky=${scroll.isSticky()})`
  } finally { await app.dispose() }
}

const headerRows: ChatRow[] = Array.from({ length: 40 }, (_, i): ChatRow => ({ id: i + 1, kind: 'user', text: `MESSAGE-${i}` }))
async function headerAtHome(): Promise<string> {
  const app = await createHarness(headerRows, false, [20, 40])
  const { scroll, screen, parsed } = app
  try {
    const homeMark = app.frames.length
    app.stdin.write('\x1b[H')
    assert.ok(await settled(() => app.frames.length > homeMark && parsed() &&
      !scroll.isSticky() && scroll.getPendingDelta() === 0 && app.timeline()?.activeId === 1 &&
      app.timeline()?.downId === 1 && scroll.getScrollTop() === 0 && app.headerHeight() === 20 &&
      app.top(1) === 20 && screen()[0]?.includes('HEADER-OWNER') === true),
    'Home belongs to the measured header, before the first MessageList row at top 20')
    assert.ok(scroll.getScrollHeight() > scroll.getViewportHeight(), 'header fixture overflows the viewport')
    const headerLine = screen()[0]!.trimEnd(), frameMark = app.frames.length
    app.stdin.write('\x0f')
    assert.ok(await settled(() => parsed() && app.frames.length > frameMark && app.headerHeight() === 40 &&
      screen().some(line => line.includes('STATE-EXPANDED'))), 'Ctrl+O really grows the header from 20 to 40')
    assert.ok(await settled(() => parsed() && scroll.getScrollTop() === 0 &&
      !scroll.isSticky() && scroll.getPendingDelta() === 0 && screen()[0]?.trimEnd() === headerLine),
    `a row below Home cannot anchor the header: top=${scroll.getScrollTop()}, sticky=${scroll.isSticky()}`)
    assertAnchorFrames(app.frames, frameMark, 0, headerLine)
    return `PASS: Home header growth (${COLUMNS} cols, header 20 -> ${app.headerHeight()}, scroll=0)`
  } finally { await app.dispose() }
}

const largeGrowthRows: ChatRow[] = [
  { id: 1, kind: 'user', text: 'P'.repeat(4000) },
  { id: 2, kind: 'user', text: userText('K', 39) },
  { id: 3, kind: 'assistant', text: userText('STREAM', 100), streaming: true },
]
async function largePrefixGrowth(): Promise<string> {
  const app = await createHarness(largeGrowthRows, false)
  const { scroll, height, top, mounted, screen, parsed } = app
  try {
    const warmMark = app.frames.length
    scroll.scrollTo(0)
    assert.ok(await settled(() => app.frames.length > warmMark && parsed() &&
      !scroll.isSticky() && scroll.getPendingDelta() === 0 && app.timeline()?.activeId === 1 &&
      screen()[0]?.includes('PPP') === true && height(1) > 0 && height(2) === 40 && top(1) === 0 &&
      top(2) === height(1) && !mounted.has(3)), 'folded prefix/K are measured and their head-first paint committed')
    const prefixHeight = height(1), kHeight = height(2), kTop = top(2), parkMark = app.frames.length
    scroll.scrollTo(kTop + 1)
    assert.ok(await settled(() => app.frames.length > parkMark && parsed() &&
      !scroll.isSticky() && scroll.getPendingDelta() === 0 && app.timeline()?.activeId === 2 &&
      screen()[0]?.includes('K-01') === true && scroll.getScrollTop() === kTop + 1 &&
      height(1) === prefixHeight && height(2) === kHeight &&
      top(1) + prefixHeight <= scroll.getScrollTop() && !mounted.has(3)),
    'committed park paints K-01 at row zero, with the mounted prefix above and streaming tail outside the window')
    const beforeTop = scroll.getScrollTop()
    const anchorRow = screen().findIndex(line => /K-\d{2}/.test(line))
    assert.ok(anchorRow >= 0, 'large-growth K supplies a visible body-line anchor')
    const anchor = screen()[anchorRow]!.trimEnd(), frameMark = app.frames.length
    app.stdin.write('\x0f')
    assert.ok(await settled(() => parsed() && app.frames.length > frameMark &&
      screen().some(line => line.includes('STATE-EXPANDED')) &&
      height(1) - prefixHeight > scroll.getViewportHeight() && height(2) === kHeight && !mounted.has(3)),
    'expanded long line grows by more than one viewport; the streaming tail is still virtualized')
    const realGrowth = height(1) - prefixHeight, expectedTop = beforeTop + realGrowth
    const freshHeight = scroll.getFreshScrollHeight()
    assert.ok(freshHeight >= expectedTop + scroll.getViewportHeight(),
      'fresh content extent can contain the corrected viewport')
    assert.ok(freshHeight > top(2) + kHeight, 'unmounted tail retains a bottom spacer below K')
    assert.ok(await settled(() => parsed() && !scroll.isSticky() && scroll.getPendingDelta() === 0 &&
      !mounted.has(3) && height(2) === kHeight && top(2) === kTop + realGrowth &&
      scroll.getScrollTop() === expectedTop && (screen()[anchorRow] ?? '').trimEnd() === anchor),
    `fresh virtual clamp must paint the corrected viewport: expected=${expectedTop}, actual=${scroll.getScrollTop()}, ` +
    `growth=${realGrowth}, anchor=${JSON.stringify(anchor)}, actual line=${JSON.stringify((screen()[anchorRow] ?? '').trimEnd())}`)
    assertAnchorFrames(app.frames, frameMark, anchorRow, anchor)
    return `PASS: large prefix growth (${COLUMNS} cols, growth=${realGrowth}, scroll ${beforeTop} -> ${scroll.getScrollTop()})`
  } finally { await app.dispose() }
}

const scenarios = [
  ['mixed remeasurement', mixedRemeasurement], ['near-bottom growth', nearBottomGrowth],
  ['Home header growth', headerAtHome], ['large prefix growth', largePrefixGrowth],
] as const
const failed: string[] = []
for (const [name, verify] of scenarios) {
  try { console.log(await verify()) }
  catch (error) { failed.push(name); console.error(error) }
}
if (failed.length > 0) {
  console.error(`FAIL: scroll anchor remeasurement (${failed.join(', ')})`)
  process.exitCode = 1
} else console.log('PASS: scroll anchor remeasurement')
