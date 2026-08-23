/**
 * Session browser view-model fork-family tests (src/sessions/view.ts): a
 * rewind/model-switch fork is a branch of its parent's conversation, not a
 * new one — each family folds to its most recently active member, → expands
 * it, a live search lifts the fold, and a folded member's sub-agent runs
 * wait for the expansion with it. Bare node:test runner over synthetic
 * SessionSummary lists — no channel, no persistence, no rendering.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionSummary } from '../../src/dsh-adapter/sessions/types.js'
import { buildView, DEFAULT_FILTERS, type BrowserRow } from '../../src/sessions/view.js'

const summary = (over: Partial<SessionSummary> & { id: string }): SessionSummary => ({
  kind: { kind: 'root' },
  title: { text: 'title', source: 'auto' },
  cwd: '/proj',
  createdAt: 1,
  updatedAt: 1,
  bytes: 10,
  hasPrompt: true,
  agentPreset: undefined,
  model: undefined,
  label: undefined,
  branch: undefined,
  childCount: 0,
  ...over,
})

const sameProject = (a: string, b: string): boolean => a === b
const context = { cwd: '/proj', branch: undefined as string | undefined, currentId: 'live', sameProject }

const sessionRows = (rows: readonly BrowserRow[]) =>
  rows.filter((row): row is Extract<BrowserRow, { kind: 'session' }> => row.kind === 'session')

// One chain tip → mid → base, a side branch off base, and an unrelated solo
// conversation. MRU order: tip, solo, side, mid, base.
const famPop = [
  summary({ id: 'tip', updatedAt: 50, kind: { kind: 'fork', parent: 'mid' } }),
  summary({ id: 'solo', updatedAt: 40 }),
  summary({ id: 'side', updatedAt: 30, kind: { kind: 'fork', parent: 'base' } }),
  summary({ id: 'mid', updatedAt: 20, kind: { kind: 'fork', parent: 'base' } }),
  summary({ id: 'base', updatedAt: 10, title: { text: 'database work', source: 'auto' } }),
]

test('collapsed by default: a family is one row — its most recently active member', () => {
  const view = buildView(famPop, DEFAULT_FILTERS, context)
  assert.deepEqual(sessionRows(view.rows).map(row => row.session.id), ['tip', 'solo'])
  assert.deepEqual(
    sessionRows(view.rows).find(row => row.session.id === 'tip')?.family,
    { role: 'rep', anchor: 'base', size: 4, expanded: false },
  )
  assert.equal(view.shown, 2)
})

test('a lone conversation carries no family marker', () => {
  const view = buildView(famPop, DEFAULT_FILTERS, context)
  assert.equal(sessionRows(view.rows).find(row => row.session.id === 'solo')?.family, undefined)
})

test('expanding reveals every member under the rep, newest first, one level in', () => {
  const view = buildView(famPop, DEFAULT_FILTERS, context, new Set(['base']))
  assert.deepEqual(
    sessionRows(view.rows).map(row => [row.session.id, row.depth]),
    [['tip', 0], ['side', 1], ['mid', 1], ['base', 1], ['solo', 0]],
  )
  assert.deepEqual(
    sessionRows(view.rows).find(row => row.session.id === 'tip')?.family,
    { role: 'rep', anchor: 'base', size: 4, expanded: true },
  )
  assert.deepEqual(
    sessionRows(view.rows).find(row => row.session.id === 'base')?.family,
    { role: 'member', anchor: 'base', rep: 'tip' },
  )
  assert.equal(view.shown, 5)
})

test('an unknown expansion anchor expands nothing', () => {
  const view = buildView(famPop, DEFAULT_FILTERS, context, new Set(['nope']))
  assert.deepEqual(sessionRows(view.rows).map(row => row.session.id), ['tip', 'solo'])
})

test('a live search lifts the fold: a folded member stays directly reachable', () => {
  const view = buildView(famPop, { ...DEFAULT_FILTERS, query: 'database' }, context)
  assert.deepEqual(
    sessionRows(view.rows).map(row => [row.session.id, row.depth, row.family]),
    [['base', 0, undefined]],
  )
})

test('a fork whose parent is gone anchors at itself — a family of one', () => {
  const view = buildView([summary({ id: 'leaf', kind: { kind: 'fork', parent: 'gone' } })], DEFAULT_FILTERS, context)
  assert.deepEqual(sessionRows(view.rows).map(row => row.session.id), ['leaf'])
  assert.equal(sessionRows(view.rows)[0]?.family, undefined)
})

test('a parent/child cycle terminates instead of looping over malformed data', () => {
  const view = buildView(
    [
      summary({ id: 'a', updatedAt: 20, kind: { kind: 'fork', parent: 'b' } }),
      summary({ id: 'b', updatedAt: 10, kind: { kind: 'fork', parent: 'a' } }),
    ],
    DEFAULT_FILTERS,
    context,
  )
  // Each anchors at the other: two families of one, both shown, no badges.
  assert.deepEqual(sessionRows(view.rows).map(row => row.session.id), ['a', 'b'])
  assert.ok(sessionRows(view.rows).every(row => row.family === undefined))
})

test("a folded member's sub-agent run waits for the expansion instead of surfacing as an orphan", () => {
  const withRuns = [
    ...famPop,
    summary({ id: 'run-of-mid', kind: { kind: 'subagent', parent: 'mid', depth: 1 } }),
    summary({ id: 'run-orphan', kind: { kind: 'subagent', parent: 'gone', depth: 1 } }),
  ]
  const collapsed = buildView(withRuns, { ...DEFAULT_FILTERS, showSubagents: true }, context)
  assert.equal(sessionRows(collapsed.rows).some(row => row.session.id === 'run-of-mid'), false)
  // The orphan logic is kept for a run whose parent truly is not in the view.
  assert.deepEqual(
    sessionRows(collapsed.rows).map(row => [row.session.id, row.depth]),
    [['tip', 0], ['solo', 0], ['run-orphan', 0]],
  )

  const expanded = buildView(withRuns, { ...DEFAULT_FILTERS, showSubagents: true }, context, new Set(['base']))
  assert.deepEqual(
    sessionRows(expanded.rows).map(row => [row.session.id, row.depth]),
    [['tip', 0], ['side', 1], ['mid', 1], ['run-of-mid', 2], ['base', 1], ['solo', 0], ['run-orphan', 0]],
  )
})

test('the live session is never a row; its /model-/rewind ancestors fold into their family and stay resumable', () => {
  const lineage = [
    summary({ id: 'model-v3', updatedAt: 100, kind: { kind: 'fork', parent: 'model-v2' } }),
    summary({ id: 'model-v2', updatedAt: 90, kind: { kind: 'fork', parent: 'model-root' } }),
    summary({ id: 'model-root', updatedAt: 80 }),
    summary({ id: 'other-fork', updatedAt: 70, kind: { kind: 'fork', parent: 'other-root' } }),
  ]
  const folded = buildView(lineage, DEFAULT_FILTERS, { ...context, currentId: 'model-v3' })
  assert.deepEqual(sessionRows(folded.rows).map(row => row.session.id), ['model-v2', 'other-fork'])
  assert.deepEqual(
    sessionRows(folded.rows).find(row => row.session.id === 'model-v2')?.family,
    { role: 'rep', anchor: 'model-root', size: 2, expanded: false },
  )

  const expanded = buildView(lineage, DEFAULT_FILTERS, { ...context, currentId: 'model-v3' }, new Set(['model-root']))
  assert.deepEqual(
    sessionRows(expanded.rows).map(row => [row.session.id, row.depth]),
    [['model-v2', 0], ['model-root', 1], ['other-fork', 0]],
  )
})

test('empty sessions are counted, never listed — inside a folded family too', () => {
  const population = [
    summary({ id: 'conv', updatedAt: 90 }),
    summary({ id: 'fork', updatedAt: 80, kind: { kind: 'fork', parent: 'conv' }, hasPrompt: false }),
  ]
  const view = buildView(population, DEFAULT_FILTERS, context)
  assert.deepEqual(sessionRows(view.rows).map(row => row.session.id), ['conv'])
  assert.deepEqual(view.emptyIds, ['fork'])
  // The empty member is not a family member at all: the row carries no badge.
  assert.equal(sessionRows(view.rows)[0]?.family, undefined)
})
