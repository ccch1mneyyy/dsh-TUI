/**
 * Native caret regression: inline/fullscreen, narrow widths, repaint ordering,
 * uninterrupted cursor-only motion, selection drags, editor handoff/clearing, focus, resize,
 * resume and cleanup, empty plugin inputs and clipped btw drafts.
 * Uses the real renderer and xterm/headless; no model or credentials required.
 * Run: node --import tsx/esm scripts/verify-native-cursor.tsx
 */
import './lib/fake-home.mjs'
import type { ReactNode } from 'react'
import type { PromptController } from '../src/components/PromptInput.js'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.TERM_PROGRAM = 'WezTerm'
delete process.env.DSH_TUI_ACCESSIBILITY
delete process.env.TMUX
delete process.env.ZELLIJ

const [
  { default: assert }, React, { Terminal: XTerm }, { PassThrough, Writable },
  { mkdtempSync, openSync, closeSync, readFileSync, rmSync }, { tmpdir }, { join },
  { render, Box, Text, InputCaret, AlternateScreen, useDeclaredCursor, useNativeCursor, useTerminalSize, useInput },
  { ListItem }, { SearchBox }, { PromptInput }, { default: instances }, { renderToScreen }, { cellAt },
  { PromptEditorLayer }, { ExtensionDialog }, { BtwComposer }, { NativeCursorContext },
  { settled, viewportLines, writeParsed }, { mock },
] = await Promise.all([
  import('node:assert/strict'), import('react'), import('@xterm/headless'), import('node:stream'),
  import('node:fs'), import('node:os'), import('node:path'), import('../src/ui.js'),
  import('../src/components/design-system/ListItem.js'), import('../src/components/SearchBox.js'),
  import('../src/components/PromptInput.js'),
  import('../src/ink/instances.js'), import('../src/ink/render-to-screen.js'), import('../src/ink/screen.js'),
  import('../src/components/PromptEditor.js'),
  import('../src/components/ExtensionDialog.js'), import('../src/components/sidePanel/btw/BtwComposer.js'),
  import('../src/ink/components/CursorDeclarationContext.js'),
  import('./lib/term-test.mjs'),
  import('node:test'),
])

const HIDE = '\x1b[?25l'
const SHOW = '\x1b[?25h'
// An external editor may override the style; picker motion never does.
const EDITOR_STYLE = '\x1b[6 q'
const DEFAULT_STYLE = '\x1b[0 q'
const TEXT = 'a中🙂b '

function makeHarness(cols: number, rows: number, appearance: { cursorStyle: 'block' | 'underline' | 'bar'; cursorBlink: boolean } = { cursorStyle: 'underline', cursorBlink: false }, synchronousWrites = false) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-native-cursor-'))
  const cleanupPath = join(dir, 'cleanup.ansi')
  const cleanupFd = openSync(cleanupPath, 'w+')
  const term = new XTerm({ cols, rows, scrollback: 100, allowProposedApi: true, ...appearance })
  const parseSynchronously = (data: string) => {
    const core = term as unknown as { _core: { _writeBuffer: { writeSync(data: string): void } } }
    core._core._writeBuffer.writeSync(data)
  }
  const frames: string[] = []
  let visible = true
  for (const [final, next] of [['h', true], ['l', false]] as const) {
    term.parser.registerCsiHandler({ prefix: '?', final }, params => {
      if (params.includes(25)) visible = next
      return false
    })
  }
  class Stdout extends Writable {
    isTTY = true
    columns = cols
    rows = rows
    fd = cleanupFd
    override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
      const data = String(chunk)
      if (data !== '') frames.push(data)
      // Emulate a terminal that ignores DEC 2026: repaint protection must
      // also work when synchronized-update markers have no effect.
      const parsed = data.replace(/\x1b\[\?2026[hl]/gu, '')
      if (synchronousWrites) {
        // Keep the real xterm parser, but avoid its own 1 ms write timer when
        // the renderer's 500 ms deadline is driven by a mocked clock.
        parseSynchronously(parsed)
        done()
      } else {
        term.write(parsed, done)
      }
    }
  }
  class Stdin extends PassThrough {
    isTTY = true
    isRaw = false
    setRawMode(raw: boolean): this { this.isRaw = raw; return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const stdout = new Stdout() as Stdout & NodeJS.WriteStream
  const stdin = new Stdin() as Stdin & NodeJS.ReadStream
  const stderr = new Writable({ write(_chunk, _encoding, done) { done() } }) as NodeJS.WriteStream
  const flush = () => new Promise<void>(resolve => { stdout.write('', () => resolve()) })
  const cursor = () => ({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY })
  const cursorStyle = () => {
    // xterm.js keeps application overrides separate from configured options.
    const modes = (term as unknown as { _core: { coreService: { decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean } } } })._core.coreService.decPrivateModes
    return { shape: modes.cursorStyle ?? term.options.cursorStyle, blinking: modes.cursorBlink ?? term.options.cursorBlink }
  }
  const find = (needle: string) => {
    const lines = viewportLines(term)
    const y = lines.findIndex(line => line.includes(needle))
    return y < 0 ? null : { x: lines[y]!.indexOf(needle), y }
  }
  const at = (x: number, y: number) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.getCell(x)
  const close = async (app: Awaited<ReturnType<typeof render>>) => {
    app.unmount()
    await flush()
    const cleanup = readFileSync(cleanupPath, 'utf8')
    if (synchronousWrites) parseSynchronously(cleanup)
    else await writeParsed(term, cleanup)
    assert.equal(visible, true, 'shutdown restores cursor visibility')
    const styled = frames.some(frame => /\x1b\[\d* q/u.test(frame))
    if (!styled) assert.ok(!/\x1b\[\d* q/u.test(cleanup), 'ordinary shutdown leaves the terminal cursor style untouched')
    assert.deepEqual(cursorStyle(), { shape: appearance.cursorStyle, blinking: appearance.cursorBlink }, 'shutdown preserves configured cursor shape and blink')
    assert.equal(term.buffer.active.type, 'normal', 'shutdown restores the main screen')
    assert.equal(stdin.isRaw, false, 'shutdown restores stdin')
    closeSync(cleanupFd)
    term.dispose()
    stdout.destroy()
    stdin.destroy()
    stderr.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
  return { term, stdout, stdin, stderr, frames, flush, cursor, cursorStyle, find, at, close, visible: () => visible }
}

function Fixture({
  column = 0, marker = 'before', focus = 'input', visible = true,
}: {
  column?: number
  marker?: string
  focus?: 'input' | 'list' | 'none'
  visible?: boolean
}): ReactNode {
  const native = useNativeCursor()
  const ref = useDeclaredCursor({ line: 0, column, active: focus === 'input', visible: native && visible })
  const { columns } = useTerminalSize()
  return <Box flexDirection="column">
    <Text>{marker}</Text>
    <Box ref={ref} marginTop={1} width={columns}><Text>{TEXT}</Text></Box>
    <ListItem isFocused={focus === 'list'}>item</ListItem>
  </Box>
}

for (const fullscreen of [false, true]) {
  for (const width of [80, 24]) {
    const h = makeHarness(width, 12)
    const wrap = (node: ReactNode) => fullscreen ? <AlternateScreen mouseTracking={false}>{node}</AlternateScreen> : node
    const app = await render(wrap(<Fixture />), {
      stdout: h.stdout, stdin: h.stdin, stderr: h.stderr,
      exitOnCtrlC: false, patchConsole: false, terminalImages: false,
    })
    const ink = instances.get(h.stdout)!
    const paint = async (node: ReactNode) => {
      const before = h.frames.length
      app.rerender(wrap(node))
      // Read the declaration after the layout effects of this commit.
      ink.onRender()
      await h.flush()
      return h.frames.slice(before).join('')
    }
    try {
      ink.onRender()
      await h.flush()
      const origin = h.find('a中🙂b')!
      assert.ok(origin, 'input text is visible')
      assert.equal(h.visible(), true, 'focused editor displays the native cursor')
      assert.deepEqual(h.cursor(), origin, 'first frame positions the cursor at the caret')

      for (const column of [1, 3, 5, 6, 0]) {
        const output = await paint(<Fixture column={column} />)
        assert.deepEqual(h.cursor(), { x: origin.x + column, y: origin.y }, 'cursor uses display cells')
        assert.equal(h.visible(), true)
        assert.ok(!output.includes(HIDE) && !output.includes(SHOW), 'cursor-only moves do not reset visibility')
        assert.ok(h.find('a中🙂b'), 'cursor motion preserves the input text')
      }
      const unchanged = await paint(<Fixture />)
      assert.equal(unchanged, '', 'unchanged frames perform no terminal writes')

      const repaint = await paint(<Fixture marker="AFTER!" />)
      assert.ok(repaint.indexOf(HIDE) >= 0 && repaint.indexOf(HIDE) < repaint.indexOf('AFTER!'), `hide before repainting: ${JSON.stringify(repaint)}`)
      assert.ok(repaint.lastIndexOf(SHOW) > repaint.indexOf('AFTER!'), 'show only after repainting and parking')
      assert.deepEqual(h.cursor(), origin)

      await paint(<Fixture marker="AFTER!" visible={false} />)
      assert.equal(h.visible(), false, 'a hidden anchor at the same coordinates hides the caret')
      await paint(<Fixture marker="AFTER!" />)
      assert.equal(h.visible(), true, 'visibility-only updates restore the caret')
      await paint(<Fixture marker="AFTER!" focus="list" />)
      assert.equal(h.visible(), false, 'list focus stays an invisible accessibility anchor')
      await paint(<Fixture marker="AFTER!" focus="none" />)
      assert.equal(h.visible(), false, 'clearing the declaration hides the caret')
      await paint(<Fixture marker="AFTER!" column={-1} />)
      assert.equal(h.visible(), false, 'a clipped caret is hidden')
      await paint(<Fixture marker="AFTER!" />)
      assert.equal(h.visible(), true, 'restoring a valid caret reclaims visibility')
      assert.deepEqual(h.cursor(), origin)

      h.term.resize(18, 8)
      h.stdout.columns = 18
      h.stdout.rows = 8
      h.stdout.emit('resize')
      ink.onRender()
      await h.flush()
      assert.ok(await settled(() => h.visible() && h.cursor().x === h.find('a中🙂b')?.x && h.cursor().y === h.find('a中🙂b')?.y), 'resize preserves the native caret')

      ink.pause()
      await writeParsed(h.term, HIDE)
      ink.resume()
      await h.flush()
      assert.equal(h.visible(), true, 'resume reasserts cursor visibility after an external handoff')
      assert.deepEqual(h.cursor(), h.find('a中🙂b'))
      ink.forceRedraw()
      await h.flush()
      assert.equal(h.visible(), true, 'full repaint restores the caret')
      assert.deepEqual(h.cursor(), h.find('a中🙂b'))
      assert.ok(!h.frames.join('').match(/\x1b\[\d* q|\x1b\](?:12|112);/u), 'the terminal owns cursor shape, blink and color')
      console.log(`PASS native cursor: ${fullscreen ? 'fullscreen' : 'inline'} ${width} cols`)
    } finally {
      await h.close(app)
    }
  }
}

// Screen-coordinate selections temporarily own the native cursor without
// replacing the editor's declaration. Drive the real SGR mouse pipeline.
function SelectionFixture({ clear, input = true, typed = '' }: {
  clear: () => void
  input?: boolean
  typed?: string
}): ReactNode {
  useInput((_input, key, event) => {
    if (key.escape) {
      clear()
      event.stopImmediatePropagation()
    }
  })
  return <Box flexDirection="column">
    <Text>DRAG a中b</Text>
    <Text>second row</Text>
    <Text> </Text>
    <Box><Text>EDITOR {typed}</Text><InputCaret active={input}>e</InputCaret><Text>dit</Text></Box>
  </Box>
}

for (const fullscreen of [false, true]) {
  for (const width of [80, 24]) {
    const h = makeHarness(width, 12)
    const clear = () => instances.get(h.stdout)?.clearTextSelection()
    const wrap = (node: ReactNode) => fullscreen ? <AlternateScreen>{node}</AlternateScreen> : node
    const app = await render(wrap(<SelectionFixture clear={clear} />), {
      stdout: h.stdout, stdin: h.stdin, stderr: h.stderr,
      exitOnCtrlC: false, patchConsole: false, terminalImages: false,
    })
    const ink = instances.get(h.stdout)!
    const write = async (data: string) => {
      const before = h.frames.length
      h.stdin.write(data)
      await new Promise<void>(resolve => setImmediate(resolve))
      ink.onRender()
      await h.flush()
      return h.frames.slice(before).join('')
    }
    const paint = async (input: boolean, typed = '') => {
      app.rerender(wrap(<SelectionFixture clear={clear} input={input} typed={typed} />))
      ink.onRender()
      await h.flush()
    }
    try {
      ink.onRender()
      await h.flush()
      const editor = h.cursor()
      assert.equal(h.visible(), true, 'the editor initially owns the native cursor')
      await write('\x1b[<0;2;1M')
      assert.deepEqual(h.cursor(), editor, 'a bare press does not steal the editor caret')
      if (!fullscreen) {
        await write('\x1b[<32;9;1M\x1b[<0;9;1m')
        assert.equal(ink.hasTextSelection(), false, 'inline selection remains terminal-owned')
        assert.deepEqual(h.cursor(), editor, 'inline mouse reports do not move the editor caret')
        console.log(`PASS native cursor selection: inline ${width} cols`)
        continue
      }
      for (const [col, edge] of [[8, 8], [6, 6], [7, 6], [2, 2], [18, 8]]) {
        await write(`\x1b[<32;${col + 1};1M`)
        assert.equal(ink.selection.isDragging, true)
        assert.deepEqual(h.cursor(), { x: edge, y: 0 }, 'cursor follows the selected text edge, excluding padding and wide-char tails')
        assert.equal(h.visible(), true, 'selection drags display the native cursor')
      }
      const motion = await write('\x1b[<32;17;1M')
      assert.deepEqual(h.cursor(), { x: 8, y: 0 }, 'moving through trailing padding keeps the cursor at the text edge')
      assert.equal(motion, '', 'padding motion with an unchanged selection edge performs no terminal writes')
      await write('\x1b[<32;5;3M')
      assert.deepEqual(h.cursor(), { x: 9, y: 1 }, 'a blank-row focus leaves the cursor on the last selected text row')
      await paint(true, 'new ')
      assert.deepEqual(h.cursor(), { x: 9, y: 1 }, 'an editor commit cannot reclaim the cursor mid-drag')
      await write('\x1b[<0;5;3m')
      assert.equal(ink.hasTextSelection(), true, 'release retains the selected text')
      assert.deepEqual(h.cursor(), { x: editor.x + 4, y: editor.y }, 'release restores the latest editor declaration')
      assert.equal(h.visible(), true)

      await write('\x1b[<0;10;2M\x1b[<32;4;2M')
      assert.deepEqual(h.cursor(), { x: 3, y: 1 })
      await write('\x1b[<32;19;1M')
      assert.deepEqual(h.cursor(), { x: 0, y: 1 }, 'reverse dragging into an unselected padding row stays at the first selected text edge')
      await write('\x1b[<32;4;1M')
      assert.deepEqual(h.cursor(), { x: 3, y: 0 }, 'reverse dragging into text follows the beginning of the selection')
      await write('\x1b')
      assert.ok(await settled(() => !ink.hasTextSelection()), 'Escape cancels the drag')
      await h.flush()
      assert.deepEqual(h.cursor(), { x: editor.x + 4, y: editor.y }, 'Escape restores the editor caret')

      await write('\x1b[<0;1;3M\x1b[<32;5;3M')
      assert.deepEqual(h.cursor(), { x: editor.x + 4, y: editor.y }, 'a wholly blank selection does not claim the cursor')
      await write('\x1b[<0;5;3m')

      await paint(false)
      assert.equal(h.visible(), false, 'without an editor the resting cursor stays hidden')
      await write('\x1b[<0;1;1M\x1b[<32;4;1M')
      assert.deepEqual(h.cursor(), { x: 3, y: 0 })
      assert.equal(h.visible(), true, 'dragging displays a cursor without an editor declaration')
      await write('\x1b[<35;4;1M')
      assert.equal(ink.selection.isDragging, false, 'no-button motion recovers a missing release')
      assert.equal(h.visible(), false, 'recovery releases cursor ownership')

      await write('\x1b[<0;10;2M\x1b[<32;4;2M')
      assert.equal(h.visible(), true)
      await write('\x1b[O')
      assert.equal(ink.selection.isDragging, false, 'focus-out ends the drag')
      assert.equal(h.visible(), false, 'focus-out releases cursor ownership')
      await write('\x1b[I')

      await write('\x1b[<0;1;1M\x1b[<32;4;1M')
      h.term.resize(18, 8)
      h.stdout.columns = 18
      h.stdout.rows = 8
      h.stdout.emit('resize')
      ink.onRender()
      await h.flush()
      assert.equal(ink.selection.isDragging, false, 'resize settles the pointer gesture')
      assert.equal(h.visible(), false, 'resize leaves no selection cursor behind')
      assert.ok(!h.frames.join('').match(/\x1b\[\d* q|\x1b\](?:12|112);/u), 'selection does not change terminal cursor styling')
      console.log(`PASS native cursor selection: fullscreen ${width} cols`)
    } finally {
      await h.close(app)
    }
  }
}

// Real text spans must remain plain; the terminal draws the only visible caret.
{
  const h = makeHarness(24, 8)
  const app = await render(<AlternateScreen mouseTracking={false}>
    <SearchBox query="a中🙂b" cursorOffset={2} isFocused isTerminalFocused={false} borderless />
  </AlternateScreen>, { stdout: h.stdout, stdin: h.stdin, stderr: h.stderr, patchConsole: false, exitOnCtrlC: false, terminalImages: false })
  try {
    instances.get(h.stdout)!.onRender()
    await h.flush()
    assert.ok(h.find('a中🙂b'), 'search preserves complete CJK and emoji text')
    assert.equal(h.visible(), true, 'terminal focus events do not suppress the native caret')
    assert.equal(h.at(h.cursor().x, h.cursor().y)?.getChars(), '🙂', 'caret lands on the emoji leader')
    assert.ok(!h.at(h.cursor().x, h.cursor().y)?.isInverse(), 'native caret has no painted duplicate')
    app.rerender(<AlternateScreen mouseTracking={false}><Box><Text>left</Text><InputCaret>中</InputCaret><Text>right</Text></Box></AlternateScreen>)
    instances.get(h.stdout)!.onRender()
    await h.flush()
    assert.equal(h.at(h.cursor().x, h.cursor().y)?.getChars(), '中', 'the shared caret anchors a wide glyph')
  } finally {
    await h.close(app)
  }
}

// Empty plugin inputs reserve their caret row even without a placeholder.
for (const fullscreen of [false, true]) {
  for (const width of [60, 24]) {
    for (const placeholder of [undefined, '']) {
      const h = makeHarness(width, 12)
      const tree = <ExtensionDialog
        dialog={{ kind: 'input', key: 'empty-input', title: 'EMPTY INPUT', initial: '', placeholder }}
        onDecide={() => {}} onCancel={() => {}}
      />
      const app = await render(fullscreen ? <AlternateScreen mouseTracking={false}>{tree}</AlternateScreen> : tree, {
        stdout: h.stdout, stdin: h.stdin, stderr: h.stderr,
        exitOnCtrlC: false, patchConsole: false, terminalImages: false,
      })
      try {
        instances.get(h.stdout)!.onRender()
        await h.flush()
        const title = h.find('EMPTY INPUT')
        assert.ok(title, 'the plugin input dialog is mounted')
        // The title's margin occupies one row; the input must keep the next.
        const origin = { x: title.x, y: title.y + 2 }
        const caretAt = (columns: number) => h.visible()
          && h.cursor().x === origin.x + columns && h.cursor().y === origin.y
        assert.ok(caretAt(0), 'an empty plugin input has a visible caret without a placeholder')

        const text = 'a中🙂b'
        h.stdin.write(text)
        assert.ok(await settled(() => h.find(text) !== null && caretAt(6)),
          'typing preserves the input row and advances by display cells')
        h.stdin.write('\x7f'.repeat([...text].length))
        assert.ok(await settled(() => h.find(text) === null && caretAt(0)),
          'Backspace to empty preserves the input row and visible caret')
        console.log(`PASS native cursor empty dialog: ${fullscreen ? 'fullscreen' : 'inline'} ${width} cols placeholder=${JSON.stringify(placeholder)}`)
      } finally {
        await h.close(app)
      }
    }
  }
}

// The painted fallback also keeps an empty input row in both blink phases.
for (const caretBlink of [true, false]) {
  const h = makeHarness(8, 4)
  const app = await render(<Box flexDirection="column">
    <NativeCursorContext.Provider value={false}>
      <SearchBox query="" placeholder="" prefix="" width={8} borderless
        placeholderAlign="left" isFocused isTerminalFocused caretBlink={caretBlink} />
    </NativeCursorContext.Provider>
    <Text>AFTER</Text>
  </Box>, {
    stdout: h.stdout, stdin: h.stdin, stderr: h.stderr,
    exitOnCtrlC: false, patchConsole: false, terminalImages: false,
  })
  try {
    instances.get(h.stdout)!.onRender()
    await h.flush()
    assert.deepEqual(h.find('AFTER'), { x: 0, y: 1 }, 'the empty painted input reserves one row')
    assert.equal(Boolean(h.at(0, 0)?.isInverse()), caretBlink, 'blinking only changes the blank caret style')
  } finally {
    await h.close(app)
  }
}

// A clipped btw draft anchors to its rendered caret, before the fixed hint.
for (const fullscreen of [false, true]) {
  for (const width of [60, 40]) {
    const h = makeHarness(width, 12)
    const draft = 'abcdef'.repeat(20)
    const wrap = (node: ReactNode) => fullscreen ? <AlternateScreen mouseTracking={false}>{node}</AlternateScreen> : node
    const tree = (text: string, caret: number, focused = true, native = true) => wrap(
      <NativeCursorContext.Provider value={native}>
        <BtwComposer state={{ text, caret }} focused={focused} busy={false} />
      </NativeCursorContext.Provider>,
    )
    const app = await render(tree(draft, draft.length, true, false), {
      stdout: h.stdout, stdin: h.stdin, stderr: h.stderr,
      exitOnCtrlC: false, patchConsole: false, terminalImages: false,
    })
    const paint = async (text: string, caret: number, focused = true, native = true) => {
      app.rerender(tree(text, caret, focused, native))
      instances.get(h.stdout)!.onRender()
      await h.flush()
    }
    try {
      instances.get(h.stdout)!.onRender()
      await h.flush()
      const row = h.find('…')?.y
      assert.notEqual(row, undefined, 'the long draft is visibly clipped')
      // Read the painted fallback from terminal cells, independently of
      // the declaration's coordinate calculation or the renderer node cache.
      const column = Array.from({ length: width }, (_, x) => x)
        .find(x => h.at(x, row!)?.isInverse())
      assert.notEqual(column, undefined, 'the painted caret stays in the clipped input')
      const fallbackRows = viewportLines(h.term)
      await paint(draft, draft.length)
      assert.equal(h.visible(), true, 'the clipped draft keeps its native caret visible')
      assert.deepEqual(h.cursor(), { x: column, y: row },
        'the caret follows the clipped text instead of landing on the hint')
      assert.deepEqual(viewportLines(h.term), fallbackRows, 'switching caret modes preserves the text layout')
      assert.ok(h.find('Enter send · Esc'), 'the fixed editing hint stays intact')

      await paint(draft, draft.length, false)
      assert.equal(h.visible(), false, 'leaving btw editing withdraws the caret')
      await paint('a中🙂b', 1)
      assert.equal(h.visible(), true)
      assert.equal(h.at(h.cursor().x, h.cursor().y)?.getChars(), '中',
        'returning to a short draft restores the caret on its actual glyph')
      assert.ok(!h.at(h.cursor().x, h.cursor().y)?.isInverse(), 'the native caret has no painted duplicate')
      await paint('a中🙂b', 2)
      assert.equal(h.at(h.cursor().x, h.cursor().y)?.getChars(), '🙂', 'the caret anchors to the emoji leader')
      console.log(`PASS native cursor clipped btw: ${fullscreen ? 'fullscreen' : 'inline'} ${width} cols`)
    } finally {
      await h.close(app)
    }
  }
}

// Pure screenshots have no terminal cursor and retain the painted fallback.
{
  const plain = renderToScreen(<InputCaret active={false}>x</InputCaret>, 8)
  const plainStyle = cellAt(plain.screen, 0, 0)!.styleId
  const { screen } = renderToScreen(<InputCaret>x</InputCaret>, 8)
  const cell = cellAt(screen, 0, 0)!
  assert.equal(cell.char, 'x')
  assert.notEqual(cell.styleId, plainStyle, 'snapshots retain a painted caret')
}

// A main composer must not reclaim a memoized secondary editor's caret when
// unrelated content commits (for example streaming output or status ticks).
{
  const h = makeHarness(80, 12)
  const channel = {
    mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
    commandList: [], commandCompletions: () => [], notifications: [], pending: [],
    working: false, notify() {}, submit() {}, steer() {}, interruptAndDeliver() { return 0 },
    removePending() { return false }, stageImage() {}, listFiles: async () => [], sessionColor: '',
  }
  const Secondary = React.memo(({ active }: { active: boolean }) =>
    <Box><Text>SECONDARY</Text><InputCaret active={active}>x</InputCaret></Box>)
  const controller: { current: PromptController | null } = { current: null }
  const tree = (secondary: boolean, marker = 'first') => <AlternateScreen mouseTracking={false}>
    <Text>{marker}</Text>
    <Secondary active={secondary} />
    <PromptInput channel={channel as never} controllerRef={controller} cursorParking={!secondary} helpOpen={false}
      onToggleHelp={() => {}} onRunCommand={() => false} selectionActive={false} />
  </AlternateScreen>
  const app = await render(tree(true), {
    stdout: h.stdout, stdin: h.stdin, stderr: h.stderr,
    exitOnCtrlC: false, patchConsole: false, terminalImages: false,
  })
  try {
    const ink = instances.get(h.stdout)!
    ink.onRender()
    await h.flush()
    const editor = h.cursor()
    assert.equal(h.at(editor.x, editor.y)?.getChars(), 'x', 'secondary editor owns the caret')
    assert.equal(h.stdin.isRaw, true, 'the input owns raw mode')
    app.rerender(tree(true, 'second'))
    ink.onRender()
    await h.flush()
    assert.deepEqual(h.cursor(), editor, 'a status commit does not steal the secondary caret')
    app.rerender(tree(false, 'second'))
    ink.onRender()
    await h.flush()
    assert.equal(h.visible(), true, 'returning focus restores the main composer caret')
    assert.notDeepEqual(h.cursor(), editor)
    assert.ok(!h.at(h.cursor().x, h.cursor().y)?.isInverse(), 'an empty prompt has no painted duplicate caret')
    controller.current!.append('FIRST' + 'a'.repeat(900) + 'ENDMARKER')
    assert.ok(await settled(() => h.find('ENDMARKER') !== null), 'long draft is visible at its end')
    h.stdin.write('\x1b[H')
    assert.ok(await settled(() => h.visible() && h.at(h.cursor().x, h.cursor().y)?.getChars() === 'F'),
      'the unfolded draft caret includes its fold-prefix width')
  } finally {
    await h.close(app)
  }
}

// The fullscreen editor lives in a separate store-driven layer. Closing it
// must return the caret to the inline value node before Ctrl+C clears it.
for (const fullscreen of [false, true]) {
  for (const width of [80, 40]) {
    const h = makeHarness(width, 24)
    const controller: { current: PromptController | null } = { current: null }
    const channel = {
      mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
      commandList: [], commandCompletions: () => [], notifications: [], pending: [],
      working: false, notify() {}, submit() {}, steer() {}, interruptAndDeliver() { return 0 },
      removePending() { return false }, stageImage() {}, listFiles: async () => [], sessionColor: '',
    }
    function EditorFixture(): ReactNode {
      // Mirror Chat's idle Ctrl+C route through the real prompt controller.
      useInput((input, key, event) => {
        if (key.ctrl && input === 'c' && controller.current?.hasText()) {
          controller.current.clear()
          event.stopImmediatePropagation()
        }
      }, { prepend: true })
      return <Box height={24} flexDirection="column" justifyContent="flex-end">
        <PromptInput channel={channel as never} controllerRef={controller} helpOpen={false}
          onToggleHelp={() => {}} onRunCommand={() => false} selectionActive={false} />
        <PromptEditorLayer />
      </Box>
    }
    const tree = <EditorFixture />
    const app = await render(fullscreen ? <AlternateScreen mouseTracking={false}>{tree}</AlternateScreen> : tree, {
      stdout: h.stdout, stdin: h.stdin, stderr: h.stderr,
      exitOnCtrlC: false, patchConsole: false, terminalImages: false,
    })
    const caretAt = (column: number) => {
      const prompt = h.find('❯')
      return prompt !== null && h.visible()
        && h.cursor().x === prompt.x + 2 + column && h.cursor().y === prompt.y
    }
    try {
      instances.get(h.stdout)!.onRender()
      await h.flush()
      for (let cycle = 0; cycle < 2; cycle++) {
        const draft = cycle === 0 ? 'draft' : 'draft\nmiddle\nend'
        const lastLine = draft.split('\n').at(-1)!
        const atDraftEnd = () => {
          const end = h.find(lastLine)
          return end !== null && h.visible()
            && h.cursor().x === end.x + lastLine.length && h.cursor().y === end.y
        }
        h.stdin.write(`\x1b[200~${draft}\x1b[201~`)
        assert.ok(await settled(() => h.find('draft') !== null), 'draft is typed into the main input')
        h.stdin.write('\x1b[69;6u')
        assert.ok(await settled(() => h.find('Draft editor') !== null), 'the fullscreen draft editor opens')
        // At 40 columns the existing editor chrome can clip the textarea;
        // verify its caret immediately when the editing area is visible.
        if (width === 80) {
          assert.ok(await settled(atDraftEnd), 'the fullscreen editor immediately claims its native caret')
        }
        h.stdin.write('\x1b')
        assert.ok(await settled(() => h.find('Draft editor') === null && atDraftEnd()), 'Esc immediately returns the caret to the main input')
        h.stdin.write('\x03')
        assert.ok(await settled(() => controller.current?.text() === '' && caretAt(0)),
          `Ctrl+C leaves a visible caret at the empty input: ${JSON.stringify({ cursor: h.cursor(), visible: h.visible(), screen: viewportLines(h.term) })}`)

        h.stdin.write('a中🙂b')
        assert.ok(await settled(() => caretAt(6) && h.find('a中🙂b') !== null), 'typing after clearing advances the native caret')
        for (const column of [5, 3, 1, 0]) {
          h.stdin.write('\x1b[D')
          assert.ok(await settled(() => caretAt(column)), 'arrow movement follows display-cell boundaries after editor handoff')
        }
        h.stdin.write('\x03')
        assert.ok(await settled(() => controller.current?.text() === '' && caretAt(0)), 'clearing the edited draft keeps the caret active')
      }
      console.log(`PASS native cursor editor handoff: ${fullscreen ? 'fullscreen' : 'inline'} ${width} cols`)
    } finally {
      await h.close(app)
    }
  }
}

// Accessibility keeps native focus anchors visible even outside text editing.
{
  process.env.DSH_TUI_ACCESSIBILITY = '1'
  const h = makeHarness(24, 8)
  const app = await render(<Fixture focus="list" />, {
    stdout: h.stdout, stdin: h.stdin, stderr: h.stderr,
    exitOnCtrlC: false, patchConsole: false, terminalImages: false,
  })
  try {
    instances.get(h.stdout)!.onRender()
    await h.flush()
    assert.equal(h.visible(), true, 'accessibility exposes the list focus anchor')
    assert.equal(h.cursor().y, h.find('item')?.y)
    app.rerender(<Text>No input</Text>)
    instances.get(h.stdout)!.onRender()
    await h.flush()
    assert.equal(h.visible(), true, 'accessibility retains visibility without an editor')
  } finally {
    await h.close(app)
    delete process.env.DSH_TUI_ACCESSIBILITY
  }
}

// Picker anchors inherit the terminal's cursor and hide exactly 500 ms after
// movement. Fake time proves the deadline without wall-clock settle races.
for (const identity of [
  { TERM_PROGRAM: 'WezTerm' },
  { TERM: 'xterm-256color' },
  { TERM_PROGRAM: 'WezTerm', TMUX: 'fixture' },
  { TERM_PROGRAM: 'WezTerm', ZELLIJ: 'fixture' },
]) for (const fullscreen of [false, true]) {
  const environment: Record<string, string | undefined> = {
    TERM_PROGRAM: undefined, TERM_PROGRAM_VERSION: undefined, TERM: undefined,
    KITTY_WINDOW_ID: undefined, TMUX: undefined, ZELLIJ: undefined, ...identity,
  }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const IdleFixture = ({ target, column = 0, marker = 'before' }: { target: 'row' | 'input' | 'none'; column?: number; marker?: string }): ReactNode => {
    const native = useNativeCursor()
    const rowRef = useDeclaredCursor({ line: 0, column, active: target === 'row', visible: native, hideOnIdle: true })
    const inputRef = useDeclaredCursor({ line: 0, column: 0, active: target === 'input', visible: native })
    return <Box flexDirection="column">
      <Box ref={rowRef}><Text>❯ row {marker}</Text></Box>
      <Box ref={inputRef} marginTop={1}><Text>input</Text></Box>
    </Box>
  }
  const h = makeHarness(24, 8, { cursorStyle: 'block', cursorBlink: true }, true)
  const wrap = (node: ReactNode) => fullscreen ? <AlternateScreen mouseTracking={false}>{node}</AlternateScreen> : node
  const app = await render(wrap(<IdleFixture target="input" />), {
    stdout: h.stdout, stdin: h.stdin, stderr: h.stderr,
    exitOnCtrlC: false, patchConsole: false, terminalImages: false,
  })
  const ink = instances.get(h.stdout)!
  const tick = async (ms: number) => {
    mock.timers.tick(ms)
    await h.flush()
  }
  const paint = async (target: 'row' | 'input' | 'none', column = 0, marker = 'before') => {
    const before = h.frames.length
    app.rerender(wrap(<IdleFixture target={target} column={column} marker={marker} />))
    ink.onRender()
    await tick(0)
    return h.frames.slice(before).join('')
  }
  try {
    ink.onRender()
    await h.flush()
    mock.timers.enable({ apis: ['setTimeout'] })
    await paint('row')
    assert.equal(h.visible(), true)
    assert.equal(h.cursor().y, h.find('row')?.y)
    assert.deepEqual(h.cursorStyle(), { shape: 'block', blinking: true }, 'moving anchors use the configured shape and blinking')
    await tick(499)
    assert.equal(h.visible(), true, 'the moving caret remains visible before 500 ms')
    await paint('row', 0, 'AFTER!')
    await tick(1)
    assert.equal(h.visible(), false, 'a stationary repaint does not extend the 500 ms deadline')
    assert.equal(await paint('row', 0, 'AFTER!'), '', 'a hidden stationary anchor stays a zero-write frame')
    await paint('row', 1)
    assert.equal(h.visible(), true, 'movement shows a hidden caret again')
    await tick(250)
    const motion = await paint('row', 3)
    assert.ok(!motion.includes(HIDE) && !motion.includes(SHOW), 'continuous cursor-only movement keeps visibility uninterrupted')
    await tick(250)
    assert.equal(h.visible(), true, 'the previous move cannot hide the newer cursor')
    await tick(249)
    assert.equal(h.visible(), true)
    await tick(1)
    assert.equal(h.visible(), false, '500 ms after the latest move hides the caret')
    await paint('row', 1)
    await paint('input')
    await tick(750)
    assert.equal(h.visible(), true, 'an input stays visible past the picker deadline')
    await paint('row')
    ink.pause()
    await tick(1000)
    ink.resume()
    await tick(0)
    assert.equal(h.visible(), true, 'resume starts a fresh visibility window')
    await tick(500)
    assert.equal(h.visible(), false)
    await paint('none')
    const cleared = h.frames.length
    await tick(1000)
    assert.equal(h.frames.length, cleared, 'clearing the declaration cancels its hide timer')
    process.env.DSH_TUI_ACCESSIBILITY = '1'
    await paint('row')
    await tick(1000)
    assert.equal(h.visible(), true, 'accessibility keeps focus anchors visible')
    delete process.env.DSH_TUI_ACCESSIBILITY
    await paint('row', 1)
    assert.ok(!/\x1b\[\d* q/u.test(h.frames.join('')), 'picker motion never overrides the terminal cursor style')
    app.unmount()
    await tick(0)
    const unmounted = h.frames.length
    await tick(1000)
    assert.equal(h.frames.length, unmounted, 'unmount cancels the pending hide timer')
    console.log(`PASS native cursor idle: ${fullscreen ? 'fullscreen' : 'inline'} ${JSON.stringify(identity)}`)
  } finally {
    mock.timers.reset()
    delete process.env.DSH_TUI_ACCESSIBILITY
    await h.close(app)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// An external editor owns the tty between enterAlternateScreen and
// exitAlternateScreen and may drive DECSCUSR itself, so the return must
// re-assert the terminal's own caret style before repainting (a text input's
// declaration writes no style changes on its own).
for (const fullscreen of [false, true]) {
  const h = makeHarness(24, 8)
  const tree = <Fixture />
  const app = await render(fullscreen ? <AlternateScreen>{tree}</AlternateScreen> : tree, {
    stdout: h.stdout, stdin: h.stdin, stderr: h.stderr,
    exitOnCtrlC: false, patchConsole: false, terminalImages: false,
  })
  const ink = instances.get(h.stdout)!
  try {
    ink.onRender()
    await h.flush()
    ink.enterAlternateScreen()
    await h.flush()
    assert.ok(h.frames.join('').includes(DEFAULT_STYLE), 'the handoff hands the terminal its caret style back')
    await writeParsed(h.term, EDITOR_STYLE)
    assert.deepEqual(h.cursorStyle(), { shape: 'bar', blinking: false }, 'the child changes the cursor style')
    const before = h.frames.length
    ink.exitAlternateScreen()
    await h.flush()
    assert.ok(h.frames.slice(before).join('').includes(DEFAULT_STYLE), 'the return from the child re-asserts the terminal caret style')
    assert.deepEqual(h.cursorStyle(), { shape: 'underline', blinking: false }, 'returning from the child recovers configured shape and blink')
  } finally {
    await h.close(app)
  }
}

console.log('native cursor regression passed')
