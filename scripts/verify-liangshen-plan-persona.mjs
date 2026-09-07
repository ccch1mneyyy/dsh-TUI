/**
 * Regression for liangshen's plan-aware persona: the complete persona section
 * must stay byte-identical to the previous static Minimal persona while the
 * session is NOT in plan mode, and must render the deployment plan guidance
 * from the YAML while real plan mode is active (or an entry is pending).
 *
 * The real plan state is load-bearing: `exit_plan_mode` only exists while
 * `plan/mode` is active. The persona therefore reads `planMode.get` only and
 * must never claim "You are in plan mode" when the state disagrees — a
 * pending exit drops the guidance immediately, before the next step appends
 * `plan/mode`.
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
  apply,
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
assert.equal(effectCalls, 1, 'persona section is registered through one ctx.effect')
assert.equal(runtimeSuppressed, true, 'runtime context stays suppressed (old includeRuntimeContext: false)')
assert.equal(registeredSection.name, 'deployment:persona')
assert.equal(registeredSection.order, 0)
assert.equal(registeredSection.complete, true)

const render = (id, planState = {}) => {
  states.set(id, planState)
  return registeredSection.text({ agent: { session: { id } } })
}

// Plan mode off: byte-identical to the old static persona row.
assert.equal(render('off', { active: false }), BASE_PERSONA)
assert.equal(render('off-missing', {}), BASE_PERSONA)

// Plan mode on: base persona + the YAML guidance (the derived-injection
// contract — every plan-mode entry injects, regardless of the entry path).
const planningPrompt = render('on', { active: true })
assert.equal(planningPrompt, `${BASE_PERSONA}\n\n${PLAN_SECTION}`)
assert.ok(planningPrompt.startsWith(`${BASE_PERSONA}\n\n`))
assert.ok(planningPrompt.includes('You are in plan mode. Stay in plan mode'))
assert.ok(planningPrompt.includes('Do not edit or write files'))

// A queued /plan entry during an open turn: pending true wins before the
// plan/mode event reaches the log.
assert.equal(
  render('pending-on', { active: false, pending: true }),
  planningPrompt,
)

// An approved exit: pending false wins over the still logged active state,
// so the guidance drops immediately.
assert.equal(
  render('pending-off', { active: true, pending: false }),
  BASE_PERSONA,
)

// Missing agent context and an empty/missing plan section degrade to BASE
// instead of throwing or sending an empty prompt.
assert.equal(registeredSection.text({}), BASE_PERSONA)
const previous = ctx.planMode.section
ctx.planMode.section = '   '
assert.equal(render('empty-section', { active: true }), BASE_PERSONA)
ctx.planMode.section = previous

console.log('liangshen plan-aware persona verified (derived from real plan state, pending wins, Minimal outside plan mode)')
