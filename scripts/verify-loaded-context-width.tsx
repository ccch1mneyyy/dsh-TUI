/**
 * LoadedContextPanel narrow-terminal regression (issue #167): the collapsed
 * summary must stay on one physical row instead of interleaving with its hint.
 * Run: node --import tsx/esm scripts/verify-loaded-context-width.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { Terminal: XTerm }, { render, ThemeProvider }, { LoadedContextPanel }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/components/LoadedContextPanel.js'),
  ])

const COLS = 60
const ROWS = 8
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true

  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    term.write(String(chunk), callback)
  }
}

const context = {
  sections: Array.from({ length: 16 }, (_, i) => ({
    name: `section-${i}`,
    text: `System prompt section ${i}`,
  })),
  contexts: Array.from({ length: 2 }, (_, i) => ({
    name: `runtime-${i}`,
    text: `Runtime context ${i}`,
  })),
  files: [],
  skills: Array.from({ length: 7 }, (_, i) => ({
    name: `skill-${i}`,
    description: `Skill ${i}`,
  })),
  tools: Array.from({ length: 25 }, (_, i) => ({
    name: `tool-${i}`,
    description: `Tool ${i}`,
  })),
}

const app = await render(
  <ThemeProvider theme="dark">
    <LoadedContextPanel context={context} open={false} onToggle={() => {}} />
  </ThemeProvider>,
  {
    stdout: new FakeStdout() as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

await new Promise(resolve => setTimeout(resolve, 300))

const lines = Array.from(
  { length: ROWS },
  (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '',
)
const contentLines = lines.filter(line => line.trim() !== '')

await app.unmount()

if (contentLines.length !== 1) {
  throw new Error(
    `Collapsed context summary occupied ${contentLines.length} rows at ${COLS} columns:\n${contentLines.join('\n')}`,
  )
}
if (!contentLines[0]?.includes('Context loaded')) {
  throw new Error(`Collapsed context summary was not rendered: ${contentLines[0] ?? ''}`)
}
if (!contentLines[0]?.includes('Ctrl+P')) {
  throw new Error(`Collapsed context summary lost the expand hint: ${contentLines[0] ?? ''}`)
}

process.stdout.write('loaded context narrow-width regression passed\n')
