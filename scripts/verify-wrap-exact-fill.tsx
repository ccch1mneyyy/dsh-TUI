/**
 * A word that exactly fills the wrap width must not push its separator space
 * to the start of the next row (wrap-ansi trim:false does). The renderer
 * elides that space, keeps per-segment styles aligned past it, and copy still
 * re-inserts it so the joined text matches the source.
 * Run: node --import tsx/esm scripts/verify-wrap-exact-fill.tsx
 */
process.env.FORCE_COLOR = '3'
import assert from 'node:assert/strict'

const [React, { default: Box }, { default: Text }, { renderToScreen }, { cellAt }, { captureScrolledRows, createSelectionState, getSelectedText, selectWordAt, startSelection, updateSelection }] = await Promise.all([
  import('react'), import('../src/ink/components/Box.js'),
  import('../src/ink/components/Text.js'), import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'), import('../src/ink/selection.js'),
])
type Screen = ReturnType<typeof renderToScreen>['screen']

function rows(screen: Screen, width: number): string[] {
  return Array.from({ length: screen.height }, (_, y) =>
    Array.from({ length: width }, (_, x) => cellAt(screen, x, y)?.char ?? ' ').join('').trimEnd())
}

function select(screen: Screen, fromCol: number, fromRow: number, toCol: number, toRow: number): string {
  const s = createSelectionState()
  startSelection(s, fromCol, fromRow)
  updateSelection(s, toCol, toRow)
  return getSelectedText(s, screen)
}

// Exact fill: the continuation row starts with the word, copy keeps the space.
{
  const { screen } = renderToScreen(<Text>aaa the PR.</Text>, 7)
  assert.deepEqual(rows(screen, 7), ['aaa the', 'PR.'], 'exact-fill continuation must not start with a space')
  assert.equal(screen.softWrap[1], -7, 'continuation records the elided separator')
  assert.equal(select(screen, 0, 0, 6, 1), 'aaa the PR.', 'copy re-inserts the elided separator')
  assert.equal(select(screen, 4, 0, 5, 0), 'th', 'a selection short of the row end adds no space')
  const s = createSelectionState()
  selectWordAt(s, screen, 5, 0)
  assert.equal(getSelectedText(s, screen), 'the', 'double-clicking the row-end word adds no separator')
  captureScrolledRows(s, screen, 0, 0, 'above')
  assert.equal(s.scrolledOffAbove[0]!.text, 'the', 'capturing a selection ending at the row edge adds no separator')
}

// Captured rows on either side still join with the visible selection.
for (const side of ['above', 'below'] as const) {
  const { screen } = renderToScreen(<Text>aaa the PR.</Text>, 7)
  const s = createSelectionState()
  startSelection(s, 0, 0)
  updateSelection(s, 2, 1)
  const row = side === 'above' ? 0 : 1
  captureScrolledRows(s, screen, row, row, side)
  if (side === 'above') s.anchor = { col: 0, row: 1 }
  else s.focus = { col: 6, row: 0 }
  assert.equal(getSelectedText(s, screen), 'aaa the PR.', `copy restores the separator with rows captured ${side}`)
}

// Keep whitespace-only pieces: later joins and trailing trim depend on them.
for (const [width, text, expected] of [
  [7, 'aaa the changes', 'aaa the changes'],
  [1, 'a b', 'a b'],
  [7, 'aaa the  \nEND', 'aaa the\nEND'],
] as const) {
  const { screen } = renderToScreen(<Text>{text}</Text>, width)
  assert.equal(select(screen, 0, 0, width - 1, screen.height - 1), expected, 'whitespace-only rows preserve copy joins and trailing trim')
}

// Not an exact fill: wrap-ansi already leaves the space trailing the row.
{
  const { screen } = renderToScreen(<Text>aaa the PR.</Text>, 8)
  assert.deepEqual(rows(screen, 8), ['aaa the', 'PR.'])
  assert.equal(screen.softWrap[1], 8)
  assert.equal(select(screen, 0, 0, 7, 1), 'aaa the PR.')
}

// Only the one separator is elided; extra source whitespace survives.
{
  const { screen } = renderToScreen(<Text>aaa the  PR.</Text>, 7)
  assert.deepEqual(rows(screen, 7), ['aaa the', ' PR.'])
  assert.equal(select(screen, 0, 0, 6, 1), 'aaa the  PR.')
}

// Padding right of the text is not copied as the separator.
{
  const { screen } = renderToScreen(<Box width={9} paddingRight={2}><Text>aaa the PR.</Text></Box>, 9)
  assert.deepEqual(rows(screen, 9), ['aaa the', 'PR.'])
  assert.equal(select(screen, 0, 0, 8, 1), 'aaa the PR.')
  assert.equal(select(screen, 8, 0, 8, 0), '', 'a selection confined to padding copies no separator')
  assert.equal(select(screen, 8, 0, 2, 1), 'PR.', 'starting in padding copies only the next row')
}

// Multi-segment text, including typed decoration: styles stay aligned past the gap.
for (const decoration of [undefined, { hang: true }]) {
  const { screen } = renderToScreen(<Text decoration={decoration}>aaa the <Text bold>PR.</Text> x</Text>, 7)
  assert.deepEqual(rows(screen, 7), ['aaa the', 'PR. x'])
  const style = (x: number, y: number) => cellAt(screen, x, y)!.styleId
  assert.equal(style(0, 1), style(2, 1), 'the whole bold segment shares one style')
  assert.notEqual(style(0, 1), style(0, 0), '"P" is bold, unlike the plain text before the gap')
  assert.equal(style(3, 1), style(0, 0), 'the space after the bold segment is plain')
  assert.equal(select(screen, 0, 0, 6, 1), 'aaa the PR. x')
}

console.log('wrap exact-fill passed (no leading space, styles aligned, copy keeps separator)')
