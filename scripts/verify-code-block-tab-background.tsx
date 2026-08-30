/**
 * Regression for issue #606: a TAB inside a background region (code blocks)
 * must keep that background across its expanded columns. writeLineToScreen
 * expanded tabs at stylePool.none, so the columns dropped the bg and the diff's
 * empty-cell optimization skipped them — showing the terminal default bg (black
 * under tmux / Windows Terminal) while the rest of the line kept its bg.
 *
 * Run: node --import tsx/esm scripts/verify-code-block-tab-background.tsx
 */

process.env.FORCE_COLOR = '3'

const [{ default: Output }, screen, { applyTextStyles }] = await Promise.all([
  import('../src/ink/output.js'),
  import('../src/ink/screen.js'),
  import('../src/ink/colorize.js'),
])

const { StylePool, CharPool, HyperlinkPool, createScreen, visibleCellAtIndex } = screen

const WIDTH = 40
const TAB_STOP = 8
const BG = '#5f5f5f' // the (95,95,95) code-block grey from the issue

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()
const buffer = createScreen(WIDTH, 1, stylePool, charPool, hyperlinkPool)
const output = new Output({ width: WIDTH, height: 1, stylePool, screen: buffer })

// A background-styled line starting with a tab (a code line inside a bg Box).
const line = applyTextStyles('\tX', { backgroundColor: BG })
output.write(0, 0, line)
const painted = output.get()

// Tab at column 0 expands to column 8, where 'X' lands; its style is the
// reference for "background present here".
const xCell = visibleCellAtIndex(painted.cells, painted.charPool, painted.hyperlinkPool, TAB_STOP, -1)
if (!xCell || xCell.char !== 'X') {
  throw new Error(`expected 'X' at column ${TAB_STOP}, got ${JSON.stringify(xCell)}`)
}
const bgStyleId = xCell.styleId

const failures: string[] = []
for (let x = 0; x < TAB_STOP; x++) {
  const cell = visibleCellAtIndex(painted.cells, painted.charPool, painted.hyperlinkPool, x, -1)
  if (!cell) {
    failures.push(`col ${x}: tab cell unstyled — skipped by the diff (terminal default bg)`)
  } else if (cell.styleId !== bgStyleId) {
    failures.push(`col ${x}: styleId ${cell.styleId} != 'X' background styleId ${bgStyleId}`)
  }
}

if (failures.length > 0) {
  throw new Error('tab indentation lost the code-block background:\n  ' + failures.join('\n  '))
}

process.stdout.write('code-block tab background regression passed\n')

