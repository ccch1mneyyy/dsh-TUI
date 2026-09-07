/**
 * Channel-level verification of the derived plan-injection contract: real
 * plan state (the upstream planMode service) is the single source of truth
 * the liangshen persona derives prompt injection from. Toggling plan mode
 * through the service only appends `plan/mode`, and `planModeEnabled`
 * reflects the live state (the persona half of the contract is covered by
 * scripts/verify-liangshen-plan-persona.mjs).
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-plan-injection.mjs
 */
import assert from 'node:assert/strict'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function makeAgent(handlers, id) {
  const events = []
  const appended = []
  let appending = false
  const session = {
    id,
    seq: 0,
    events,
    append(type, data) {
      if (appending) throw new Error('session append cannot reenter while another append is being published')
      appending = true
      try {
        appended.push({ type, data })
        const event = { type, seq: events.length + 1, time: Date.now(), data }
        events.push(event)
        handlers.get('session/event')?.(session, event)
        return event
      } finally {
        appending = false
      }
    },
  }
  return {
    agent: { id: `agent-${id}`, status: 'idle', session, ctx: { on: () => () => {} } },
    events,
    appended,
  }
}

function foldPlanActive(events) {
  let active = false
  for (const event of events) {
    if (event.type === 'plan/mode') active = event.data.active === true
  }
  return active
}

function makeEnv(agentPreset, services = {}) {
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get(name) {
      return services[name]
    },
    logger: { warn() {} },
  }
  const { agent, appended } = makeAgent(handlers, `s-${agentPreset}`)
  const channel = createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
    agentPreset,
  })
  return { channel, appended, agent, services }
}

{
  // A planMode controller in the shape dsh-plan-mode exposes: `set` routes
  // through its pending-intent queue and logs `plan/mode` when idle.
  const services = {
    planMode: {
      set(agent, active) {
        if (foldPlanActive(agent.session.events) !== active) {
          agent.session.append('plan/mode', { active })
        }
      },
      get(agent) {
        return { active: foldPlanActive(agent.session.events) }
      },
    },
  }
  const env = makeEnv('liangshen', services)
  const { channel, appended } = env
  check('liangshen starts out of plan mode', channel.planModeEnabled() === false)

  services.planMode.set(env.agent, true)
  check(
    'entering plan mode appends plan/mode on',
    appended.length === 1 && appended[0].type === 'plan/mode' && appended[0].data.active === true,
    JSON.stringify(appended),
  )
  check('liangshen planModeEnabled reflects the live state', channel.planModeEnabled() === true)

  services.planMode.set(env.agent, false)
  check(
    'leaving plan mode appends plan/mode off',
    appended.length === 2 && appended[1].type === 'plan/mode' && appended[1].data.active === false,
    JSON.stringify(appended),
  )
  check('planModeEnabled reflects the exit', channel.planModeEnabled() === false)
}

{
  const { channel } = makeEnv('standard')
  check('standard planModeEnabled works without a controller', channel.planModeEnabled() === false)
}

if (failed > 0) process.exit(failed)
console.log('plan-injection channel verified (plan/mode is the single source of truth)')
