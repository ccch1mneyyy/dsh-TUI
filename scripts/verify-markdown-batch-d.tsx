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

// Env first, then dynamic imports: static imports hoist above the env
// setup and chalk would cache a colorless level before FORCE_COLOR lands.
const [
  assertModule,
  React,
  { Writable },
  { Terminal: XTerm },
  { Box, Text },
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

console.log('markdown batch D: heading layering + compressed whitespace passed')
