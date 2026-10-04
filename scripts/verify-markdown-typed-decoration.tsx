/**
 * Typed text decoration (header row, per-row prefix, hanging indent on
 * wrapped continuations) and the code frame drawn with it.
 *
 *  1. Engine equivalence: typed and hybrid (DSH_TUI_CODE_FRAME=hybrid)
 *     frames render identical rows, Screen.noSelect bitmaps, softWrap
 *     flags and copied bytes across shapes and widths.
 *  2. Structure counts: a typed code frame is one ink-text leaf with no
 *     ink-box nodes; the hybrid engine still renders its component layout.
 *  3. Copy contract: a body-anchored selection copies the clean code;
 *     rail/header anchors copy only the decoration.
 *  4. Wrap continuation: without the hang decoration a continuation falls
 *     to column 0; with it quote rails repeat, list/task continuations
 *     hang at the content column, CJK keeps the structure, copied bytes
 *     match the unwrapped line, and streaming equals the settled render.
 *  5. The selection fingerprint reads the same screen planes.
 *  6. Mermaid fallback shares the typed frame; a changed decoration
 *     object invalidates the paint cache.
 *  7. codeFrameStyle setting: light default, full box, round trip.
 *  8. A Text gaining or losing its decoration keeps its hook count.
 *  9. Measure matches paint, and decoration never paints past its node.
 *
 * Run: node --import tsx/esm scripts/verify-markdown-typed-decoration.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [
  assertModule,
  { PassThrough, Writable },
  React,
  { renderToScreen },
  { cellAtIndex },
  { stringWidth },
  { TerminalSizeContext },
  { render, Box, Text },
  { Markdown },
  { StreamingMarkdown },
  { CodeBlockFrame },
  { MermaidDiagram },
  selection,
  { default: instances },
  { settled },
] = await Promise.all([
  import('node:assert/strict'),
  import('node:stream'),
  import('react'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/ui.js'),
  import('../src/components/Markdown.js'),
  import('../src/components/StreamingMarkdown.js'),
  import('../src/components/CodeBlockFrame.js'),
  import('../src/components/MermaidDiagram.js'),
  import('../src/ink/selection.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])
const assert = assertModule.default

function snap(el: React.ReactElement, width: number) {
  const wrapped = (
    <TerminalSizeContext.Provider value={{ columns: width, rows: 60 }}>
      <Box flexDirection="column" width={width}>{el}</Box>
    </TerminalSizeContext.Provider>
  )
  const rendered = renderToScreen(wrapped, width)
  const rows: string[] = []
  for (let y = 0; y < Math.max(1, rendered.height); y++) {
    let line = ''
    for (let x = 0; x < width; x++) line += cellAtIndex(rendered.screen, y * width + x).char
    rows.push(line.trimEnd())
  }
  return { rows, screen: rendered.screen }
}

function codeToken(lang: string | undefined, text: string) {
  return { type: 'code' as const, raw: '', lang, text }
}

function copyRect(
  scr: ReturnType<typeof snap>['screen'],
  anchor: [number, number],
  focus: [number, number],
): string {
  const sel = selection.createSelectionState()
  selection.startSelection(sel, anchor[0], anchor[1], scr)
  selection.updateSelection(sel, focus[0], focus[1])
  selection.finishSelection(sel)
  return selection.getSelectedText(sel, scr)
}

const NL = '\n'
const BAR = '\u258e'
const RAIL = '\u2502'

// -- 1. Engine equivalence (typed vs hybrid) ------------------------------

const SHAPES: Array<[string, string]> = [
  ['ts', 'const answer = await agent.run()' + NL + 'return answer'],
  ['txt', 'x'.repeat(90)],
  ['txt', '\u4e2d\u6587\u6d4b\u8bd5'.repeat(12)],
  ['ts', ''],
  ['txt', 'short' + NL + NL + 'gap' + NL + 'tail'],
  ['ts', 'emoji \u{1F680} rocket and combining a\u0301 stack' + NL + 'tail'],
]
for (const width of [100, 60, 40]) {
  for (const [lang, text] of SHAPES) {
    process.env.DSH_TUI_CODE_FRAME = 'hybrid'
    const h = snap(<CodeBlockFrame token={codeToken(lang, text)} highlight={null} />, width)
    process.env.DSH_TUI_CODE_FRAME = 'typed'
    const t = snap(<CodeBlockFrame token={codeToken(lang, text)} highlight={null} />, width)
    assert.deepEqual(t.rows, h.rows,
      'engine rows equal @' + width + ' ' + lang + ' len' + text.length)
    assert.deepEqual(Array.from(t.screen.noSelect), Array.from(h.screen.noSelect),
      'engine noSelect equal @' + width + ' ' + lang)
    assert.deepEqual(Array.from(t.screen.softWrap), Array.from(h.screen.softWrap),
      'engine softWrap equal @' + width + ' ' + lang)
    if (text !== '') {
      const hiT = t.rows.findIndex(r => r.startsWith('\u250c'))
      const hiH = h.rows.findIndex(r => r.startsWith('\u250c'))
      assert.ok(hiT >= 0 && hiH >= 0, 'headers exist @' + width)
      assert.equal(
        copyRect(t.screen, [2, hiT + 1], [width - 1, hiT + 2]),
        copyRect(h.screen, [2, hiH + 1], [width - 1, hiH + 2]),
        'body-anchored copy bytes equal @' + width + ' ' + lang)
      assert.equal(
        copyRect(t.screen, [0, hiT + 1], [0, hiT + 2]),
        copyRect(h.screen, [0, hiH + 1], [0, hiH + 2]),
        'rail-anchored copy bytes equal @' + width + ' ' + lang)
    }
  }
}
console.log('1. typed engine equals hybrid on rows, noSelect, softWrap and copy bytes (6 shapes x 3 widths)')

// -- 2. Structure counts: one text leaf, zero structural boxes ----------

class FrameInput extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class FrameOutput extends Writable {
  isTTY = true
  columns = 80
  rows = 40
  _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() }
}

type AnyNode = { nodeName?: string; childNodes?: AnyNode[] }
function countNodes(node: AnyNode, pred: (n: AnyNode) => boolean): number {
  let n = pred(node) ? 1 : 0
  for (const child of node.childNodes ?? []) n += countNodes(child, pred)
  return n
}

async function liveFrameCounts(engine: 'typed' | 'hybrid') {
  process.env.DSH_TUI_CODE_FRAME = engine
  const stdout = new FrameOutput()
  const tree = (
    <Box flexDirection="column" width={80}>
      <CodeBlockFrame token={codeToken('ts', 'const one = 1' + NL + 'const two = 2')} highlight={null} />
    </Box>
  )
  const app = await render(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FrameInput() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await settled(() => true)
  const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as
    | { rootNode: AnyNode }
    | undefined
  assert.ok(ink, 'ink instance registered for engine ' + engine)
  const boxes = countNodes(ink.rootNode, n => n.nodeName === 'ink-box')
  const texts = countNodes(ink.rootNode, n => n.nodeName === 'ink-text')
  await app.unmount()
  return { boxes, texts }
}
const typedCounts = await liveFrameCounts('typed')
const hybridCounts = await liveFrameCounts('hybrid')
// The fixture column Box accounts for 1; the typed frame itself adds ZERO
// structural ink-box nodes and exactly ONE ink-text (the code body leaf).
assert.equal(typedCounts.texts, 1, 'typed frame is a single ink-text leaf')
assert.equal(typedCounts.boxes, 1, 'typed frame adds no structural box beyond the fixture column')
assert.ok(hybridCounts.boxes - 1 >= 4, 'hybrid fallback keeps its structural layout: ' + hybridCounts.boxes)
assert.ok(hybridCounts.boxes > typedCounts.boxes, 'hybrid is heavier than typed')
process.env.DSH_TUI_CODE_FRAME = 'typed'
console.log('2. structure counts: typed = 1 text leaf / 0 frame boxes; hybrid = ' +
  hybridCounts.boxes + ' boxes (fallback intact)')

// -- 3. Copy contract on the typed engine (hard gate) --------------------

const SRC = '```ts' + NL + 'const answer = await agent.run()' + NL + 'return answer' + NL + '```' + NL
const target = snap(<Markdown>{SRC}</Markdown>, 60)
const hi = target.rows.findIndex(r => r.startsWith('\u250c\u2500 ts'))
assert.ok(hi >= 0, 'typed frame header row exists')
assert.equal(stringWidth(target.rows[hi]!), 60, 'wide header fills the column')
assert.ok(target.rows[hi]!.endsWith('\u2500'), 'header divider runs to the edge')
assert.equal(
  copyRect(target.screen, [2, hi + 1], [59, hi + 2]),
  'const answer = await agent.run()' + NL + ' return answer',
  'body anchor copies the clean payload: rail and header never leak',
)
assert.equal(copyRect(target.screen, [0, hi + 1], [0, hi + 2]), RAIL + NL + RAIL,
  'rail anchor copies the rail column only')
const headText = copyRect(target.screen, [0, hi], [40, hi])
assert.ok(headText.includes('\u250c') && !headText.includes('const answer'),
  'header anchor copies the decoration region only')
const nsAt = (x: number, y: number) => target.screen.noSelect![y * target.screen.width + x]
assert.equal(nsAt(0, hi), 1, 'header corner cell is noSelect')
assert.equal(nsAt(5, hi), 1, 'header label cell is noSelect')
assert.equal(nsAt(0, hi + 1), 1, 'rail cell is noSelect')
assert.equal(nsAt(1, hi + 1), 0, 'padding cell stays selectable')
assert.equal(nsAt(2, hi + 1), 0, 'body cell stays selectable')
console.log('3. typed copy contract holds: body/rail/header anchors, bitmap machinery')

// -- 4. Wrap continuation hangs under the line's leading structure --------

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mik november oscar papa'

// Bad baseline: the legacy paint (no decoration) drops the wrapped
// continuation at column 0, which the hang decoration replaces.
const legacy = snap(<Text>{BAR + ' ' + WORDS}</Text>, 40)
const legacyCont = legacy.rows.filter(r => r !== '').slice(1)
assert.ok(legacyCont.length >= 2 && legacyCont.every(r => !r.startsWith(BAR)),
  'legacy paint drops continuations at column 0 (bad baseline): ' +
    JSON.stringify(legacyCont.slice(0, 2)))

const quote = snap(<Markdown>{'> ' + WORDS + NL}</Markdown>, 40)
const quoteRows = quote.rows.filter(r => r !== '')
assert.ok(quoteRows.length >= 3, 'quote wraps to 3+ rows')
assert.ok(quoteRows.every(r => r.startsWith(BAR + ' ')),
  'every wrapped quote row repeats the rail: ' + JSON.stringify(quoteRows))
assert.equal(
  copyRect(quote.screen, [0, 0], [39, quoteRows.length - 1]),
  BAR + ' ' + WORDS,
  'quote copy keeps the baked first-row rail and joins continuations without injected rails',
)

const list = snap(<Markdown>{'- ' + WORDS + NL}</Markdown>, 40)
const listRows = list.rows.filter(r => r !== '')
assert.ok(listRows.length >= 3, 'list item wraps')
assert.ok(listRows.slice(1).every(r => r.startsWith('  ')),
  'list continuations hang at the marker body column: ' + JSON.stringify(listRows))
assert.ok(!listRows.slice(1).some(r => r.trimStart().startsWith('-')),
  'the marker itself never repeats as a glyph')

const task = snap(<Markdown>{'- [x] ' + WORDS + NL}</Markdown>, 40)
const taskRows = task.rows.filter(r => r !== '')
assert.ok(taskRows.slice(1).every(r => r.startsWith('      ')),
  'task continuations hang past the checkbox (2 + 4 columns): ' + JSON.stringify(taskRows.slice(0, 3)))

const cjkQuote = snap(<Markdown>{'> ' + '\u4e2d\u6587\u6d4b\u8bd5'.repeat(16) + NL}</Markdown>, 40)
const cjkRows = cjkQuote.rows.filter(r => r !== '')
assert.ok(cjkRows.length >= 3 && cjkRows.every(r => r.startsWith(BAR + ' ')),
  'CJK quote continuations keep the rail: ' + JSON.stringify(cjkRows.slice(0, 3)))
assert.equal(
  cjkRows.map(r => r.slice(2)).join(''),
  '\u4e2d\u6587\u6d4b\u8bd5'.repeat(16),
  'CJK wrapped rows reassemble to the original payload',
)

// Streaming keeps the hang: sealed quote blocks do not lose their rails
// when the suffix grows.
const QUOTE_DOC = '> ' + WORDS + NL + NL + '> second quoted line' + NL
assert.deepEqual(
  snap(<StreamingMarkdown>{QUOTE_DOC}</StreamingMarkdown>, 40).rows,
  snap(<Markdown>{QUOTE_DOC}</Markdown>, 40).rows,
  'streaming equals settled for wrapped quotes',
)
console.log('4. wrap continuations hang: quote rail repeats, list/task columns, CJK, copy bytes, streaming')

// -- 5. The fingerprint consumes the same planes -------------------------

const FINGERPRINT_DOC_A = '> ' + WORDS + NL
const FINGERPRINT_DOC_B = '> ' + WORDS.split(' ').reverse().join(' ') + NL
const fa = snap(<Markdown>{FINGERPRINT_DOC_A}</Markdown>, 40)
const fb = snap(<Markdown>{FINGERPRINT_DOC_B}</Markdown>, 40)
const fa2 = snap(<Markdown>{FINGERPRINT_DOC_A}</Markdown>, 40)

const liveSel = selection.createSelectionState()
selection.startSelection(liveSel, 0, 0, fa.screen)
selection.updateSelection(liveSel, 39, 2)
selection.finishSelection(liveSel)
assert.equal(selection.refreshSelectionFingerprint(liveSel, fa.screen, false), false,
  'first observation baselines')
assert.equal(selection.refreshSelectionFingerprint(liveSel, fa2.screen, false), false,
  'an identical re-render does not latch stale')
assert.ok(selection.refreshSelectionFingerprint(liveSel, fb.screen, false),
  'replaced content under a stationary selection latches stale')
assert.ok(liveSel.stale, 'stale is sticky once latched')
console.log('5. fingerprint: identical frame clean, replaced content latches stale')

// -- 6. Mermaid fallback shares the frame; cache honors decoration -------

const mermaid = snap(
  <MermaidDiagram
    token={codeToken('mermaid', 'this is !! not a diagram !!')}
    highlight={null}
  />,
  60,
)
assert.ok(mermaid.rows.some(r => r.startsWith('\u250c\u2500 mermaid')),
  'mermaid fallback shares the typed frame header: ' + JSON.stringify(mermaid.rows.slice(0, 3)))
assert.ok(mermaid.rows.some(r => r.startsWith(RAIL + ' ')),
  'mermaid fallback body carries the typed rail')

// Decoration identity keys the paint cache: same text, new decoration
// object with a different rail glyph -> the row repaints.
const stdout = new FrameOutput()
const body = 'cache probe'
const dec1 = { prefix: { text: RAIL + ' ', width: 2, noSelect: 1 } }
const dec2 = { prefix: { text: '\u00a6 ', width: 2, noSelect: 1 } }
const cacheTree = (dec: typeof dec1) => (
  <Box flexDirection="column" width={80}>
    <Text decoration={dec}>{body}</Text>
  </Box>
)
const app2 = await render(cacheTree(dec1), {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: new FrameInput() as unknown as NodeJS.ReadStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
const ink2 = () => instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as {
  frontFrame: { screen: ReturnType<typeof snap>['screen'] }
}
const liveRow = () => {
  const scr = ink2().frontFrame.screen
  let line = ''
  for (let x = 0; x < 20; x++) line += cellAtIndex(scr, x).char
  return line.trimEnd()
}
await settled(() => liveRow().startsWith(RAIL))
assert.equal(liveRow(), RAIL + ' ' + body, 'first decoration paints the rail')
app2.rerender(cacheTree(dec2))
await settled(() => liveRow().startsWith('\u00a6'))
assert.equal(liveRow(), '\u00a6 ' + body, 'a changed decoration object repaints (cache keyed on identity)')
app2.rerender(cacheTree(dec1))
await settled(() => liveRow().startsWith(RAIL))
assert.equal(liveRow(), RAIL + ' ' + body, 'switching back repaints again')
await app2.unmount()
console.log('6. mermaid fallback shares the typed frame; decoration identity keys the paint cache')

// -- 7. codeFrameStyle setting: light default, full form, roundtrip -------

const { applyCodeFrameStyle, getCodeFrameStyle } = await import('../src/tuiDisplayPrefs.js')
assert.equal(getCodeFrameStyle(), 'light', 'light is the default frame style')
assert.equal(applyCodeFrameStyle('nonsense'), 'light', 'normalize rejects unknown values')

// Light rows byte-identical with section 3 (the default path is unchanged).
const lightRows = snap(<Markdown>{SRC}</Markdown>, 60).rows
assert.deepEqual(lightRows, target.rows, 'light default renders the exact section-3 rows')

applyCodeFrameStyle('full')
const fullFrame = snap(<CodeBlockFrame token={codeToken('ts', 'const a = 1' + NL + 'const bb = 2')} highlight={null} />, 60)
const fullRows = fullFrame.rows.filter(r => r !== '')
assert.ok(fullRows.length >= 4, 'full frame has header, body rows and a bottom edge')
assert.ok(fullRows[0]!.startsWith('\u250c\u2500 ts ') && fullRows[0]!.endsWith('\u2500\u2510'),
  'full header carries the label and closes with the top-right corner: ' + JSON.stringify(fullRows[0]))
for (const row of fullRows.slice(1, -1)) {
  assert.ok(row.startsWith(RAIL + ' ') && row.endsWith(RAIL),
    'every full body row keeps the rail and the continuous right wall: ' + JSON.stringify(row))
}
assert.ok(fullRows[fullRows.length - 1]!.startsWith('\u2514\u2500') && fullRows[fullRows.length - 1]!.endsWith('\u2500\u2518'),
  'full bottom edge closes the box: ' + JSON.stringify(fullRows[fullRows.length - 1]))

// Wrapped body keeps the wall continuous across rows (a layout border,
// not per-row paint).
const fullWrap = snap(<CodeBlockFrame token={codeToken('txt', 'x'.repeat(90))} highlight={null} />, 40)
const wrapRows = fullWrap.rows.filter(r => r !== '')
assert.ok(wrapRows.length >= 5, 'long body wraps inside the full box')
for (const row of wrapRows.slice(1, -1)) {
  assert.ok(row.startsWith(RAIL + ' ') && row.endsWith(RAIL),
    'wrapped full rows keep rail and wall: ' + JSON.stringify(row))
}

// Copy contract under full: body selectable, decorations excluded.
const fullNoSelect = (x: number, y: number) => fullFrame.screen.noSelect![y * fullFrame.screen.width + x]
assert.equal(fullNoSelect(0, 0), 1, 'full header row is noSelect')
assert.equal(fullNoSelect(0, 1), 1, 'full rail is noSelect')
assert.equal(fullNoSelect(1, 1), 0, 'full padding stays selectable')
assert.equal(fullNoSelect(2, 1), 0, 'full body stays selectable')
assert.equal(fullNoSelect(fullFrame.screen.width - 1, 1), 1, 'full right wall is noSelect')
const fullHi = fullFrame.rows.findIndex(r => r.startsWith('\u250c'))
assert.equal(
  copyRect(fullFrame.screen, [2, fullHi + 1], [fullFrame.screen.width - 2, fullHi + 2]),
  'const a = 1' + NL + ' const bb = 2',
  'full body-anchored copy stays the clean payload (wall and rail excluded)',
)

// The narrow fallback (net width < 8) stays the plain ANSI fence under
// whatever style is active.
const tinyFull = snap(<CodeBlockFrame token={codeToken('js', 'const a = 1')} highlight={null} />, 12)
assert.ok(tinyFull.rows.some(r => r.startsWith('```js')),
  'net width < 8 keeps the ANSI fence even in full style')
assert.ok(!tinyFull.rows.some(r => r.includes('\u2510')), 'no closed-box glyphs in the narrow fallback')

// Roundtrip: flipping back to light restores the section-3 bytes.
applyCodeFrameStyle('light')
assert.deepEqual(snap(<Markdown>{SRC}</Markdown>, 60).rows, target.rows,
  'switching back to light restores the exact default rows')
console.log('7. codeFrameStyle: light default byte-identical, full closed box (walls/bottom/copy), narrow fallback, roundtrip')

// -- 8. Decoration toggle keeps the hook count -----------------------------

// The frame narrowing into its plain fallback reuses the same Text fiber
// with the decoration removed. Its hook count must not change (React
// #300/#310 would take the whole app down).
const resizeOut = new FrameOutput()
const resizeTree = (columns: number) => (
  <TerminalSizeContext.Provider value={{ columns, rows: 40 }}>
    <CodeBlockFrame token={codeToken('ts', 'const a = 1')} highlight={null} />
  </TerminalSizeContext.Provider>
)
const app3 = await render(resizeTree(80), {
  stdout: resizeOut as unknown as NodeJS.WriteStream,
  stdin: new FrameInput() as unknown as NodeJS.ReadStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
let resizeError: unknown
void app3.waitUntilExit().catch((error: unknown) => { resizeError = error })
const resizeRow = () => {
  const ink = instances.get(resizeOut as unknown as NodeJS.WriteStream) as unknown as
    | { frontFrame: { screen: ReturnType<typeof snap>['screen'] } }
    | undefined
  if (ink === undefined) return ''
  let line = ''
  for (let x = 0; x < 10; x++) line += cellAtIndex(ink.frontFrame.screen, x).char
  return line.trimEnd()
}
assert.ok(await settled(() => resizeRow().startsWith('\u250c')), 'wide frame paints its header')
app3.rerender(resizeTree(12))
assert.ok(await settled(() => resizeRow().startsWith('```ts')),
  'narrowed frame falls back to the fence: ' + JSON.stringify(resizeRow()))
app3.rerender(resizeTree(80))
assert.ok(await settled(() => resizeRow().startsWith('\u250c')), 'widened frame paints its header again')
assert.equal(resizeError, undefined, 'toggling decoration on one Text does not crash the app')
await app3.unmount()
console.log('8. decoration toggle on one Text keeps hooks stable')

// -- 9. Measure matches paint; decoration never paints past the node -----

const HANG = { hang: true }
const withEnd = (el: React.ReactElement) => (
  <Box flexDirection="column">{el}<Text>END</Text></Box>
)
// wrap-ansi counts a Devanagari vowel sign as one column where stringWidth
// counts zero, so a line that fits by stringWidth still wraps once the
// paint decides to wrap (because another line overflows). The decorated
// measure must count those rows too, or END lands on the last body row.
const VOWEL_SIGN = '\u093f'
const fitsAt = (columns: number) => 'ab ' + VOWEL_SIGN + ' ' + 'c'.repeat(columns - 4)
for (const width of [40, 60]) {
  assert.equal(stringWidth(fitsAt(width - 2)), width - 2, 'fixture fits the framed body by stringWidth')
  const code = 'x'.repeat(width + 10) + NL + fitsAt(width - 2)
  process.env.DSH_TUI_CODE_FRAME = 'hybrid'
  const h = snap(withEnd(<CodeBlockFrame token={codeToken('txt', code)} highlight={null} />), width)
  process.env.DSH_TUI_CODE_FRAME = 'typed'
  const t = snap(withEnd(<CodeBlockFrame token={codeToken('txt', code)} highlight={null} />), width)
  assert.deepEqual(t.rows, h.rows, 'prefix measure counts the rows wrap-ansi paints @' + width)

  const prose = 'x'.repeat(width + 10) + NL + fitsAt(width)
  assert.deepEqual(
    snap(withEnd(<Text decoration={HANG}>{prose}</Text>), width).rows,
    snap(withEnd(<Text>{prose}</Text>), width).rows,
    'hang on structure-free text paints and measures like plain text @' + width,
  )
}

// A hang as wide as the column leaves no room for content: continuations
// paint without a prefix instead of spilling past the node.
const narrowTask = snap(
  <Box width={4}><Text decoration={HANG}>{'- [ ] x alpha beta'}</Text></Box>,
  20,
)
assert.ok(narrowTask.rows.every(r => stringWidth(r) <= 4),
  'narrow hang stays inside its 4-column node: ' + JSON.stringify(narrowTask.rows))

// A language label longer than the column is cut, not painted past it.
const longLabel = 'averyveryverylonglanguagenamethatkeepsgoing'
const longHeader = snap(
  <Box width={30}><CodeBlockFrame token={codeToken(longLabel, 'x = 1')} highlight={null} forceWidth={30} /></Box>,
  60,
)
assert.ok(longHeader.rows.every(r => stringWidth(r) <= 30),
  'long label header stays inside the frame: ' + JSON.stringify(longHeader.rows))
assert.ok(longHeader.rows[0]!.startsWith('\u250c\u2500 avery'), 'cut header keeps its start: ' + JSON.stringify(longHeader.rows[0]))
// The header counts toward the node width: a short body in a row
// container does not cut a label that fits.
const shortBody = snap(
  <Box width={30}><CodeBlockFrame token={codeToken('typescript', 'x')} highlight={null} forceWidth={30} /></Box>,
  60,
)
assert.equal(shortBody.rows[0], '\u250c\u2500 typescript', 'a label that fits is painted whole')
console.log('9. measure matches paint under wrap-ansi width drift; narrow hang and long header stay in the node')

console.log('markdown typed decoration verified (engine equivalence, structure counts, copy contract, hanging continuations, fingerprint, mermaid sharing, cache identity, frame style, decoration toggle, measure/paint agreement)')
