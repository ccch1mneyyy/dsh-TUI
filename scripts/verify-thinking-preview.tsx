/**
 * AssistantThinkingMessage live-preview height regression.
 *
 * The preview body is a fixed three-row Yoga box. Render at a narrow, fixed
 * width and verify that the following sentinel remains four rows below the
 * thinking header (one header row plus three body rows).
 *
 * Run: node --import tsx/esm scripts/verify-thinking-preview.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { Terminal: XTerm }, { render, Box, Text }, { AssistantThinkingMessage }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/components/messages/AssistantThinkingMessage.js'),
  ])

const COLS = 32
const ROWS = 12
const EXPECTED_HEADER_TO_SENTINEL = 4

const cases = [
  ['short thinking', 'brief'],
  ['single-line thinking', 'one complete line of thinking'],
  [
    'long thinking',
    Array.from({ length: 8 }, (_, i) => `reasoning line ${i} with enough text to truncate`).join('\n'),
  ],
] as const

async function renderCase(thinking: string): Promise<string[]> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }

  const app = await render(
    <Box flexDirection="column" width={COLS}>
      <AssistantThinkingMessage thinking={thinking} addMargin={false} verbose={false} preview />
      <Box height={1}>
        <Text>preview-sentinel</Text>
      </Box>
    </Box>,
    {
      stdout: new FakeStdout() as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  await new Promise(resolve => setTimeout(resolve, 100))
  const lines = Array.from(
    { length: ROWS },
    (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '',
  )
  await app.unmount()
  term.dispose()
  return lines
}

for (const [name, thinking] of cases) {
  const lines = await renderCase(thinking)
  const header = lines.findIndex(line => line.includes('Thinking'))
  const sentinel = lines.findIndex(line => line.includes('preview-sentinel'))
  const distance = sentinel - header
  if (header < 0 || sentinel < 0 || distance !== EXPECTED_HEADER_TO_SENTINEL) {
    throw new Error(
      `${name}: expected sentinel ${EXPECTED_HEADER_TO_SENTINEL} rows after header, ` +
        `got header=${header}, sentinel=${sentinel}, distance=${distance}\n${lines.join('\n')}`,
    )
  }
  console.log(`PASS: ${name} preview block is ${EXPECTED_HEADER_TO_SENTINEL - 1} body rows`)
}

console.log('AssistantThinkingMessage preview height regression passed')
