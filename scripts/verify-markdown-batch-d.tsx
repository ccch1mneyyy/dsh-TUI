/**
 * Markdown token-shape regression (Batch D of the rendering upgrade,
 * design spec section 3/4): heading layering + compressed whitespace, the
 * subtle single-row hr divider, list hanging indent / steady nesting
 * ladder / loose-item bullets, per-level blockquote gutters with
 * empty-line structure, and image alt + OSC 8 links.
 *
 * Every section starts from a bad-baseline proof: the assertion is red on
 * the pre-batch renderer (double blank rows under headings, `---` glued to
 * the next block, loose items without bullets, col-0 soft-break
 * continuations, structure-less empty quote lines, bare image URLs) and
 * green after the batch.
 *
 * Run: node --import tsx/esm scripts/verify-markdown-batch-d.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
// OSC 8-capable terminal for the hyperlink path; the plain-degradation
// path toggles this off below (supports-hyperlinks reads env live, only
// its stdout probe is cached - false in this non-TTY process).
process.env.TERM_PROGRAM = 'kitty'

// Env first, then dynamic imports: static imports hoist above the env
// setup and chalk would cache a colorless level before FORCE_COLOR lands.
const [
  assertModule,
  React,
  { Writable },
  { Terminal: XTerm },
  { Box, Text, render },
  { TerminalSizeContext },
  { renderToScreen },
  { cellAtIndex },
  { Markdown },
  { StreamingMarkdown },
  markdown,
] = await Promise.all([
  import('node:assert/strict'),
  import('react'),
  import('node:stream'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/components/Markdown.js'),
  import('../src/components/StreamingMarkdown.js'),
  import('../src/terminal-utils/markdown.js'),
])
const assert = assertModule.default
const { applyMarkdown, configureMarked } = markdown
configureMarked()

const ESC = '\u001b'
/** Strip SGR sequences for plain-shape assertions. */
const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '')
/** SGR + OSC 8 stripped: what the row actually reads like on screen. */
const visible = (s: string): string =>
  plain(s).replace(/\u001b\]8;;[^\u0007]*\u0007/g, '')
const BOLD = ESC + '[1m'
const ITALIC = ESC + '[3m'
const UNDERLINE = ESC + '[4m'

// -- 1. Heading layering + compressed whitespace ------------------------

// Bad baseline: every heading emitted EOL + EOL, which stacked with the
// following space token into TWO blank rows; tight sources gained an
// invented blank row. Now the heading ends with exactly one newline and
// the source's own blank lines provide the air.
const h1doc = applyMarkdown('# Title' + '\n' + '\n' + 'intro' + '\n')
assert.equal(plain(h1doc), 'Title' + '\n' + '\n' + 'intro',
  'blank-separated heading keeps exactly ONE blank row: ' + JSON.stringify(plain(h1doc)))
assert.ok(!plain(h1doc).includes('\n\n\n'), 'no double blank row below a heading')

const tightH3 = applyMarkdown('### h3 head' + '\n' + 'body right under' + '\n')
assert.equal(plain(tightH3), 'h3 head' + '\n' + 'body right under',
  'tight heading sits directly above its body: ' + JSON.stringify(plain(tightH3)))

const twoHeadings = applyMarkdown('# A' + '\n' + '\n' + '## B' + '\n' + '\n' + 'text' + '\n')
assert.equal(plain(twoHeadings), 'A' + '\n' + '\n' + 'B' + '\n' + '\n' + 'text',
  'heading-to-heading rhythm is one blank row per source gap')

assert.equal(plain(applyMarkdown('# End' + '\n')), 'End', 'trailing heading trims clean')

// Six distinct visual levels (spec: H3-H6 were near-identical bold).
const depths = [1, 2, 3, 4, 5, 6].map(d => applyMarkdown('#'.repeat(d) + ' X' + '\n'))
const styledSet = new Set(depths)
assert.equal(styledSet.size, 6, 'all six heading depths render distinctly')
for (let i = 0; i < depths.length; i++) {
  assert.equal(plain(depths[i]!), 'X', 'depth ' + (i + 1) + ' text survives')
}
assert.ok(depths[0]!.includes(UNDERLINE), 'H1 keeps its underline')
assert.ok(!depths[1]!.includes(UNDERLINE), 'H2 has no underline')
assert.ok(depths[2]!.includes(BOLD) && !depths[2]!.includes(ITALIC) && !depths[2]!.includes(UNDERLINE),
  'H3 is bold near-text without italic/underline')
assert.ok(depths[3]!.includes(BOLD) && depths[3]!.includes(ITALIC), 'H4 is bold + italic')
assert.ok(depths[4]!.includes(ITALIC) && !depths[4]!.includes(BOLD), 'H5 is italic without bold')
assert.ok(!depths[5]!.includes(BOLD) && !depths[5]!.includes(ITALIC), 'H6 is upright without bold')
// Muteness ladder: the two subtle levels carry a foreground color while
// H3 stays near-text (no 38;2 color code of its own).
assert.ok(depths[4]!.includes('38;2') && depths[5]!.includes('38;2'), 'H5/H6 carry the subtle foreground color')
assert.ok(!depths[2]!.includes('38;2'), 'H3 stays near-text')

// -- 2. hr: subtle single-row divider -----------------------------------

const hrStd = applyMarkdown('intro' + '\n' + '\n' + '---' + '\n' + '\n' + 'outro' + '\n')
assert.equal(plain(hrStd), 'intro' + '\n' + '\n' + '\u2500\u2500\u2500' + '\n' + 'outro',
  'divider replaces the ASCII dashes and keeps the exact one-row height budget: ' +
    JSON.stringify(plain(hrStd)))
assert.ok(hrStd.includes('38;2'), 'divider is subtle-styled')
assert.ok(!plain(hrStd).endsWith('\n'), 'divider adds no trailing blank row')

// Bad baseline: `---` had no trailing newline and nothing inserted the row
// break, so a rule directly before a heading rendered `---H`. The join
// guard (appendBlockText) now keeps them on separate rows.
const hrThenHeading = applyMarkdown('---' + '\n' + '# H' + '\n')
assert.equal(plain(hrThenHeading), '\u2500\u2500\u2500' + '\n' + 'H',
  'divider never merges into the next block: ' + JSON.stringify(plain(hrThenHeading)))

const doubleHr = applyMarkdown('---' + '\n' + '***' + '\n')
assert.equal(plain(doubleHr), '\u2500\u2500\u2500' + '\n' + '\u2500\u2500\u2500',
  'two adjacent rules stay on separate rows')

// -- 3. Lists: hanging indent, steady ladder, loose-item markers --------

// Bad baseline proofs: loose items (blank line between items) rendered
// with NO marker at all - the paragraph went through renderParagraph's
// fresh state, which reset the list_item parent the old bullet branch
// keyed on. Soft-break continuations fell back to column 0. The old
// per-level indent double-counted the enclosing item (2/6/10 instead of
// 2/4/6), and inline styling recursing through em/strong kept that
// parent, so a bold lead grew one bullet per nested text token.
const tight = applyMarkdown('- a' + '\n' + '- b' + '\n')
assert.equal(plain(tight), '- a' + '\n' + '- b', 'tight items keep the byte shape Batch A locked')

const loose = applyMarkdown('- a para' + '\n' + '\n' + '  second para' + '\n' + '\n' + '- b' + '\n')
assert.equal(plain(loose), '- a para' + '\n' + '\n' + '  second para' + '\n' + '- b',
  'loose items keep their markers and hang follow-up paragraphs at the body column: ' +
    JSON.stringify(plain(loose)))

const softBreak = applyMarkdown('- first line' + '\n' + '  continued here' + '\n' + '- second' + '\n')
assert.equal(plain(softBreak), '- first line' + '\n' + '  continued here' + '\n' + '- second',
  'soft-break continuations hang under the item body')

const nested4 = applyMarkdown('- a' + '\n' + '  - b' + '\n' + '    - c' + '\n' + '      - d' + '\n')
assert.equal(plain(nested4), '- a' + '\n' + '  - b' + '\n' + '    - c' + '\n' + '      - d',
  'nesting ladder advances one marker width per level: ' + JSON.stringify(plain(nested4)))

const orderedNested = applyMarkdown('1. one' + '\n' + '   1. nested' + '\n')
assert.equal(plain(orderedNested), '1. one' + '\n' + '   a. nested',
  'nested ordered item aligns under the parent body column')

const orderedHang = applyMarkdown('1. first' + '\n' + '   continued' + '\n')
assert.equal(plain(orderedHang), '1. first' + '\n' + '   continued',
  'ordered hanging matches the marker width (3 for one digit)')

const taskHang = applyMarkdown('- [x] first' + '\n' + '  continued' + '\n')
assert.equal(plain(taskHang), '- [x] first' + '\n' + '      continued',
  'task-item continuation hangs past the checkbox (2 + 4 columns)')

const boldTail = applyMarkdown('- **bold** tail' + '\n')
assert.equal(plain(boldTail), '- bold tail', 'inline styling does not grow extra bullets')
assert.ok(boldTail.includes(BOLD), 'the strong span still renders bold')

const quoteInList = applyMarkdown('- item' + '\n' + '\n' + '  > quoted para' + '\n')
assert.equal(plain(quoteInList), '- item' + '\n' + '\n' + '  \u258e quoted para',
  'blockquote inside an item indents under the body column')

const emptyItem = applyMarkdown('-' + '\n' + '- b' + '\n')
assert.equal(plain(emptyItem), '- ' + '\n' + '- b', 'an empty item still shows its marker row')

// Task-state shapes stay compatible with the Batch A gate (markers now
// also cover loose items, which previously lost them).
const tasks = applyMarkdown('- [x] done task' + '\n' + '- [ ] open task' + '\n')
assert.equal(plain(tasks), '- [x] done task' + '\n' + '- [ ] open task')
const looseTasks = applyMarkdown('- loose [x] a' + '\n' + '\n' + '- loose [ ] b' + '\n')
assert.equal(plain(looseTasks), '- loose [x] a' + '\n' + '- loose [ ] b',
  'loose task items carry bullets AND checkboxes')
const orderedTask = applyMarkdown('1. [x] ordered task' + '\n' + '2. plain item' + '\n')
assert.equal(plain(orderedTask), '1. [x] ordered task' + '\n' + '2. plain item')
const nestedTask = applyMarkdown('- outer' + '\n' + '  - [ ] nested open' + '\n')
assert.ok(plain(nestedTask).includes('  - [ ] nested open'), 'nested task keeps marker + checkbox')
const quotedTask = applyMarkdown('> - [x] quoted task' + '\n')
assert.equal(plain(quotedTask), '\u258e - [x] quoted task', 'quoted task line keeps marker + checkbox')
const cjkTask = applyMarkdown('- [x] \u4e2d\u6587\u4efb\u52a1' + '\n')
assert.equal(plain(cjkTask), '- [x] \u4e2d\u6587\u4efb\u52a1', 'CJK task text follows the checkbox')

// Markers keep the permission tint (list structure reads as structure).
assert.ok(applyMarkdown('- a' + '\n').includes('38;2'), 'bullet carries the theme tint')

// -- 4. Blockquotes: per-level gutters, empty-line structure ----------

// Bad baseline: every level used the same dim bar, blank lines inside a
// quote dropped the rail entirely (the structure broke across paragraph
// gaps), and a content-free `>` quote collapsed to nothing.
const quotedPlain = applyMarkdown('> a' + '\n' + '> more' + '\n')
assert.equal(plain(quotedPlain), '\u258e a' + '\n' + '\u258e more', 'level-1 quote keeps its rail per line')
assert.ok(quotedPlain.includes('38;2'), 'level-1 rail carries the subtle color (was dim-only)')
assert.ok(quotedPlain.includes(ITALIC), 'quoted text stays italic')

const quotedGap = applyMarkdown('> a' + '\n' + '>' + '\n' + '> b' + '\n')
assert.equal(plain(quotedGap), '\u258e a' + '\n' + '\u258e' + '\n' + '\u258e b',
  'blank lines inside a quote keep a bare rail: ' + JSON.stringify(plain(quotedGap)))

const bareQuote = applyMarkdown('>' + '\n')
assert.equal(plain(bareQuote), '\u258e', 'a content-free quote still shows one rail row')

const nestedQuote = applyMarkdown('> one' + '\n' + '> > two' + '\n' + '> > > three' + '\n')
assert.equal(
  plain(nestedQuote),
  '\u258e one' + '\n' + '\u258e \u258e two' + '\n' + '\u258e \u258e \u258f three',
  'nested quotes stack one rail per level: ' + JSON.stringify(plain(nestedQuote)),
)
const nestedLines = plain(nestedQuote).split('\n')
assert.ok(nestedLines[1]!.includes('\u258e \u258e'), 'second level doubles the rail')
assert.ok(nestedLines[2]!.includes('\u258f'), 'third level switches to the thinner one-eighth bar')
// Level styling: first rail colorized, deeper rails dim.
const secondLineAnsi = applyMarkdown('> one' + '\n' + '> > two' + '\n').split('\n')[1]!
assert.ok(secondLineAnsi.includes(ESC + '[2m'), 'the nested rail is dim, not colorized')

// -- 5. Images: alt text + OSC 8 link, never a download -------------

// Bad baseline: the image token echoed the bare href; the alt text was
// dropped entirely.
const OSC8_START = ESC + ']8;;'
const OSC8_END = String.fromCharCode(7)
const imgLine = applyMarkdown('![alt text](https://example.invalid/i.png) tail' + '\n')
assert.equal(visible(imgLine), '[img] alt text tail',
  'image renders the [img] marker + alt, not the bare URL: ' + JSON.stringify(visible(imgLine)))
assert.ok(imgLine.includes(OSC8_START + 'https://example.invalid/i.png' + OSC8_END),
  'the href rides an OSC 8 wrap (click target only)')
assert.ok(imgLine.indexOf(OSC8_START) < imgLine.indexOf('[img] alt text'), 'the label sits inside the wrap')

const imgNoAlt = applyMarkdown('![](https://example.invalid/i.png)' + '\n')
assert.equal(visible(imgNoAlt), '[img]', 'an empty alt still shows the linked marker')

// Multi-line alt collapses to single spaces.
const imgMultiAlt = applyMarkdown('![line one\nline two](https://example.invalid/i.png)' + '\n')
assert.equal(visible(imgMultiAlt), '[img] line one line two')

// Terminals without hyperlink support keep a readable plain form that
// still carries both the alt and the URL.
const savedTermProgram = process.env.TERM_PROGRAM
delete process.env.TERM_PROGRAM
const imgPlain = applyMarkdown('![alt text](https://example.invalid/i.png) tail' + '\n')
process.env.TERM_PROGRAM = savedTermProgram
assert.equal(visible(imgPlain), '[img] alt text (https://example.invalid/i.png) tail',
  'no-OSC8 terminals show alt + url as text: ' + JSON.stringify(visible(imgPlain)))

// An image nested in a link must not smuggle a second OSC 8 sequence
// (it would override the outer href).
const imgInLink = applyMarkdown('[![alt](https://img.invalid/x.png)](https://page.invalid)' + '\n')
assert.ok(imgInLink.includes(OSC8_START + 'https://page.invalid' + OSC8_END), 'the outer link keeps its href')
assert.ok(!imgInLink.includes('https://img.invalid/x.png' + OSC8_END), 'no nested OSC 8 for the inner image')
assert.ok(visible(imgInLink).includes('alt'), 'the inner alt survives as the link label')

// Rejected schemes degrade to the label only - the hostile href never
// reaches the screen as a clickable or printed URL.
const imgHostile = applyMarkdown('![alt](javascript:alert(1))' + '\n')
assert.equal(visible(imgHostile), '[img] alt', 'non-whitelisted scheme shows alt only')
assert.ok(!imgHostile.includes(OSC8_START + 'javascript:'), 'no OSC 8 wrap for a rejected scheme')

// -- 6. Screen-level rows + streaming equivalence ----------------------

const DOC =
  '# Title' + '\n' + '\n' +
  '- first item line' + '\n' + '  continued under body' + '\n' + '  - nested child' + '\n' +
  '- second' + '\n' + '\n' +
  '> quoted one' + '\n' + '> > quoted two' + '\n' + '\n' +
  '---' + '\n' + '\n' +
  '![chart](https://example.invalid/chart.png)' + '\n'

function snap(el: React.ReactElement, width: number): string[] {
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
    rowsOut.push(line.replace(/\u001b\]8;;[^\u0007]*\u0007/g, '').trimEnd())
  }
  return rowsOut.filter((row, index, all) => index < all.length - 1 || row !== '')
}

const expectedRows = [
  'Title',
  '',
  '- first item line',
  '  continued under body',
  '  - nested child',
  '- second',
  '',
  '\u258e quoted one',
  '\u258e \u258e quoted two',
  '',
  '\u2500\u2500\u2500',
  '[img] chart',
]
for (const width of [56, 34]) {
  assert.deepEqual(snap(<Markdown>{DOC}</Markdown>, width), expectedRows,
    'rendered rows at width ' + width)
}

// Streaming: the growing suffix must keep the whole-document row shape
// (sealed heading/list/quote blocks do not re-space when the divider and
// image arrive).
const COLS = 56
const ROWS = 30
async function renderRows(stages: readonly string[], streaming: boolean): Promise<string[]> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  const tree = (source: string): React.ReactNode => (
    <Box flexDirection="column" width={COLS}>
      <Text>{'D-START'}</Text>
      {streaming
        ? <StreamingMarkdown>{source}</StreamingMarkdown>
        : <Markdown>{source}</Markdown>}
      <Text>{'D-END'}</Text>
    </Box>
  )
  const app = await render(tree(stages[0]!), {
    stdout: new FakeStdout() as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  for (const stage of stages.slice(1)) {
    await new Promise(resolve => setTimeout(resolve, 60))
    app.rerender(tree(stage))
  }
  await new Promise(resolve => setTimeout(resolve, 150))
  const screen = Array.from(
    { length: ROWS },
    (_, y) => term.buffer.active.getLine(y)?.translateToString(true).trimEnd() ?? '',
  )
  await app.unmount()
  term.dispose()
  const start = screen.findIndex(line => line.includes('D-START'))
  const end = screen.findIndex(line => line.includes('D-END'))
  if (start < 0 || end <= start) throw new Error('sentinels missing\n' + screen.join('\n'))
  return screen.slice(start + 1, end)
}

const STAGES = [
  '# Title' + '\n' + '\n' + '- first item line' + '\n' + '  continued under body' + '\n' + '  - nested child' + '\n',
  '# Title' + '\n' + '\n' + '- first item line' + '\n' + '  continued under body' + '\n' + '  - nested child' + '\n' +
    '- second' + '\n' + '\n' + '> quoted one' + '\n' + '> > quoted two' + '\n',
  DOC,
]
for (let i = 0; i < STAGES.length; i++) {
  const settledRows = await renderRows(STAGES.slice(0, i + 1), false)
  const streamedRows = await renderRows(STAGES.slice(0, i + 1), true)
  assert.deepEqual(streamedRows, settledRows, 'streaming stage ' + i + ' equals settled render')
}

console.log('markdown batch D verified (headings, hr, lists, quotes, images, screen rows, streaming equivalence)')
