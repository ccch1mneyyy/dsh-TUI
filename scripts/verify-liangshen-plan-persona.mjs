/**
 * Regression for liangshen's plan-prompt switch: the complete persona section
 * must stay byte-identical to the previous static Minimal persona until BOTH
 * the durable `plan-prompt/mode` switch (`/planPrompt`) is on AND the session
 * really is in plan mode. When both agree, it must render the deployment plan
 * guidance from the YAML.
 *
 * The real plan state is load-bearing: `exit_plan_mode` only exists while
 * `plan/mode` is active. The persona must therefore never claim "You are in
 * plan mode" from the prompt switch alone, and it must drop the guidance as
 * soon as plan mode logs off (or an exit becomes pending). Plain `/plan` is
 * unchanged — a `plan/mode` activation without the prompt switch still renders
 * the Minimal persona.
 *
 * The YAML itself is parsed as the source of truth for the plan section, so
 * this test also fails if someone duplicates (and then drifts) the guidance
 * text into the plugin or removes the row from the planning group.
 *
 * Run with plain node:
 *   node scripts/verify-liangshen-plan-persona.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { PERSONA_ORDER as UPSTREAM_PERSONA_ORDER, PERSONA_SECTION as UPSTREAM_PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import {
  PERSONA_ORDER,
  PERSONA_SECTION,
  PLAN_PROMPT_EVENT,
  apply,
  foldPlanPrompt,
  inject,
  name,
} from '../presets/liangshen/plan-aware-persona.mjs'

const presetRoot = new URL('../presets/liangshen/', import.meta.url)
const preset = parse(readFileSync(fileURLToPath(new URL('agent.cordis.yml', presetRoot)), 'utf8'), { logLevel: 'silent' })

const planning = preset.find(row => row?.id === 'planning')
assert.ok(planning?.group === true, 'planning group exists')
const rows = planning.config.map(row => row?.id)
const planModeIndex = rows.indexOf('plan-mode')
const personaIndex = rows.indexOf('plan-aware-persona')
assert.ok(planModeIndex !== -1, 'plan-mode stays inside the planning group')
assert.ok(personaIndex > planModeIndex, 'plan-aware-persona is mounted inside the planning group after plan-mode')
assert.ok(!preset.some(row => row?.id === 'persona' && row?.name === '@deepseek-ai/dsh-persona'), 'static dsh-persona row is removed')

const PLAN_SECTION = planning.config[planModeIndex].config.section
assert.ok(typeof PLAN_SECTION === 'string' && PLAN_SECTION.trim() !== '', 'plan-mode section is a non-empty string')
assert.ok(PLAN_SECTION.includes('You are in plan mode. Stay in plan mode'), 'plan section carries the stay-in-plan rule')
assert.ok(PLAN_SECTION.includes('Do not edit or write files'), 'plan section carries the no-edit rule')

const BASE_PERSONA = 'You are a helpful software engineer assistant.'

let registeredSection
let runtimeSuppressed = false
let effectCalls = 0
const states = new Map()
const ctx = {
  planMode: {
    section: PLAN_SECTION,
    get(agent) {
      return states.get(agent.session.id) ?? { active: false }
    },
  },
  systemPrompt: {
    suppressRuntimeContext() {
      runtimeSuppressed = true
      return () => {}
    },
    section(value) {
      registeredSection = value
      return () => {}
    },
  },
  effect(callback) {
    effectCalls += 1
    return callback()
  },
}

apply(ctx)

assert.equal(name, 'plan-aware-persona')
assert.deepEqual([...inject].sort(), ['planMode', 'systemPrompt'])
assert.equal(PERSONA_SECTION, UPSTREAM_PERSONA_SECTION, 'pinned persona section matches @deepseek-ai/dsh-system-prompt')
assert.equal(PERSONA_ORDER, UPSTREAM_PERSONA_ORDER, 'pinned persona order matches @deepseek-ai/dsh-system-prompt')
assert.equal(PLAN_PROMPT_EVENT, 'plan-prompt/mode', 'durable switch event name stays in sync with the TUI channel')
assert.equal(effectCalls, 1, 'persona section is registered through one ctx.effect')
assert.equal(runtimeSuppressed, true, 'runtime context stays suppressed (old includeRuntimeContext: false)')
assert.equal(registeredSection.name, 'deployment:persona')
assert.equal(registeredSection.order, 0)
assert.equal(registeredSection.complete, true)

const event = (type, data) => ({ type, data })
const render = (id = 's1', events = [], planState = {}) => {
  states.set(id, planState)
  return registeredSection.text({ agent: { session: { id, events } } })
}

// Switch off (the default): byte-identical to the old static persona row.
assert.equal(render('off', []), BASE_PERSONA)
assert.equal(render('off-event', [event('plan-prompt/mode', { active: false })]), BASE_PERSONA)

// Plain /plan stays untouched: a plan-mode activation alone must NOT inject
// anything — the user must also run /planPrompt.
assert.equal(render('plan-only', [event('plan/mode', { active: true })], { active: true }), BASE_PERSONA)

// The prompt switch alone must NOT inject either. This is the regression
// for the exit_plan_mode bug: "You are in plan mode" requires real plan
// state, otherwise exit_plan_mode reports "only available in plan mode".
assert.equal(render('prompt-only', [event('plan-prompt/mode', { active: true })], { active: false }), BASE_PERSONA)

// /planPrompt on + plan mode on: base persona + YAML guidance.
const planPrompt = render(
  'both',
  [event('plan-prompt/mode', { active: true }), event('plan/mode', { active: true })],
  { active: true },
)
assert.equal(planPrompt, `${BASE_PERSONA}\n\n${PLAN_SECTION}`)
assert.ok(planPrompt.startsWith(`${BASE_PERSONA}\n\n`))
assert.ok(planPrompt.includes('You are in plan mode. Stay in plan mode'))
assert.ok(planPrompt.includes('Do not edit or write files'))

// A queued /plan entry during an open turn: pending true wins before the
// plan/mode event reaches the log.
assert.equal(
  render(
    'pending-on',
    [event('plan-prompt/mode', { active: true })],
    { active: false, pending: true },
  ),
  planPrompt,
)

// An approved exit (or /planPrompt off): pending false wins over the still
// logged active state, so the guidance drops immediately.
assert.equal(
  render(
    'pending-off',
    [event('plan-prompt/mode', { active: true }), event('plan/mode', { active: true })],
    { active: true, pending: false },
  ),
  BASE_PERSONA,
)

// /planPrompt off drops the guidance again; the last event wins.
assert.equal(
  render('off-after-on', [
    event('plan-prompt/mode', { active: true }),
    event('plan/mode', { active: true }),
    event('plan-prompt/mode', { active: false }),
  ], { active: false }),
  BASE_PERSONA,
)

// A stale prompt switch (e.g. plan mode exited while it stayed on) is
// inert until real plan mode returns.
assert.equal(
  render('stale-switch', [event('plan-prompt/mode', { active: true })], { active: true }),
  planPrompt,
)

// Malformed payloads degrade to off instead of throwing.
assert.equal(render('malformed', [event('plan-prompt/mode', { active: 'yes' })]), BASE_PERSONA)
assert.equal(render('missing-data', [event('plan-prompt/mode', undefined)]), BASE_PERSONA)
assert.equal(foldPlanPrompt(undefined), false)
assert.equal(foldPlanPrompt([]), false)

// Missing agent context and an empty/missing plan section degrade to BASE
// instead of throwing or sending an empty prompt.
assert.equal(registeredSection.text({}), BASE_PERSONA)
const previous = ctx.planMode.section
ctx.planMode.section = '   '
assert.equal(
  render('empty-section', [event('plan-prompt/mode', { active: true }), event('plan/mode', { active: true })], { active: true }),
  BASE_PERSONA,
)
ctx.planMode.section = previous

console.log('liangshen plan-aware persona verified (prompt switch AND real plan state, exit_plan_mode regression fixed, /plan untouched)')
