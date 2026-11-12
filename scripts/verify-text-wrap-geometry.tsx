/**
 * Fractional Yoga constraints must paint exactly the rows measurement reserves.
 * Run: node --import tsx/esm scripts/verify-text-wrap-geometry.tsx
 */
process.env.FORCE_COLOR = '3'
import assert from 'node:assert/strict'

const [React, { default: Box }, { default: Text }, { renderToScreen, scanPositions }, { default: wrapText }, { createNode, createTextNode, insertBeforeNode, setTextNodeValue }, { YogaLayoutNode }] = await Promise.all([
  import('react'), import('../src/ink/components/Box.js'),
  import('../src/ink/components/Text.js'), import('../src/ink/render-to-screen.js'),
  import('../src/ink/wrap-text.js'), import('../src/ink/dom.js'), import('../src/ink/layout/yoga.js'),
])

const text = Array.from({ length: 200 }, (_, i) =>
  `Paragraph ${i}: Inspect the input, collect symbols, and transform the expression. Keep the result consistent with the recorded source.`,
).join('\n\n') + '\nTAIL-END'

for (const width of [20, 20.25, 20.75, 59.5, 96.03921568627452, 97]) {
  const expectedRows = wrapText(text, width, 'wrap').split('\n').length
  const rendered = renderToScreen(<Box width={width}><Text>{text}</Text></Box>, 100)
  assert.equal(rendered.height, expectedRows, `height at ${width} columns`)
  assert.deepEqual(scanPositions(rendered.screen, 'TAIL-END'), [{ row: expectedRows - 1, col: 0, len: 8 }], `painted tail at ${width} columns`)
}

// Each grapheme occupies one physical row below one cell. Keep these
// expectations independent of wrapText so measurement and paint cannot agree
// on the same wrong row count while silently dropping the tail.
const subCellCases = [
  { label: 'ASCII', source: 'ABCD', glyphs: ['A', 'B', 'C', 'D'] },
  { label: 'hard newline', source: 'AB\nCD', glyphs: ['A', 'B', 'C', 'D'] },
  { label: 'ANSI', source: '\x1b[31mABCD\x1b[0m', glyphs: ['A', 'B', 'C', 'D'] },
  { label: 'CJK', source: '中文', glyphs: ['中', '文'] },
  { label: 'emoji', source: '👩‍💻🙂', glyphs: ['👩‍💻', '🙂'] },
] as const
for (const wrap of ['wrap', 'wrap-trim'] as const) {
  for (const width of [0.5, 0.82, 0.99]) {
    for (const { label, source, glyphs } of subCellCases) {
      const rendered = renderToScreen(
        <Box width={12} flexDirection="column">
          <Box width={width}><Text wrap={wrap}>{source}</Text></Box>
          <Text>NEXT</Text>
        </Box>,
        20,
      )
      const context = `${label}/${wrap} at ${width} columns`
      assert.equal(rendered.height, glyphs.length + 1, `${context}: reserve every painted row`)
      for (const [row, glyph] of glyphs.entries()) {
        const positions = scanPositions(rendered.screen, glyph).map(({ row, col }) => ({ row, col }))
        assert.deepEqual(positions, [{ row, col: 0 }], `${context}: preserve ${glyph}`)
      }
      assert.deepEqual(scanPositions(rendered.screen, 'NEXT'), [{ row: glyphs.length, col: 0, len: 4 }], `${context}: next sibling follows the painted tail`)
    }
  }
}

for (const wrap of ['truncate', 'truncate-start', 'truncate-middle'] as const) {
  const rendered = renderToScreen(
    <Box width={12} flexDirection="column">
      <Box width={0.82}><Text wrap={wrap}>ABCD</Text></Box>
      <Text>NEXT</Text>
    </Box>,
    20,
  )
  assert.equal(rendered.height, 2, `${wrap}: a sub-cell probe keeps one intrinsic row`)
  assert.deepEqual(scanPositions(rendered.screen, 'A'), [], `${wrap}: no glyph fits below one cell`)
  assert.deepEqual(scanPositions(rendered.screen, 'NEXT'), [{ row: 1, col: 0, len: 4 }], `${wrap}: no inflated footer height`)
}

// An integer container also creates sub-cell constraints: four siblings share
// three columns. Rounding overlaps the first two boxes horizontally, so pin
// the visible tails of the remaining peers instead of that existing overlap.
const peers = renderToScreen(
  <Box width={3} flexDirection="column">
    <Box>{['ABCD', 'EFGH', 'IJKL', 'MNOP'].map(value => <Text key={value}>{value}</Text>)}</Box>
    <Text>END</Text>
  </Box>,
  20,
)
assert.equal(peers.height, 5, 'integer flex shrink reserves four text rows and one following row')
for (const [col, glyph] of ['H', 'L', 'P'].entries()) {
  assert.deepEqual(scanPositions(peers.screen, glyph), [{ row: 3, col, len: 1 }], `integer flex shrink preserves ${glyph}`)
}
assert.deepEqual(scanPositions(peers.screen, 'END'), [{ row: 4, col: 0, len: 3 }], 'integer flex shrink keeps the next sibling below the tail')

const parent = createNode('ink-box')
const node = createNode('ink-text')
const leaf = createTextNode(text)
insertBeforeNode(node, leaf, node.childNodes[0])
insertBeforeNode(parent, node, parent.childNodes[0])
assert.ok(node.yogaNode instanceof YogaLayoutNode)
const yoga = node.yogaNode.yoga
const measure = yoga.measureFunc
assert.ok(measure)
let measureCalls = 0
yoga.measureFunc = (...args) => {
  measureCalls++
  return measure(...args)
}
const originalWidth = 96.03921568627452
try {
  // Each width needs two Yoga cache slots. A third distinct width would
  // evict the first one before the return, silently testing a cache miss.
  for (const [index, width] of [originalWidth, 60.5, originalWidth].entries()) {
    const before = measureCalls
    parent.yogaNode!.setWidth(width)
    for (let pass = 0; pass < 4; pass++) {
      parent.yogaNode!.calculateLayout(width)
      const measuredWidth: number = node.yogaNode.getComputedMeasureWidth()
      assert.equal(measuredWidth, width)
      const paintedRows = wrapText(leaf.nodeValue, measuredWidth, 'wrap').split('\n').length
      assert.equal(node.yogaNode.getComputedHeight(), paintedRows, 'warm layout must restore both height and its measurement width')
    }
    if (index === 2) assert.equal(measureCalls, before, 'the width round trip must restore a cached measurement')
    else assert.ok(measureCalls > before)
  }
  const beforeAppend = measureCalls
  setTextNodeValue(leaf, leaf.nodeValue + '\nappended tail')
  for (const width of [originalWidth, 100]) {
    parent.yogaNode!.setWidth(width)
    parent.yogaNode!.calculateLayout(width)
    assert.ok(measureCalls > beforeAppend, 'appending invalidates cached text dimensions')
    assert.equal(node.yogaNode.getComputedMeasureWidth(), width)
    assert.equal(node.yogaNode.getComputedHeight(), wrapText(leaf.nodeValue, width, 'wrap').split('\n').length, 'appended text must be measured at the current width')
  }
} finally {
  parent.yogaNode!.freeRecursive()
}

console.log('text wrap geometry passed (fractional/sub-cell columns, Unicode tails, integer flex shrink, truncate modes, cached layouts and resize)')
