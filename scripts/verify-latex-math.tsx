/** LaTeX math rendering regression: the vendored renderer's contract
 * (./src/terminal-utils/latex.ts, from Pi), delimiter recognition and its
 * prose guards (prices, shell variables, PIDs, code), the Markdown dispatch
 * (inline Unicode, display blocks, nested blocks, tables), the viewport and
 * settings fallbacks, and streaming parity: a reply fed one character at a
 * time through StreamingMarkdown must settle on the same screen as a
 * one-shot Markdown render. Run with:
 * node --import tsx/esm scripts/verify-latex-math.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  assertModule,
  { Writable },
  React,
  { Terminal: XTerm },
  { marked },
  { renderToScreen },
  { cellAt },
  { stringWidth },
  { TerminalSizeContext },
  { render, Box, Text },
  { Markdown },
  { StreamingMarkdown },
  { MathBlock },
  { renderLatex },
  { renderDisplayMath, renderInlineMath },
  { configureMarked },
  { applyLatexMath },
] = await Promise.all([
  import('node:assert/strict'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('marked'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/ui.js'),
  import('../src/components/Markdown.js'),
  import('../src/components/StreamingMarkdown.js'),
  import('../src/components/MathBlock.js'),
  import('../src/terminal-utils/latex.js'),
  import('../src/terminal-utils/math.js'),
  import('../src/terminal-utils/markdown.js'),
  import('../src/tuiDisplayPrefs.js'),
])
const assert = assertModule.default
configureMarked()

// ── Vendored renderer contract (cases from Pi's latex.test.ts) ─────────

const INLINE_CASES: ReadonlyArray<readonly [string, string]> = [
  [String.raw`\mathbb{C}^3 \to \mathbb{C}^3`, 'ℂ³ → ℂ³'],
  [String.raw`F_1 = -\frac{1}{4x^2}.`, 'F₁ = -1/(4x²).'],
  [String.raw`e^{i\pi}+1=0`, 'e^(iπ)+1 = 0'],
  [String.raw`\alpha + \beta \leq \sqrt{x^2+y^2}`, 'α + β ≤ √(x²+y²)'],
  [String.raw`\forall \epsilon > 0, \exists \delta`, '∀ ϵ > 0, ∃ δ'],
  [String.raw`\deg q = 3`, 'deg q = 3'],
]
for (const [source, expected] of INLINE_CASES) {
  assert.equal(renderLatex(source), expected, `renderLatex(${JSON.stringify(source)})`)
}
assert.equal(
  renderLatex(String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`, { display: true }),
  '    -b±√(b²-4ac)\nx = ────────────\n         2a',
  'display mode stacks fractions',
)
assert.equal(renderLatex(String.raw`\sum_{i=0}^n x_i`, { display: true }), ' n\n ∑  xᵢ\ni=0', 'display mode stacks limits')
assert.equal(
  renderLatex(String.raw`f(x) = \begin{cases} x^{2} & x \geq 0 \\ -x & x < 0 \end{cases}`),
  '       ⎧ x² if x ≥ 0\nf(x) = ⎨\n       ⎩ -x if x < 0',
  'cases lay out over rows even outside display mode',
)
assert.equal(renderLatex(String.raw`x + \unknown{y}`), undefined, 'unsupported commands yield undefined')
for (const malformed of [String.raw`\frac{1}{x`, 'x}', String.raw`\begin{matrix}1 & 2`, 'x\\']) {
  assert.equal(renderLatex(malformed), undefined, `malformed ${JSON.stringify(malformed)} yields undefined`)
}
assert.equal(stringWidth('ℂ³ → ℂ³'), 7, 'the display-width helper counts math symbols as one column')

// ── Render policy (math.ts) ────────────────────────────────────────────

assert.equal(renderInlineMath(String.raw`\alpha^2`), 'α²')
assert.equal(
  renderInlineMath(String.raw`\begin{cases} 1 & x \\ 0 & y \end{cases}`),
  undefined,
  'inline math never returns a multi-line layout',
)
assert.equal(renderInlineMath(`x+${'y'.repeat(5000)}`), undefined, 'the source-length cap keeps the source')
assert.deepEqual(renderDisplayMath(String.raw`\frac{1}{2}`), ['1', '─', '2'])

// ── Delimiter recognition ──────────────────────────────────────────────

function mathTexts(source: string): string[] {
  const found: string[] = []
  marked.walkTokens(marked.lexer(source), token => {
    if (token.type === 'math' || token.type === 'mathBlock') found.push(`${token.type}:${token.text}`)
  })
  return found
}

const PROSE = [
  'Costs $5 and $10 or $8k–$12k; use `$x$`, $HOME, and ${PATH}',
  'money: $5.00 and $10.00; shell: $HOME/$USER',
  'pid: echo $$ and $$ again',
  String.raw`Escaped \$x-y\$.`,
  'prices $5,$6 and $A$B',
  '```text\n$\\mathbb{C}^3$\n```',
  'inline `$\\alpha$` code',
]
for (const source of PROSE) {
  assert.deepEqual(mathTexts(source), [], `prose stays prose: ${JSON.stringify(source)}`)
}
assert.deepEqual(
  mathTexts(String.raw`Inline $E = mc^2$ and \(\alpha\) and $\{a, b\}$`),
  ['math:E = mc^2', 'math:\\alpha', 'math:\\{a, b\\}'],
  'inline delimiters keep the exact TeX (escapes not eaten by marked)',
)
assert.deepEqual(mathTexts('其中$x_i$表示第$i$个'), ['math:x_i', 'math:i'], 'CJK prose may touch the delimiters')
assert.deepEqual(mathTexts('$a*b*c$ and $x_1 + y_1$'), ['math:a*b*c', 'math:x_1 + y_1'], 'emphasis markers inside math stay math')
assert.deepEqual(mathTexts('text\n$$\n\\frac{a}{b}\n$$\nmore'), ['mathBlock:\\frac{a}{b}'], 'a $$ block interrupts a paragraph')
assert.deepEqual(mathTexts('\\[\nx^2\n\\]'), ['mathBlock:x^2'], '\\[ \\] is a block delimiter')
assert.deepEqual(mathTexts('$$x^2$$ trails prose\n\nnext'), ['math:x^2'], 'a $$ pair with trailing text is inline')
const MIXED_MATH_DOCUMENTS = [
  '$$x^2$$ trails prose\n\n**Important**\n\n$$y^2$$',
  '\\[x^2\\] trails prose\n\n**Important**\n\n\\[y^2\\]',
]
for (const source of MIXED_MATH_DOCUMENTS) {
  assert.deepEqual(
    mathTexts(source),
    ['math:x^2', 'mathBlock:y^2'],
    'the first closer with trailing prose must not consume a later formula',
  )
  const strongTexts: string[] = []
  marked.walkTokens(marked.lexer(source), token => {
    if (token.type === 'strong') strongTexts.push(token.text)
  })
  assert.deepEqual(strongTexts, ['Important'], 'intervening prose retains its Markdown structure')
}
assert.deepEqual(
  mathTexts('$$x + \\$$$\n'),
  ['mathBlock:x + \\$'],
  'an escaped dollar before the closing pair stays inside the formula',
)
assert.deepEqual(
  mathTexts('\\[x \\\\]\ny\\]\n'),
  ['mathBlock:x \\\\]\ny'],
  'an escaped bracket closer stays inside the formula',
)
assert.deepEqual(mathTexts('- item\n\n  $$\\sum_i i$$'), ['mathBlock:\\sum_i i'], 'blocks nest in list items')
assert.deepEqual(mathTexts('> $$\n> \\frac{a}{b}\n> $$'), ['mathBlock:\\frac{a}{b}'], 'blocks nest in blockquotes')
{
  const block = marked.lexer('lead\n\n$$\n\\frac{a}{').find(token => token.type === 'mathBlock') as
    { pending?: boolean } | undefined
  assert.equal(block?.pending, true, 'an unclosed $$ block is pending')
}
assert.deepEqual(
  mathTexts('costs $5 + tax, **note**'),
  [],
  'an unclosed $ does not swallow the rest of the paragraph',
)
assert.ok(
  marked.lexer('costs $5 + tax, **note**')[0]!.raw.includes('**note**') &&
    JSON.stringify(marked.lexer('costs $5 + tax, **note**')).includes('"type":"strong"'),
  'formatting after an unclosed $ still parses',
)

// ── Component and Markdown dispatch ────────────────────────────────────

function screenLines(element: React.ReactElement, width: number): string[] {
  const screen = renderToScreen(
    <TerminalSizeContext.Provider value={{ columns: width, rows: 40 }}>{element}</TerminalSizeContext.Provider>,
    width,
  )
  return Array.from({ length: screen.height }, (_, row) =>
    Array.from({ length: width }, (_, column) => cellAt(screen.screen, column, row)?.char ?? '').join('').trimEnd(),
  )
}

for (const source of MIXED_MATH_DOCUMENTS) {
  assert.deepEqual(
    screenLines(<Markdown>{source}</Markdown>, 80),
    ['x² trails prose', '', 'Important', '', '  y²'],
    'inline math, intervening prose and the following display block stay separate',
  )
}

const LONG_PREFIX = 'a'.repeat(501)
const LATE_INLINE_MATH = ['$x^2$', String.raw`\(x^2\)`]
const LATE_BLOCK_MATH = ['$$\nx^2\n$$', '\\[\nx^2\n\\]']
for (const cacheTokens of [true, false]) {
  for (const formula of LATE_INLINE_MATH) {
    const source = `${LONG_PREFIX} ${formula}`
    assert.equal(
      screenLines(<Markdown cacheTokens={cacheTokens}>{source}</Markdown>, 80).join(''),
      `${LONG_PREFIX} x²`,
      'inline math after a long plain prefix must reach the lexer',
    )
  }
  for (const formula of LATE_BLOCK_MATH) {
    const source = `${LONG_PREFIX}\n\n${formula}`
    const lines = screenLines(<Markdown cacheTokens={cacheTokens}>{source}</Markdown>, 80)
    assert.equal(lines.slice(0, -2).join(''), LONG_PREFIX, 'the long prose prefix remains intact')
    assert.deepEqual(lines.slice(-2), ['', '  x²'], 'a late display block still gets its own layout node')
  }
}

const QUADRATIC = String.raw`x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}`
const blockToken = (text: string, pending = false) => ({
  type: 'mathBlock' as const,
  raw: `$$\n${text}\n$$`,
  text,
  ...(pending ? { pending: true } : {}),
})

const wide = screenLines(<MathBlock token={blockToken(QUADRATIC)} dimColor={false} forceWidth={80} />, 80)
assert.deepEqual(
  wide.filter(line => line !== ''),
  ['      -b ± √(b²-4ac)', '  x = ──────────────', '            2a'],
  'a fitting block renders stacked and indented',
)

const narrow = screenLines(<MathBlock token={blockToken(QUADRATIC)} dimColor={false} forceWidth={20} />, 20)
assert.ok(!narrow.some(line => line.includes('─')), 'a too-wide block does not draw a torn layout')
assert.equal(narrow.map(line => line.trim()).join(' '), 'x = (-b ± √(b²-4ac))/(2a)', 'a too-wide block falls back to the single-line form, wrapping like prose')
assert.ok(narrow.every(line => line === '' || line.startsWith('  ')), 'every wrapped row of the fallback keeps the block indent')

const matrix = String.raw`\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}`
const narrowMatrix = screenLines(<MathBlock token={blockToken(matrix)} dimColor={false} forceWidth={8} />, 8)
assert.ok(narrowMatrix.join('').includes('\\begin{pmatrix}'), 'no single-line form either → exact source')

const pending = screenLines(<MathBlock token={blockToken(QUADRATIC, true)} dimColor={false} forceWidth={80} />, 80)
assert.ok(pending.some(line => line.includes('\\frac{-b')), 'a pending block shows its source')

const unsupported = screenLines(<MathBlock token={blockToken(String.raw`\unknown{x}`)} dimColor={false} forceWidth={80} />, 80)
assert.ok(unsupported.some(line => line.includes('\\unknown{x}')), 'an unsupported block shows its source')

const DOCUMENT = [
  String.raw`Energy $E = mc^2$, set $\mathbb{R}^n$, 其中$x_i$表示第$i$个.`,
  '',
  '$$',
  QUADRATIC,
  '$$',
  '',
  '- item $a^2$',
  '- nested:',
  '',
  String.raw`  $$\sum_{i=1}^n i$$`,
  '',
  '| sym | val |',
  '| --- | --- |',
  String.raw`| $\alpha$ | $x^2$ |`,
  '',
  'Price $5 and $10, shell $HOME.',
].join('\n')

const doc = screenLines(<Markdown>{DOCUMENT}</Markdown>, 80)
const docText = doc.join('\n')
assert.ok(docText.includes('Energy E = mc², set ℝⁿ, 其中xᵢ表示第i个.'), 'inline math renders inside prose')
assert.ok(docText.includes('  x = ──────────────'), 'a top-level block renders as a stacked layout')
assert.ok(docText.includes('a²'), 'inline math renders inside list items')
assert.ok(docText.includes('∑ᵢ₌₁ⁿ i'), 'a block nested in a list item renders single-line, not dropped')
assert.ok(screenLines(<Markdown>{'> $$\n> \\frac{a}{b}\n> $$'}</Markdown>, 80).join('\n').includes('a/b'), 'a block nested in a blockquote renders single-line, not dropped')
assert.ok(doc.some(line => line.includes('α') && line.includes('x²')), 'inline math renders inside table cells')
assert.ok(docText.includes('Price $5 and $10, shell $HOME.'), 'prices and shell variables stay verbatim')
assert.ok(!docText.includes('\\frac') && !docText.includes('\\mathbb'), 'no TeX source leaks when rendering is on')

applyLatexMath(false)
const off = screenLines(<Markdown>{DOCUMENT}</Markdown>, 80).join('\n')
assert.ok(off.includes(String.raw`$E = mc^2$`) && off.includes(String.raw`$\mathbb{R}^n$`), 'off: inline source verbatim')
assert.ok(off.includes(QUADRATIC), 'off: block source verbatim, backslashes intact')
assert.ok(!off.includes('x = ─'), 'off: no stacked layout')
applyLatexMath(undefined)
assert.ok(screenLines(<Markdown>{DOCUMENT}</Markdown>, 80).join('\n').includes('E = mc²'), 'unset re-enables the default')

// ── Streaming parity ───────────────────────────────────────────────────

const COLS = 72
const ROWS = 40
const START = 'math-start'
const END = 'math-end'

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
      <Text>{START}</Text>
      {streaming ? <StreamingMarkdown>{source}</StreamingMarkdown> : <Markdown>{source}</Markdown>}
      <Text>{END}</Text>
    </Box>
  )
  const app = await render(tree(stages[0]!), {
    stdout: new FakeStdout() as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  for (const stage of stages.slice(1)) {
    app.rerender(tree(stage))
    await new Promise(resolve => setImmediate(resolve)) // 固定窗:pacing
  }
  await new Promise(resolve => setTimeout(resolve, 150)) // 固定窗:墙钟
  const screen = Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true).trimEnd() ?? '')
  await app.unmount()
  term.dispose()
  const start = screen.findIndex(line => line.includes(START))
  const end = screen.findIndex(line => line.includes(END))
  if (start < 0 || end <= start) throw new Error(`sentinels missing\n${screen.join('\n')}`)
  return screen.slice(start + 1, end)
}

const STREAMED = [
  String.raw`Let $f(x) = x^2$ and \(\alpha > 0\).`,
  '',
  '$$',
  String.raw`\int_0^1 f(x)\,dx = \frac{1}{3}`,
  '$$',
  '',
  String.raw`Then $\sum_{i=1}^n i = \frac{n(n+1)}{2}$ holds; costs $5 and $10.`,
].join('\n')
const prefixes = Array.from({ length: STREAMED.length }, (_, index) => STREAMED.slice(0, index + 1))
const expected = await renderRows([STREAMED], false)
const actual = await renderRows(prefixes, true)
assert.deepEqual(actual, expected, 'char-by-char streaming settles on the one-shot render')
assert.ok(expected.some(line => line.includes('─')), 'the streamed reply contains a stacked block')

for (const source of [
  ...MIXED_MATH_DOCUMENTS,
  ...LATE_INLINE_MATH.map(formula => `${LONG_PREFIX} ${formula}`),
  ...LATE_BLOCK_MATH.map(formula => `${LONG_PREFIX}\n\n${formula}`),
]) {
  const stages = Array.from({ length: source.length }, (_, index) => source.slice(0, index + 1))
  assert.deepEqual(
    await renderRows(stages, true),
    await renderRows([source], false),
    'delimiter boundaries and late formulas must settle identically when streamed',
  )
}

console.log('LaTeX math verified: vendored renderer contract, delimiter guards, Markdown dispatch, fallbacks and settings, streaming parity')
