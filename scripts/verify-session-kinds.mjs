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
 * folding, and the variable-height windowing that keeps a fixed-height list
 * box from rendering two rows onto the same line.
 *
 * Run: `node scripts/verify-session-kinds.mjs`
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'

const { classify, readHeader } = await import('../lib/types/dsh-adapter/sessions/header.js')
const { buildView, buildWorkspaceGroups, normalizeWorkspaceCwd, anchorTop, windowEnd, moveSelection, seekSelectable, sessionAt, DEFAULT_FILTERS } =
  await import('../lib/types/sessions/view.js')
const { formatWhen, formatBytes, truncateWidth, wrapWidth, formatProject, kindMark, titleColor, spreadRow, tailWidth } =
  await import('../lib/types/sessions/format.js')
const { setLang } = await import('../lib/types/i18n.js')
setLang('en')

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
check('invalid inherited cut is not exposed', readHeader({ id: 'x', seedLength: -1 }).seedLength, undefined)
check(
  'alpha4 inspect cut narrows into the shared seedLength field',
  readHeader({ id: 'x', inheritedEventCount: 7 }).seedLength,
  7,
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

// Only the exceptional kinds are marked; an ordinary conversation gets no
// badge, because a badge on every row costs a column and teaches nothing.
check('a root conversation carries no marker', kindMark({ kind: 'root' }), undefined)
check('a fork is marked', kindMark({ kind: 'fork', parent: 'p' })?.glyph, '⑃')
check('a delegated run is marked differently', kindMark({ kind: 'subagent', parent: 'p', depth: 1 })?.glyph, '⑂')
check('a fallback title is dimmed rather than stated as a name', titleColor('fallback', false), 'subtle')
check('a real title is stated plainly', titleColor('auto', false), 'text')
check('focus wins over provenance', titleColor('fallback', true), 'suggestion')

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
  ['conv', 'fork'],
)
check('a rewind fork survives the sub-agent filter', base.rows.some(r => r.kind === 'session' && r.session.id === 'fork'), true)
const modelSwitchLineage = [
  summary({ id: 'model-v3', updatedAt: 100, kind: { kind: 'fork', parent: 'model-v2' } }),
  summary({ id: 'model-v2', updatedAt: 90, kind: { kind: 'fork', parent: 'model-root' } }),
  summary({ id: 'model-root', updatedAt: 80 }),
  summary({ id: 'other-fork', updatedAt: 70, kind: { kind: 'fork', parent: 'other-root' } }),
]
check(
  'current conversation ancestors are not resume targets, while unrelated forks remain visible',
  buildView(modelSwitchLineage, DEFAULT_FILTERS, { ...context, currentId: 'model-v3' })
    .rows.filter(r => r.kind === 'session').map(r => r.session.id),
  ['other-fork'],
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
  ['#/proj', 'conv', 'fork', '#/elsewhere', 'other-project'],
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

// The explicit directory menu has one compatibility bucket for the LIVE cwd;
// every other historical cwd stays exact instead of being transitively merged.
const ancestorCompatible = (left, right) =>
  left !== '' && right !== '' &&
  (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`))
const workspacePopulation = [
  summary({ id: 'current-live', cwd: '/current', updatedAt: 100 }),
  summary({ id: 'current-old-root', cwd: '/current', updatedAt: 90 }),
  summary({ id: 'current-old-subdir', cwd: '/current/pkg', updatedAt: 80 }),
  summary({ id: 'foreign-root', cwd: '/repo', updatedAt: 70 }),
  summary({ id: 'foreign-a', cwd: '/repo/a', updatedAt: 60 }),
  summary({ id: 'foreign-b', cwd: '/repo/b', updatedAt: 50 }),
  summary({ id: 'unknown', cwd: '', updatedAt: 40 }),
  summary({ id: 'foreign-run', cwd: '/repo', updatedAt: 75, kind: { kind: 'subagent', parent: 'foreign-root', depth: 1 } }),
  summary({ id: 'foreign-empty', cwd: '/empty', updatedAt: 30, hasPrompt: false }),
]
check('directory keys keep filesystem root distinct from unknown cwd',
  [normalizeWorkspaceCwd('/'), normalizeWorkspaceCwd('')], ['/', ''])
const workspaces = buildWorkspaceGroups(workspacePopulation, {
  cwd: '/current',
  branch: 'main',
  currentId: 'current-live',
  sameProject: ancestorCompatible,
})
check(
  'directory menu: live root and legacy subdirectory share the current bucket',
  workspaces[0],
  { id: 'current', cwd: '/current', count: 2, updatedAt: 90, current: true },
)
check(
  'directory menu: foreign paths stay exact (no transitive ancestor merge)',
  workspaces.slice(1).map(group => [group.cwd, group.count]),
  [['/repo', 1], ['/repo/a', 1], ['/repo/b', 1], ['', 1]],
)
check(
  'directory menu: delegated runs and empty artifacts do not inflate resumable counts',
  workspaces.reduce((sum, group) => sum + group.count, 0),
  6,
)
const consistentAll = buildView(
  [
    summary({ id: 'current-root', cwd: '/current', updatedAt: 40 }),
    summary({ id: 'current-sub', cwd: '/current/pkg', updatedAt: 30 }),
    summary({ id: 'alias-a', cwd: '/foreign/path', updatedAt: 20 }),
    summary({ id: 'alias-b', cwd: '/foreign/path/', updatedAt: 10 }),
  ],
  { ...DEFAULT_FILTERS, allProjects: true },
  { cwd: '/current', branch: 'main', currentId: 'none', sameProject: ancestorCompatible },
)
check(
  'all-directories headers reuse current compatibility and normalized foreign keys',
  consistentAll.rows.filter(row => row.kind === 'project').map(row => [row.project, row.count]),
  [['/current', 2], ['/foreign/path', 2]],
)

const runs = buildView(population, { ...DEFAULT_FILTERS, showSubagents: true }, context)
check(
  'sub-agent runs appear indented under their parent',
  runs.rows.filter(r => r.kind === 'session').map(r => [r.session.id, r.depth]),
  [['conv', 0], ['run1', 1], ['run2', 1], ['fork', 0]],
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

// ── 4. Selection and windowing ──────────────────────────────────────────
const rows = all.rows
check('project headers are not selectable', sessionAt(rows, 0), undefined)
check('seek finds the first selectable row', seekSelectable(rows, 0, 1), 1)
check('seek backwards from the end', seekSelectable(rows, rows.length - 1, -1), rows.length - 1)
check('seek off the end reports -1', seekSelectable(rows, rows.length, 1), -1)
check('moving down skips the header between groups', moveSelection(rows, 2, 1), 4)
check('moving up skips it too', moveSelection(rows, 4, -1), 2)
check('moving past the end wraps to the first selectable row', moveSelection(rows, rows.length - 1, 1), 1)
check('moving before the start wraps to the last', moveSelection(rows, 1, -1), rows.length - 1)

// Heights differ by row kind, so the window must be resolved in LINES.
// A budget of 5 lines holds a 1-line header plus two 2-line sessions.
check('window start stays at 0 while the focus fits', anchorTop(rows, 1, 5, 0), 0)
check('window end is measured in lines, not rows', windowEnd(rows, 0, 5), 3)
check('a budget of 4 lines cannot hold the third row', windowEnd(rows, 0, 4), 2)
check('scrolling down moves the start only as far as it must', anchorTop(rows, 4, 5, 0), 2)
check('a focus above the window pulls the start up to it', anchorTop(rows, 1, 5, 3), 1)
check('with room to spare the start reaches the very top', anchorTop(rows, 1, 9, 3), 0)
check('slack below the last row is reclaimed by pulling the start back', anchorTop(rows, 4, 99, 3), 0)
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

// ── 5. Formatting ───────────────────────────────────────────────────────
// Pure functions with real edge cases: bucket boundaries a reader would
// notice being off by one, and CJK widths where a wrong count reflows a row
// and pushes every row under it down a line.
const NOW = Date.parse('2026-03-10T12:00:00Z')
const ago = (ms) => formatWhen(NOW - ms, NOW)
check('under 45 seconds reads as now', ago(44_000), 'just now')
check('45 seconds rounds into the minute bucket', ago(45_000), '1m ago')
check('minutes round to nearest', ago(90_000), '2m ago')
check('59 minutes stays in minutes', ago(59 * 60_000), '59m ago')
check('an hour crosses into hours', ago(60 * 60_000), '1h ago')
check('23 hours stays in hours', ago(23 * 3_600_000), '23h ago')
check('a day crosses into days', ago(24 * 3_600_000), '1d ago')
check('seven days is still relative', ago(7 * 24 * 3_600_000), '7d ago')
check('past a week an absolute date is more useful than an offset', ago(30 * 24 * 3_600_000).includes('/'), true)
check('a future timestamp never reads as negative', formatWhen(NOW + 10_000, NOW), 'just now')

check('bytes below a kilobyte are exact', formatBytes(812), '812 B')
check('kilobytes carry one decimal', formatBytes(146_330), '142.9 KB')
check('megabytes carry one decimal', formatBytes(4_404_019), '4.2 MB')
check('exactly 1024 bytes is a kilobyte', formatBytes(1024), '1.0 KB')
check('an unknown size formats to nothing at all', formatBytes(undefined), undefined)
check('a nonsense size formats to nothing', formatBytes(-5), undefined)

check('text that fits is returned untouched', truncateWidth('hello', 5), 'hello')
check('a wide character costs two columns', truncateWidth('你好世界', 8), '你好世界')
check('truncation counts columns, not characters', truncateWidth('你好世界', 7), '你好世…')
check('a zero budget yields nothing', truncateWidth('anything', 0), '')
check('the ellipsis always fits the budget', truncateWidth('你好世界', 3), '你…')

check('CJK wraps mid-character because there is nothing else to break on', wrapWidth('你好世界你好', 4), ['你好', '世界', '你好'])
check('latin prefers a word boundary', wrapWidth('alpha beta gamma', 11), ['alpha beta', 'gamma'])
check('a single long token still makes progress', wrapWidth('aaaaaaaaaa', 4), ['aaaa', 'aaaa', 'aa'])
check('newlines in the source are honoured', wrapWidth('one\ntwo', 10), ['one', 'two'])
check('a zero width wraps to nothing rather than looping', wrapWidth('text', 0), [])

// The header's arithmetic, pinned directly. This is the layer where a
// character count passes in English and overflows in Chinese, so the check is
// exhaustive over both scripts and every width the row can be given.
{
  const stringWidth = (await import('../lib/types/ink/stringWidth.js')).stringWidth
  const LEFTS = ['', ' Resume session', ' 恢复会话', ' 恢复会话 Resume', '很长很长很长很长很长很长很长很长的标题']
  const RIGHTS = ['', '3 sessions', '8 个会话 · 29 个子运行已折叠 · 15 个空会话', 'mixed 混合 text 文本 here 这里']
  let worst = 'ok'
  for (const left of LEFTS) {
    for (const right of RIGHTS) {
      for (let columns = 0; columns <= 80; columns++) {
        const row = spreadRow(left, right, columns)
        const total = stringWidth(row.left) + row.gap + stringWidth(row.right)
        if (total > columns && columns > 0) {
          worst = `overflow at columns=${columns}: ${total} for ${JSON.stringify([left, right])}`
        }
        if (columns > 0 && row.gap < 1) worst = `segments touch at columns=${columns}`
      }
    }
  }
  check('a spread row is never wider than the columns it was given', worst, 'ok')
  check('a zero-width row renders nothing', spreadRow('a', 'b', 0), { left: '', gap: 0, right: '' })
  check('the right segment is pinned to the end', spreadRow('ab', 'cd', 10), { left: 'ab', gap: 6, right: 'cd' })
  check('a CJK left segment is measured in columns', spreadRow('恢复', 'ab', 10), { left: '恢复', gap: 4, right: 'ab' })
  // 12 columns, a left segment 8 wide, one reserved for the gap: 3 remain.
  check('the right segment yields first', spreadRow('恢复会话', '12345', 12).right, '12…')
  check('the left segment yields when it alone will not fit', spreadRow('恢复会话', 'x', 5).left, '恢…')
}

check('the tail is what a one-line editor keeps', tailWidth('abcdefgh', 5), '…efgh')
check('text that fits keeps its head', tailWidth('abc', 5), 'abc')
check('the tail is measured in columns too', tailWidth('你好世界', 5), '…世界')
check('a zero budget yields nothing at all', tailWidth('abc', 0), '')

check('home collapses to a tilde', formatProject('/home/me/code', '/home/me'), '~/code')
check('the home directory itself is just a tilde', formatProject('/home/me', '/home/me'), '~')
check('backslashes normalize before comparing', formatProject('C:\\Users\\me\\proj', 'C:\\Users\\me'), '~/proj')
check('a sibling of home is not collapsed', formatProject('/home/melissa', '/home/me'), '/home/melissa')
check('a path outside home is shown whole', formatProject('/srv/app', '/home/me'), '/srv/app')

console.log(`verify-session-kinds: OK (${checks} checks)`)
