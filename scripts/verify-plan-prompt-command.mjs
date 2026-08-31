/**
 * Channel-level verification of the `/planPrompt` command: the camelCase
 * local command parses, `setPlanPrompt`/`planPromptEnabled` fold the durable
 * `plan-prompt/mode` event, the switch keeps real `plan/mode` state
 * consistent (on enters plan mode, off leaves it), and it never tears down a
 * plan mode the user entered through plain `/plan`.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-plan-prompt-command.mjs
 */
import assert from 'node:assert/strict'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { isLocalCommandName, normalizeLocalCommandName, parseCommandName } from '../lib/types/commands.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---- parser ---------------------------------------------------------------
check(
  'parseCommandName accepts the camelCase local command',
  parseCommandName('/planPrompt')?.name === 'planPrompt' &&
  parseCommandName('/planPrompt')?.rawInput === '',
)
const off = parseCommandName('/planPrompt off')
check('parseCommandName preserves /planPrompt off raw input', off?.name === 'planPrompt' && off?.rawInput === ' off')
check('parseCommandName leaves /plan untouched', parseCommandName('/plan')?.name === 'plan')
const mixed = parseCommandName('/PlAnPrOmPt off')
check(
  'parseCommandName preserves mixed-case /PlAnPrOmPt for catalog folding',
  mixed?.name === 'PlAnPrOmPt' && mixed?.rawInput === ' off',
)
check(
  'normalizeLocalCommandName folds every casing back to planPrompt',
  ['/planPrompt', '/PlanPrompt', '/PLANPROMPT', '/pLaNpRoMpT ']
    .every(variant => normalizeLocalCommandName(variant) === 'planPrompt'),
)
check(
  'isLocalCommandName matches the catalog case-insensitively',
  ['planPrompt', 'PLANPROMPT', '/PlanPrompt '].every(variant => isLocalCommandName(variant)),
)
check('isLocalCommandName still rejects unknown names', !isLocalCommandName('/planpromt'))

// ---- channel --------------------------------------------------------------
function makeAgent(handlers, id) {
  const events = []
  const appended = []
  const listenerErrors = []
  let appending = false
  const session = {
    id,
    seq: 0,
    events,
    append(type, data) {
      // Mirror dsh-session's publication boundary: observers may not append
      // reentrantly while the previous event is still being published.
      if (appending) {
        const error = new Error('session append cannot reenter while another append is being published')
        listenerErrors.push(error)
        throw error
      }
      appending = true
      try {
        appended.push({ type, data })
        const event = { type, seq: events.length + 1, time: Date.now(), data }
        events.push(event)
        try {
          handlers.get('session/event')?.(session, event)
        } catch (error) {
          // dsh-session contains observer failures and the append still lands.
          listenerErrors.push(error)
        }
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
    listenerErrors,
  }
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
  const { agent, events, appended, listenerErrors } = makeAgent(handlers, 's1')
  const channel = createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
    agentPreset,
  })
  return { channel, events, appended, listenerErrors, session: agent.session, agent }
}

{
  const { channel, appended } = makeEnv('liangshen')
  check('fresh Liangshen session starts with injection off', channel.planPromptEnabled() === false)
  check('fresh Liangshen session starts with plan mode off', channel.planModeEnabled() === false)
  check('/planPrompt is listed only for Liangshen', channel.commandList.some(command => command.name === 'planPrompt'))

  check('setPlanPrompt(true) returns true', channel.setPlanPrompt(true) === true)
  check('injection enabled after setPlanPrompt(true)', channel.planPromptEnabled() === true)
  check('plan mode enabled after setPlanPrompt(true)', channel.planModeEnabled() === true)
  check(
    'enabling appends prompt switch on + real plan mode on',
    appended.length === 2 &&
    appended[0].type === 'plan-prompt/mode' && appended[0].data.active === true &&
    appended[1].type === 'plan/mode' && appended[1].data.active === true,
    JSON.stringify(appended),
  )
  check(
    'enabling projects the toggle into the transcript',
    channel.rows.filter(row => row.kind === 'notice').length === 1,
    JSON.stringify(channel.rows.map(row => row.kind)),
  )

  check('setPlanPrompt(false) returns false', channel.setPlanPrompt(false) === false)
  check('injection disabled after setPlanPrompt(false)', channel.planPromptEnabled() === false)
  check('plan mode disabled after setPlanPrompt(false)', channel.planModeEnabled() === false)
  check(
    'disabling appends prompt switch off + real plan mode off',
    appended.length === 4 &&
    appended[2].type === 'plan-prompt/mode' && appended[2].data.active === false &&
    appended[3].type === 'plan/mode' && appended[3].data.active === false,
    JSON.stringify(appended),
  )
  check(
    'disabling projects the toggle into the transcript',
    channel.rows.filter(row => row.kind === 'notice').length === 2,
    JSON.stringify(channel.rows.map(row => row.kind)),
  )
}

{
  // Build the plan-only case with an explicit pre-existing plan/mode event:
  // fresh env, pre-append plan mode on, then /planPrompt off must be a no-op
  // for both the prompt switch and plan state.
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() {
      return undefined
    },
    logger: { warn() {} },
  }
  const { agent, appended } = makeAgent(handlers, 's2')
  const session = agent.session
  session.append('plan/mode', { active: true })
  const channel = createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
    agentPreset: 'liangshen',
  })
  const before = appended.length
  check('plan-only session starts with prompt switch off', channel.planPromptEnabled() === false)
  check('setPlanPrompt(false) on a plan-only session returns false', channel.setPlanPrompt(false) === false)
  check(
    '/planPrompt off leaves plain /plan mode untouched',
    appended.length === before,
    JSON.stringify(appended.slice(before)),
  )
  check(
    'plain plan/mode event is still the last plan event',
    appended[before - 1].type === 'plan/mode' && appended[before - 1].data.active === true,
    JSON.stringify(appended),
  )
}

{
  // A plan-mode exit that did not come from /planPrompt (exit_plan_mode
  // approval or /plan off) must clear the stale prompt switch. The clear is
  // deferred because dsh-session forbids reentrant appends from inside the
  // session/event observer.
  const { channel, session, appended, listenerErrors } = makeEnv('liangshen')
  channel.setPlanPrompt(true)
  appended.length = 0
  session.append('plan/mode', { active: false })
  check(
    'external plan-mode exit does not append reentrantly from the session/event observer',
    listenerErrors.length === 0,
    listenerErrors.map(error => String(error)).join('; '),
  )
  await Promise.resolve()
  check(
    'external plan-mode exit clears the /planPrompt switch',
    channel.planPromptEnabled() === false &&
    appended.some(entry => entry.type === 'plan-prompt/mode' && entry.data.active === false),
    JSON.stringify(appended),
  )
  channel.setPlanPrompt(true)
  check(
    're-entering /planPrompt after /plan off restarts the switch and plan mode',
    channel.planPromptEnabled() === true &&
    appended.filter(entry => entry.type === 'plan/mode').at(-1)?.data.active === true,
    JSON.stringify(appended),
  )
}

{
  // Shift+Tab after `/planPrompt` on a blank session. The first press must
  // land on the plan mode (not stay stuck on the unmarked base because the
  // approval service left `ask` unlogged), and the second press must leave
  // plan mode AND clear the `/planPrompt` switch.
  let approvalPolicy = 'ask'
  const services = {
    approval: {
      setPolicy(agent, policy) {
        // dsh-user-approval.setPolicy is a no-op when the target equals the
        // configured default — this is the regression shape.
        if (approvalPolicy === policy) return
        approvalPolicy = policy
        agent.session.append('approval/policy', { policy })
      },
    },
    commands: {
      find(_agent, name) {
        return name === 'plan' ? { name, handler: () => ({ kind: 'success', text: 'ok' }) } : undefined
      },
      list() {
        return [{ name: 'plan', description: 'Enter or leave plan mode' }]
      },
      execute(agent, line, _images, _signal) {
        if (line === '/plan off') agent.session.append('plan/mode', { active: false })
        else if (line === '/plan') agent.session.append('plan/mode', { active: true })
        return Promise.resolve({ result: { text: 'ok' } })
      },
    },
  }
  const env = makeEnv('liangshen', services)
  const { channel, appended, listenerErrors } = env
  channel.setPlanPrompt(true)
  check('/planPrompt on a blank session leaves the mode indicator on the base', channel.modeIndex === 0)
  await channel.cycleMode()
  check(
    'first Shift+Tab lands on the plan mode with a logged approval override',
    channel.modeIndex === 1 && channel.planPromptEnabled() === true,
    `modeIndex=${channel.modeIndex} events=${JSON.stringify(appended)}`,
  )
  await channel.cycleMode()
  await Promise.resolve()
  check(
    'second Shift+Tab leaves plan mode and clears /planPrompt',
    channel.modeIndex === 2 && channel.planPromptEnabled() === false,
    `modeIndex=${channel.modeIndex} prompt=${channel.planPromptEnabled()} events=${JSON.stringify(appended)}`,
  )
  check(
    'Shift+Tab transitions never throw reentrant append errors',
    listenerErrors.length === 0,
    listenerErrors.map(error => String(error)).join('; '),
  )
}

{
  // `/plan off` queued during an open turn is a pending intent in
  // dsh-plan-mode, not a logged plan/mode event yet. A `/planPrompt` re-enter
  // before the next boundary must replace that pending OFF with ON — the old
  // direct-append path saw both switches still on, did nothing, and the
  // queued OFF won at the next step, silently swallowing the command.
  let pending
  const setCalls = []
  const fold = events => {
    let active = false
    for (const event of events) {
      if (event.type === 'plan/mode') active = event.data.active === true
    }
    return active
  }
  const hasOpenTurn = events => {
    let open = false
    for (const event of events) {
      if (event.type === 'turn/start') open = true
      else if (event.type === 'turn/end') open = false
    }
    return open
  }
  const services = {
    planMode: {
      set(agent, active) {
        setCalls.push(active)
        pending = active
        if (!hasOpenTurn(agent.session.events)) {
          if (fold(agent.session.events) !== active) {
            agent.session.append('plan/mode', { active })
          }
          pending = undefined
        }
      },
      get(agent) {
        return { active: fold(agent.session.events), pending }
      },
      /** Simulate dsh-plan-mode's accepted pre-step boundary. */
      commitPending(agent) {
        if (pending === undefined) return
        if (fold(agent.session.events) !== pending) agent.session.append('plan/mode', { active: pending })
        pending = undefined
      },
      pending() {
        return pending
      },
    },
  }
  const env = makeEnv('liangshen', services)
  const { channel, session } = env
  channel.setPlanPrompt(true)
  session.append('turn/start', { turn: 1 })
  // dsh-plan-mode receives /plan off while the turn is open.
  services.planMode.set(env.agent, false)
  check(
    '/plan off during an open turn queues pending OFF',
    pending === false && fold(session.events) === true,
    `pending=${String(pending)} fold=${String(fold(session.events))}`,
  )
  check(
    'planModeEnabled reports the queued OFF as off (pending wins)',
    channel.planModeEnabled() === false,
    `planModeEnabled=${channel.planModeEnabled()}`,
  )
  channel.setPlanPrompt(true)
  check(
    '/planPrompt re-enter routes through the controller and replaces pending OFF',
    setCalls.includes(true) && pending === true,
    `calls=${JSON.stringify(setCalls)} pending=${String(pending)}`,
  )
  check(
    'planModeEnabled reports the replaced pending ON as on',
    channel.planModeEnabled() === true,
    `planModeEnabled=${channel.planModeEnabled()}`,
  )
  services.planMode.commitPending(env.agent)
  check(
    'after the next boundary plan mode is still on and the prompt switch is on',
    channel.planPromptEnabled() === true && channel.planModeEnabled() === true && fold(session.events) === true,
    `prompt=${channel.planPromptEnabled()} plan=${channel.planModeEnabled()} fold=${String(fold(session.events))}`,
  )
}

{
  // A resumed log from before this fix can contain prompt-on after plan-off.
  // Binding the channel must normalize the stale switch back to off.
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() {
      return undefined
    },
    logger: { warn() {} },
  }
  const { agent, appended } = makeAgent(handlers, 's3')
  agent.session.append('plan/mode', { active: false })
  agent.session.append('plan-prompt/mode', { active: true })
  const channel = createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
    agentPreset: 'liangshen',
  })
  check('stale resume switch is normalized to off', channel.planPromptEnabled() === false)
  check(
    'stale normalization appends one clearing event',
    appended.slice(2).some(entry => entry.type === 'plan-prompt/mode' && entry.data.active === false),
    JSON.stringify(appended.slice(2)),
  )
}

{
  // 复审修复：/plan 先开的 plan mode 不被 /planPrompt off 误关。所有权由事件
  // 序推断（switch ON 时 plan 是否已被开启），无 controller 的 fallback 路径
  // 与 controller 路径走同一守卫，resume 后仍成立。
  const a = makeEnv('liangshen')
  a.events.push({ type: 'plan/mode', seq: 0, time: 0, data: { active: true } })
  a.channel.setPlanPrompt(true)
  a.channel.setPlanPrompt(false)
  check('plan-mode owned by /plan survives planPrompt off',
    !a.appended.some(e => e.type === 'plan/mode' && e.data.active === false)
      && a.channel.planModeEnabled() === true,
    JSON.stringify(a.appended))
  // 对照：自己开的（ON 时 plan 未 active）→ off 时关掉
  const b = makeEnv('liangshen')
  b.channel.setPlanPrompt(true)
  b.channel.setPlanPrompt(false)
  check('plan-mode acquired by planPrompt is torn down on off',
    b.appended.some(e => e.type === 'plan/mode' && e.data.active === false),
    JSON.stringify(b.appended))
}

{
  const { channel, appended } = makeEnv('standard')
  check('setPlanPrompt is undefined outside Liangshen', channel.setPlanPrompt(true) === undefined)
  check('/planPrompt is not listed outside Liangshen', !channel.commandList.some(command => command.name === 'planPrompt'))
  check('non-Liangshen switch appends nothing', appended.length === 0, JSON.stringify(appended))
}

if (failed > 0) process.exit(failed)
console.log('planPrompt command channel verified (case-insensitive camelCase parse/fold, prompt+plan consistency, pending-intent re-enter, /plan untouched)')
