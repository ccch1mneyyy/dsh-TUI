/** Mermaid diagram rendering regression: engine contract the component
 * relies on (display-width reporting, styled/plain parity, streaming
 * monotonicity), the viewport fit / fallback decisions, the settings switch,
 * and the Markdown dispatch. Run with:
 * node --import tsx/esm scripts/verify-mermaid-diagram.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  assertModule,
  React,
  { renderToScreen },
  { cellAt },
  { stringWidth },
  { TerminalSizeContext },
  { MermaidDiagram },
  { Markdown },
  { getMermaidEnginePromise, isMermaidLang, renderMermaid },
  { applyMermaidDiagrams },
] = await Promise.all([
  import('node:assert/strict'),
  import('react'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/components/MermaidDiagram.js'),
  import('../src/components/Markdown.js'),
  import('../src/terminal-utils/mermaid.js'),
  import('../src/tuiDisplayPrefs.js'),
])
const assert = assertModule.default

const engine = await getMermaidEnginePromise()
assert.ok(engine, 'lovely-mermaid must load')

const FLOWCHART = [
  'flowchart LR',
  '  A[用户输入] --> B{是否 mermaid?}',
  '  B -->|yes| C[lovely-mermaid]',
  '  B -->|no| D[原样代码块]',
  '  C --> E[Unicode art]',
].join('\n')
const SEQUENCE = 'sequenceDiagram\n  participant U as User\n  participant T as TUI\n  U->>T: submit\n  T-->>U: stream'
const BOX_DRAWING = /[┌┐└┘─│├┤┬┴╔╗╚╝═║▶◄]/

function lines(element: React.ReactElement, width: number): string[] {
  const screen = renderToScreen(element, width)
  return Array.from({ length: screen.height }, (_, row) =>
    Array.from({ length: width }, (_, column) => cellAt(screen.screen, column, row)?.char ?? '').join('').trimEnd(),
  )
}

function codeToken(text: string, lang = 'mermaid') {
  return { type: 'code' as const, raw: '```' + lang + '\n' + text + '\n```', lang, text }
}

function renderDiagram(text: string, width: number, lang = 'mermaid'): string[] {
  return lines(
    <TerminalSizeContext.Provider value={{ columns: width, rows: 40 }}>
      <MermaidDiagram token={codeToken(text, lang) as never} highlight={null} dimColor={false} forceWidth={width} />
    </TerminalSizeContext.Provider>,
    width,
  )
}

// ── Engine contract ───────────────────────────────────────────────────

const cjk = renderMermaid(engine, FLOWCHART)
assert.ok(cjk, 'a CJK flowchart renders')
assert.equal(cjk.warnings.length, 0, 'the full source parses without warnings')
assert.equal(
  Math.max(...cjk.plain.map(row => stringWidth(row))),
  cjk.width,
  'art.width is the display width of the widest row (CJK labels count two columns)',
)
assert.ok(
  cjk.styled.every((row, index) => row.map(span => span.text).join('') === cjk.plain[index]),
  'styled rows join back to the plain rows, so painting cannot shift columns',
)

for (const [name, source] of [['flowchart', FLOWCHART], ['sequence', SEQUENCE]] as const) {
  let drawnSince = -1
  for (let end = 1; end <= source.length; end++) {
    const art = renderMermaid(engine, source.slice(0, end))
    if (art && drawnSince < 0) drawnSince = end
    if (drawnSince >= 0) assert.ok(art, `${name}: prefix ${end} flipped back to null after art at ${drawnSince}`)
  }
  assert.ok(drawnSince > 0, `${name}: some prefix draws`)
}

assert.equal(renderMermaid(engine, 'gantt\n  title x'), null, 'unsupported diagram types yield null')
assert.equal(renderMermaid(engine, 'x'.repeat(20_001)), null, 'the source-length guard skips the engine')

assert.equal(isMermaidLang('mermaid'), true)
assert.equal(isMermaidLang('Mermaid title=flow'), true)
assert.equal(isMermaidLang('mermaidjs'), false)
assert.equal(isMermaidLang('js'), false)
assert.equal(isMermaidLang(undefined), false)

// ── Component: fit, fallback, switch ──────────────────────────────────

const wide = renderDiagram(FLOWCHART, 100)
assert.ok(wide.some(line => BOX_DRAWING.test(line)), 'a fitting diagram renders as box art')
assert.ok(!wide.some(line => line.includes('```')), 'the diagram carries no fence line')
assert.ok(wide.some(line => line.includes('用户输入')), 'CJK labels survive')
assert.ok(wide.every(line => stringWidth(line) <= 100), 'the diagram stays inside the viewport')
assert.ok(wide.every(line => line === '' || line.startsWith('  ')), 'art rows carry the code-block indent')

const narrow = renderDiagram(FLOWCHART, 40)
assert.equal(narrow[0], '```mermaid', 'the source fallback is a real code block, fence line included')
assert.ok(narrow.some(line => line.includes('flowchart LR')), 'a too-wide diagram falls back to the fenced source')
assert.ok(!narrow.some(line => BOX_DRAWING.test(line)), 'no box art leaks into the fallback')
assert.ok(
  narrow.some(line => line.includes(`diagram needs ${cjk!.width} columns`)),
  'the fallback captions the width the diagram needs',
)

const unsupported = renderDiagram('gantt\n  title x', 100)
assert.ok(unsupported.some(line => line.includes('gantt')), 'unsupported types show the source')
assert.ok(!unsupported.some(line => line.includes('diagram needs')), 'no width caption without art')

applyMermaidDiagrams(false)
const disabled = renderDiagram(FLOWCHART, 100)
assert.ok(disabled.some(line => line.includes('flowchart LR')) && !disabled.some(line => BOX_DRAWING.test(line)),
  'the setting off keeps the fenced source')
assert.ok(!disabled.some(line => line.includes('diagram needs')), 'the setting off adds no caption')
applyMermaidDiagrams(undefined)
assert.ok(renderDiagram(FLOWCHART, 100).some(line => BOX_DRAWING.test(line)), 'unset re-enables the default')

// ── Markdown dispatch ─────────────────────────────────────────────────

function renderMarkdown(source: string, width: number): string[] {
  return lines(
    <TerminalSizeContext.Provider value={{ columns: width, rows: 40 }}>
      <Markdown>{source}</Markdown>
    </TerminalSizeContext.Provider>,
    width,
  )
}

const document = `before\n\n\`\`\`mermaid\n${SEQUENCE}\n\`\`\`\n\nafter`
const rendered = renderMarkdown(document, 100)
assert.equal(rendered[0], 'before')
assert.equal(rendered.at(-1), 'after')
assert.ok(rendered.some(line => BOX_DRAWING.test(line)), 'a mermaid fence inside prose renders as a diagram')
assert.ok(rendered.some(line => line.includes('User') && line.includes('TUI')), 'participants are laid out side by side')

const plainFence = renderMarkdown('```js\nconst a = 1\n```', 100)
assert.ok(plainFence.some(line => line.includes('const a = 1')) && !plainFence.some(line => BOX_DRAWING.test(line)),
  'other fences stay ordinary code blocks')

console.log('Mermaid diagrams verified: engine width/parity/streaming contract, viewport fit and fallbacks, settings switch, Markdown dispatch')
