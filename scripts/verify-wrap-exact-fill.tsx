/**
 * A word that exactly fills the wrap width must not push its separator space
 * to the start of the next row (wrap-ansi trim:false does). The renderer
 * elides that space, keeps per-segment styles aligned past it, and copy still
 * re-inserts it so the joined text matches the source.
 * Run: node --import tsx/esm scripts/verify-wrap-exact-fill.tsx
 */
process.env.FORCE_COLOR = '3'
import assert from 'node:assert/strict'

const [React, { default: Box }, { default: Text }, { renderToScreen }, { cellAt }, { getSelectedText, startSelection, updateSelection }] = await Promise.all([
  import('react'), import('../src/ink/components/Box.js'),
  import('../src/ink/components/Text.js'), import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'), import('../src/ink/selection.js'),
])
type Screen = ReturnType<typeof renderToScreen>['screen']
type SelectionState = Parameters<typeof getSelectedText>[0]

function rows(screen: Screen, width: number): string[] {
  return Array.from({ length: screen.height }, (_, y) =>
    Array.from({ length: width }, (_, x) => cellAt(screen, x, y)?.char ?? ' ').join('').trimEnd())
}

function select(screen: Screen, fromCol: number, fromRow: number, toCol: number, toRow: number): string {
  const s = {
    anchor: null, focus: null, isDragging: false, anchorSpan: null,
    scrolledOffAbove: [], scrolledOffBelow: [],
    lastPressHadAlt: false, coveredFingerprint: null, coveredText: null, coveredGeometry: null, stale: false,
  } as unknown as SelectionState
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
}

// Multi-segment text: styles stay on their own characters past the gap.
{
  const { screen } = renderToScreen(<Text>aaa the <Text bold>PR.</Text> x</Text>, 7)
  assert.deepEqual(rows(screen, 7), ['aaa the', 'PR. x'])
  const style = (x: number, y: number) => cellAt(screen, x, y)!.styleId
  assert.equal(style(0, 1), style(2, 1), 'the whole bold segment shares one style')
  assert.notEqual(style(0, 1), style(0, 0), '"P" is bold, unlike the plain text before the gap')
  assert.equal(style(3, 1), style(0, 0), 'the space after the bold segment is plain')
  assert.equal(select(screen, 0, 0, 6, 1), 'aaa the PR. x')
}

console.log('wrap exact-fill passed (no leading space, styles aligned, copy keeps separator)')
