#!/usr/bin/env node
/**
 * Regression for the resume-model-route backfill (dsh-tui side of the
 * subagent `{{model}}` failure): resume must feed the target session's
 * recorded request/header route back into `agents.resume({ agentOptions })`
 * so `options.model` is populated again. A provider-only cordis.yml pin
 * (issue #67) otherwise leaves agentOptions.model undefined, which breaks
 * the `{{model}}` persona variable for the resumed agent's own assembly
 * AND for every subagent it spawns (dsh-subagent's resolveChildAgentOptions
 * inherits `parent.options.model`).
 *
 * Verifies `resolvePersistedRoute` (src/dsh-adapter/presets.ts):
 *   1. a session whose log records request/header returns that route;
 *   2. a session whose log records request/header WITHOUT a model half
 *      returns undefined (recordedModelRoute requires BOTH halves);
 *   3. a session with no request/header at all returns undefined;
 *   4. a missing/corrupt artifact returns undefined, not a throw;
 *   5. a context without sessionPersistence returns undefined.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-resume-route.mjs
 */
import assert from 'node:assert/strict'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const { resolvePersistedRoute } = await import('../lib/types/dsh-adapter/presets.js')

const header = (provider, model) => ({
  type: 'request/header',
  seq: 1,
  time: 1,
  data: { header: { config: { provider, model } } },
})

const ctxOf = (load) => ({
  get(key) {
    return key === 'sessionPersistence' && load !== undefined
      ? { load }
      : undefined
  },
})

const sid = '00000000-1111-2222-3333-444444444444'

// 1. Full route recorded → returned.
{
  const route = await resolvePersistedRoute(ctxOf(async () => ({
    meta: {},
    events: [header('deepseek-official', 'deepseek-v4-flash')],
  })), sid)
  check(
    'recorded request/header yields the full route',
    route?.provider === 'deepseek-official' && route?.model === 'deepseek-v4-flash',
    JSON.stringify(route),
  )
}

// 2. Provider-only recorded (half pin) → undefined, never a half-merged route.
{
  const route = await resolvePersistedRoute(ctxOf(async () => ({
    meta: {},
    events: [header('deepseek-official', undefined)],
  })), sid)
  check('provider-only record yields undefined', route === undefined, JSON.stringify(route))
}

// 3. No request/header → undefined.
{
  const route = await resolvePersistedRoute(ctxOf(async () => ({
    meta: {},
    events: [{ type: 'user/message', seq: 1, time: 1, data: {} }],
  })), sid)
  check('bare log (no header) yields undefined', route === undefined, JSON.stringify(route))
}

// 4. Unreadable artifact → undefined, not a throw.
{
  const route = await resolvePersistedRoute(ctxOf(async () => { throw new Error('corrupt') }), sid)
  check('unreadable artifact yields undefined', route === undefined, String(route))
}

// 5. No persistence service → undefined.
{
  const route = await resolvePersistedRoute(ctxOf(undefined), sid)
  check('absent persistence yields undefined', route === undefined, String(route))
}

// 6. Last header wins (the route the session actually continues on).
{
  const route = await resolvePersistedRoute(ctxOf(async () => ({
    meta: {},
    events: [header('deepseek-official', 'deepseek-v4-flash'), header('other-provider', 'other-model')],
  })), sid)
  check(
    'last request/header wins',
    route?.provider === 'other-provider' && route?.model === 'other-model',
    JSON.stringify(route),
  )
}

console.log(failed === 0 ? 'verify-resume-route: all checks passed' : `verify-resume-route: ${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
