/** Selection region regressions. Run with node --import tsx/esm. */
import assert from 'node:assert/strict'
import { CharPool, HyperlinkPool, StylePool, createScreen, markNoSelectRegion, blitRegion, shiftRows } from '../src/ink/screen.js'
import Output from '../src/ink/output.js'
import { createSelectionState, startSelection, updateSelection, getSelectedText, isCellSelected, captureScrolledRows, pickFollowForSelection, refreshSelectionFingerprint, reconcileSelectionPane, selectLineAt, extendSelection } from '../src/ink/selection.js'

const styles = new StylePool()
const screen = createScreen(20, 4, styles, new CharPool(), new HyperlinkPool())
const output = new Output({ width: 20, height: 4, stylePool: styles, screen })
output.write(0, 0, 'CHAT_A\nCHAT_B\nCHAT_C', [false, false, false])
output.write(10, 0, 'PANEL_a\nPANEL_b\nPANEL_c', [false, false, false])
output.get()
markNoSelectRegion(screen, 10, 0, 20, 4)
const selection = createSelectionState()
startSelection(selection, 14, 0, screen)
updateSelection(selection, 11, 2)
assert.equal(getSelectedText(selection, screen), 'L_a\nPANEL_b\nPA', 'diagonal multi-row selection stays linear inside the panel')
updateSelection(selection, 2, 2)
assert.equal(getSelectedText(selection, screen), 'L_a\nPANEL_b\nP', 'crossing the divider clamps to the original panel')
assert.equal(isCellSelected(selection, 2, 1), false, 'intermediate rows cannot highlight the other pane')
console.log('PASS: panel selection diagonal and cross-pane boundaries')

// Opposite wrap patterns on the same physical rows must remain independent.
const split = createScreen(20, 4, styles, new CharPool(), new HyperlinkPool())
const paint = new Output({ width: 20, height: 4, stylePool: styles, screen: split })
paint.registerSelectionPane('chat', { x: 0, y: 0, width: 9, height: 4 })
paint.selectionPane = 'chat'
paint.write(0, 0, 'CHAT_A\nCHAT_B\nCHAT_C', [false, false, false])
paint.registerSelectionPane('panel', { x: 10, y: 0, width: 10, height: 4 })
paint.selectionPane = 'panel'
paint.write(10, 0, 'PANEL_\na\nb', [false, true, false])
paint.get()
const chat = createSelectionState()
startSelection(chat, 0, 0, split)
updateSelection(chat, 19, 1)
assert.equal(getSelectedText(chat, split), 'CHAT_A\nCHAT_B')
assert.equal(chat.pane?.id, 'chat')
const panel = createSelectionState()
startSelection(panel, 10, 0, split)
updateSelection(panel, 2, 1)
assert.equal(getSelectedText(panel, split), 'PANEL_a')
assert.equal(panel.pane?.id, 'panel')
selectLineAt(panel, split, 0)
extendSelection(panel, split, 0, 1)
assert.equal(getSelectedText(panel, split), 'PANEL_a', 'line extension stays inside the owner')
const events = [
  { delta: 1, viewportTop: 0, viewportBottom: 3, selectionPane: 'panel' },
  { delta: 2, viewportTop: 0, viewportBottom: 3, selectionPane: 'chat' },
]
assert.equal(pickFollowForSelection(events, 1, chat.pane?.id)?.delta, 2)
assert.equal(pickFollowForSelection(events.slice(0, 1), 1, chat.pane?.id), null)
captureScrolledRows(panel, split, 0, 0, 'above')
assert.deepEqual(panel.scrolledOffAbove.map(row => row.text), ['PANEL_'])
assert.equal(refreshSelectionFingerprint(chat, split, false), false)
split.selectionPanes!.get('panel')!.softWrap[1] = 0
assert.equal(refreshSelectionFingerprint(chat, split, false), false, 'other pane wrapping cannot stale this copy')
assert.equal(getSelectedText(chat, split), 'CHAT_A\nCHAT_B')
const cached = createScreen(20, 4, styles, split.charPool, split.hyperlinkPool)
blitRegion(cached, split, 0, 0, 20, 4)
assert.equal(getSelectedText(chat, cached), 'CHAT_A\nCHAT_B', 'whole-subtree cache preserves owner metadata')
cached.selectionPanes!.get('panel')!.softWrap[2] = 16
shiftRows(cached, 0, 3, 1, 10, 10)
assert.equal(cached.selectionPanes!.get('panel')!.softWrap[1], 16)
assert.deepEqual([...cached.selectionPanes!.get('chat')!.softWrap], [0, 0, 0, 0])
reconcileSelectionPane(chat, cached)
assert.ok(chat.anchor)
cached.selectionPanes!.get('chat')!.width = 8
reconcileSelectionPane(chat, cached)
assert.equal(chat.anchor, null, 'horizontal reflow invalidates old coordinates')
reconcileSelectionPane(panel, createScreen(20, 4, styles, split.charPool, split.hyperlinkPool))
assert.equal(panel.anchor, null, 'closed/switched panes cannot retain a ghost selection')
console.log('PASS: independent wrap, scroll ownership, captured rows, cache and reflow')

const partial = createScreen(20, 4, styles, split.charPool, split.hyperlinkPool)
blitRegion(partial, split, 10, 0, 18, 1)
assert.equal(partial.selectionPanes!.size, 0, 'a cached child cannot resurrect a switched pane')
console.log('PASS: cached children cannot restore removed pane identities')
