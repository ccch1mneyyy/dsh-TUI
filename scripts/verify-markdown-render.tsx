/**
 * CodeBlockFrame regression (Batch B of the rendering upgrade, design
 * spec section 1): the light code frame's visual contract, its copy
 * contract (header/rail NoSelect, selectable body), the narrow-terminal
 * fallbacks, highlighter degradation at component level, and streaming
 * equivalence for a growing fence.
 *
 * Run: node --import tsx/esm scripts/verify-markdown-render.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [
  assertModule,
  React,
  { renderToScreen },
  { cellAtIndex },
  { stringWidth },
  { TerminalSizeContext },
  { Box },
  { Markdown },
  { StreamingMarkdown },
  { CodeBlockFrame },
  selection,
] = await Promise.all([
  import('node:assert/strict'),
  import('react'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/ui.js'),
  import('../src/components/Markdown.js'),
  import('../src/components/StreamingMarkdown.js'),
  import('../src/components/CodeBlockFrame.js'),
  import('../src/ink/selection.js'),
])
const assert = assertModule.default

/** Render `el` at `width` with the TerminalSizeContext the frame reads. */
function snap(el: React.ReactElement, width: number) {
  const wrapped = (
    <TerminalSizeContext.Provider value={{ columns: width, rows: 40 }}>
      <Box flexDirection="column" width={width}>{el}</Box>
    </TerminalSizeContext.Provider>
  )
  const rendered = renderToScreen(wrapped, width)
  const rowsOut: string[] = []
  for (let y = 0; y < Math.max(1, rendered.height); y++) {
    let line = ''
    for (let x = 0; x < width; x++) line += cellAtIndex(rendered.screen, y * width + x).char
    rowsOut.push(line.trimEnd())
  }
  return { rows: rowsOut, screen: rendered.screen }
}

function codeToken(lang: string | undefined, text: string) {
  return { type: 'code' as const, raw: '', lang, text }
}

const NL = '\n'
const F = '```'
const CODE = 'const answer = await agent.run()' + NL + 'return answer'
const SRC_WIDE = 'before' + NL + NL + '```ts' + NL + CODE + NL + F + NL + 'after'
const SRC_NARROW = 'x' + NL + NL + '```ts' + NL + CODE + NL + F
const SRC_COPY = '```ts' + NL + CODE + NL + F + NL
const STAGES = [
  'para' + NL + NL + '```ts' + NL + 'const a = 1',
  'para' + NL + NL + '```ts' + NL + 'const a = 1' + NL + 'const b = 2',
  'para' + NL + NL + '```ts' + NL + 'const a = 1' + NL + 'const b = 2' + NL + F + NL + 'after',
]

// -- Visual: wide frame --------------------------------------------------

const wide = snap(<Markdown>{SRC_WIDE}</Markdown>, 100)
const headerIdx = wide.rows.findIndex(r => r.startsWith('┌─ ts '))
assert.ok(headerIdx > 0, 'wide header row exists: ' + JSON.stringify(wide.rows.slice(0, 4)))
assert.ok(wide.rows[headerIdx]!.endsWith('─'), 'header divider runs to the frame width')
assert.equal(stringWidth(wide.rows[headerIdx]!), 100, 'header fills the content column')
assert.equal(wide.rows[headerIdx - 1], '', 'one blank row before the frame (node gap)')
const bodyRows = wide.rows.slice(headerIdx + 1).filter(r => r.startsWith('│'))
assert.equal(bodyRows.length, 2, 'two body rows')
assert.ok(bodyRows[0]!.includes('const answer = await agent.run()'), 'first code line visible')
assert.ok(bodyRows[1]!.includes('return answer'), 'second code line visible')
assert.ok(bodyRows.every(r => r.startsWith('│ ')), 'rail plus one padding column per body row')
assert.ok(!wide.rows.some(r => /[┐┘└├┤]/.test(r)), 'no right wall, bottom edge or tee joints')
const afterIdx = wide.rows.findIndex(r => r === 'after')
assert.ok(afterIdx === headerIdx + 4, 'after-prose follows one blank row after the last body row (node gap)')
assert.equal(wide.rows[afterIdx - 1], '', 'one blank row after the frame (node gap)')

// -- Visual: narrow frame ------------------------------------------------

const narrow = snap(<Markdown>{SRC_NARROW}</Markdown>, 40)
assert.equal(narrow.rows.find(r => r.includes('┌')), '┌─ ts', 'narrow header is the short label only, no dash fill')
assert.ok(narrow.rows.some(r => r.startsWith('│ const answer')), 'narrow body keeps the rail')

// -- Label resolution ----------------------------------------------------

const noLang = snap(<CodeBlockFrame token={codeToken(undefined, 'a = 1')} highlight={null} />, 60)
assert.ok(noLang.rows.some(r => r.startsWith('┌─ code ')), 'no language shows the generic code label')
const metaLang = snap(<CodeBlockFrame token={codeToken('js meta=1', 'a = 1')} highlight={null} />, 60)
assert.ok(metaLang.rows.some(r => r.startsWith('┌─ js ')), 'fence info resolves to its first word')

// -- Fallback: net width < 8 ---------------------------------------------

const tiny = snap(<CodeBlockFrame token={codeToken('js', 'const a = 1')} highlight={null} />, 12)
assert.ok(tiny.rows.some(r => r.startsWith('```js')), 'net width < 8 falls back to the ANSI fence: ' + JSON.stringify(tiny.rows))
assert.ok(!tiny.rows.some(r => r.includes('┌')), 'no frame glyphs in the fallback')

// -- Long-line and CJK wrap keep the rail --------------------------------

const longLine = 'x'.repeat(90)
const wrapped = snap(<CodeBlockFrame token={codeToken('txt', longLine)} highlight={null} />, 40)
const wrapRows = wrapped.rows.filter(r => r.startsWith('│'))
assert.ok(wrapRows.length >= 3, 'a 90-char line wraps to 3+ rows: ' + wrapRows.length)
assert.ok(wrapRows.every(r => r.startsWith('│ ')), 'every wrapped continuation row keeps rail and padding')
assert.equal(
  wrapRows.map(r => r.slice(2).trimEnd()).join(''),
  longLine,
  'wrapped rows reassemble to the original payload',
)

const cjk = snap(
  <CodeBlockFrame token={codeToken('txt', '中文测试'.repeat(12))} highlight={null} />,
  40,
)
const cjkRows = cjk.rows.filter(r => r.startsWith('│'))
assert.ok(cjkRows.length >= 2, 'CJK body wraps')
assert.ok(cjkRows.every(r => r.startsWith('│ ')), 'CJK wrapped rows keep the rail')

// -- Copy contract (spec 1.2) --------------------------------------------

const copyTarget = snap(<Markdown>{SRC_COPY}</Markdown>, 60)
const copyHeader = copyTarget.rows.findIndex(r => r.startsWith('┌─ ts'))
const firstBodyRow = copyHeader + 1
const lastBodyRow = copyHeader + 2

// Body-anchored drag: clean payload without rail, header or ANSI.
const bodySel = selection.createSelectionState()
selection.startSelection(bodySel, 2, firstBodyRow, copyTarget.screen)
selection.updateSelection(bodySel, 59, lastBodyRow)
selection.finishSelection(bodySel)
const bodyText = selection.getSelectedText(bodySel, copyTarget.screen)
// The single padding column belongs to the selectable body region (spec
// 1.2: only header/rail are NoSelect), so full-row continuation rows carry
// its space; no rail glyph, header glyph or ANSI ever leaks.
assert.equal(
  bodyText,
  'const answer = await agent.run()' + NL + ' return answer',
  'body-anchored selection copies the clean code payload: ' + JSON.stringify(bodyText),
)

// Header-anchored drag: the accepted anchor semantics copy the decoration.
const headSel = selection.createSelectionState()
selection.startSelection(headSel, 0, copyHeader, copyTarget.screen)
selection.updateSelection(headSel, 40, copyHeader)
selection.finishSelection(headSel)
const headText = selection.getSelectedText(headSel, copyTarget.screen)
assert.ok(headText.includes('┌'), 'header anchor copies the decoration region: ' + JSON.stringify(headText))
assert.ok(!headText.includes('const answer'), 'header anchor does not reach the body')

// Rail-anchored drag: copies the rail glyph only (one-column noSelect run).
const railSel = selection.createSelectionState()
selection.startSelection(railSel, 0, firstBodyRow, copyTarget.screen)
selection.updateSelection(railSel, 0, lastBodyRow)
selection.finishSelection(railSel)
const railText = selection.getSelectedText(railSel, copyTarget.screen)
assert.equal(railText, '│' + NL + '│', 'rail anchor copies the rail column only: ' + JSON.stringify(railText))

// The noSelect bitmap is the machinery: header cells and rail cells are 1,
// padding and body cells are 0.
const noSelectAt = (s: ReturnType<typeof snap>['screen'], x: number, y: number) => s.noSelect![y * s.width + x]
assert.equal(noSelectAt(copyTarget.screen, 0, copyHeader), 1, 'header corner cell is noSelect')
assert.equal(noSelectAt(copyTarget.screen, 5, copyHeader), 1, 'header label cell is noSelect')
assert.equal(noSelectAt(copyTarget.screen, 0, firstBodyRow), 1, 'rail cell is noSelect')
assert.equal(noSelectAt(copyTarget.screen, 1, firstBodyRow), 0, 'padding cell stays selectable')
assert.equal(noSelectAt(copyTarget.screen, 2, firstBodyRow), 0, 'body cell stays selectable')

// -- Highlighter degradation at component level ---------------------------

const throwing = {
  supportsLanguage: () => true,
  highlight: (): string => {
    throw new Error('fake explosion')
  },
} as never
const degraded = snap(<CodeBlockFrame token={codeToken('ts', 'const boom = 1')} highlight={throwing} />, 60)
assert.ok(degraded.rows.some(r => r.startsWith('┌─ ts ')), 'frame survives a throwing highlighter')
assert.ok(degraded.rows.some(r => r.startsWith('│ const boom = 1')), 'plaintext body survives a throwing highlighter')

// -- Streaming equivalence for a growing fence ----------------------------

for (const width of [55, 100]) {
  for (const source of STAGES) {
    const settledRows = snap(<Markdown>{source}</Markdown>, width).rows
    const streamedRows = snap(<StreamingMarkdown>{source}</StreamingMarkdown>, width).rows
    assert.deepEqual(streamedRows, settledRows,
      'streaming equals settled at width ' + width + ' for ' + JSON.stringify(source.slice(0, 40)))
  }
}

// -- Resize: same token, two widths, both coherent ------------------------

const resizeToken = codeToken('ts', CODE)
const at100 = snap(<CodeBlockFrame token={resizeToken} highlight={null} />, 100)
const at40 = snap(<CodeBlockFrame token={resizeToken} highlight={null} />, 40)
assert.equal(stringWidth(at100.rows.find(r => r.startsWith('┌'))!), 100, 'wide header fills 100')
assert.equal(at40.rows.find(r => r.startsWith('┌')), '┌─ ts', 'narrow header is short')

console.log('markdown code frame verified (visuals, copy contract, fallbacks, highlighter isolation, streaming equivalence)')