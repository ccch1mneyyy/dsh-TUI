#!/usr/bin/env node
/**
 * Regression: what a session IS, and which sessions a view shows.
 *
 * This is the gate on the defect that started the session-browser work: the
 * picker listed one row per stored session log, so a project with two
 * conversations and twenty-nine delegated sub-agent runs showed thirty-one
 * rows. The header always carried the answer (`origin: 'subagent'`); nothing
 * read it.
 *
 * The trap this pins down is the one an obvious fix walks straight into. A
 * `/rewind` fork records `parentSession` exactly like a delegated run does,
 * and differs ONLY by the absence of `origin` — so filtering on lineage
 * silently hides the user's own rewound branches. Every case below states
 * which field decided it.
 *
 * Also covers the pure view layer: search, project scoping, sub-agent
 * folding, fork-family folding (collapsed by default, `→` expands, a live
 * search lifts the fold), and the variable-height windowing that keeps a
 * fixed-height list box from rendering two rows onto the same line.
 *
 * Run: `node scripts/verify-session-kinds.mjs`
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'

const { classify, readHeader } = await import('../lib/types/dsh-adapter/sessions/header.js')
const { buildView, anchorTop, windowEnd, moveSelection, seekSelectable, sessionAt, DEFAULT_FILTERS } =
  await import('../lib/types/sessions/view.js')

let checks = 0
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name)
  checks += 1
}

// ── 1. Header narrowing is total ────────────────────────────────────────
check('null is not a header', readHeader(null), undefined)
check('a string is not a header', readHeader('nope'), undefined)
check('an array is not a header', readHeader([]), undefined)
check('a header without an id is unusable', readHeader({ cwd: '/a' }), undefined)
check('an empty id is unusable', readHeader({ id: '' }), undefined)
check(
  'unexpected field types degrade to undefined rather than throwing',
  readHeader({ id: 'x', cwd: 42, createdAt: 'soon', delegationDepth: NaN, origin: [] }),
  {
    id: 'x',
    cwd: undefined,
    createdAt: undefined,
    parentSession: undefined,
    origin: undefined,
    delegationDepth: undefined,
    seedLength: undefined,
    agentPreset: undefined,
  },
)
check(
  'Infinity is not a finite number',
  readHeader({ id: 'x', createdAt: Infinity }).createdAt,
  undefined,
)

// ── 2. Classification truth table ───────────────────────────────────────
const kindOf = (raw) => classify(readHeader({ id: 'x', ...raw }))

check('no lineage, no origin => root', kindOf({}), { kind: 'root' })
check(
  'parentSession alone => fork (a /rewind branch, NOT a delegated run)',
  kindOf({ parentSession: 'p1' }),
  { kind: 'fork', parent: 'p1' },
)
check(
  'origin subagent => subagent, depth from the header',
  kindOf({ parentSession: 'p1', origin: 'subagent', delegationDepth: 2 }),
  { kind: 'subagent', parent: 'p1', depth: 2 },
)
check(
  'origin wins over lineage — this is the whole discriminator',
  kindOf({ parentSession: 'p1', origin: 'subagent' }).kind,
  'subagent',
)
check(
  'a subagent whose header omits delegationDepth is depth 1, not 0',
  kindOf({ parentSession: 'p1', origin: 'subagent' }).depth,
  1,
)
check(
  'a subagent with no recorded parent is still a subagent',
  kindOf({ origin: 'subagent' }),
  { kind: 'subagent', parent: undefined, depth: 1 },
)
check(
  'delegationDepth alone does NOT make a subagent — origin is the authority',
  kindOf({ parentSession: 'p1', delegationDepth: 3 }),
  { kind: 'fork', parent: 'p1' },
)
check('an unknown origin value is not a subagent', kindOf({ origin: 'imported' }), { kind: 'root' })

// ── 3. The view ─────────────────────────────────────────────────────────
const summary = (over) => ({
  id: 'id',
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

const sameProject = (a, b) => a === b
const context = { cwd: '/proj', branch: 'main', currentId: 'live', sameProject }

const population = [
  summary({ id: 'live', updatedAt: 100 }),
  summary({ id: 'conv', updatedAt: 90, title: { text: 'render fix', source: 'auto' }, branch: 'main' }),
  summary({ id: 'fork', updatedAt: 80, kind: { kind: 'fork', parent: 'conv' }, branch: 'other' }),
  summary({ id: 'run1', updatedAt: 70, kind: { kind: 'subagent', parent: 'conv', depth: 1 }, label: 'audit' }),
  summary({ id: 'run2', updatedAt: 60, kind: { kind: 'subagent', parent: 'conv', depth: 1 } }),
  summary({ id: 'empty', updatedAt: 50, hasPrompt: false }),
  summary({ id: 'other-project', updatedAt: 40, cwd: '/elsewhere' }),
]

const base = buildView(population, DEFAULT_FILTERS, context)
check(
  'default view: this project, conversations only, live session excluded',
  base.rows.filter(r => r.kind === 'session').map(r => r.session.id),
  ['conv'],
)
check(
  'a rewind fork is NOT filtered out with the runs — it folds into its family',
  base.rows.find(r => r.kind === 'session' && r.session.id === 'conv')?.family,
  { role: 'rep', anchor: 'conv', size: 2, expanded: false },
)
// `/model` switches and rewinds continue the live conversation in a fork.
// The fork's ancestors are NOT hidden: the family folds to its most recently
// active member, and expanding it makes every ancestor resumable again. Only
// the live session itself is never offered.
const modelSwitchLineage = [
  summary({ id: 'model-v3', updatedAt: 100, kind: { kind: 'fork', parent: 'model-v2' } }),
  summary({ id: 'model-v2', updatedAt: 90, kind: { kind: 'fork', parent: 'model-root' } }),
  summary({ id: 'model-root', updatedAt: 80 }),
  summary({ id: 'other-fork', updatedAt: 70, kind: { kind: 'fork', parent: 'other-root' } }),
]
check(
  'the live session leaves the list; its ancestors stay, folded behind the family row',
  buildView(modelSwitchLineage, DEFAULT_FILTERS, { ...context, currentId: 'model-v3' })
    .rows.filter(r => r.kind === 'session').map(r => r.session.id),
  ['model-v2', 'other-fork'],
)
check(
  'expanding the family offers the live session\'s ancestors for resume again',
  buildView(modelSwitchLineage, DEFAULT_FILTERS, { ...context, currentId: 'model-v3' }, new Set(['model-root']))
    .rows.filter(r => r.kind === 'session').map(r => [r.session.id, r.depth]),
  [['model-v2', 0], ['model-root', 1], ['other-fork', 0]],
)
check('delegated runs are counted, not merely dropped', base.hiddenSubagents, 2)
check('sessions with no conversation are counted', base.emptyCount, 1)
check('and named, so they can be cleaned', base.emptyIds, ['empty'])
// The count drives a destructive action, so its scope must match the list's.
const withForeignEmpty = [...population, summary({ id: 'empty-elsewhere', cwd: '/elsewhere', hasPrompt: false })]
check(
  'another project\'s empty sessions are NOT offered for cleanup from this one',
  buildView(withForeignEmpty, DEFAULT_FILTERS, context).emptyIds,
  ['empty'],
)
check(
  'they are, once the view actually spans every project',
  buildView(withForeignEmpty, { ...DEFAULT_FILTERS, allProjects: true }, context).emptyIds.sort(),
  ['empty', 'empty-elsewhere'],
)
check(
  'a search narrows the rows but never what "empty" means',
  buildView(withForeignEmpty, { ...DEFAULT_FILTERS, query: 'render' }, context).emptyIds,
  ['empty'],
)
check('an empty session is never a row', base.rows.every(r => r.kind !== 'session' || r.session.id !== 'empty'), true)
check('no project headers inside a single project', base.rows.every(r => r.kind !== 'project'), true)

const all = buildView(population, { ...DEFAULT_FILTERS, allProjects: true }, context)
check(
  'all projects: other directories appear, each under its own header',
  all.rows.map(r => (r.kind === 'project' ? `#${r.project}` : r.session.id)),
  ['#/proj', 'conv', '#/elsewhere', 'other-project'],
)

const interleavedProjects = buildView(
  [
    summary({ id: 'a-new', cwd: '/a', updatedAt: 30 }),
    summary({ id: 'b-mid', cwd: '/b', updatedAt: 20 }),
    summary({ id: 'a-old', cwd: '/a', updatedAt: 10 }),
  ],
  { ...DEFAULT_FILTERS, allProjects: true },
  context,
)
check(
  'all projects: interleaved MRU entries stay in one group per project',
  interleavedProjects.rows.map(r => (r.kind === 'project' ? `#${r.project}:${r.count}` : r.session.id)),
  ['#/a:2', 'a-new', 'a-old', '#/b:1', 'b-mid'],
)

const runs = buildView(population, { ...DEFAULT_FILTERS, showSubagents: true }, context)
check(
  'sub-agent runs appear indented under their parent',
  runs.rows.filter(r => r.kind === 'session').map(r => [r.session.id, r.depth]),
  [['conv', 0], ['run1', 1], ['run2', 1]],
)
check('nothing is hidden once runs are shown', runs.hiddenSubagents, 0)

const branch = buildView(population, { ...DEFAULT_FILTERS, branchOnly: true }, context)
check(
  'branch filter keeps only sessions last used on this branch',
  branch.rows.filter(r => r.kind === 'session').map(r => r.session.id),
  ['conv'],
)

const searched = buildView(population, { ...DEFAULT_FILTERS, query: 'RENDER' }, context)
check('search is case-insensitive over titles', searched.rows.filter(r => r.kind === 'session').map(r => r.session.id), ['conv'])
const byLabel = buildView(population, { ...DEFAULT_FILTERS, showSubagents: true, query: 'audit' }, context)
check(
  'a parent is kept when one of its runs matches, and only the matching run shows',
  byLabel.rows.filter(r => r.kind === 'session').map(r => r.session.id),
  ['conv', 'run1'],
)
const byParentText = buildView(
  population,
  { ...DEFAULT_FILTERS, showSubagents: true, query: 'render' },
  context,
)
check(
  'a matching parent brings all of its runs with it',
  byParentText.rows.filter(r => r.kind === 'session').map(r => r.session.id),
  ['conv', 'run1', 'run2'],
)
const noMatch = buildView(population, { ...DEFAULT_FILTERS, query: 'zzz' }, context)
check('a query that matches nothing yields no rows', noMatch.rows.length, 0)

// A run whose parent is filtered out must still be reachable rather than lost.
const orphaned = buildView(
  [summary({ id: 'run', kind: { kind: 'subagent', parent: 'gone', depth: 1 } })],
  { ...DEFAULT_FILTERS, showSubagents: true },
  context,
)
check(
  'a run with no visible parent is offered at the top level',
  orphaned.rows.filter(r => r.kind === 'session').map(r => [r.session.id, r.depth]),
  [['run', 0]],
)

// ── 3b. Fork-family folding ─────────────────────────────────────────────
// A rewind fork is another branch of its parent's conversation, not a new
// one: the list folds each family to its most recently active member and
// reveals the rest on demand. tip → mid → base is one chain, side branches
// off base; solo is unrelated.
const famPop = [
  summary({ id: 'tip', updatedAt: 50, kind: { kind: 'fork', parent: 'mid' } }),
  summary({ id: 'solo', updatedAt: 40 }),
  summary({ id: 'side', updatedAt: 30, kind: { kind: 'fork', parent: 'base' } }),
  summary({ id: 'mid', updatedAt: 20, kind: { kind: 'fork', parent: 'base' } }),
  summary({ id: 'base', updatedAt: 10, title: { text: 'database work', source: 'auto' } }),
]

const folded = buildView(famPop, DEFAULT_FILTERS, context)
check(
  'a family folds to its most recently active member',
  folded.rows.filter(r => r.kind === 'session').map(r => r.session.id),
  ['tip', 'solo'],
)
check(
  'the family row carries the fold state and size',
  folded.rows.find(r => r.kind === 'session' && r.session.id === 'tip')?.family,
  { role: 'rep', anchor: 'base', size: 4, expanded: false },
)
check(
  'a lone conversation carries no family marker',
  folded.rows.find(r => r.kind === 'session' && r.session.id === 'solo')?.family,
  undefined,
)

const famExpanded = buildView(famPop, DEFAULT_FILTERS, context, new Set(['base']))
check(
  'expanding reveals every member under the rep, newest first',
  famExpanded.rows.filter(r => r.kind === 'session').map(r => [r.session.id, r.depth]),
  [['tip', 0], ['side', 1], ['mid', 1], ['base', 1], ['solo', 0]],
)
check(
  'a member row names its family and rep',
  famExpanded.rows.find(r => r.kind === 'session' && r.session.id === 'base')?.family,
  { role: 'member', anchor: 'base', rep: 'tip' },
)

// A fork whose parent was deleted (or lives outside this view) anchors at
// itself — a family of one, shown whole rather than folded into nothing.
const brokenChain = buildView(
  [summary({ id: 'leaf', kind: { kind: 'fork', parent: 'gone' } })],
  DEFAULT_FILTERS,
  context,
)
check(
  'a fork whose parent is gone anchors at itself',
  brokenChain.rows.find(r => r.kind === 'session')?.family,
  undefined,
)

// Runs of a folded member wait for the expansion with their parent, instead
// of surfacing as top-level orphans with no context around them.
const withMemberRun = [
  ...famPop,
  summary({ id: 'run-of-mid', kind: { kind: 'subagent', parent: 'mid', depth: 1 } }),
]
check(
  'a run whose parent is folded away waits with it',
  buildView(withMemberRun, { ...DEFAULT_FILTERS, showSubagents: true }, context).rows
    .some(r => r.kind === 'session' && r.session.id === 'run-of-mid'),
  false,
)
check(
  'the expansion reveals both, the run under its own parent',
  buildView(withMemberRun, { ...DEFAULT_FILTERS, showSubagents: true }, context, new Set(['base'])).rows
    .filter(r => r.kind === 'session').map(r => [r.session.id, r.depth]),
  [['tip', 0], ['side', 1], ['mid', 1], ['run-of-mid', 2], ['base', 1], ['solo', 0]],
)

// A live query lifts the fold: a folded member matching the search stays
// directly reachable, as its own top-level row with no badge.
const famSearch = buildView(famPop, { ...DEFAULT_FILTERS, query: 'database' }, context)
check(
  'a live query never folds',
  famSearch.rows.filter(r => r.kind === 'session').map(r => [r.session.id, r.depth, r.family]),
  [['base', 0, undefined]],
)

// ── 4. Selection and windowing ──────────────────────────────────────────
const rows = all.rows
check('project headers are not selectable', sessionAt(rows, 0), undefined)
check('seek finds the first selectable row', seekSelectable(rows, 0, 1), 1)
check('seek backwards from the end', seekSelectable(rows, rows.length - 1, -1), rows.length - 1)
check('seek off the end reports -1', seekSelectable(rows, rows.length, 1), -1)
check('moving down skips the header between groups', moveSelection(rows, 1, 1), 3)
check('moving up skips it too', moveSelection(rows, 3, -1), 1)
check('moving past the end wraps to the first selectable row', moveSelection(rows, rows.length - 1, 1), 1)
check('moving before the start wraps to the last', moveSelection(rows, 1, -1), rows.length - 1)

// Heights differ by row kind, so the window must be resolved in LINES.
// A budget of 5 lines holds a 1-line header plus two 2-line sessions.
check('window start stays at 0 while the focus fits', anchorTop(rows, 1, 5, 0), 0)
check('window end is measured in lines, not rows', windowEnd(rows, 0, 5), 3)
check('a budget of 3 lines cannot hold the third row', windowEnd(rows, 0, 3), 2)
check('scrolling down moves the start only as far as it must', anchorTop(rows, 3, 5, 0), 1)
check('a focus above the window pulls the start up to it', anchorTop(rows, 1, 5, 3), 1)
check('with room to spare the start reaches the very top', anchorTop(rows, 1, 9, 3), 0)
check('slack below the last row is reclaimed by pulling the start back', anchorTop(rows, 3, 99, 3), 0)
check('an empty list windows to nothing', anchorTop([], 0, 10, 0), 0)
check('a zero budget never divides by it', anchorTop(rows, 2, 0, 0), 0)
check(
  'at every focus, budget and prior position: the slice fits and the focus is inside it',
  (() => {
    for (let budget = 2; budget <= 12; budget++) {
      for (let focus = 0; focus < rows.length; focus++) {
        for (let previous = 0; previous < rows.length; previous++) {
          const top = anchorTop(rows, focus, budget, previous)
          const end = windowEnd(rows, top, budget)
          let lines = 0
          for (let at = top; at < end; at++) lines += rows[at].kind === 'session' ? 2 : 1
          if (lines > budget) return `overflow: budget=${budget} focus=${focus} prev=${previous} -> ${lines} lines`
          if (focus < top || focus >= end) {
            return `focus lost: budget=${budget} focus=${focus} prev=${previous} -> window [${top},${end})`
          }
        }
      }
    }
    return 'ok'
  })(),
  'ok',
)

console.log(`verify-session-kinds: OK (${checks} checks)`)
