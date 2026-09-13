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

console.log('text wrap geometry passed (fractional columns, tail visibility, cached layouts and resize)')
