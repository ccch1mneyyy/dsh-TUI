/**
 * Headless verification of copy-on-select: with <AlternateScreen> mounted,
 * an SGR mouse drag must produce an OSC 52 clipboard write carrying the
 * selected text — fired by the useCopyOnSelect subscription when the drag
 * settles. Copies retain the selection, duplicate releases do not copy,
 * and Esc clears it. Checks the painted terminal cells at 100/20 columns
 * plus the inline-mode boundary, alongside pure overlay edge cases and
 * real Chat Escape priority with search and preset overlays.
 *
 * Run against the compiled lib: `node scripts/verify-copy-on-select.mjs`
 */
import './lib/fake-home.mjs'
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import {
  render,
  Text,
  AlternateScreen,
  useCopyOnSelect,
  useInput,
} from '../lib/types/ui.js'
import { useSelection } from '../lib/types/ink/hooks/use-selection.js'
import instances from '../lib/types/ink/instances.js'
import { createSelectionState, startSelection, updateSelection, applySelectionOverlay, getSelectedText, getSelectionCursor } from '../lib/types/ink/selection.js'
import { CharPool, HyperlinkPool, StylePool, createScreen, setCellAt, cellAtIndex } from '../lib/types/ink/screen.js'
import { findText, sleep, settle, settled, viewportLines } from './lib/term-test.mjs'

const { Terminal } = xterm

// Force the pure OSC 52 path: SSH_CONNECTION skips the wl-copy/xclip/xsel
// probe chain so the assertion only depends on stdout frames.
process.env.SSH_CONNECTION = 'headless-test'
delete process.env.TMUX

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// Exercise the real overlay with explicit expected cell ranges. Copy text
// assertions keep whitespace trimming separate from visible highlighting.
function verifyOverlay() {
  const make = (rows, width = 12) => {
    const styles = new StylePool()
    const screen = createScreen(width, rows.length, styles, new CharPool(), new HyperlinkPool())
    rows.forEach((text, row) => {
      [...text].forEach((char, col) => setCellAt(screen, col, row, {
        char, styleId: styles.none, width: 0, hyperlink: undefined,
      }))
    })
    return { screen, styles }
  }
  const paint = (screen, styles, from, to) => {
    const selection = createSelectionState()
    startSelection(selection, ...from, screen)
    updateSelection(selection, ...to)
    const before = Array.from({ length: screen.width * screen.height }, (_, i) => cellAtIndex(screen, i).styleId)
    applySelectionOverlay(screen, selection, styles)
    return {
      text: getSelectedText(selection, screen),
      cursor: getSelectionCursor(screen, selection),
      rows: Array.from({ length: screen.height }, (_, row) =>
        Array.from({ length: screen.width }, (_, col) => col)
          .filter(col => cellAtIndex(screen, row * screen.width + col).styleId !== before[row * screen.width + col])),
    }
  }
  const equal = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual))

  {
    const { screen, styles } = make(['a b', '   ', 'end'])
    const result = paint(screen, styles, [0, 0], [11, 2])
    equal('overlay excludes trailing padding and blank rows', result.rows, [[0, 1, 2], [], [0, 1, 2]])
    equal('blank rows remain in copied text', result.text, 'a b\n\nend')
    equal('selection cursor stays at the actual text edge', result.cursor, { col: 2, row: 2 })
  }
  {
    const { screen, styles } = make(['    x', 'a   b'])
    equal('code indentation remains highlighted', paint(screen, styles, [0, 0], [11, 0]).rows[0], [0, 1, 2, 3, 4])
    equal('a selection of interior spaces remains highlighted', paint(screen, styles, [1, 1], [3, 1]).rows[1], [1, 2, 3])
  }
  {
    const { screen, styles } = make(['a ', 'b'])
    screen.softWrap[1] = 2
    const result = paint(screen, styles, [0, 0], [11, 1])
    equal('soft-wrap separator stays highlighted without viewport padding', result.rows, [[0, 1], [0]])
    equal('soft-wrap copy keeps the separator', result.text, 'a b')
  }
  {
    const { screen, styles } = make(['a b', ''])
    const background = styles.intern([{ type: 'ansi', code: '\x1b[44m', endCode: '\x1b[49m' }])
    for (let row = 0; row < screen.height; row++) {
      for (let col = 0; col < screen.width; col++) {
        const cell = cellAtIndex(screen, row * screen.width + col)
        setCellAt(screen, col, row, { ...cell, styleId: background })
      }
    }
    styles.setSelectionBg({ type: 'ansi', code: '\x1b[47m', endCode: '\x1b[49m' })
    equal('solid selection color leaves styled padding and blank rows unchanged', paint(screen, styles, [0, 0], [11, 1]).rows, [[0, 1, 2], []])
  }
  {
    const { screen, styles } = make([''])
    setCellAt(screen, 0, 0, { char: '界', styleId: styles.none, width: 1, hyperlink: undefined })
    setCellAt(screen, 2, 0, { char: '👩‍💻', styleId: styles.none, width: 1, hyperlink: undefined })
    setCellAt(screen, 4, 0, { char: 'e\u0301', styleId: styles.none, width: 0, hyperlink: undefined })
    const result = paint(screen, styles, [0, 0], [11, 0])
    // SpacerTail inherits the head's terminal style; it is never restyled.
    equal('Unicode grapheme heads highlight without trailing padding', result.rows, [[0, 2, 4]])
    equal('Unicode copy preserves graphemes', result.text, '界👩‍💻e\u0301')
    equal('selection cursor anchors to a complete grapheme', result.cursor, { col: 4, row: 0 })
  }
  {
    const { screen, styles } = make(['hi    PANEL', '      PANEL'])
    for (let row = 0; row < screen.height; row++) screen.noSelect.fill(1, row * screen.width + 6, (row + 1) * screen.width)
    const result = paint(screen, styles, [0, 0], [11, 1])
    equal('excluded side-panel text does not extend chat highlighting', result.rows, [[0, 1], []])
    equal('chat cursor ignores blank rows with excluded panel text', result.cursor, { col: 1, row: 0 })
  }
  {
    const { screen, styles } = make(['chat  P', 'chat'])
    for (let row = 0; row < screen.height; row++) screen.noSelect.fill(1, row * screen.width + 6, (row + 1) * screen.width)
    const result = paint(screen, styles, [6, 0], [11, 1])
    equal('panel-origin selection trims its own padding', result.rows, [[6], []])
    equal('panel cursor remains inside its text fence', result.cursor, { col: 6, row: 0 })
  }
  {
    const { screen, styles } = make(['', '   '])
    const result = paint(screen, styles, [0, 0], [11, 1])
    equal('blank-only selections have no text cursor', result.cursor, null)
  }
  {
    const { screen, styles } = make(['abc', '   ', 'tail'])
    equal('reverse drag across blanks uses the first selected text edge', paint(screen, styles, [2, 2], [11, 1]).cursor, { col: 0, row: 2 })
  }
  {
    const { screen, styles } = make(['>>> abc'])
    screen.noSelect.fill(1, 0, 4)
    equal('reverse cursor skips excluded gutters', paint(screen, styles, [6, 0], [0, 0]).cursor, { col: 4, row: 0 })
  }
}

function makeStreams(columns) {
  const terminal = new Terminal({ cols: columns, rows: 30, allowProposedApi: true })
  let painted = Promise.resolve()
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      painted = painted.then(() => new Promise(resolve => terminal.write(String(chunk), resolve)))
      cb()
    },
  })
  stdout.columns = columns
  stdout.rows = 30
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin, terminal, flush: () => painted }
}

function CopyOnSelectMount() {
  useCopyOnSelect()
  return null
}

// Raw mode (App's stdin 'readable' handler) is only armed when a useInput
// consumer exists — production has PromptInput/Chat; this tree needs one
// explicitly or injected mouse sequences are never read. The Esc binding
// mirrors Chat.tsx: an active drag or retained mouse selection is cleared
// before the ordinary chat meanings of Esc.
function InputConsumer() {
  const { clearSelection, hasSelection, getState } = useSelection()
  useInput((_input, key, event) => {
    if (key.escape && (hasSelection() || getState()?.isDragging)) {
      clearSelection()
      event.stopImmediatePropagation()
    }
  })
  return null
}

async function run(columns, fullscreen) {
  console.log(`\n${fullscreen ? 'fullscreen' : 'inline'} ${columns} columns`)
  const { stdout, stderr, stdin, terminal, flush } = makeStreams(columns)
  const previousInk = instances.get(process.stdout)
  const tree = React.createElement(
    fullscreen ? AlternateScreen : React.Fragment,
    null,
    React.createElement(CopyOnSelectMount),
    React.createElement(InputConsumer),
    React.createElement(Text, null, 'line zero'),
    React.createElement(Text, null, 'hello world'),
    React.createElement(Text, null, '   '),
    React.createElement(Text, null, '  界e\u0301 z'),
    React.createElement(Text, null, 'line two'),
  )
  const instance = await render(tree, {
    stdout,
    stderr,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  // useSelection and AlternateScreen resolve the Ink instance via
  // instances.get(process.stdout); production renders to the real
  // process.stdout, so there the lookup just works. Here the render went to
  // a fake stdout, and the instance registers under that fake stdout key
  // only during render() — AFTER child components first read the map.
  // Alias the key, then re-render so useSelection's memoized stub is
  // recomputed against the real instance, and assert alt-screen state
  // explicitly (AlternateScreen's insertion effect already ran).
  const ink = instances.get(stdout)
  instances.set(process.stdout, ink)
  instance.rerender(tree)
  if (fullscreen) ink?.setAltScreenActive(true, true)

  const cleanup = async () => {
    instance.unmount()
    await flush()
    terminal.dispose()
    if (previousInk) instances.set(process.stdout, previousInk)
    else instances.delete(process.stdout)
  }
  if (!fullscreen) {
    await flush()
    check('inline does not enable mouse tracking', !stdout.frames.join('').includes('\x1b[?1006h'))
    stdin.write('\x1b[<0;2;2M\x1b[<32;10;2M\x1b[<0;10;2m')
    await sleep(100) // 固定窗:探针 inline 的鼠标字节不得创建应用选区或自动复制
    check('inline selection stays with the terminal', !ink.hasTextSelection() && !stdout.frames.join('').includes('\x1b]52;c;'))
    await cleanup()
    return
  }

  await settle(() => stdout.frames.join('').includes('\x1b[?1006h'))

  // 1. AlternateScreen mounted: alt-screen entered + mouse tracking on.
  const out0 = stdout.frames.join('')
  check('alt-screen entered (DEC 1049)', out0.includes('\x1b[?1049h'))
  check(
    'mouse tracking enabled (SGR 1000/1002/1003/1006)',
    out0.includes('\x1b[?1000h') && out0.includes('\x1b[?1006h'),
  )

  // 2. Drag-select "ello worl" on the 'hello world' row (terminal row 2,
  // 1-indexed): press at col 2, drag to col 10, release.
  stdin.write('\x1b[<0;2;2M')
  await settle(() => ink?.selection.isDragging === true)
  stdin.write('\x1b[<32;10;2M')
  await settle(() => ink?.selection.focus?.col === 9)
  check('dragging does not copy prematurely', !stdout.frames.join('').includes('\x1b]52;c;'))
  stdin.write('\x1b[<0;10;2m')
  await settle(() => stdout.frames.join('').includes('\x1b]52;c;'))

  const out1 = stdout.frames.join('')
  const osc52 = out1.match(/\x1b\]52;c;([A-Za-z0-9+/=]+)/)
  check('OSC 52 emitted on drag release', osc52 !== null)
  check(
    'clipboard payload is the selected text',
    osc52 !== null &&
      Buffer.from(osc52[1], 'base64').toString('utf8') === 'ello worl',
    osc52 ? Buffer.from(osc52[1], 'base64').toString('utf8') : 'no osc52',
  )
  check(
    'selection remains after automatic copy',
    ink?.hasTextSelection() === true && !ink.selection.isDragging,
  )
  await flush()
  const highlightedColumns = row => Array.from({ length: columns }, (_, col) => col)
    .filter(col => terminal.buffer.active.getLine(row)?.getCell(col)?.isInverse())
  check('retained highlight is visible in the terminal', JSON.stringify(highlightedColumns(1)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]))

  const copyCount = () => stdout.frames.join('').match(/\x1b\]52;c;/g)?.length ?? 0
  const beforeRepaint = copyCount()
  ink.renderNow()
  await flush()
  check('a repaint keeps the highlight without copying again', copyCount() === beforeRepaint && JSON.stringify(highlightedColumns(1)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]))
  let changes = 0
  const unsubscribe = ink.subscribeToSelectionChange(() => { changes += 1 })
  const copiesBeforeRepeat = copyCount()
  const changesBeforeRepeat = changes
  stdin.write('\x1b[<0;10;2m')
  await settle(() => changes > changesBeforeRepeat)
  await sleep(100) // 固定窗:探针 重复 release 完成后观察异步剪贴板不得再次写入
  check('repeated release does not copy again', copyCount() === copiesBeforeRepeat)
  stdin.write('\x1b')
  check('Esc clears the retained selection', await settled(() => ink?.hasTextSelection() === false))
  check('clearing a retained selection does not copy again', copyCount() === copiesBeforeRepeat)
  // A new gesture selecting the same bytes must still copy.
  stdin.write('\x1b[<0;2;2M')
  await settle(() => ink.selection.isDragging)
  stdin.write('\x1b[<32;10;2M')
  await settle(() => ink.selection.focus?.col === 9)
  stdin.write('\x1b[<0;10;2m')
  check('a new selection of the same text copies again', await settled(() => copyCount() === copiesBeforeRepeat + 1))
  ink.moveSelectionFocus('right')
  check('keyboard extension copies the updated selection', await settled(() => copyCount() === copiesBeforeRepeat + 2))
  check('keyboard extension retains the selection', ink.hasTextSelection())
  unsubscribe()

  // 3. Double-click word-select copies the word (multi-click path:
  // handleMultiClick → selectWordAt → same notify → same copy hook). The
  // copy fires on the SECOND release — while the second press is held
  // (isDragging), a drag could still extend the word selection, so the
  // clipboard is only written once the selection settles.
  stdin.write('\x1b[<0;5;2M')   // press   col 5 ('o' of hello)
  await settle(() => ink.selection.isDragging)
  stdin.write('\x1b[<0;5;2m')   // release
  await settle(() => !ink.selection.isDragging)
  stdin.write('\x1b[<0;5;2M')   // second press within the multi-click window
  await settle(() => ink.selection.anchorSpan?.kind === 'word')
  stdin.write('\x1b[<0;5;2m')   // second release → word selection settles
  await settle(() => !ink.selection.isDragging && copyCount() > copiesBeforeRepeat + 2)
  const outWord = stdout.frames.join('')
  const osc52Word = [...outWord.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)/g)].at(-1)
  check(
    'double-click word-select copies the word',
    osc52Word !== undefined &&
      Buffer.from(osc52Word[1], 'base64').toString('utf8') === 'hello',
    osc52Word ? Buffer.from(osc52Word[1], 'base64').toString('utf8') : 'no osc52',
  )
  check('word selection remains after automatic copy', ink.hasTextSelection())

  const beforeLine = copyCount()
  stdin.write('\x1b[<0;5;2M')
  await settle(() => ink.selection.anchorSpan?.kind === 'line')
  stdin.write('\x1b[<0;5;2m')
  check('triple-click copies and retains the line', await settled(() => copyCount() === beforeLine + 1 && ink.hasTextSelection() && !ink.selection.isDragging))
  await flush()
  check('line selection leaves terminal padding unhighlighted', JSON.stringify(highlightedColumns(1)) === JSON.stringify(Array.from({ length: 11 }, (_, col) => col)))

  // Multi-line drag includes a whitespace-only row and indented CJK text.
  const beforeMultiline = copyCount()
  stdin.write('\x1b[<0;1;1M')
  await settle(() => ink.selection.isDragging)
  stdin.write(`\x1b[<32;${columns};5M`)
  await settle(() => ink.selection.focus?.row === 4)
  stdin.write(`\x1b[<0;${columns};5m`)
  check('multi-line drag copies once and retains the selection', await settled(() => copyCount() === beforeMultiline + 1 && ink.hasTextSelection()))
  await flush()
  const expectedEnds = [8, 10, -1, 6, 7]
  check('painted rows exclude blanks and padding, preserving spaces and CJK width', expectedEnds.every((end, row) =>
    JSON.stringify(highlightedColumns(row)) === JSON.stringify(Array.from({ length: end + 1 }, (_, col) => col))))

  // A missing release is recovered by no-button motion. A delayed release
  // for that same gesture must not copy the retained selection a second time.
  const beforeRecovery = copyCount()
  stdin.write('\x1b[<0;2;5M')
  await settle(() => ink.selection.isDragging)
  stdin.write('\x1b[<32;6;5M')
  await settle(() => ink.selection.focus?.col === 5)
  stdin.write('\x1b[<35;6;5M')
  check('lost-release recovery copies and retains the selection', await settled(() => copyCount() === beforeRecovery + 1 && !ink.selection.isDragging && ink.hasTextSelection()))
  stdin.write('\x1b[<0;6;5m')
  await sleep(100) // 固定窗:探针 丢失 release 恢复后的迟到 release 不得重复复制
  check('delayed release after recovery does not copy again', copyCount() === beforeRecovery + 1)

  const beforeFocusOut = copyCount()
  stdin.write('\x1b[<0;2;1M')
  await settle(() => ink.selection.isDragging)
  stdin.write('\x1b[<32;6;1M')
  await settle(() => ink.selection.focus?.row === 0 && ink.selection.focus?.col === 5)
  stdin.write('\x1b[O')
  check('focus-out recovery copies and retains the selection', await settled(() => copyCount() === beforeFocusOut + 1 && !ink.selection.isDragging && ink.hasTextSelection()))
  stdin.write('\x1b[I')

  // 4. Esc cancels an in-progress drag without copying (press+drag held,
  // no release: the selection exists but has not settled).
  stdin.write('\x1b[<0;2;5M')   // press on 'line two' row
  await settle(() => ink.selection.isDragging)
  stdin.write('\x1b[<32;6;5M')  // drag held
  await settle(() => ink.selection.focus?.col === 5)
  check('mid-drag selection exists', ink?.hasTextSelection() === true)
  const before = stdout.frames.join('').match(/\x1b\]52;c;/g)?.length ?? 0
  stdin.write('\x1b')           // Esc
  await settle(() => !ink.hasTextSelection())
  const after2 = stdout.frames.join('').match(/\x1b\]52;c;/g)?.length ?? 0
  check('Esc cancels the drag (selection gone)', ink?.hasTextSelection() === false)
  check('Esc cancel copies nothing', after2 === before)

  // A press has no focus yet. Esc must cancel that gesture too, so later
  // held-button motion and release cannot resurrect it or copy any text.
  stdin.write('\x1b[<0;1;1M')
  check('a bare press starts dragging without a selection', await settled(() =>
    ink.selection.isDragging && ink.selection.focus === null && !ink.hasTextSelection()))
  const beforeBarePressCancel = copyCount()
  stdin.write('\x1b')
  check('Esc cancels a drag before its first motion', await settled(() =>
    !ink.selection.isDragging && ink.selection.anchor === null && ink.selection.focus === null))
  stdin.write('\x1b[<32;6;1M\x1b[<0;6;1m')
  await sleep(100) // 固定窗:探针 Esc 取消后的移动和松手不得重建选区或写入剪贴板
  check('motion and release after Esc cannot restore the cancelled selection',
    !ink.selection.isDragging && !ink.hasTextSelection() && ink.selection.anchor === null)
  check('motion and release after Esc do not copy', copyCount() === beforeBarePressCancel)

  await cleanup()
  const out2 = stdout.frames.join('')
  check('alt-screen exited on unmount', out2.includes('\x1b[?1049l'))
}

async function runChatEscapePriority(columns) {
  const [{ Chat }, { QuestionStore }] = await Promise.all([
    import('../lib/types/screens/Chat.js'),
    import('../lib/types/dsh-adapter/questions.js'),
  ])
  const { stdout, stderr, stdin, terminal, flush } = makeStreams(columns)
  const previousInk = instances.get(process.stdout)
  const channel = {
    version: 0, rows: [{ id: 0, kind: 'user', text: 'SELECT_ME' }],
    status: 'idle', sessionTitle: 'selection', agentId: 'selection', model: 'deepseek-v4-flash',
    tokens: { input: 0, output: 0 }, cwd: '/tmp', displayCwd: '/tmp',
    working: false, mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
    pending: [], commandList: [{ name: 'preset', description: 'Choose a preset' }],
    commandCompletions: () => [], notifications: [],
    subscribe: () => () => {}, submit() {}, cancel() {}, clear() {}, notify() {},
    listModels: async () => [], listSessions: () => [], setResumeTarget() {},
    listFiles: async () => [],
    listPresets: async () => [{ id: 'fixture', name: 'fixture', description: 'PICKER_ONLY' }],
  }
  const questionStore = new QuestionStore()
  const tree = () => React.createElement(AlternateScreen, null,
    React.createElement(Chat, { channel, questionStore, fullscreen: true, onExit() {} }))
  const app = await render(tree(), {
    stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false, terminalImages: false,
  })
  const ink = instances.get(stdout)
  instances.set(process.stdout, ink)
  app.rerender(tree())
  ink.setAltScreenActive(true, true)
  const lines = () => viewportLines(terminal)
  const copies = () => stdout.frames.join('').match(/\x1b\]52;c;/g)?.length ?? 0
  const send = async data => {
    stdin.write(data)
    await new Promise(resolve => setImmediate(resolve))
    ink.renderNow()
    await flush()
  }
  const select = async () => {
    await settle(() => findText(terminal, 'SELECT_ME') !== null)
    const { col, row } = findText(terminal, 'SELECT_ME')
    await send(`\x1b[<0;${col + 1};${row + 1}M\x1b[<32;${col + 7};${row + 1}M\x1b[<0;${col + 7};${row + 1}m`)
    check(`Chat ${columns}: transcript selection is retained`, await settled(() =>
      ink.hasTextSelection() && !ink.selection.isDragging))
  }
  try {
    await settle(() => findText(terminal, 'SELECT_ME') !== null)
    await send('\x0f') // Ctrl+O enters transcript mode, where / opens search.
    await select()
    await send('/')
    check(`Chat ${columns}: search opens over the retained selection`, await settled(() =>
      lines().some(line => line.trim() === '/') && ink.hasTextSelection()))
    await send('ESC_QUERY')
    const searchOpen = () => lines().some(line => line.trimStart().startsWith('/ESC_QUERY'))
    check(`Chat ${columns}: search query is visible`, await settled(searchOpen))
    let beforeEscape = copies()
    await send('\x1b')
    check(`Chat ${columns}: first Esc closes search and preserves selection without copying`, await settled(() =>
      !searchOpen() && ink.hasTextSelection() && copies() === beforeEscape))
    await send('\x1b')
    check(`Chat ${columns}: next Esc clears the selection without copying`, await settled(() =>
      !searchOpen() && !ink.hasTextSelection() && copies() === beforeEscape))

    await send('\x0f') // Return to the prompt to open its /preset picker.
    await select()
    await send('/preset')
    await settle(() => lines().some(line => line.includes('/preset')))
    await send('\r')
    const pickerOpen = () => lines().some(line => line.includes('PICKER_ONLY'))
    check(`Chat ${columns}: preset picker opens over the retained selection`, await settled(() =>
      pickerOpen() && ink.hasTextSelection()))
    beforeEscape = copies()
    await send('\x1b')
    check(`Chat ${columns}: first Esc closes the picker and preserves selection without copying`, await settled(() =>
      !pickerOpen() && ink.hasTextSelection() && copies() === beforeEscape))
    await send('\x1b')
    check(`Chat ${columns}: Esc clears the selection after closing the picker`, await settled(() =>
      !ink.hasTextSelection() && copies() === beforeEscape))
  } finally {
    app.unmount()
    await flush()
    terminal.dispose()
    if (previousInk) instances.set(process.stdout, previousInk)
    else instances.delete(process.stdout)
  }
}

verifyOverlay()
try {
  await run(100, true)
  await run(20, true)
  await run(20, false)
  await runChatEscapePriority(100)
  await runChatEscapePriority(36)
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
} catch (err) {
  console.error(err)
  process.exit(1)
}
