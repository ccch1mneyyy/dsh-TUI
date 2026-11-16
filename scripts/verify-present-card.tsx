/**
 * `present` delivery-card regression (issue #2046): the B/E design.
 *
 * Pins the three layers the card now owns:
 *  - the presenter stats a relative path against the result's `meta.cwd`
 *    (and never guesses a cwd on the pending call);
 *  - the collapsed card is one bold, clickable row per file — type badge,
 *    basename, right-aligned size/time, no directory/description until the
 *    card is expanded (a single deliverable shows them immediately);
 *  - the Nerd Font icon skin (opt-in) replaces the badge with one-cell glyphs,
 *    and the expanded card never prints the generic "no raw full text" note.
 *
 * zh is pinned; the times are built relative to "now" so the assertions do
 * not rot. Exits non-zero on any failed assertion (CI convention).
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ Writable }, React, { Terminal: XTerm }, { render }, { AssistantToolUseMessage }, { settled }, { applyNerdFontIcons }, { presentToolView }, { stringWidth }, { getTheme }, { mixColor }, { presentCardSurface }, { setMinimalUiMode }] = await Promise.all([
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
])

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
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

interface PresentedFile { path: string; description?: string; size?: number; mtimeMs?: number }

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

async function draw(options: {
  cols: number
  verbose: boolean
  files: readonly PresentedFile[]
  toolBackground?: 'none' | 'subtle' | 'strong'
}): Promise<{ screen: string; background: number }> {
  const term = new XTerm({ cols: options.cols, rows: 30, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = options.cols
    rows = 30
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  const app = await render(React.createElement(AssistantToolUseMessage, {
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
    onOpenFile: () => {},
  }), { stdout: new FakeStdout(), debug: true, exitOnCtrlC: false, patchConsole: false })
  await settled(() => screenOf(term).includes('交付'))
  await new Promise(resolve => setTimeout(resolve, 60))
  const screen = screenOf(term)
  const cell = term.buffer.active.getLine(1)?.getCell(Math.min(20, options.cols - 1))
  return { screen, background: cell?.getBgColor() ?? -1 }
}

// ── presenter: metadata only where a real cwd exists ─────────────────────
{
  const stats = (rawArgs: string, cwd?: string) => presentToolView('present', rawArgs, cwd)?.files?.[0]
  const withCwd = stats(JSON.stringify({ files: [{ path: 'package.json' }] }), process.cwd())
  const withoutCwd = stats(JSON.stringify({ files: [{ path: 'package.json' }] }))
  check('the presenter stats a relative path against the result cwd', (withCwd?.size ?? 0) > 0 && (withCwd?.mtimeMs ?? 0) > 0)
  check('the pending call never guesses a cwd', withoutCwd?.size === undefined && withoutCwd?.mtimeMs === undefined)
  check('another tool never becomes the files card', presentToolView('write', '{"files":[]}') === undefined)
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
check('no rendered line exceeds the terminal width', narrow.split('\n').every(line => stringWidth(line.trimEnd()) <= 36))

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
