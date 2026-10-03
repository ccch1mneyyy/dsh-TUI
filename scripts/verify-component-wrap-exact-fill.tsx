/** Pre-wrapped components must hide only the separator moved past a full row.
 * Run: node --import tsx/esm scripts/verify-component-wrap-exact-fill.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-wrap-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome

const [assertModule, React, { renderToScreen }, { cellAt }, { TerminalSizeContext },
  { JobCard }, { GoalTodoPanel }, { MarkdownTable }, { CompanionPanel },
  { SidePanelRuntimeContext }, { layoutInlineMedia }, { default: wrapText, wrapTextLines },
  { default: stripAnsi }, { Box, Text, render, AlternateScreen }, selection,
  { Writable }, { Terminal }, { settled, viewportLines }] = await Promise.all([
  import('node:assert/strict'), import('react'), import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'), import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/components/Chat/JobCard.js'), import('../src/components/GoalTodoPanel.js'),
  import('../src/components/MarkdownTable.js'), import('../src/components/sidePanel/companion/CompanionPanel.js'),
  import('../src/components/sidePanel/SidePanelRuntimeContext.js'), import('../src/math/inline-layout.js'),
  import('../src/ink/wrap-text.js'), import('strip-ansi'), import('../src/ui.js'), import('../src/ink/selection.js'),
  import('node:stream'), import('@xterm/headless'), import('./lib/term-test.mjs'),
])
const assert = assertModule.default

// Exact fill, ordinary wrapping, hard newlines, indentation, multiple spaces,
// wide characters, ANSI styles and links: remove one separator, never rows.
for (const [text, width, expected] of [
  ['aaa the PR.', 7, ['aaa the', 'PR.']],
  ['aaa the PR.', 8, ['aaa the ', 'PR.']],
  ['aaa the\n PR.', 7, ['aaa the', ' PR.']],
  ['aaa the\n\n  PR.', 7, ['aaa the', '', '  PR.']],
  ['aaa the  PR.', 7, ['aaa the', ' PR.']],
  ['你好abc PR.', 7, ['你好abc', 'PR.']],
  ['\x1b[1maaa the PR.\x1b[22m', 7, ['aaa the', 'PR.']],
  ['aaa the \x1b]8;;https://example.com\x07PR.\x1b]8;;\x07', 7, ['aaa the', 'PR.']],
  ['abcdefghi', 7, ['abcdefg', 'hi']],
  ['aaa the ', 7, ['aaa the', '']],
] as const) {
  const rows = wrapTextLines(text, width)
  assert.deepEqual(rows.map(row => stripAnsi(row.text)), expected)
  assert.equal(rows.length, wrapText(text, width, 'wrap').split('\n').length, 'display normalization preserves row count')
  const restored = rows.map((row, index) => (index === 0 ? '' : row.continuation ? row.gap ? ' ' : '' : '\n') + stripAnsi(row.text)).join('')
  assert.equal(restored, stripAnsi(text), 'metadata preserves the logical source')
}
const bold = wrapTextLines('\x1b[1maaa the PR.\x1b[22m', 7)[1]!.text
assert.match(bold, /^\x1b\[1mPR\.\x1b\[22m$/, 'slicing the separator keeps balanced styles')
const linked = wrapTextLines('aaa the \x1b]8;;https://example.com\x07PR.\x1b]8;;\x07', 7)[1]!.text
assert.ok(linked.includes('https://example.com') && linked.endsWith('\x1b]8;;\x07'), 'slicing keeps the link target and terminator')

function lines(element: React.ReactElement, columns: number): string[] {
  const { screen, height } = renderToScreen(
    <TerminalSizeContext.Provider value={{ columns, rows: 40 }}>{element}</TerminalSizeContext.Provider>, columns,
  )
  return Array.from({ length: height }, (_, row) =>
    Array.from({ length: columns }, (_, col) => cellAt(screen, col, row)?.char ?? '').join('').trimEnd(),
  )
}

const channel = { version: 0, working: true, todos: [{ content: 'aaa the PR.', status: 'pending' }], subscribe: () => () => {} }
const failures: string[] = []
function check(ok: boolean, message: string): void {
  if (!ok) failures.push(message)
}

const todo = lines(<GoalTodoPanel channel={channel as never} variant="panel" wrapWidth={7} />, 30)
check(todo.at(-1)?.indexOf('PR.') === todo.at(-2)?.indexOf('aaa the'), `todo continuation: ${JSON.stringify(todo)}`)

const job = { id: '1', kind: 'sh', label: 'aaaa the PR.', status: 'running', startedAt: Date.now(), outputLines: [{ text: 'aaa ' + 'b'.repeat(31) + ' PR.' }] }
const log = lines(<JobCard job={job as never} marginTopOnTurn={false} />, 40)
check(log.includes('  │ PR.'), `job log continuation: ${JSON.stringify(log)}`)
const label = lines(<JobCard job={job as never} marginTopOnTurn={false} rail={{ open: true, close: true }} />, 33)
const first = label.find(line => line.includes('aaaa the'))!
check(first !== undefined, `grouped label: ${JSON.stringify(label)}`)
check(label[1]?.indexOf('PR.') === first?.indexOf('aaaa the'), 'grouped label continuation aligns with the first word')

const cell = (text: string) => ({ text, tokens: [{ type: 'text', raw: text, text }] })
const token = { type: 'table', raw: '', header: [cell('Key')], align: [null], rows: [[cell('aaa the PR.')]] }
const table = lines(<MarkdownTable token={token as never} highlight={null} forceWidth={15} />, 15)
check(table.includes('│ PR.     │'), `table continuation: ${JSON.stringify(table)}`)

const narration = 'aaa ' + 'b'.repeat(36) + ' PR.'
const companionElement = (
  <SidePanelRuntimeContext.Provider value={{ runtime: undefined, channel: channel as never,
    activity: { line: narration, phase: 'tool-use' } as never, attention: { approvals: 0, questions: 0 } }}>
    <CompanionPanel width={44} height={40} focused={false} visible={true} mode="split" />
  </SidePanelRuntimeContext.Provider>
)
const companion = lines(companionElement, 44)
const bubbleFirst = companion.findIndex(line => line.includes('aaa '))
check(bubbleFirst >= 0, `companion bubble: ${JSON.stringify(companion)}`)
check(companion[bubbleFirst + 1]?.indexOf('PR.') === companion[bubbleFirst]?.indexOf('aaa '), 'bubble continuation aligns with the first word')

const inline = layoutInlineMedia('aaa the PR.', 7, [])!
check(inline[1]?.pieces[0]?.kind === 'text' && inline[1].pieces[0].text === 'PR.', 'inline layout hides the separator')
check(inline[1]?.gap === true, 'inline layout records the omitted separator')

// Exercise the row Box -> Output -> selection seam, including a left offset.
const painted = renderToScreen(
  <Box paddingLeft={2} flexDirection="column">
    {inline.map((row, index) => <Box key={index} height={1}
      softWrapContinuation={row.continuation ? (row.gap ? -1 : 1) * inline[index - 1]!.width : undefined}>
      <Text wrap="truncate">{row.pieces.map(piece => piece.kind === 'text' ? piece.text : '').join('')}</Text>
    </Box>)}
  </Box>, 12,
).screen
assert.equal(painted.softWrap[1], -9, 'the signed marker includes the Box offset')
const selected = {
  anchor: null, focus: null, isDragging: false, anchorSpan: null,
  scrolledOffAbove: [], scrolledOffBelow: [], lastPressHadAlt: false,
  coveredFingerprint: null, coveredText: null, coveredGeometry: null, stale: false,
} as unknown as import('../src/ink/selection.js').SelectionState
selection.startSelection(selected, 2, 0)
selection.updateSelection(selected, 11, 1)
selected.fence = { colStart: 2, colEnd: 11 }
assert.equal(selection.getSelectedText(selected, painted), 'aaa the PR.', 'copy restores the separator within an offset panel')
selection.refreshSelectionFingerprint(selected, painted, false)
painted.softWrap[1] = 9
assert.equal(selection.refreshSelectionFingerprint(selected, painted, false), true, 'a gap-only change makes the selection stale')

assert.deepEqual(failures, [])

// Verify terminal emission at narrow widths in both supported screen modes.
const fixtures = [
  [<GoalTodoPanel channel={channel as never} variant="panel" wrapWidth={7} />, 30, todo.at(-1)!],
  [<JobCard job={job as never} marginTopOnTurn={false} />, 40, '  │ PR.'],
  [<JobCard job={job as never} marginTopOnTurn={false} rail={{ open: true, close: true }} />, 33, label[1]!],
  [<MarkdownTable token={token as never} highlight={null} forceWidth={15} />, 15, '│ PR.     │'],
  [companionElement, 44, companion[bubbleFirst + 1]!],
] as const
for (const fullscreen of [false, true]) {
  for (const [element, columns, continuation] of fixtures) {
    const term = new Terminal({ cols: columns, rows: 44, scrollback: 100, allowProposedApi: true })
    class Out extends Writable {
      isTTY = true
      columns = columns
      rows = 44
      _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void { term.write(String(chunk), done) }
    }
    const stderr = new Writable({ write(_chunk, _encoding, done) { done() } })
    const tree = <TerminalSizeContext.Provider value={{ columns, rows: 44 }}>{element}</TerminalSizeContext.Provider>
    const app = await render(fullscreen ? <AlternateScreen>{tree}</AlternateScreen> : tree, {
      stdout: new Out() as NodeJS.WriteStream, stderr: stderr as NodeJS.WriteStream,
      exitOnCtrlC: false, patchConsole: false,
    })
    try {
      assert.ok(await settled(() => viewportLines(term, 44).includes(continuation)),
        `${fullscreen ? 'fullscreen' : 'inline'} ${columns}-column continuation: ${JSON.stringify(continuation)}`)
    } finally {
      await app.unmount()
      term.dispose()
    }
  }
}
rmSync(isolatedHome, { recursive: true, force: true })
console.log('Component exact-fill wrapping passed: todo, job logs and grouped labels, table, companion bubble, inline layout')
