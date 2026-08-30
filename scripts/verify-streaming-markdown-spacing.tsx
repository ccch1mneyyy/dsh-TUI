/**
 * StreamingMarkdown stable-prefix/suffix spacing regression.
 *
 * The incremental renderer splits completed Markdown blocks from the growing
 * tail. Its two halves must have the same display-row spacing as one ordinary
 * Markdown render: real paragraph gaps stay, but a fenced code block followed
 * directly by prose must not gain an invented blank row.
 *
 * Run: node --import tsx/esm scripts/verify-streaming-markdown-spacing.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [
  { Writable },
  React,
  { Terminal: XTerm },
  { render, Box, Text },
  { Markdown },
  { StreamingMarkdown },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/Markdown.js'),
  import('../src/components/StreamingMarkdown.js'),
])

const COLS = 56
const ROWS = 30
const START = 'spacing-start'
const END = 'spacing-end'

async function renderRows(sources: string | readonly string[], streaming: boolean): Promise<string[]> {
  const stages = typeof sources === 'string' ? [sources] : sources
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }

  const tree = (source: string): React.ReactNode => (
    <Box flexDirection="column" width={COLS}>
      <Text>{START}</Text>
      {streaming
        ? <StreamingMarkdown>{source}</StreamingMarkdown>
        : <Markdown>{source}</Markdown>}
      <Text>{END}</Text>
    </Box>
  )
  const app = await render(tree(stages[0]!), {
    stdout: new FakeStdout() as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  for (const stage of stages.slice(1)) {
    await new Promise(resolve => setTimeout(resolve, 60))
    app.rerender(tree(stage))
  }
  await new Promise(resolve => setTimeout(resolve, 150))
  const screen = Array.from(
    { length: ROWS },
    (_, y) => term.buffer.active.getLine(y)?.translateToString(true).trimEnd() ?? '',
  )
  const start = screen.findIndex(line => line.includes(START))
  const end = screen.findIndex(line => line.includes(END))
  await app.unmount()
  term.dispose()
  if (start < 0 || end <= start) {
    throw new Error(`sentinels missing: start=${start}, end=${end}\n${screen.join('\n')}`)
  }
  return screen.slice(start + 1, end)
}

const cases: readonly {
  name: string
  source: string
  stages?: readonly string[]
}[] = [
  { name: 'paragraph gap', source: 'alpha\n\nbeta' },
  { name: 'heading gap', source: '## alpha\nbeta' },
  {
    name: 'incremental code-to-prose adjacency',
    source: '```\nconst value = 1\n```\nbeta',
    stages: ['```\nconst value = 1\n```', '```\nconst value = 1\n```\nbeta'],
  },
  { name: 'list paragraph gap', source: '- alpha\n- beta\n\ngamma' },
  { name: 'table paragraph gap', source: '| a | b |\n| - | - |\n| 1 | 2 |\n\ntail' },
  {
    name: 'incremental table-to-table gap',
    source: '| a |\n| - |\n| 1 |\n\n| b |\n| - |\n| 2 |',
    stages: ['| a |\n| - |\n| 1 |', '| a |\n| - |\n| 1 |\n\n| b |\n| - |\n| 2 |'],
  },
  {
    name: 'invisible definition spacing',
    source: 'alpha\n\n[ref]: /x\n\nbeta',
    stages: ['alpha', 'alpha\n\n[ref]: /x', 'alpha\n\n[ref]: /x\n\nbeta'],
  },
  {
    name: 'invisible HTML spacing',
    source: 'alpha\n\n<div>hidden</div>\n\nbeta',
    stages: ['alpha', 'alpha\n\n<div>hidden</div>', 'alpha\n\n<div>hidden</div>\n\nbeta'],
  },
]

for (const { name, source, stages } of cases) {
  const expected = await renderRows(source, false)
  const actual = await renderRows(stages ?? source, true)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${name}: StreamingMarkdown spacing diverged\n` +
      `expected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`,
    )
  }
  console.log(`PASS: ${name}`)
}

console.log('StreamingMarkdown spacing regression passed')
