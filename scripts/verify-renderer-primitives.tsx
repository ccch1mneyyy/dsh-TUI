/** Run: node --import tsx/esm scripts/verify-renderer-primitives.tsx */
process.env.FORCE_COLOR = '3'

const [assertModule, React, { Ansi }, { default: Box }, { default: Text }, { default: Newline }, { RawAnsi }, { renderToScreen, scanPositions }, { cellAt }] = await Promise.all([
  import('node:assert/strict'), import('react'), import('../src/ink/Ansi.js'),
  import('../src/ink/components/Box.js'), import('../src/ink/components/Text.js'),
  import('../src/ink/components/Newline.js'), import('../src/ink/components/RawAnsi.js'),
  import('../src/ink/render-to-screen.js'), import('../src/ink/screen.js'),
])
const assert = assertModule.default

function snapshot(element: React.ReactElement, width = 12) {
  const result = renderToScreen(element, width)
  return Array.from({ length: result.height }, (_, row) =>
    Array.from({ length: width }, (_, col) => {
      const cell = cellAt(result.screen, col, row)!
      return { char: cell.char, width: cell.width, styleId: cell.styleId, hyperlink: cell.hyperlink }
    }))
}

assert.deepEqual(snapshot(<Ansi>{'\x1b[1;31m红A\x1b[0mB'}</Ansi>),
  snapshot(<Text><Text color="ansi:red" bold>红A</Text>B</Text>), 'ANSI spans preserve CJK width and reset style')
assert.deepEqual(snapshot(<Ansi dimColor>{'\x1b[1;34m蓝色\x1b[0m'}</Ansi>),
  snapshot(<Text dim><Text color="ansi:blue" dim>蓝色</Text></Text>), 'forced dim takes precedence over bold')
assert.deepEqual(snapshot(<Ansi>{'\x1b[48;2;11;22;33mX\x1b[0m'}</Ansi>),
  snapshot(<Text><Text backgroundColor="rgb(11,22,33)">X</Text></Text>), 'RGB background survives ANSI projection')
assert.deepEqual(snapshot(<Ansi>{'e\u0301 中文\nnext'}</Ansi>, 8),
  snapshot(<Text>{'e\u0301 中文\nnext'}</Text>, 8), 'combining characters and line breaks match text layout')
assert.equal(renderToScreen(<Ansi>{'\x1b[31m\x1b[0m'}</Ansi>, 10).height, 0, 'control-only content produces no row')
assert.equal(renderToScreen(<Text>{null}</Text>, 10).height, 0, 'absent text produces no row')
assert.equal(renderToScreen(<RawAnsi lines={[]} width={10} />, 10).height, 0, 'empty preformatted output produces no row')

const lines = renderToScreen(<Text>one<Newline count={2} />three</Text>, 12)
assert.deepEqual(scanPositions(lines.screen, 'three'), [{ row: 2, col: 0, len: 5 }], 'Newline keeps blank rows')
const layout = renderToScreen(<Box paddingLeft={2} flexDirection="column"><Text>A</Text><Text>中B</Text></Box>, 12)
assert.deepEqual(scanPositions(layout.screen, '中B'), [{ row: 1, col: 2, len: 3 }], 'Box padding and column direction use display cells')
const raw = renderToScreen(<RawAnsi lines={['first', '\x1b[31msecond\x1b[0m']} width={10} />, 10)
assert.equal(raw.height, 2)
assert.deepEqual(scanPositions(raw.screen, 'second'), [{ row: 1, col: 0, len: 6 }])

console.log('renderer primitives passed (ANSI styles, resets, CJK, empty output, newlines and layout)')
