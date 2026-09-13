/**
 * Long Markdown blocks must match the unsplit formatter, including spacing.
 * Run: node --import tsx/esm scripts/verify-streaming-markdown-blocks.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import assert from 'node:assert/strict'
import type { Tokens } from 'marked'
import type { DOMNode, TextNode, DOMElement } from '../src/ink/dom.js'
import type { Frame } from '../src/ink/frame.js'
import type { Screen } from '../src/ink/screen.js'

const [React, { marked }, { Box, Text }, { Markdown }, { StreamingMarkdown }, { MarkdownTable }, { configureMarked, formatToken }, { renderToScreen }, { cellAtIndex }] = await Promise.all([
  import('react'), import('marked'), import('../src/ui.js'),
  import('../src/components/Markdown.js'), import('../src/components/StreamingMarkdown.js'),
  import('../src/components/MarkdownTable.js'), import('../src/terminal-utils/markdown.js'),
  import('../src/ink/render-to-screen.js'), import('../src/ink/screen.js'),
])
configureMarked()

function unsplit(source: string): React.ReactElement {
  const nodes: React.ReactNode[] = []
  let text = ''
  const flush = () => {
    if (text) nodes.push(<Text key={nodes.length}>{text.trim()}</Text>)
    text = ''
  }
  for (const token of marked.lexer(source.trim())) {
    if (token.type === 'table') {
      flush()
      nodes.push(<MarkdownTable key={nodes.length} token={token as Tokens.Table} highlight={null} />)
    } else text += formatToken(token)
  }
  flush()
  return <Box flexDirection="column" gap={1}>{nodes}</Box>
}

function screenSnapshot(screen: Screen, height = screen.height, styles = true) {
  return {
    height,
    cells: Array.from({ length: screen.width * height }, (_, index) => {
      const cell = cellAtIndex(screen, index)
      // wrap-ansi normalizes wrapped text; a short unwrapped suffix can
      // retain decomposed code points for the same displayed grapheme.
      return { char: cell.char.normalize(), width: cell.width, hyperlink: cell.hyperlink, styleId: styles ? cell.styleId : undefined }
    }),
  }
}

function snapshot(element: React.ReactElement, width: number, styles = true) {
  const { screen, height } = renderToScreen(element, width)
  return screenSnapshot(screen, height, styles)
}

const paragraph = (index: number) => `Paragraph ${index}: **bold text**, inline \`value\`, and ordinary words to exercise wrapping across the sealed boundary.\n\n`
const prefix = Array.from({ length: 100 }, (_, index) => paragraph(index)).join('')
const cases = [
  prefix + 'tail',
  prefix + '\n\n\nlast paragraph\n',
  prefix + '```ts\nconst value = 1\n```\nprose after code\n\n',
  prefix + '- first item\n- second item\n\nnext paragraph',
  prefix + '> a quoted paragraph\n> another line\n\ntail',
  prefix + '| a | b |\n| - | - |\n| 1 | 2 |\n\n| c |\n| - |\n| 3 |\n\ntail',
  '[link][target]\n\n' + prefix + '[target]: https://example.invalid\n\ntail',
  '[target]: https://example.invalid\n\n' + prefix + '[go][target]',
  prefix + '[target]: https://example.invalid\n\n[go][target]',
  '[target]: https://example.invalid\n\n' + prefix + '[go][target] ' + 'growing tail '.repeat(400),
  prefix + '<div>hidden</div>\n\nvisible tail',
  prefix + '\u4e2d\u6587 e\u0301 \ud83d\ude00 final text',
  prefix.slice(0, 7600) + '\n\n| a | b |\n| - | - |\n' + '| long cell content | another cell |\n'.repeat(40) + '\ntail',
  '```\n' + 'a long code line\n'.repeat(600) + '```\n\ntail',
]

for (const width of [55, 100]) {
  for (const [index, source] of cases.entries()) {
    const expected = snapshot(unsplit(source), width)
    assert.deepEqual(snapshot(<Markdown>{source}</Markdown>, width), expected, `settled case ${index}, width ${width}`)
    assert.deepEqual(snapshot(<StreamingMarkdown>{source}</StreamingMarkdown>, width), expected, `streaming case ${index}, width ${width}`)
  }
}

const [{ PassThrough, Writable }, { render }, { default: instances }, { settled }, { scanPositions }] = await Promise.all([
  import('node:stream'), import('../src/ui.js'), import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'), import('../src/ink/render-to-screen.js'),
])
class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  isTTY = true
  columns = 55
  rows = 1000
  _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() }
}
function firstParagraph(node: DOMNode): TextNode | undefined {
  if (node.nodeName === '#text') return node.nodeValue.includes('Paragraph 0:') ? node : undefined
  for (const child of node.childNodes) {
    const found = firstParagraph(child)
    if (found) return found
  }
  return undefined
}
const stdout = new Output()
const app = await render(<StreamingMarkdown>{prefix + 'WARM-TAIL-0'}</StreamingMarkdown>, {
  stdout: stdout as unknown as NodeJS.WriteStream, stdin: new Input() as unknown as NodeJS.ReadStream,
  stderr: new Output() as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
})
const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as { rootNode: DOMElement; frontFrame: Frame }
try {
  assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, 'WARM-TAIL-0').length === 1))
  const sealed = firstParagraph(ink.rootNode)!
  const sealedText = sealed.nodeValue
  const appended = prefix + 'WARM-TAIL-0\n\n' + paragraph(101) + 'WARM-TAIL-1'
  app.rerender(<StreamingMarkdown>{appended}</StreamingMarkdown>)
  assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, 'WARM-TAIL-1').length === 1))
  assert.equal(firstParagraph(ink.rootNode), sealed, 'an append must retain the sealed text node')
  assert.equal(sealed.nodeValue, sealedText, 'an append must not rewrite the sealed text')
  // Style IDs are local to each render root. The cold comparisons above
  // check colours; this cross-root check covers geometry, text and links.
  assert.deepEqual(screenSnapshot(ink.frontFrame.screen, undefined, false), snapshot(unsplit(appended), 55, false))

  const replacement = '[go][target]\n\n' + prefix + 'REPLACED-END'
  app.rerender(<StreamingMarkdown>{replacement}</StreamingMarkdown>)
  assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, 'REPLACED-END').length === 1))
  assert.deepEqual(screenSnapshot(ink.frontFrame.screen, undefined, false), snapshot(unsplit(replacement), 55, false), 'replacement drops obsolete blocks')
  const defined = replacement + '\n\n[target]: https://example.invalid\n\nLINK-END'
  app.rerender(<StreamingMarkdown>{defined}</StreamingMarkdown>)
  assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, 'LINK-END').length === 1))
  assert.deepEqual(screenSnapshot(ink.frontFrame.screen, undefined, false), snapshot(unsplit(defined), 55, false), 'late definitions update earlier references')

  const referencePrefix = '[target]: https://example.invalid\n\n' + prefix
  for (const [index, tail] of ['[go][target]', '[go][target] more text', '[go][target]\n\n[next][target]'].entries()) {
    const marker = `REFERENCE-END-${index}`
    const source = referencePrefix + tail + ' ' + marker
    app.rerender(<StreamingMarkdown>{source}</StreamingMarkdown>)
    assert.ok(await settled(() => scanPositions(ink.frontFrame.screen, marker).length === 1))
    assert.deepEqual(screenSnapshot(ink.frontFrame.screen, undefined, false), snapshot(unsplit(source), 55, false), 'growing suffix resolves definitions from the stable prefix')
  }
} finally {
  await app.unmount()
}

console.log('streaming Markdown blocks passed (unsplit cell equivalence, tables, code, references and Unicode)')
