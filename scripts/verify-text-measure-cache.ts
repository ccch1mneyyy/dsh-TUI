/**
 * Text measurement reuse across Yoga's alternating width probes.
 * Run: node --import tsx/esm scripts/verify-text-measure-cache.ts
 * Checks result identity instead of wall time, plus warm/cold dimensions.
 */
import assert from 'node:assert/strict'
import {
  appendChildNode,
  createNode,
  createTextNode,
  insertBeforeNode,
  removeChildNode,
  setStyle,
  setTextNodeValue,
} from '../src/ink/dom.js'
import { YogaLayoutNode } from '../src/ink/layout/yoga.js'
import type { Styles } from '../src/ink/styles.js'
import { MeasureMode } from '../src/native-ts/yoga-layout/index.js'

function fixture(text: string, wrap: Styles['textWrap'] = 'wrap') {
  const node = createNode('ink-text')
  const leaf = createTextNode(text)
  insertBeforeNode(node, leaf, node.childNodes[0])
  setStyle(node, { textWrap: wrap })
  assert.ok(node.yogaNode instanceof YogaLayoutNode)
  const measure = node.yogaNode.yoga.measureFunc
  assert.ok(measure)
  return {
    node,
    leaf,
    measure: (width: number, mode: MeasureMode = MeasureMode.Exactly) =>
      measure(width, mode, NaN, MeasureMode.Undefined),
    dispose: () => node.yogaNode!.freeRecursive(),
  }
}

const longText = Array.from({ length: 500 }, (_, i) =>
  `Paragraph ${i}: Inspect the input, collect symbols, and transform the expression. Keep the result consistent with the recorded source.`,
).join('\n\n')
const probes: readonly [number, MeasureMode][] = [
  [100, MeasureMode.AtMost],
  [98.03921568627452, MeasureMode.AtMost],
  [97, MeasureMode.Exactly],
  [96.03921568627452, MeasureMode.Exactly],
]

const long = fixture(longText)
try {
  const first = probes.map(([width, mode]) => long.measure(width, mode))
  for (let repeat = 0; repeat < 30; repeat++) {
    probes.forEach(([width, mode], index) => {
      assert.equal(long.measure(width, mode), first[index], 'repeat probe must reuse its result before scanning text')
    })
  }
  setTextNodeValue(long.leaf, longText + '\n\nA new paragraph.')
  probes.forEach(([width, mode], index) => {
    const result = long.measure(width, mode)
    assert.notEqual(result, first[index], 'streaming append invalidates every previous width')
    const cold = fixture(long.leaf.nodeValue)
    try { assert.deepEqual(result, cold.measure(width, mode)) } finally { cold.dispose() }
    assert.equal(long.measure(width, mode), result)
  })
} finally {
  long.dispose()
}

const sources = [
  '',
  'short',
  'alpha beta gamma delta\n\nsecond paragraph',
  '\x1b[31mcolored text\x1b[0m\nnext line',
  '\u4e2d\u6587 e\u0301 \ud83d\ude00 \ud83d\udc69\u200d\ud83d\udcbb\nwide characters',
  'first\tsecond\n\tindented',
  'a long line with words '.repeat(6),
  'first\n\nlast\n',
]
const widths = [60, 10, 1, 0.5, 0, NaN, Infinity, 100]
const modes = [MeasureMode.AtMost, MeasureMode.Exactly, MeasureMode.Undefined]
const wraps: Styles['textWrap'][] = ['wrap', 'wrap-trim', 'truncate', 'truncate-start', 'truncate-middle']
const warm = fixture('initial')
try {
  for (const wrap of wraps) {
    setStyle(warm.node, { textWrap: wrap })
    let text = 'one two three four five six\n'
    for (const suffix of ['', 'tail', '\n', '\nnext', '\t', '\u4e2d\u6587']) {
      text += suffix
      setTextNodeValue(warm.leaf, text)
      const cold = fixture(text, wrap)
      try {
        assert.deepEqual(warm.measure(8), cold.measure(8), 'appending after a newline must match a fresh measurement')
      } finally {
        cold.dispose()
      }
    }
  }
  for (const wrap of wraps) {
    setStyle(warm.node, { textWrap: wrap })
    for (const text of sources) {
      setTextNodeValue(warm.leaf, text)
      for (const width of widths) {
        for (const mode of modes) {
          const cold = fixture(text, wrap)
          try {
            const result = warm.measure(width, mode)
            assert.deepEqual(result, cold.measure(width, mode), `${wrap}/${width}/${mode}: ${JSON.stringify(text)}`)
            assert.equal(warm.measure(width, mode), result, 'unchanged measurement must reuse its result')
          } finally {
            cold.dispose()
          }
        }
      }
    }
  }

  setStyle(warm.node, { textWrap: 'wrap' })
  setTextNodeValue(warm.leaf, 'alpha beta gamma delta\nsecond line')
  const wrapped = warm.measure(8)
  setStyle(warm.node, { textWrap: 'truncate' })
  const truncated = warm.measure(8)
  assert.notEqual(truncated, wrapped, 'wrap-mode changes invalidate unchanged text')
  const truncatedCold = fixture(warm.leaf.nodeValue, 'truncate')
  try { assert.deepEqual(truncated, truncatedCold.measure(8)) } finally { truncatedCold.dispose() }
  setStyle(warm.node, { textWrap: 'wrap' })
  assert.deepEqual(warm.measure(8), wrapped)
  const intrinsic = warm.measure(8, MeasureMode.Undefined)
  assert.notDeepEqual(intrinsic, wrapped, 'intrinsic and constrained probes must not share a result')
  assert.deepEqual(warm.measure(8), wrapped, 'intrinsic probe cannot overwrite constrained result')

  setTextNodeValue(warm.leaf, 'iiii')
  const narrow = warm.measure(3)
  setTextNodeValue(warm.leaf, '\u4e2d\u6587\u4e2d\u6587')
  assert.notEqual(warm.measure(3), narrow, 'same-length text replacement invalidates the cache')

  const previous = warm.measure(20)
  const nested = createNode('ink-virtual-text')
  const nestedLeaf = createTextNode(' nested child content')
  insertBeforeNode(nested, nestedLeaf, nested.childNodes[0])
  appendChildNode(warm.node, nested)
  assert.notEqual(warm.measure(20), previous, 'nested text insertion invalidates the cache')
  setTextNodeValue(nestedLeaf, ' changed nested content')
  const cold = fixture(warm.leaf.nodeValue + nestedLeaf.nodeValue)
  try { assert.deepEqual(warm.measure(20), cold.measure(20)) } finally { cold.dispose() }
  removeChildNode(warm.node, nested)
  assert.deepEqual(warm.measure(20), previous, 'nested text removal restores dimensions')

  const old = warm.measure(20)
  for (let width = 30; width < 70; width++) warm.measure(width)
  assert.notEqual(warm.measure(20), old, 'old width entries are evicted instead of growing without bound')
} finally {
  warm.dispose()
}

console.log('text measurement cache passed (reuse, append, replacement, nesting, modes, resize and eviction)')
