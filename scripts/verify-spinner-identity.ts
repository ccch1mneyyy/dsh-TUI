/**
 * Verify the spinner's local identity and the small public glyph contract.
 *
 * Run with: node --import tsx/esm scripts/verify-spinner-identity.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringWidth } from '../src/ink/stringWidth.js'
import { SPINNER_VERBS } from '../src/terminal-utils/spinnerVerbs.js'
import {
  BLACK_CIRCLE,
  BULLET,
  DOWN_ARROW,
  MULTIPLICATION_X,
  POINTER,
  THINKING_SETTLED_MARKER,
  THINKING_SPINNER_FRAMES,
  THINKING_SPINNER_INTERVAL_MS,
  TICK,
  UP_ARROW,
} from '../src/terminal-utils/figures.js'
import { getDefaultCharacters } from '../src/components/Spinner/spinnerUtils.js'
import { getStallState } from '../src/components/Spinner/useStalledAnimation.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
assert.ok(SPINNER_VERBS.length >= 12 && SPINNER_VERBS.length <= 20, 'spinner verb set should stay focused')
assert.equal(new Set(SPINNER_VERBS).size, SPINNER_VERBS.length, 'spinner verbs must be unique')
assert.ok(SPINNER_VERBS.every(verb => /^[A-Z][a-z]+ing$/.test(verb)), 'verbs should be short -ing forms')
assert.ok(SPINNER_VERBS.every(verb => verb.length <= 15), 'spinner verbs should remain compact')

const frameSet = getDefaultCharacters()
assert.ok(frameSet.length >= 4, 'spinner needs enough frames for a visible pulse')
assert.ok(frameSet.every(frame => stringWidth(frame) === 1), 'spinner frames must occupy one display cell')
assert.notEqual(new Set(frameSet).size, 1, 'spinner frames must animate')
const copy = getDefaultCharacters()
copy[0] = 'x'
assert.notEqual(getDefaultCharacters()[0], 'x', 'frame set must be returned by value')

const expectedFigureExports = [
  'BLACK_CIRCLE',
  'POINTER',
  'TICK',
  'BULLET',
  'MULTIPLICATION_X',
  'UP_ARROW',
  'DOWN_ARROW',
  'THINKING_SPINNER_FRAMES',
  'THINKING_SPINNER_INTERVAL_MS',
  'THINKING_SETTLED_MARKER',
].sort()
const figureSource = fs.readFileSync(path.join(repoRoot, 'src/terminal-utils/figures.ts'), 'utf8')
const actualFigureExports = [...figureSource.matchAll(/^export const ([A-Z0-9_]+)/gm)]
  .map(match => match[1]!)
  .sort()
assert.deepEqual(actualFigureExports, expectedFigureExports, 'figures should contain active glyph exports only')
assert.equal(THINKING_SPINNER_INTERVAL_MS, 80)
assert.ok(THINKING_SPINNER_FRAMES.length > 0)
assert.ok(THINKING_SPINNER_FRAMES.every(frame => stringWidth(frame) === stringWidth(THINKING_SETTLED_MARKER)))
assert.ok([BLACK_CIRCLE, POINTER, TICK, BULLET, MULTIPLICATION_X, UP_ARROW, DOWN_ARROW].every(Boolean))

assert.deepEqual(getStallState(3000), { isStalled: false, intensity: 0 })
assert.equal(getStallState(3001).isStalled, true)
assert.equal(getStallState(4000).intensity, 0.5)
assert.deepEqual(getStallState(6000), { isStalled: true, intensity: 1 })
assert.deepEqual(getStallState(60_000, true), { isStalled: false, intensity: 0 })

console.log(`spinner identity verified: ${SPINNER_VERBS.length} verbs, ${frameSet.length} one-cell frames`)
