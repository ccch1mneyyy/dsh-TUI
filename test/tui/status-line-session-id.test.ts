import './redirect-home.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StatusLineView } from '../../src/tui/components/status-line.js'
import type { TUI } from '../../src/tui/public.js'
import type { StatusLineProjection } from '../../src/tui/view-model.js'
import { DEFAULT_STATUS_BAR } from '../../src/tuiDisplayPrefs.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const
const AGENT_ID = 'd5a3b7c9-e1f2-4a6b-8c3d-0123456789ab'
const SHORT_ID = '#d5a3b7c9'

const fakeUi = { requestRender() {} } as unknown as TUI

function makeProjection(overrides: Partial<StatusLineProjection> = {}): StatusLineProjection {
  return {
    meta,
    minimal: false,
    statusBar: { ...DEFAULT_STATUS_BAR },
    lastUsage: undefined,
    reasoningEffort: undefined,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    contextWindow: undefined,
    tps: undefined,
    tpsSamples: [],
    model: 'test-model',
    tokens: { input: 0, output: 0 },
    gitBranch: undefined,
    displayCwd: '/repo',
    sessionTitle: '',
    agentId: AGENT_ID,
    working: false,
    workingActivity: undefined,
    activityFrames: undefined,
    contextBarEnabled: false,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    ...overrides,
  }
}

function renderStatus(vm: StatusLineProjection, width = 140): string {
  const view = new StatusLineView(fakeUi, vm)
  return view.render(width).join('\n')
}

// ---------------------------------------------------------------------------
// statusBar.sessionId
// ---------------------------------------------------------------------------

test('session id stays hidden while the switch is off (default)', () => {
  const out = renderStatus(makeProjection())
  assert.ok(!out.includes(SHORT_ID), `unexpected short session id in:\n${out}`)
  assert.ok(!out.includes('d5a3b7c9'), `agent id leaked in:\n${out}`)
})

test('session id switch renders # + the first 8 agent id chars, dim trail', () => {
  const out = renderStatus(makeProjection({
    statusBar: { ...DEFAULT_STATUS_BAR, sessionId: true },
  }))
  assert.ok(out.includes(SHORT_ID), `missing short session id in:\n${out}`)
  assert.ok(!out.includes('d5a3b7c9-e1f2'), `full id leaked in:\n${out}`)
})

test('minimal mode hides the session id even when the switch is on', () => {
  const out = renderStatus(makeProjection({
    minimal: true,
    statusBar: { ...DEFAULT_STATUS_BAR, sessionId: true },
  }))
  assert.ok(!out.includes(SHORT_ID), `short session id leaked in minimal mode:\n${out}`)
  assert.ok(!out.includes('d5a3b7c9'), `agent id leaked in minimal mode:\n${out}`)
})

test('an empty agent id renders no session id tag', () => {
  const out = renderStatus(makeProjection({
    agentId: '',
    statusBar: { ...DEFAULT_STATUS_BAR, sessionId: true },
  }))
  assert.ok(!out.includes('#'), `unexpected session id tag in:\n${out}`)
})
