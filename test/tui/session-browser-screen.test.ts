/**
 * SessionBrowserScreen fork-family interaction tests
 * (src/tui/screens/session-browser.ts): the ▸N/▾N badge, → expands the
 * folded family under the cursor, ← closes it — from a member row landing
 * the cursor back on the family row — a live search lifts the fold so a
 * folded member is directly resumable, and the expansion survives reloads.
 * Bare node:test runner with a fake command sink; no terminal.
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionBrowserScreen } from '../../src/tui/screens/session-browser.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import type { SessionsProjection } from '../../src/tui/view-model.js'
import { stripTerminalSequences } from '../../src/tui/public.js'
import type { SessionSummary } from '../../src/dsh-adapter/sessions/types.js'

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

interface Harness {
  screen: SessionBrowserScreen
  resumed: string[]
  closed: () => boolean
  rendered: () => string
  focusedLine: () => string
  push: (sessions: readonly SessionSummary[]) => void
}

function makeHarness(sessions: readonly SessionSummary[]): Harness {
  let closed = false
  const resumed: string[] = []
  const commands = {
    query: {
      listSessions: async () => sessions,
      previewSession: async () => [],
    },
    session: {
      resumeTo: async (id: string) => {
        resumed.push(id)
        return { ok: true }
      },
      deleteSession: async () => true,
      renameSessionTo: async () => true,
    },
    info: {
      notify: () => () => {},
    },
  } as unknown as TuiCommands
  const screen = new SessionBrowserScreen({
    commands,
    home: '/home/u',
    sameProject: (a, b) => a === b,
    onClose: () => {
      closed = true
    },
  })
  const push = (next: readonly SessionSummary[]): void => {
    const vm: SessionsProjection = {
      meta: { revision: 1, sessionEpoch: 1, generation: 1 },
      sessions: next,
      cwd: '/proj',
      gitBranch: undefined,
      currentAgentId: 'live',
    }
    screen.update(vm)
  }
  push(sessions)
  return {
    screen,
    resumed,
    closed: () => closed,
    rendered: () => stripTerminalSequences(screen.render(100).join('\n')),
    focusedLine: () =>
      stripTerminalSequences(screen.render(100).join('\n'))
        .split('\n')
        .find(line => line.trimStart().startsWith('❯')) ?? '',
    push,
  }
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const ENTER = '\r'

// One family of two (conv ← fork, the fork being the stale branch a rewind
// left behind) plus an unrelated solo conversation. The live session is
// 'live', which never reaches the list.
const population = [
  summary({ id: 'live', updatedAt: 100 }),
  summary({ id: 'conv', updatedAt: 90, title: { text: 'render fix', source: 'auto' } }),
  summary({ id: 'fork', updatedAt: 80, kind: { kind: 'fork', parent: 'conv' }, title: { text: 'rewind branch', source: 'auto' } }),
  summary({ id: 'solo', updatedAt: 70, title: { text: 'solo chat', source: 'auto' } }),
]

test('a folded family shows one row with a ▸N badge; solo rows have none', () => {
  const harness = makeHarness(population)
  const out = harness.rendered()
  assert.ok(out.includes('▸2'), 'the family row carries the folded badge')
  assert.ok(!out.includes('rewind branch'), 'the folded member is not listed')
  assert.ok(out.includes('solo chat'))
  assert.ok(!out.split('\n').some(line => line.includes('solo chat') && line.includes('▸')), 'no badge on a family of one')
})

test('→ expands the family under the cursor; ← closes it again', () => {
  const harness = makeHarness(population)
  // The cursor starts on the first row — the family rep (MRU).
  assert.ok(harness.focusedLine().includes('render fix'))

  harness.screen.handleInput(RIGHT)
  const expanded = harness.rendered()
  assert.ok(expanded.includes('▾2'), 'the badge flips to the expanded glyph')
  assert.ok(expanded.includes('rewind branch'), 'the member row appears')

  harness.screen.handleInput(LEFT)
  const collapsed = harness.rendered()
  assert.ok(collapsed.includes('▸2'), 'the badge folds back')
  assert.ok(!collapsed.includes('rewind branch'), 'the member row folds away')
})

test('← on a member row closes the family and lands the cursor on its row', () => {
  const harness = makeHarness(population)
  harness.screen.handleInput(RIGHT)
  harness.screen.handleInput(DOWN)
  assert.ok(harness.focusedLine().includes('rewind branch'), 'the cursor is on the member')

  harness.screen.handleInput(LEFT)
  const out = harness.rendered()
  assert.ok(!out.includes('rewind branch'), 'the family folded')
  assert.ok(harness.focusedLine().includes('render fix'), 'the cursor moved to the family row')
  assert.ok(harness.focusedLine().includes('▸2'), '...which carries the folded badge again')
})

test('→ on a family of one (or a plain row) is a no-op', () => {
  const harness = makeHarness(population)
  harness.screen.handleInput(DOWN) // solo
  assert.ok(harness.focusedLine().includes('solo chat'))
  harness.screen.handleInput(RIGHT)
  harness.screen.handleInput(LEFT)
  assert.ok(harness.focusedLine().includes('solo chat'), 'the cursor never moved')
  assert.ok(harness.rendered().includes('▸2'), 'the family above is untouched')
})

test('a live search lifts the fold: the folded member is found and resumed directly', async () => {
  const harness = makeHarness(population)
  for (const char of 'rewi') harness.screen.handleInput(char)
  const out = harness.rendered()
  assert.ok(out.includes('rewind branch'), 'the folded member matches as its own row')
  assert.ok(!out.includes('render fix'), 'non-matching rows are filtered out')
  assert.ok(!out.includes('▸'), 'no badges under a live query')

  harness.screen.handleInput(ENTER)
  await tick()
  assert.deepEqual(harness.resumed, ['fork'])
  assert.equal(harness.closed(), true)
})

test('the expansion survives a reload / projection push', () => {
  const harness = makeHarness(population)
  harness.screen.handleInput(RIGHT)
  assert.ok(harness.rendered().includes('▾2'))
  // A reload replaces the sessions array (post-mutation re-list); the
  // expansion is held as anchor identity, not row state, so it survives.
  harness.push([...population])
  const out = harness.rendered()
  assert.ok(out.includes('▾2'), 'the family is still expanded')
  assert.ok(out.includes('rewind branch'))
})

test('a rename-style MRU shuffle keeps the expansion on the family', () => {
  const harness = makeHarness(population)
  harness.screen.handleInput(RIGHT)
  // The solo session jumps to the top of the MRU order, as a touch would do.
  harness.push(population.map(session => (session.id === 'solo' ? { ...session, updatedAt: 95 } : session)))
  const out = harness.rendered()
  assert.ok(out.includes('▾2'), 'the expansion followed the family, not the row position')
  assert.ok(out.includes('rewind branch'))
})
