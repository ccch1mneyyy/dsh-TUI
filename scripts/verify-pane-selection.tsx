/** Pane ownership, independent wraps and real SGR gestures (#1305).
 * Run: node --import tsx/esm scripts/verify-pane-selection.tsx
 * Uses real SidePanelLayout/SplitDiffView and checks copied bytes + highlights.
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import { render, AlternateScreen, ThemeProvider, Box, Text, useInput, ScrollBox } from '../src/ui.js'
import type { ScrollBoxHandle } from '../src/ink/components/ScrollBox.js'
import { stringWidth } from '../src/ink/stringWidth.js'
import { SidePanelLayout } from '../src/components/sidePanel/SidePanelLayout.js'
import { SplitDiffView } from '../src/components/SplitDiffView.js'
import { OverlayAbove } from '../src/components/OverlayAbove.js'
import instances from '../src/ink/instances.js'
import { getSelectedText, clearSelection } from '../src/ink/selection.js'
import { settled, sleep } from './lib/term-test.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
const COLS = 120
const ROWS = 24
const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
class Out extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: Buffer.Encoding, done: () => void) { term.write(String(chunk), done) }
}
class In extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
const stdout = new Out()
const stdin = new In()
let mode: 'split' | 'diff' | 'scroll' | 'nested' | 'overlay' | 'overlay-side' | 'gaps' | 'mixed' = 'split'
let overlayVisible = true
let overlayLeft = 0
let overlayWidth = COLS
let overlayText = 'VISIBLE OVERLAY ' + 'z'.repeat(60)
let mixedWidth = COLS
let mixedLong = false
let gapDeletion = false
const gapSparse = 'GAP A\n\nGAP B'
const gapAdded = 'GAP A\nINSERTED\n\nGAP B'
let chat = 64
let bump: (() => void) | undefined
const leftScroll = React.createRef<ScrollBoxHandle>()
const rightScroll = React.createRef<ScrollBoxHandle>()
const left = 'CHAT ' + 'x'.repeat(70) + '\nCHAT hard end'
const right = 'PANEL ' + 'y'.repeat(65) + '\nPANEL hard end'
const oldText = 'OLD ' + 'a'.repeat(72) + '\nold tail 中🙂'
const newText = 'NEW ' + 'b'.repeat(91) + '\nnew tail 文🙂'
function Harness() {
  const [, tick] = React.useState(0)
  bump = () => tick(n => n + 1)
  useInput(() => bump?.())
  if (mode === 'overlay' || mode === 'overlay-side') {
    const content = <Box width={mode === 'overlay-side' ? chat : COLS} height={20} flexDirection="column">
      <SplitDiffView diffs={[{ path: '/tmp/pane.txt', oldText, newText }]} width={mode === 'overlay-side' ? chat : COLS} maxRows={100} verbose />
      <Box marginLeft={overlayLeft} width={overlayWidth}>
        {overlayVisible && <OverlayAbove maxHeight={12}><Text>{Array(12).fill(overlayText).join('\n')}</Text></OverlayAbove>}
        <Text>ANCHOR</Text>
      </Box>
    </Box>
    return mode === 'overlay' ? content : <Box width={COLS} height={ROWS}>
      <SidePanelLayout geometry={{ chat, panel: COLS - chat - 1 }} focus="chat" side={<Text>{Array(20).fill('SIBLING').join('\n')}</Text>}>{content}</SidePanelLayout>
    </Box>
  }
  if (mode === 'gaps') return <SplitDiffView diffs={[{ path: '/tmp/gaps.txt', oldText: gapDeletion ? gapAdded : gapSparse, newText: gapDeletion ? gapSparse : gapAdded }]} width={COLS} maxRows={100} verbose />
  if (mode === 'mixed') return <ScrollBox ref={leftScroll} width={mixedWidth} height={12} flexDirection="column">
    <SplitDiffView diffs={[
      { path: '/tmp/top.txt', newText: 'TOP0\nTOP1' },
      { path: '/tmp/middle.txt', oldText: 'LEFT0\nLEFT1', newText: mixedLong ? ['RIGHT0 ', 'RIGHT1 '].map(line => line + 'r'.repeat(40)).join('\n') : 'RIGHT0\nRIGHT1' },
      { path: '/tmp/bottom.txt', newText: Array.from({ length: 14 }, (_, i) => 'BOTTOM' + i).join('\n') },
    ]} width={mixedWidth} maxRows={100} verbose />
  </ScrollBox>
  if (mode === 'nested') return <ScrollBox ref={leftScroll} height={12} flexDirection="column">
    <Text>{'head0\nhead1\nhead2'}</Text>
    <SplitDiffView diffs={[{ path: '/tmp/pane.txt', oldText, newText }]} width={COLS} maxRows={100} verbose />
    <Text>{Array.from({ length: 20 }, (_, i) => 'after' + i).join('\n')}</Text>
  </ScrollBox>
  if (mode === 'diff') return <SplitDiffView diffs={[{ path: '/tmp/pane.txt', oldText, newText }]} width={COLS} maxRows={100} verbose />
  const scroller = (side: 'L' | 'R', ref: React.RefObject<ScrollBoxHandle | null>) => (
    <ScrollBox ref={ref} height={8} flexDirection="column">
      {Array.from({ length: 25 }, (_, n) => <Text key={n}>{`${side}${String(n).padStart(2, '0')} row 中🙂`}</Text>)}
    </ScrollBox>
  )
  return <Box width={COLS} height={ROWS}><SidePanelLayout geometry={{ chat, panel: COLS - chat - 1 }} focus="chat"
    onResize={n => { chat = Math.max(64, Math.min(91, n)); bump?.() }}
    side={mode === 'scroll' ? scroller('R', rightScroll) : <Text>{right}</Text>}>
    {mode === 'scroll' ? scroller('L', leftScroll) : <Text>{left}</Text>}
  </SidePanelLayout></Box>
}
const app = await render(<AlternateScreen mouseTracking><ThemeProvider theme="dark"><Harness /></ThemeProvider></AlternateScreen>, {
  stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
  stderr: new Writable({ write(_c, _e, done) { done() } }) as NodeJS.WriteStream,
  patchConsole: false, exitOnCtrlC: false,
})
const ink = instances.get(stdout)!
ink.setSelectionBgColor('rgb(80, 90, 120)')
const lines = () => Array.from({ length: ROWS }, (_, row) => term.buffer.active.getLine(row)?.translateToString(false) ?? '')
const copied = () => getSelectedText(ink.selection, ink.frontFrame.screen)
const mark = (col: number, row: number) => {
  const cell = term.buffer.active.getLine(row)?.getCell(col)
  return cell !== undefined && (cell.getBgColor() === 0x505a78 || cell.isInverse() !== 0)
}
const sgr = (button: number, col: number, row: number, end = 'M') => `\x1b[<${button};${col + 1};${row + 1}${end}`
async function send(data: string) { stdin.write(data); await new Promise(resolve => setImmediate(resolve)) }
async function paint() {
  bump?.()
  await sleep(80) // 固定窗:pacing render and xterm parser frame after imperative selection update
}
async function drag(a: [number, number], b: [number, number]) {
  clearSelection(ink.selection)
  await send(sgr(0, ...a)); await send(sgr(32, ...b)); await send(sgr(0, ...b, 'm')); await paint()
}
function check(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name)
  console.log('PASS: ' + name)
}
try {
  assert.ok(await settled(() => lines()[0]?.includes('PANEL')))
  for (const [name, x, prefix, body, hard, opposite] of [
    ['chat', 0, 'CHAT ', 'x'.repeat(70), 'CHAT hard end', 70],
    ['panel', 65, 'PANEL ', 'y'.repeat(65), 'PANEL hard end', 5],
  ] as const) {
    for (const reverse of [false, true]) {
      const a: [number, number] = [x + prefix.length, 0]
      const b: [number, number] = [x + 3, 2]
      await drag(reverse ? b : a, reverse ? a : b)
      check(`${name} ${reverse ? 'reverse' : 'forward'} diagonal exact copy`, copied(), body + '\n' + hard.slice(0, 4))
      check(`${name} highlight owns the intermediate row`, mark(x + 2, 1), true)
      check(`${name} excludes sibling highlight`, mark(opposite, 1), false)
    }
    await drag([x, 0], [x + hard.length - 1, 2])
    check(`${name} independent soft-wrap + hard newline`, copied(), prefix + body + '\n' + hard)
    // Distinct row/cell resets the click chain before double/triple clicks.
    await send(sgr(0, x + 6, 2)); await send(sgr(0, x + 6, 2, 'm'))
    await send(sgr(0, x + 6, 2)); await send(sgr(0, x + 6, 2, 'm')); await paint()
    check(`${name} word copy`, copied(), 'hard')
    check(`${name} word highlight excludes sibling`, mark(opposite, 2), false)
    await send(sgr(0, x + 6, 2)); await send(sgr(0, x + 6, 2, 'm')); await paint()
    check(`${name} line copy`, copied(), hard)
  }
  await drag([5, 0], [3, 2])
  const beforeReflow = copied()
  chat = 75; await paint()
  check('wrapped selection survives changed visual row count', copied(), beforeReflow)
  check('wrapped reflow preserves live selection', ink.selection.stale, false)
  chat = 64; clearSelection(ink.selection); await paint()
  await drag([65, 2], [78, 2])
  const beforeResize = copied()
  chat = 70; await paint()
  check('pane identity survives horizontal layout resize', copied(), beforeResize)
  check('resize does not mark unchanged copied text stale', ink.selection.stale, false)
  clearSelection(ink.selection)
  await send(sgr(0, chat, 5)); await send(sgr(32, chat + 5, 5)); await send(sgr(0, chat + 5, 5, 'm')); await paint()
  check('divider drag does not create text selection', ink.selection.focus, null)

  mode = 'diff'; clearSelection(ink.selection); await paint()
  assert.ok(await settled(() => lines().some(line => line.includes('OLD'))))
  const locate = (needle: string): [number, number] => {
    const row = lines().findIndex(line => line.includes(needle))
    assert.ok(row >= 0, needle + ' is rendered')
    return [stringWidth(lines()[row]!.slice(0, lines()[row]!.indexOf(needle))), row]
  }
  for (const [start, tail, expected, other] of [['OLD', 'old tail', oldText, 'NEW'], ['NEW', 'new tail', newText, 'OLD']] as const) {
    const a = locate(start)
    const end = locate(tail)
    const b: [number, number] = [end[0] + stringWidth(expected.split('\n').at(-1)!) - 1, end[1]]
    for (const reverse of [false, true]) {
      await drag(reverse ? b : a, reverse ? a : b)
      check(`${start} diff exact copy excludes gutter and opposite pane`, copied(), expected)
      check(`${start} diff selected glyph highlight`, mark(a[0] + 1, a[1]), true)
      const sibling = locate(other)
      check(`${start} diff sibling untouched`, mark(sibling[0], sibling[1]), false)
    }
    for (let clicks = 1; clicks <= 3; clicks++) {
      await send(sgr(0, end[0] + 5, end[1])); await send(sgr(0, end[0] + 5, end[1], 'm'))
      if (clicks >= 2) {
        await paint()
        check(`${start} diff ${clicks === 2 ? 'word' : 'line'} copy`, copied(), clicks === 2 ? 'tail' : expected.split('\n').at(-1))
        check(`${start} diff multiclick highlight`, mark(end[0] + 5, end[1]), true)
        const sibling = locate(other)
        check(`${start} diff multiclick excludes other pane`, mark(sibling[0], sibling[1]), false)
      }
    }
  }
  if (process.env.DSH_TUI_PANE_SNAPSHOT) writeFileSync(process.env.DSH_TUI_PANE_SNAPSHOT, lines().join('\n'))

  mode = 'overlay'; clearSelection(ink.selection); await paint()
  for (const partial of [false, true]) {
    overlayLeft = partial ? 12 : 0
    overlayWidth = partial ? 48 : COLS
    overlayText = 'VISIBLE OVERLAY ' + 'z'.repeat(partial ? 28 : 60)
    await paint()
    assert.ok(await settled(() => lines().some(line => line.includes(overlayText))))
    const row = lines().findIndex(line => line.includes(overlayText))
    await drag([overlayLeft, row], [overlayLeft + overlayText.length - 1, row])
    check(`${partial ? 'partial' : 'full'} opaque overlay copies visible text without hidden diff pane or gutters`, copied(), overlayText)
    await paint()
    check('cached opaque overlay keeps the same visible copy', copied(), overlayText)
    if (partial) {
      await drag([0, row], [COLS - 1, row])
      check('uncovered diff retains its original column fence', ink.selection.fence?.colEnd, 58)
      check('uncovered diff excludes overlay and opposite pane', copied().includes('VISIBLE') || copied().includes('NEW'), false)
    }
  }
  overlayVisible = false; clearSelection(ink.selection); await paint()
  const restoredStart = locate('OLD')
  const restoredTail = locate('old tail')
  await drag(restoredStart, [restoredTail[0] + stringWidth(oldText.split('\n').at(-1)!) - 1, restoredTail[1]])
  check('closing overlay restores diff pane copy and gutters', copied(), oldText)

  mode = 'overlay-side'; overlayVisible = true; overlayLeft = 0; overlayWidth = chat
  overlayText = 'VISIBLE OVERLAY ' + 'z'.repeat(28)
  clearSelection(ink.selection); await paint()
  const overlayRow = lines().findIndex(line => line.includes(overlayText))
  assert.ok(overlayRow >= 0)
  await drag([0, overlayRow], [COLS - 1, overlayRow])
  check('overlay retains its ancestor chat fence', ink.selection.fence?.colEnd, chat - 1)
  check('overlay inside chat copies visible text without sibling pane', copied(), overlayText)
  await paint()
  check('cached overlay retains ancestor chat fence', ink.selection.fence?.colEnd, chat - 1)
  check('cached overlay inside chat keeps exact copy', copied(), overlayText)

  mode = 'scroll'; clearSelection(ink.selection); await paint()
  leftScroll.current?.scrollTo(0); rightScroll.current?.scrollTo(0); await paint()
  assert.ok(await settled(() => lines()[0]?.includes('L00') && lines()[0]?.includes('R00')))
  await drag([0, 2], [12, 3])
  const leftCopy = copied()
  const leftAnchor = { ...ink.selection.anchor! }
  rightScroll.current?.scrollBy(2); await paint()
  check('right scrolling never translates left anchor', ink.selection.anchor, leftAnchor)
  check('right scrolling never changes left copied text', copied(), leftCopy)
  check('right scrolling does not stale left selection', ink.selection.stale, false)
  leftScroll.current?.scrollBy(1); await paint()
  check('own scrolling follows selected content exactly', copied(), leftCopy)
  check('own scrolling moves anchor one row', ink.selection.anchor?.row, leftAnchor.row - 1)
  await drag([chat + 1, 2], [chat + 13, 3])
  const rightCopy = copied()
  const rightAnchor = { ...ink.selection.anchor! }
  leftScroll.current?.scrollBy(1); await paint()
  check('left scrolling never translates right anchor', ink.selection.anchor, rightAnchor)
  check('left scrolling never changes right copy', copied(), rightCopy)
  check('left scrolling never stales right selection', ink.selection.stale, false)

  mode = 'nested'; clearSelection(ink.selection); await paint()
  leftScroll.current?.scrollTo(0); await paint()
  const oldRow = lines().findIndex(line => line.includes('OLD'))
  assert.ok(oldRow >= 0)
  const oldCol = lines()[oldRow]!.indexOf('OLD')
  await drag([oldCol, oldRow], [oldCol + 2, oldRow])
  const nestedId = ink.selection.paneId!
  const beforeRows = [...ink.frontFrame.screen.selectionPanes!.get(nestedId)!.keys()].sort((a, b) => a - b)
  leftScroll.current?.scrollBy(1); await paint()
  const afterRows = [...ink.frontFrame.screen.selectionPanes!.get(nestedId)!.keys()].sort((a, b) => a - b)
  check('nested diff pane membership shifts with cached content', afterRows, beforeRows.map(row => row - 1))
  check('nested diff scrolling preserves exact copy', copied(), 'OLD')

  mode = 'gaps'; clearSelection(ink.selection); await paint()
  for (const deletion of [false, true]) {
    gapDeletion = deletion; await paint()
    const point = (needle: string): [number, number] => {
      const row = lines().findIndex(line => line.includes(needle))
      assert.ok(row >= 0)
      return [deletion ? lines()[row]!.lastIndexOf(needle) : lines()[row]!.indexOf(needle), row]
    }
    const end = point('GAP B')
    await drag(point('GAP A'), [end[0] + 4, end[1]])
    check(`${deletion ? 'deletion' : 'insertion'} alignment gap is omitted but source blank line survives`, copied(), gapSparse)
  }

  mode = 'scroll'; clearSelection(ink.selection); await paint()
  leftScroll.current?.scrollTo(0); rightScroll.current?.scrollTo(0); await paint()
  await drag([chat + 1, 0], [chat + 1 + stringWidth('R06 row 中🙂') - 1, 6])
  const forwardCopy = Array.from({ length: 7 }, (_, i) => `R${String(i).padStart(2, '0')} row 中🙂`).join('\n')
  for (let step = 1; step <= 2; step++) {
    rightScroll.current?.scrollBy(1); await paint()
    check(`right pane captured selection survives scroll ${step}`, copied(), forwardCopy)
    check(`right pane captured selection stays live ${step}`, ink.selection.stale, false)
  }
  chat += 5; await paint()
  rightScroll.current?.scrollBy(1); await paint()
  check('captured pane retains ownership after a horizontal resize', copied(), forwardCopy)
  check('resized captured pane remains live', ink.selection.stale, false)
  clearSelection(ink.selection); leftScroll.current?.scrollTo(10); await paint()
  await drag([stringWidth('L17 row 中🙂') - 1, 7], [0, 1])
  const reverseCopy = Array.from({ length: 7 }, (_, i) => `L${String(i + 11).padStart(2, '0')} row 中🙂`).join('\n')
  for (let step = 1; step <= 2; step++) {
    leftScroll.current?.scrollBy(-1); await paint()
    check(`left pane captured selection survives reverse scroll ${step}`, copied(), reverseCopy)
    check(`left pane captured selection stays live ${step}`, ink.selection.stale, false)
  }

  let reportedSelection = ink.hasTextSelection()
  check('listener starts with a live pane selection', reportedSelection, true)
  const unsubscribe = ink.subscribeToSelectionChange(() => { reportedSelection = ink.hasTextSelection() })
  mode = 'diff'; await paint()
  check('removing the owning pane clears selection', ink.hasTextSelection(), false)
  check('removing the owning pane notifies selection consumers', reportedSelection, false)
  unsubscribe()

  mode = 'mixed'; clearSelection(ink.selection); await paint()
  leftScroll.current?.scrollTo(0); await paint()
  const mixedEnd = locate('BOTTOM2')
  await drag(locate('TOP0'), [mixedEnd[0] + 6, mixedEnd[1]])
  const mixedCopy = 'TOP0\nTOP1\nRIGHT0\nRIGHT1\nBOTTOM0\nBOTTOM1\nBOTTOM2'
  check('mixed-width diff copies only its new-side rows before capture', copied(), mixedCopy)
  leftScroll.current?.scrollBy(6); await paint()
  check('captured mixed-width diff rows exclude the opposite pane', copied(), mixedCopy)
  check('captured mixed-width diff remains live', ink.selection.stale, false)
  mixedLong = true; clearSelection(ink.selection); await paint()
  leftScroll.current?.scrollTo(0); await paint()
  const longEnd = locate('BOTTOM2')
  await drag(locate('TOP0'), [longEnd[0] + 6, longEnd[1]])
  const beforeNarrow = copied()
  leftScroll.current?.scrollBy(2); await paint()
  check('captured diff before narrowing retains exact source', copied(), beforeNarrow)
  mixedWidth = 80; await paint()
  check('narrowing that changes captured diff selection still marks stale', ink.selection.stale, true)
  check('changed captured diff copy is refused after narrowing', ink.copySelectionNoClear(), '')


} finally {
  await app.unmount()
  term.dispose()
}
console.log('PASS: pane ownership SGR regression')
