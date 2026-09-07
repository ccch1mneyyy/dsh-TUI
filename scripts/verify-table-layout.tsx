/** Focused MarkdownTable layout regression. Run with:
 * node --import tsx/esm scripts/verify-table-layout.tsx
 */
process.env.FORCE_COLOR = '3'

const [assertModule, React, { renderToScreen }, { cellAt }, { MarkdownTable }, { TerminalSizeContext }, { formatToken }] = await Promise.all([
  import('node:assert/strict'),
  import('react'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/components/MarkdownTable.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/terminal-utils/markdown.js'),
])
const assert = assertModule.default

type Cell = { text: string; tokens: [{ type: 'text'; raw: string; text: string }] }
type Table = {
  type: 'table'
  raw: string
  header: Cell[]
  align: Array<'left' | 'center' | 'right' | null>
  rows: Cell[][]
}

function cell(text: string): Cell {
  return { text, tokens: [{ type: 'text', raw: text, text }] }
}

function table(header: string[], rows: string[][]): Table {
  return {
    type: 'table',
    raw: '',
    header: header.map(cell),
    align: header.map(() => null),
    rows: rows.map(row => row.map(cell)),
  }
}

function lines(element: React.ReactElement, width: number): string[] {
  const screen = renderToScreen(element, width)
  return Array.from({ length: screen.height }, (_, row) =>
    Array.from({ length: width }, (_, column) => cellAt(screen.screen, column, row)?.char ?? '').join('').trimEnd(),
  )
}

function render(token: Table, width: number): string[] {
  return lines(
    <TerminalSizeContext.Provider value={{ columns: width, rows: 40 }}>
      <MarkdownTable token={token as never} highlight={null} forceWidth={width} />
    </TerminalSizeContext.Provider>,
    width,
  )
}

const wide = render(table(['Name', 'State'], [['alpha', 'ready'], ['beta', 'queued']]), 40)
assert.equal(wide[0]?.startsWith('┌'), true, 'wide table has a top border')
assert.equal(wide.at(-1)?.startsWith('└'), true, 'wide table has a bottom border')
assert.ok(wide.every(line => line.length <= 40), 'wide table stays within its budget')
assert.ok(wide.some(line => line.includes('alpha')))
assert.ok(wide.some(line => line.includes('queued')))

const wrapped = render(table(['Key', 'Value'], [['long', 'abcdefghijklmno']]), 18)
assert.ok(wrapped.every(line => line.length <= 18), 'long words do not overflow narrow output')
assert.ok(wrapped.some(line => line.includes('Key:')), 'narrow output uses key-value labels')
assert.ok(wrapped.some(line => line.includes('abcdefgh')), 'narrow output preserves long value text')

const longValue = 'abcdefghijklmnopqrstuvwx'.repeat(3)
const narrow = render(table(['Value'], [[longValue]]), 18)
const valueRow = narrow.findIndex(line => line.startsWith('Value:'))
assert.ok(valueRow >= 0)
const restoredValue = [narrow[valueRow]!.slice('Value:'.length).trimStart(),
  ...narrow.slice(valueRow + 1).map(line => line.trimStart())].join('')
assert.equal(restoredValue, longValue, 'hard wrapping must not insert spaces into a path or hash')

const emptyCell = render(table(['Key', 'Value'], [['', 'present']]), 30)
assert.ok(emptyCell.some(line => line.includes('│') && line.includes('present')), 'empty cells preserve table columns')

const empty = render(table([], []), 20)
assert.deepEqual(empty, [], 'empty tables render no rows')

const strongToken = {
  type: 'strong',
  raw: '**bold**',
  text: 'bold',
  tokens: [{ type: 'text', raw: 'bold', text: 'bold' }],
}
const styled = formatToken(strongToken as never, 0, null, null, null)
assert.match(styled, /\x1b\[/, 'strong cell formatting retains ANSI styling')

console.log('MarkdownTable layout verified: borders, alignment budget, wrapping, narrow fallback, ANSI-safe cell path, and empty cells')
