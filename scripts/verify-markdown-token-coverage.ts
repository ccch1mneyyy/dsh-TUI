/**
 * Markdown token-level correctness gate (Batch A of the rendering upgrade).
 *
 * 1. Token census: the real lexer (configureMarked + math extensions) over a
 *    corpus that exercises every GFM/math construct must produce EXACTLY the
 *    expected token-type set. A marked upgrade that introduces a new type
 *    fails here (fail closed) until dispatch grows a handler or the type is
 *    explicitly registered as ignored.
 * 2. Checkbox: task state ([x]/[ ]) must survive rendering between bullet
 *    and body - tight, ordered, nested, loose, quoted and CJK items alike.
 * 3. Deliberately invisible tokens (def, html) stay invisible.
 *
 * Run: node --import tsx/esm scripts/verify-markdown-token-coverage.ts
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

// Env first, then dynamic imports: static imports hoist above the env
// setup and chalk would cache a colorless level before FORCE_COLOR lands.
const [assertModule, { default: stripAnsi }, { marked }, markdown] = await Promise.all([
  import('node:assert/strict'),
  import('strip-ansi'),
  import('marked'),
  import('../src/terminal-utils/markdown.js'),
])
const assert = assertModule.default
const { applyMarkdown, codeLanguageTag, configureMarked, formatCodeBody, formatToken } = markdown
type Token = marked.Token

configureMarked()

// -- 1. Token census ----------------------------------------------------

const BS = String.fromCharCode(92) // single backslash for markdown escapes
const CORPUS = [
  '# heading 1\n\n## heading 2\n\n### h3\n',
  'paragraph with **strong**, *em*, `code`, ~~gone~~ and ~100 approx.\n',
  '- tight one\n- tight two\n',
  '- [x] done task\n- [ ] open task\n',
  '1. [x] ordered task\n2. plain item\n',
  '- outer\n  - [ ] nested open\n',
  '- loose [x] a\n\n- loose [ ] b\n',
  '> quoted\n> more\n',
  '> - [x] quoted task\n',
  '---\n',
  '```ts\nconst a = 1\n```\n',
  '```\nno lang fence\n```\n',
  '| a | b |\n| - | - |\n| 1 | 2 |\n',
  '[link](https://example.invalid) and ![alt](img.png)\n',
  '[ref]: https://example.invalid\n\n[go][ref]\n',
  '<div>block html</div>\n',
  'inline <span>tag</span> text\n',
  'escape ' + BS + '* this\n',
  'line one  \nline two\n',
  '$inline math$ and text\n',
  '$$\nblock math\n$$\n',
  '- [x] \u4e2d\u6587\u4efb\u52a1\n',
]

function collectTokenTypes(tokens: Token[], into: Set<string>): void {
  for (const token of tokens) {
    into.add(token.type)
    const container = token as { tokens?: Token[]; items?: Token[] }
    if (container.tokens) collectTokenTypes(container.tokens, into)
    if (container.items) collectTokenTypes(container.items, into)
  }
}

const census = new Set<string>()
for (const sample of CORPUS) collectTokenTypes(marked.lexer(sample), census)

// The 'del' entry arrived when the double-tilde tokenizer override was
// removed (Batch A): marked's built-in del only pairs double tildes.
// Every type dispatch knows how to render, plus the two deliberate
// no-ops. 'del' is absent while the tokenizer override disables it
// (Batch A re-enables it and this expectation grows with it).
const EXPECTED = new Set([
  'blockquote', 'br', 'checkbox', 'code', 'codespan', 'def', 'del', 'em', 'escape',
  'heading', 'hr', 'html', 'image', 'link', 'list', 'list_item', 'math',
  'mathBlock', 'paragraph', 'space', 'strong', 'table', 'text',
])
assert.deepEqual([...census].sort(), [...EXPECTED].sort(),
  'token census changed - new token types must gain a dispatch handler or an explicit ignore entry')

// -- 2. Checkbox state --------------------------------------------------

const tasks = applyMarkdown('- [x] done task\n- [ ] open task\n')
assert.ok(stripAnsi(tasks).includes('- [x] done task'),
  'checked task keeps [x] between bullet and body: ' + JSON.stringify(tasks))
assert.ok(stripAnsi(tasks).includes('- [ ] open task'),
  'unchecked task keeps [ ] between bullet and body')
assert.ok(!stripAnsi(tasks).includes('- done task'), 'checked state must not be dropped')

const orderedTask = applyMarkdown('1. [x] ordered task\n')
assert.ok(stripAnsi(orderedTask).includes('1. [x] ordered task'),
  'ordered task item keeps its checkbox: ' + JSON.stringify(orderedTask))

const nested = applyMarkdown('- outer\n  - [ ] nested open\n')
assert.ok(stripAnsi(nested).includes('[ ] nested open'), 'nested task item keeps its checkbox')

const loose = applyMarkdown('- loose [x] a\n\n- loose [ ] b\n')
assert.ok(stripAnsi(loose).includes('[x] a'), 'loose task item keeps its checkbox: ' + JSON.stringify(loose))
assert.ok(stripAnsi(loose).includes('[ ] b'), 'loose unchecked item keeps its checkbox')

const quoted = applyMarkdown('> - [x] quoted task\n')
assert.ok(stripAnsi(quoted).includes('[x] quoted task'),
  'task item inside a blockquote keeps its checkbox: ' + JSON.stringify(quoted))

const cjk = applyMarkdown('- [x] \u4e2d\u6587\u4efb\u52a1\n')
assert.ok(stripAnsi(cjk).includes('- [x] \u4e2d\u6587\u4efb\u52a1'),
  'CJK task text renders after the checkbox: ' + JSON.stringify(cjk))

// Checked/unchecked styling differs (success vs subtle) - both carry ANSI
// under FORCE_COLOR=3 and strip back to width-safe ASCII.
assert.ok(tasks !== stripAnsi(tasks), 'checkbox marks are styled under FORCE_COLOR=3')
const checkedMark = tasks.slice(tasks.indexOf('[x]') - 20, tasks.indexOf('[x]') + 3)
assert.notEqual(checkedMark, '', 'checked glyph present')

// -- 2b. Strikethrough (double tilde only) ------------------------------

const struck = applyMarkdown('a ~~gone~~ b ~100 approx\n')
const struckPlain = stripAnsi(struck)
assert.ok(struckPlain.includes('gone'), 'strikethrough content renders: ' + JSON.stringify(struck))
assert.ok(!struckPlain.includes('~~'), 'double-tilde markers are consumed, not echoed')
assert.ok(struckPlain.includes('~100 approx'), 'single tilde stays literal')
assert.ok(struck.includes('\u001b[9m'), 'strikethrough SGR applied under FORCE_COLOR=3')
const strikeInside = applyMarkdown('~~**bold gone**~~\n')
assert.ok(stripAnsi(strikeInside).includes('bold gone'), 'strong inside del renders')

// -- 3. Deliberate invisibility -----------------------------------------

assert.equal(applyMarkdown('[ref]: https://example.invalid\n').trim(), '',
  'reference definitions stay invisible')
assert.equal(stripAnsi(applyMarkdown('<div>block html</div>\n')).trim(), '',
  'block html is not echoed')
assert.equal(stripAnsi(applyMarkdown('inline <span>tag</span> text\n')), 'inline tag text',
  'inline html tags are dropped, inner text kept')

// -- 4. Handler sanity for the shapes the census promises ---------------

assert.ok(stripAnsi(applyMarkdown('**bold** and `code`\n')).includes('bold and code'))
assert.ok(applyMarkdown('## head\n').includes('head'), 'heading text renders')
assert.ok(applyMarkdown('---\n').includes('---'), 'hr renders its divider')
const fence = applyMarkdown('```ts\nconst a = 1\n```\n')
assert.ok(fence.includes('const a = 1'), 'fenced code body renders')
assert.ok(stripAnsi(fence).includes('```ts'), 'fence line names the language')

// -- 5. Unknown tokens fail closed --------------------------------------

// A fabricated token type no dispatcher branch knows: the raw source must
// survive (visible fail-closed), not collapse to the silent empty string
// the old catch-all returned. Bad-baseline red: '' swallowed the text.
const bogus = { type: 'zzz-unknown-extension', raw: 'RAW-SENTINEL' } as Token
const bogusOut = formatToken(bogus)
assert.equal(bogusOut, 'RAW-SENTINEL', 'unknown token echoes its raw source: ' + JSON.stringify(bogusOut))

const bogusEmpty = { type: 'zzz-empty', raw: '' } as Token
assert.equal(formatToken(bogusEmpty), '', 'unknown token without raw renders nothing')

// The two deliberate ignores stay explicit and silent.
const defToken = { type: 'def', raw: '[x]: /y' } as Token
assert.equal(formatToken(defToken), '', 'def is the explicit invisible ignore')
const htmlToken = { type: 'html', raw: '<br>' } as Token
assert.equal(formatToken(htmlToken), '', 'html is the explicit invisible ignore')

// -- 6. Highlighter isolation: sync throw degrades, never crashes --------

const codeSrc = 'const boom = 1' + '\n' + 'return boom'
const throwHighlight = {
  supportsLanguage: () => true,
  highlight: (): string => {
    throw new Error('fake cli-highlight explosion')
  },
} as unknown as Parameters<typeof formatCodeBody>[1]
const degraded = applyMarkdown('```ts' + '\n' + codeSrc + '\n' + '```' + '\n', throwHighlight)
const degradedPlain = stripAnsi(degraded)
assert.ok(degradedPlain.includes('const boom = 1'), 'body survives a throwing highlighter: ' + JSON.stringify(degradedPlain))
assert.ok(degradedPlain.includes('```ts'), 'fence line and language label survive')

const bodyDirect = formatCodeBody({ type: 'code' as const, raw: '', lang: 'ts', text: codeSrc }, throwHighlight)
assert.equal(bodyDirect, codeSrc, 'formatCodeBody returns the plain body on throw')

// Unknown language: no crash, plaintext body, label intact.
const rejectHighlight = {
  supportsLanguage: (name: string) => name === 'js',
  highlight: (code: string, opts: { language: string }) =>
    opts.language === 'plaintext' ? code : 'styled:' + code,
} as unknown as Parameters<typeof formatCodeBody>[1]
const unknownLang = formatCodeBody(
  { type: 'code' as const, raw: '', lang: 'fancy-new-lang meta=x', text: codeSrc },
  rejectHighlight,
)
assert.equal(unknownLang, codeSrc, 'unsupported language falls back to plaintext')

// Happy path passthrough + first-word language resolution.
const okHighlight = {
  supportsLanguage: (name: string) => name === 'js',
  highlight: (code: string, opts: { language: string }) => 'L:' + opts.language + ':' + code,
} as unknown as Parameters<typeof formatCodeBody>[1]
const styled = formatCodeBody(
  { type: 'code' as const, raw: '', lang: 'js meta=1', text: codeSrc },
  okHighlight,
)
assert.equal(styled, 'L:js:' + codeSrc, 'fence info resolves to its first word')

// Trailing blank lines are trimmed in both paths.
assert.equal(
  formatCodeBody({ type: 'code' as const, raw: '', lang: '', text: 'a\n\n' }, null),
  'a',
  'trailing blank lines stripped',
)
console.log('markdown token coverage passed (census, checkbox, strikethrough, invisibles, fail-closed unknowns, highlighter isolation)')
