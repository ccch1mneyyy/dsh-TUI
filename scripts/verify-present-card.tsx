/**
 * `present` delivery-card regression (issue #2046): the B/E design.
 *
 * Covers presentation, layout, and the expanded text boundary:
 *  - the presenter uses the settled `Presented <absolute>` paths (and never
 *    guesses a cwd on the pending call);
 *  - the collapsed card is one bold, clickable row per file — type badge,
 *    basename, right-aligned size/time, no directory/description until the
 *    card is expanded (a single deliverable shows them immediately);
 *  - the Nerd Font icon skin (opt-in) replaces the badge with one-cell glyphs,
 *    and the expanded card never prints the generic "no raw full text" note;
 *  - long paths/descriptions become readable on expansion, while zero-width
 *    text remains bounded by a character budget in both display modes.
 *
 * zh is pinned; the times are built relative to "now" so the assertions do
 * not rot. Exits non-zero on any failed assertion (CI convention).
 */
import { basename, join } from 'node:path'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen, Text, useInput }, { AssistantToolUseMessage }, { settled, sleep }, { applyNerdFontIcons }, { presentToolView }, { stringWidth }, { getTheme }, { mixColor }, { presentCardSurface }, { setMinimalUiMode }, { presentedImageFacade, previewableImages }, { thumbnailCells }, { loadSharp }, { mkdtemp, rm, writeFile }, { tmpdir }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('./lib/term-test.mjs'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/dsh-adapter/present-tool.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/theme.js'),
  import('../src/utils/colorMix.js'),
  import('../src/components/messages/presentCardBackground.js'),
  import('../src/minimalUiMode.js'),
  import('../src/components/messages/presentedImage.js'),
  import('../src/components/messages/PresentedImageThumb.js'),
  import('../src/dsh-adapter/sharp.js'),
  import('node:fs/promises'),
  import('node:os'),
])

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean, detail?: string) => {
  const context = ok || detail === undefined ? '' : ` — ${detail.replace(/\s*\n\s*/gu, ' | ')}`
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${context}`)
  if (!ok) failures++
}

const now = new Date()
const at = (hour: number, minute: number): number => {
  const date = new Date(now)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}
const yesterday = (() => {
  const date = new Date(now)
  date.setDate(date.getDate() - 1)
  date.setHours(9, 30, 0, 0)
  return date.getTime()
})()

interface PresentedFile { path: string; target?: string; description?: string; size?: number; mtimeMs?: number }

const files: PresentedFile[] = [
  {
    path: 'reports/2026-Q3-financial-summary.pdf',
    description: 'Q3 财报，给财务组复核：含分部门营收、成本与现金流明细。',
    size: Math.round(2.4 * 1024 * 1024),
    mtimeMs: at(14, 2),
  },
  { path: 'slides/kickoff.pptx', description: '路演稿', size: Math.round(8.1 * 1024 * 1024), mtimeMs: at(13, 20) },
  { path: 'notes/meeting-notes.md', description: '会议纪要', size: 12 * 1024, mtimeMs: yesterday },
]

function screenOf(term: XTerm): string {
  const buffer = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buffer.length; y++) out.push(buffer.getLine(y)?.translateToString(true) ?? '')
  return out.join('\n').replace(/\n+$/u, '')
}

function foregroundAt(term: XTerm, needle: string): number | undefined {
  for (let y = 0; y < term.buffer.active.length; y++) {
    const line = term.buffer.active.getLine(y)
    const text = line?.translateToString(true) ?? ''
    const x = text.indexOf(needle)
    if (x < 0) continue
    return line?.getCell(x)?.getFgColor()
  }
  return undefined
}

async function draw(options: {
  cols: number
  rows?: number
  verbose: boolean
  files: readonly PresentedFile[]
  toolBackground?: 'none' | 'subtle' | 'strong'
  fullscreen?: boolean
  openable?: boolean
  /** Screen sentinel to wait for; defaults to the card header. */
  waitFor?: string
}): Promise<{ screen: string; background: number; term: XTerm; output: string }> {
  const rows = options.rows ?? 30
  const term = new XTerm({ cols: options.cols, rows, scrollback: 0, allowProposedApi: true })
  let output = ''
  class FakeStdout extends Writable {
    columns = options.cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
      const text = String(chunk)
      output += text
      term.write(text, cb)
    }
  }
  const card = React.createElement(AssistantToolUseMessage, {
    tool: {
      callId: 'present-card',
      argsText: '',
      status: 'ok',
      startedAt: 0,
      durationMs: 5,
      name: 'present',
      callView: { card: 'files', files: options.files },
      resultView: { card: 'files', files: options.files },
      resultText: 'Presented files',
    },
    marginTopOnTurn: false,
    verbose: options.verbose,
    toolBackground: options.toolBackground ?? 'none',
    onOpenFile: options.openable === false ? undefined : () => {},
  })
  const stdout = new FakeStdout()
  const app = await render(options.fullscreen ? React.createElement(AlternateScreen, null, card) : card,
    { stdout, debug: true, exitOnCtrlC: false, patchConsole: false })
  check('the delivery card reaches the screen', await settled(() => screenOf(term).includes(options.waitFor ?? '交付')))
  // Drain queued frame writes and xterm parsing before reading a long body.
  await new Promise<void>(resolve => stdout.write('', resolve))
  const screen = screenOf(term)
  const cell = term.buffer.active.getLine(1)?.getCell(Math.min(20, options.cols - 1))
  const background = cell?.getBgColor() ?? -1
  app.unmount()
  return { screen, background, term, output }
}

// ── presenter: metadata only where a real cwd exists ─────────────────────
{
  const stats = (rawArgs: string, cwd?: string) => presentToolView('present', rawArgs, cwd)?.files?.[0]
  const withCwd = stats(JSON.stringify({ files: [{ path: 'package.json' }] }), process.cwd())
  const withoutCwd = stats(JSON.stringify({ files: [{ path: 'package.json' }] }))
  check('the presenter stats a relative path against the result cwd', (withCwd?.size ?? 0) > 0 && (withCwd?.mtimeMs ?? 0) > 0)
  check('a result cwd also resolves the click target',
    withCwd?.target === join(process.cwd(), 'package.json'))
  check('the pending call never guesses a cwd', withoutCwd?.size === undefined && withoutCwd?.mtimeMs === undefined)
  check('another tool never becomes the files card', presentToolView('write', '{"files":[]}') === undefined)
  const resultPath = join(process.cwd(), 'package.json')
  const resultView = presentToolView('present', JSON.stringify({ files: [{ path: 'package.json' }] }), undefined, [resultPath])?.files?.[0]
  check('the presenter uses the settled result path for metadata and opening',
    resultView?.target === resultPath && (resultView?.size ?? 0) > 0 && (resultView?.mtimeMs ?? 0) > 0)
}

// ── collapsed multi-file list ────────────────────────────────────────────
const collapsed = (await draw({ cols: 100, verbose: false, files })).screen
check('the collapsed card is one row per file', collapsed.includes('2026-Q3-financial-summary.pdf') && collapsed.includes('kickoff.pptx') && collapsed.includes('meeting-notes.md'))
check('type badges identify the files', collapsed.includes('▍PDF') && collapsed.includes('▍PPT') && collapsed.includes('▍MD'))
check('size and time are right-aligned per row', collapsed.includes('2.4 MB · 14:02') && collapsed.includes('8.1 MB · 13:20') && collapsed.includes('12 KB · 昨天'))
check('the header totals the declared size', collapsed.includes('交付(3 个文件 · 11 MB)'))
check('descriptions and directories wait for expansion', !collapsed.includes('Q3 财报') && !collapsed.includes('reports/'))

// ── expanded card: directory + description, no raw-text note ─────────────
const expanded = (await draw({ cols: 100, verbose: true, files })).screen
check('expansion adds the directory and description', expanded.includes('reports/') && expanded.includes('Q3 财报') && expanded.includes('slides/') && expanded.includes('路演稿'))
check('the files card never claims a missing raw full text', !expanded.includes('以上是整理后的视图'))

// ── one deliverable shows its detail without expanding ──────────────────
const single = (await draw({ cols: 100, verbose: false, files: [files[0]!] })).screen
check('a single deliverable shows its directory and description', single.includes('reports/') && single.includes('Q3 财报'))
check('a single deliverable totals its size', single.includes('交付(1 个文件 · 2.4 MB)'))

// ── expansion restores full identity and prose, including inline ──────────
{
  const name = `${'name-'.repeat(8)}FILENAME-MIDDLE-${'tail-'.repeat(8)}.pdf`
  const directory = `/${'directory/'.repeat(8)}DIRECTORY-MIDDLE/${'nested/'.repeat(4)}`
  const target = `${directory}${name}`
  const description = `${'说明 '.repeat(100)}DESCRIPTION-TAIL🙂`
  const delivered = [{ path: `reports/${name}`, target, description, size: 4096, mtimeMs: at(14, 2) }]
  for (const cols of [36, 80]) {
    for (const fullscreen of [false, true]) {
      const context = `${fullscreen ? 'fullscreen' : 'inline'} ${cols} cols`
      const preview = await draw({ cols, verbose: false, files: delivered, fullscreen, openable: fullscreen })
      check(`${context}: the collapsed name remains a preview`, !preview.screen.includes('FILENAME-MIDDLE'))
      const full = await draw({ cols, rows: 80, verbose: true, files: delivered, fullscreen, openable: fullscreen })
      const unwrapped = full.screen.replace(/\s+/gu, '')
      check(`${context}: expansion restores the complete resolved path`, unwrapped.includes(target))
      check(`${context}: expansion restores the description past 512 cells`,
        unwrapped.includes(description.replace(/\s+/gu, '')))
    }
  }
}

// ── zero-width text is bounded by characters, not only display cells ───────
{
  for (const verbose of [false, true]) {
    const limit = verbose ? 32_768 : 1024
    const sentinel = 'PRESENT-DESCRIPTION-BUDGET:'
    const sanitizerInputs: number[] = []
    const replace = Object.getOwnPropertyDescriptor(String.prototype, 'replace')!
    // Observe the input to ANSI cleanup, not just its later on-screen slice:
    // clipping AFTER cleanRenderText would leave the quadratic work intact.
    Object.defineProperty(String.prototype, 'replace', {
      ...replace,
      value(this: unknown, ...args: unknown[]): string {
        if (typeof this === 'string' && this.startsWith(sentinel)) sanitizerInputs.push(this.length)
        return Reflect.apply(replace.value, this, args) as string
      },
    })
    let shot: Awaited<ReturnType<typeof draw>>
    try {
      shot = await draw({
        cols: 80,
        verbose,
        files: [{ path: 'report.pdf', description: `${sentinel}e${'\u0301'.repeat(100_000)}DESCRIPTION-END` }],
      })
    } finally {
      Object.defineProperty(String.prototype, 'replace', replace)
    }
    check(`${verbose ? 'expanded' : 'collapsed'}: the input is capped before sanitization`,
      sanitizerInputs.length > 0 && sanitizerInputs.every(length => length <= limit))
    const markRuns = shot.output.match(/\u0301+/gu) ?? []
    check(`${verbose ? 'expanded' : 'collapsed'}: description processing has a character budget`,
      markRuns.length > 0 && markRuns.every(run => run.length <= (verbose ? 32_768 : 1024)))
    check(`${verbose ? 'expanded' : 'collapsed'}: a safety cut is visible`,
      shot.screen.includes('…') && !shot.screen.includes('DESCRIPTION-END'))
    const boundary = await draw({
      cols: 80,
      verbose,
      files: [{ path: 'report.pdf', description: `e${'\u0301'.repeat(limit - 2)}🙂TAIL` }],
    })
    check(`${verbose ? 'expanded' : 'collapsed'}: the character cut never splits a surrogate pair`,
      !/[\uD800-\uDFFF]/u.test(boundary.output) && !boundary.output.includes('\uFFFD'))
  }
}

// ── Nerd Font icon skin ──────────────────────────────────────────────────
applyNerdFontIcons(true)
const icons = (await draw({ cols: 100, verbose: false, files })).screen
applyNerdFontIcons(false)
check('the icon skin replaces badges with Nerd Font glyphs', icons.includes('\uf1c1') && icons.includes('\uf1c4') && icons.includes('\uf48a'))
check('the icon skin does not leak the badge text', !icons.includes('▍PDF') && !icons.includes('▍PPT'))

// ── narrow terminal: nothing overflows, size survives ───────────────────
const narrow = (await draw({ cols: 36, verbose: false, files })).screen
const html = (await draw({ cols: 100, verbose: false, files: [{ path: 'site/index.html', size: 2048 }] })).screen
check('a four-cell badge keeps the full HTML abbreviation', html.includes('▍HTML'))
check('a narrow card keeps the names and sizes', narrow.includes('2.4 MB') && narrow.includes('12 KB'))
const narrowRows = narrow.split('\n')
check('narrow rows keep each badge and size on one physical line',
  narrowRows.some(line => line.includes('▍PDF') && line.includes('2.4 MB'))
  && narrowRows.some(line => line.includes('▍PPT') && line.includes('8.1 MB'))
  && narrowRows.some(line => line.includes('▍MD') && line.includes('12 KB')))
check('no rendered line exceeds the terminal width', narrow.split('\n').every(line => stringWidth(line.trimEnd()) <= 36))

// ── hostile/edge file names and descriptions ─────────────────────────────
const proto = await draw({
  cols: 100,
  verbose: false,
  files: [{ path: 'x.constructor', size: 1 }],
  waitFor: 'FIL',
})
check('prototype-named extensions do not crash the card',
  !proto.screen.includes('viewLines') && proto.screen.includes('x.constructor') && proto.screen.includes('FIL'))
applyNerdFontIcons(true)
const protoIcons = await draw({
  cols: 100,
  verbose: false,
  files: [{ path: 'x.constructor', size: 1 }],
  waitFor: '\uf15b',
})
applyNerdFontIcons(false)
check('prototype-named extensions keep the icon skin clean',
  !protoIcons.screen.includes('function') && protoIcons.screen.includes('\uf15b'))

const badges = (await draw({
  cols: 100,
  verbose: false,
  files: [{ path: 'sheet.xls', size: 1 }, { path: 'photo.jpg', size: 1 }, { path: 'track.mp3', size: 1 }],
})).screen
check('common file types keep their own badges',
  badges.includes('▍XLS') && badges.includes('▍JPG') && badges.includes('▍MP3'))

const ansi = await draw({
  cols: 100,
  verbose: false,
  files: [{ path: 'q3.pdf', description: 'safe \u001b[31mPWN\u001b[0m text', size: 1 }],
})
const safeFg = foregroundAt(ansi.term, 'safe')
const pwnFg = foregroundAt(ansi.term, 'PWN')
check('model ANSI in a description does not style the card',
  safeFg !== undefined && pwnFg !== undefined && safeFg === pwnFg)
check('the description keeps its visible text', ansi.screen.includes('safe PWN text'))

const newline = (await draw({
  cols: 100,
  verbose: false,
  files: [{ path: 'reports/\nEVIL.pdf', size: 10 }],
})).screen
check('a newline in a delivered path stays on the file row',
  newline.split('\n').some(line => line.includes('▍PDF') && line.includes('EVIL.pdf')))

// ── inline thumbnail: one image per card, bounded cells ───────────────────
{
  const png = { path: 'shots/verified.png', target: '/artifacts/shots/verified.png' }
  const other = { path: 'shots/other.png', target: '/artifacts/shots/other.png' }
  const json = { path: 'out/submission.json', target: '/artifacts/out/submission.json' }
  check('one image deliverable is the inline thumbnail',
    JSON.stringify(previewableImages([png, json])) === JSON.stringify(['/artifacts/shots/verified.png']))
  check('several image deliverables become the strip, in delivery order',
    JSON.stringify(previewableImages([png, other, json]))
      === JSON.stringify(['/artifacts/shots/verified.png', '/artifacts/shots/other.png']))
  check('a relative-only image cannot be painted without a session cwd',
    previewableImages([{ path: 'shots/relative.png' }]).length === 0)
  check('a non-image delivery never paints', previewableImages([json]).length === 0)
  check('an empty delivery never paints', previewableImages([]).length === 0)
  check('the same file listed twice paints once', previewableImages([png, { ...png }]).length === 1)

  const square = { width: 1280, height: 1280 }
  check('a 16:9 deliverable lands on the 32-column cap and 9 rows',
    JSON.stringify(thumbnailCells({ width: 1280, height: 720 }, 94, { width: 10, height: 20 }))
      === JSON.stringify({ columns: 32, rows: 9 }))
  check('a square image is height-bound',
    JSON.stringify(thumbnailCells(square, 94, { width: 10, height: 20 }))
      === JSON.stringify({ columns: 18, rows: 9 }))
  check('a tall image that would need fewer than 12 cells is skipped',
    thumbnailCells({ width: 300, height: 900 }, 94, { width: 10, height: 20 }) === undefined)
  check('a narrow card is skipped', thumbnailCells(square, 10, { width: 10, height: 20 }) === undefined)
  check('an unmeasured cell size still fits with the conventional 1:2 cell',
    JSON.stringify(thumbnailCells({ width: 1280, height: 720 }, 94, undefined))
      === JSON.stringify({ columns: 32, rows: 9 }))
  check('the 32-column cap holds however wide the card is',
    thumbnailCells(square, 400, { width: 10, height: 20 })?.columns === 18)
}

// ── terminal without graphics: delivery images add no phantom rows ───────
{
  const sharp = await loadSharp()
  if (sharp === undefined) {
    console.log('SKIP delivery-image layout: optional sharp decoder is unavailable')
  } else {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-present-image-'))
    try {
      const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#3366cc' } })
        .png().toBuffer()
      const imagePaths = Array.from({ length: 9 }, (_, index) => join(root, `delivered-${index}.png`))
      await Promise.all(imagePaths.map(path => writeFile(path, png)))
      // Warm the facade cache so the thumbnail's async probe is already
      // resolved when the frame under test commits: otherwise even a buggy
      // suppression placeholder would not exist yet and the assertion could
      // pass for the wrong reason.
      await presentedImageFacade(imagePaths[0]!)

      class CardStdout extends Writable {
        columns = 100
        rows = 24
        isTTY = true
        _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
          term.write(String(chunk), done)
        }
      }
      const term = new XTerm({ cols: 100, rows: 24, scrollback: 0, allowProposedApi: true })
      const stdout = new CardStdout()
      const endRow = (): number => screenOf(term).split('\n')
        .findIndex(line => line.includes('END-OF-CARD'))
      const settleFrames = async (): Promise<void> => {
        await new Promise<void>(resolve => stdout.write('', resolve))
        await settled(() => endRow() >= 0)
        // 固定窗:探针 预热后的 facade 状态落定不改变渲染输出，帧事件观察不到。
        await sleep(80)
        await new Promise<void>(resolve => stdout.write('', resolve))
      }
      const card = (paths: readonly string[], suppressed: boolean) => {
        // A directory makes a single deliverable emit its detail row, which
        // is the row the thumbnail's separator sits before.
        const files = paths.map(path => ({ path: `shots/${basename(path)}`, target: path, size: png.byteLength }))
        return (
          <AlternateScreen>
            <AssistantToolUseMessage
              tool={{
                callId: 'present-image-layout',
                argsText: '',
                status: 'ok',
                startedAt: 0,
                durationMs: 5,
                name: 'present',
                callView: { card: 'files', files },
                resultView: { card: 'files', files },
                resultText: 'Presented',
              }}
              marginTopOnTurn={false}
              verbose={false}
              onOpenFile={() => {}}
              onPreviewFile={() => {}}
              suppressImageGraphics={suppressed}
            />
            <Text>END-OF-CARD</Text>
          </AlternateScreen>
        )
      }
      const app = await render(card([imagePaths[0]!], false),
        { stdout: stdout as never, debug: true, exitOnCtrlC: false, patchConsole: false })
      await settleFrames()
      const paintedRow = endRow()
      const textOnlyCard = screenOf(term)
      check('a text-only terminal paints no delivery thumbnail rows', paintedRow >= 0)
      app.rerender(card([imagePaths[0]!], true))
      await settleFrames()
      check('R1: opening a preview keeps an unpainted thumbnail at zero rows',
        endRow() === paintedRow && screenOf(term) === textOnlyCard,
        `painted=${paintedRow} suppressed=${endRow()}`)

      // A single image receipt must be exactly as tall as the same receipt
      // for a file the terminal has no picture for — with a detail row below
      // the thumbnail, and with the image file missing entirely.
      app.rerender(card([imagePaths[0]!], false))
      await settleFrames()
      const singleImageRow = endRow()
      app.rerender(card([join(root, 'data.json')], false))
      await settleFrames()
      check('R2: a single image deliverable adds no spacer row', singleImageRow === endRow(),
        `image=${singleImageRow} plain=${endRow()}`)
      app.rerender(card([join(root, 'missing.png')], false))
      await settleFrames()
      check('R2: a missing single image adds no spacer row', singleImageRow === endRow(),
        `image=${singleImageRow} missing=${endRow()}`)

      app.rerender(card(imagePaths.slice(0, 2), false))
      await settleFrames()
      const stripRow = endRow()
      app.rerender(card([join(root, 'data-0.json'), join(root, 'data-1.json')], false))
      await settleFrames()
      check('R2: a multi-image sheet adds no leading blank row', stripRow === endRow(),
        `strip=${stripRow} plain=${endRow()}`)

      app.rerender(card(imagePaths, false))
      await settleFrames()
      const manyRow = endRow()
      check('R2: a text-only terminal never advertises hidden tiles',
        !screenOf(term).includes('另有 1 张图'), screenOf(term))
      app.rerender(card(Array.from({ length: 9 }, (_, index) => join(root, `data-${index}.json`)), false))
      await settleFrames()
      check('R2: a nine-image receipt is as tall as the plain one', manyRow === endRow(),
        `strip=${manyRow} plain=${endRow()}`)

      app.unmount()
      term.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

// ── click routing: an image row previews, every other row opens the menu ──
{
  /** First visible cell of `needle`; every preceding glyph in these rows is
   *  single-width, so the JS index is also the display column. */
  function cellOf(term: XTerm, needle: string): { col: number; row: number } | undefined {
    for (let row = 0; row < term.buffer.active.length; row++) {
      const text = term.buffer.active.getLine(row)?.translateToString(true) ?? ''
      const col = text.indexOf(needle)
      if (col >= 0) return { col, row }
    }
    return undefined
  }

  // Ink attaches its stdin listener only once some component subscribes to
  // input; the card alone never does. A no-op subscriber keeps the click
  // harness honest (keys are not part of this test).
  function InputOwner(): React.ReactNode {
    useInput(() => {})
    return null
  }

  // Ink's input lifecycle calls ref/unref/setRawMode on the stream; a bare
  // PassThrough has none of them.
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    override ref(): this { return this }
    override unref(): this { return this }
  }

  /** Render one card fullscreen (mouse tracking on), click the file name,
   *  and report which handler the click reached. */
  const clickRow = async (path: string, withPreview: boolean): Promise<{ previewed: string[]; opened: string[] }> => {
    const previewed: string[] = []
    const opened: string[] = []
    const term = new XTerm({ cols: 100, rows: 24, scrollback: 0, allowProposedApi: true })
    class ClickStdout extends Writable {
      columns = 100
      rows = 24
      isTTY = true
      _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
    }
    const stdin = new FakeStdin()
    const file = { path, target: path, size: 1024 }
    const card = React.createElement(AssistantToolUseMessage, {
      tool: {
        callId: 'present-click',
        argsText: '',
        status: 'ok',
        startedAt: 0,
        durationMs: 5,
        name: 'present',
        callView: { card: 'files', files: [file] },
        resultView: { card: 'files', files: [file] },
      },
      marginTopOnTurn: false,
      verbose: false,
      onOpenFile: (target: string) => { opened.push(target) },
      ...(withPreview ? { onPreviewFile: (target: string) => { previewed.push(target) } } : {}),
    })
    const app = await render(React.createElement(AlternateScreen, null, React.createElement(InputOwner), card), {
      stdin: stdin as never, stdout: new ClickStdout() as never, exitOnCtrlC: false, patchConsole: false,
    })
    const name = path.slice(path.lastIndexOf('/') + 1)
    const drawn = await settled(() => screenOf(term).includes(name))
    check(`the clickable row for ${name} reaches the screen`, drawn, screenOf(term))
    const point = drawn ? cellOf(term, name) : undefined
    check(`${name}: the name is locatable for a click`, point !== undefined, screenOf(term))
    if (point !== undefined) {
      stdin.write(`\x1b[<0;${point.col + 1};${point.row + 1}M`)
      stdin.write(`\x1b[<0;${point.col + 1};${point.row + 1}m`)
    }
    await settled(() => previewed.length > 0 || opened.length > 0)
    app.unmount()
    return { previewed, opened }
  }

  const image = await clickRow('/artifacts/kaggle-stable05-verified.png', true)
  check('an image deliverable opens the shared preview instead of the file menu',
    image.previewed.length === 1 && image.previewed[0] === '/artifacts/kaggle-stable05-verified.png'
    && image.opened.length === 0,
    `previewed=${image.previewed.join(',')} opened=${image.opened.join(',')}`)

  const data = await clickRow('/artifacts/kaggle-stable05-submission.json', true)
  check('a non-image deliverable keeps the file-action menu',
    data.opened.length === 1 && data.previewed.length === 0,
    `previewed=${data.previewed.join(',')} opened=${data.opened.join(',')}`)

  const legacy = await clickRow('/artifacts/legacy-shot.png', false)
  check('without a preview handler an image row keeps the file-action menu',
    legacy.opened.length === 1 && legacy.previewed.length === 0,
    `previewed=${legacy.previewed.join(',')} opened=${legacy.opened.join(',')}`)
}

// ── delivery surfaces: warm for none, lavender over subtle/strong ─────────
{
  const theme = getTheme('dark')
  const rgbInt = (color: string): number => {
    const match = /^rgb\((\d+),(\d+),(\d+)\)$/u.exec(color)
    if (match === null) throw new Error(`not an rgb() colour: ${color}`)
    return (Number(match[1]) << 16) | (Number(match[2]) << 8) | Number(match[3])
  }
  check('the dark subtle face is 20% deep violet over the dim card surface',
    mixColor(theme.toolCardBackgroundDim, theme.presentCardTint, 0.20) === 'rgb(40,36,73)')
  check('the warm face is the palette token when backgrounds are off',
    presentCardSurface('none', theme).background === theme.presentCardWarm)
  check('hover lifts the same hue toward white',
    presentCardSurface('subtle', theme).hover === 'rgb(53,49,84)')
  const light = getTheme('light')
  check('light palettes keep the soft lavender',
    presentCardSurface('subtle', light).background === 'rgb(240,239,255)')
  const custom = { ...theme, toolCardBackground: '#ABC', text: '#333' }
  const customSurface = presentCardSurface('subtle', custom)
  check('custom short-hex themes keep the delivery tint',
    /^rgb\(/u.test(customSurface.background) && customSurface.hover !== customSurface.background)
  check('mixColor expands #rgb and ignores #rrggbbaa alpha',
    mixColor('#ABC', '#ADA6FF', 0.2) === 'rgb(171,183,214)'
    && mixColor('#AABBCCDD', '#ADA6FF', 0.2) === mixColor('#AABBCC', '#ADA6FF', 0.2))

  const noneShot = await draw({ cols: 100, verbose: false, files, toolBackground: 'none' })
  check('a none-background card paints the warm delivery face',
    noneShot.background === rgbInt(theme.presentCardWarm))
  const subtleShot = await draw({ cols: 100, verbose: false, files, toolBackground: 'subtle' })
  check('a subtle card paints the dark violet face',
    subtleShot.background === rgbInt(presentCardSurface('subtle', theme).background))
  const strongShot = await draw({ cols: 100, verbose: false, files, toolBackground: 'strong' })
  check('a strong card paints the deeper violet face',
    strongShot.background === rgbInt(presentCardSurface('strong', theme).background))

  setMinimalUiMode(true)
  const minimalShot = await draw({ cols: 100, verbose: false, files, toolBackground: 'none' })
  setMinimalUiMode(false)
  check('the minimal UI drops the delivery face', minimalShot.background === -1)
}

console.log(results.join('\n'))
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nALL PASS')
process.exit(0)
