/** Semantic copy for terminal images: an image with copy text (a formula's
 * source) copies as that text once, wherever a selection touches it, instead
 * of its blank backing cells; the rows below a multi-row image add no empty
 * lines; copy regions survive the blit of a clean subtree and scrolling like
 * noSelect; an image without copy text stays out of copies; and rows marked
 * as wrap continuations join on copy like wrapped <Text>. Run with:
 * node --import tsx/esm scripts/verify-semantic-copy.tsx
 */
import assert from 'node:assert/strict'
import { createNode, setAttribute } from '../src/ink/dom.js'
import Output from '../src/ink/output.js'
import { blitRegion, CharPool, createScreen, HyperlinkPool, shiftRows, StylePool, type Screen } from '../src/ink/screen.js'
import { captureScrolledRows, getSelectedText, shiftSelectionForViewportResize, startSelection, updateSelection, type SelectionState } from '../src/ink/selection.js'
import type { TerminalImageSource } from '../src/ink/terminal-image.js'

const source: TerminalImageSource = { data: new Uint8Array(4 * 4), width: 2, height: 2 }
const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

function selection(fromCol: number, fromRow: number, toCol: number, toRow: number): SelectionState {
  const s = {
    anchor: null, focus: null, isDragging: false, anchorSpan: null,
    scrolledOffAbove: [], scrolledOffBelow: [], scrolledOffAboveSW: [], scrolledOffBelowSW: [],
    lastPressHadAlt: false, coveredFingerprint: null, coveredText: null, coveredGeometry: null, stale: false,
  } as unknown as SelectionState
  startSelection(s, fromCol, fromRow)
  updateSelection(s, toCol, toRow)
  return s
}

function image(copyText?: string) {
  const node = createNode('ink-image')
  if (copyText !== undefined) setAttribute(node, 'imageCopyText', copyText)
  return node
}

/** A 20×5 frame: "a " + inline image (3 cols) + " b" on row 0, a 3-row block
 * image on rows 1–3, "tail" on row 4, and a decorative image without copy
 * text at the end of row 0. */
function frame(): Screen {
  const screen = createScreen(20, 5, stylePool, charPool, hyperlinkPool)
  const output = new Output({ width: 20, height: 5, stylePool, screen, terminalImages: true })
  const inline = image('$x^2$')
  const block = image('$$\n\\frac{a}{b}\n$$')
  const decorative = image()
  output.write(0, 0, 'a ')
  assert.equal(output.image(inline, 2, 0, 3, 1, source), true)
  output.imageBacking(inline)
  output.write(5, 0, ' b')
  assert.equal(output.image(decorative, 10, 0, 2, 1, source), true)
  output.imageBacking(decorative)
  assert.equal(output.image(block, 2, 1, 6, 3, source), true)
  output.imageBacking(block)
  output.write(0, 4, 'tail')
  return output.get()
}

{
  const screen = frame()
  assert.equal(getSelectedText(selection(0, 0, 19, 0), screen), 'a $x^2$ b', 'an inline image copies its source in place; an image without copy text is left out')
  assert.equal(getSelectedText(selection(3, 0, 4, 0), screen), '$x^2$', 'touching part of an image copies all of it')
  assert.equal(
    getSelectedText(selection(0, 0, 19, 4), screen),
    'a $x^2$ b\n$$\n\\frac{a}{b}\n$$\ntail',
    'a multi-row image copies once, without the indent left of it; its lower rows add no empty lines',
  )
  assert.equal(getSelectedText(selection(0, 2, 19, 4), screen), '$$\n\\frac{a}{b}\n$$\ntail', 'starting inside the block still copies it whole')
}

{
  // A clean subtree is blitted from the previous frame: its regions travel.
  const previous = frame()
  const next = createScreen(20, 5, stylePool, charPool, hyperlinkPool)
  blitRegion(next, previous, 0, 0, 20, 5)
  assert.equal(getSelectedText(selection(0, 0, 19, 4), next), 'a $x^2$ b\n$$\n\\frac{a}{b}\n$$\ntail', 'a blitted frame keeps its copy regions')
  // Scrolling shifts regions with their rows.
  shiftRows(next, 0, 4, 1)
  assert.equal(getSelectedText(selection(0, 0, 19, 3), next), '$$\n\\frac{a}{b}\n$$\ntail', 'scrolling shifts copy regions with the cells')
}

{
  // Rows laid out outside <Text> mark a wrap continuation to join on copy.
  const screen = createScreen(20, 2, stylePool, charPool, hyperlinkPool)
  const output = new Output({ width: 20, height: 2, stylePool, screen, terminalImages: true })
  const inline = image('$y$')
  output.write(0, 0, 'wrapped ')
  output.write(0, 1, 'line ')
  assert.equal(output.image(inline, 5, 1, 2, 1, source), true)
  output.imageBacking(inline)
  output.softWrapRow(1, 8)
  const joined = output.get()
  assert.equal(joined.softWrap[1], 8, 'the continuation records where the previous row ends')
  assert.equal(getSelectedText(selection(0, 0, 19, 1), joined), 'wrapped line $y$', 'a wrapped row joins its predecessor on copy')
}

{
  // Drag-to-scroll: rows scrolled out are captured as text before they go.
  // A formula split between captured and visible rows copies once.
  const screen = frame()
  const s = selection(0, 0, 19, 4)
  captureScrolledRows(s, screen, 0, 2, 'above')
  s.anchor = { col: 0, row: 3 }
  assert.equal(getSelectedText(s, screen), 'a $x^2$ b\n$$\n\\frac{a}{b}\n$$\ntail', 'a formula scrolled half out during a drag copies once')
}

{
  // Something painted over an image later (a menu, an overlay) is what
  // copies there, not the formula beneath it.
  const screen = createScreen(20, 2, stylePool, charPool, hyperlinkPool)
  const output = new Output({ width: 20, height: 2, stylePool, screen, terminalImages: true })
  const block = image('$$\nz\n$$')
  output.write(0, 0, ' '.repeat(10) + '\n' + ' '.repeat(10))
  assert.equal(output.image(block, 0, 0, 10, 2, source), true)
  output.imageBacking(block)
  output.write(0, 1, 'MENU')
  const covered = output.get()
  assert.equal(getSelectedText(selection(0, 1, 3, 1), covered), 'MENU', 'an overlay covering a formula copies as itself')
  assert.equal(getSelectedText(selection(0, 0, 9, 0), covered), '$$\nz\n$$', 'the uncovered part of the formula still copies its source')
}

{
  // Region texts do not pile up while a formula is blitted frame after frame
  // and another one is repainted every frame.
  let previous = frame()
  for (let index = 0; index < 50; index++) {
    const next = createScreen(20, 5, stylePool, charPool, hyperlinkPool)
    const output = new Output({ width: 20, height: 5, stylePool, screen: next, terminalImages: true })
    output.blit(previous, 0, 1, 20, 3)
    const inline = image(`$n_{${index}}$`)
    assert.equal(output.image(inline, 0, 0, 3, 1, source), true)
    output.imageBacking(inline)
    previous = output.get()
  }
  assert.ok(previous.copyTexts!.size <= 2, `only live regions keep their text (got ${previous.copyTexts!.size})`)
}

{
  // A viewport that shrinks under a live selection (a bottom panel opens)
  // captures the covered rows; restoring it pops them again. Captures keep
  // one entry per physical row, formula rows included, so the copy is the
  // same afterwards — the formula neither lost nor repeated.
  const screen = frame()
  const whole = getSelectedText(selection(0, 0, 19, 4), screen)
  for (const [shrunk, restored] of [[1, 4], [0, 2], [0, 4]] as const) {
    const s = selection(0, 0, 19, 4)
    shiftSelectionForViewportResize(s, screen, 0, 4, 0, shrunk)
    shiftSelectionForViewportResize(s, screen, 0, shrunk, 0, restored)
    assert.equal(getSelectedText(s, screen), whole, `viewport 0..4 → 0..${shrunk} → 0..${restored} copies the same text`)
  }
}

{
  // A clean overlay blitted over a formula from a frame without regions
  // clears the formula's region under it.
  const menu = createScreen(20, 2, stylePool, charPool, hyperlinkPool)
  const menuOutput = new Output({ width: 20, height: 2, stylePool, screen: menu })
  menuOutput.write(0, 0, 'MENU')
  const menuFrame = menuOutput.get()
  const screen = createScreen(20, 2, stylePool, charPool, hyperlinkPool)
  const output = new Output({ width: 20, height: 2, stylePool, screen, terminalImages: true })
  const inline = image('$x$')
  output.write(0, 0, ' '.repeat(10))
  assert.equal(output.image(inline, 0, 0, 10, 1, source), true)
  output.imageBacking(inline)
  output.blit(menuFrame, 0, 0, 4, 1)
  const covered = output.get()
  assert.equal(getSelectedText(selection(0, 0, 3, 0), covered), 'MENU', 'a blitted overlay copies as itself')
}

console.log('Semantic copy verified: inline and block image sources, once per selection, no blank rows, blit and scroll, decorative images excluded, wrap continuations')
