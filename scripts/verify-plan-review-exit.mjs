/**
 * Regression for the plan-review panel's "Exit planning" row: leaving plan
 * mode must route through dsh-plan-mode's controller
 * (`planMode.set(agent, false)`), not append `plan/mode { active: false }`
 * directly. A queued `/plan on` pending intent survives a direct append and
 * wins at the next accepted pre-step, silently re-entering plan mode after
 * the user just left it.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-plan-review-exit.mjs
 */
import assert from 'node:assert/strict'
import { QuestionStore } from '../lib/types/dsh-adapter/questions.js'
import { serviceForAgent } from '../lib/types/dsh-adapter/presets.js'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const REVIEW = {
  id: 'review',
  question: 'Approve this plan?',
  intent: { kind: 'plan-review', approve: 'Approve' },
}

function foldPlanActive(events) {
  let active = false
  for (const event of events) {
    if (event.type === 'plan/mode') active = event.data.active === true
  }
  return active
}

function hasOpenTurn(events) {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/**
 * A miniature of dsh-plan-mode's controller: logged fold plus one pending
 * intent applied at the next accepted pre-step.
 */
function makePlanMode(events) {
  let pending
  const setCalls = []
  return {
    service: {
      set(agent, active) {
        setCalls.push(active)
        if (hasOpenTurn(agent.session.events)) {
          pending = active
          return foldPlanActive(agent.session.events) === active ? 'cancelled' : 'queued'
        }
        if (foldPlanActive(agent.session.events) !== active) {
          agent.session.append('plan/mode', { active })
        }
        pending = undefined
        return foldPlanActive(agent.session.events) === active ? 'noop' : 'committed'
      },
      get(agent) {
        return { active: foldPlanActive(agent.session.events), pending }
      },
    },
    setCalls,
    commitPending() {
      if (pending === undefined) return
      if (foldPlanActive(events) !== pending) events.push({ type: 'plan/mode', data: { active: pending } })
      pending = undefined
    },
    pending: () => pending,
  }
}

function makeAgent() {
  const events = []
  let cancelled = 0
  const session = {
    id: 's1',
    events,
    append(type, data) {
      events.push({ type, data })
    },
  }
  const agent = {
    id: 'agent-1',
    session,
    ctx: {},
    cancel() {
      cancelled += 1
    },
  }
  return { agent, session, events, cancelled: () => cancelled }
}

/** Install the exact handler plugin.ts installs for production boots. */
function installPluginHandler(store, ctx, agent, session) {
  store.setPlanModeOffHandler(callingAgent => {
    const planMode = serviceForAgent(ctx, callingAgent, 'planMode')
    if (planMode?.set !== undefined) {
      planMode.set(callingAgent, false)
    } else {
      session.append('plan/mode', { active: false })
    }
  })
}

async function exitReview(store, agent) {
  const settled = store.ask({ questions: [REVIEW], agent }).then(
    () => ({ resolved: true }),
    error => ({ error }),
  )
  store.exitPlanReview()
  return settled
}

// ---- controller path: queued ON must be replaced, not outlived ------------
{
  const { agent, session, events, cancelled } = makeAgent()
  const planMode = makePlanMode(events)
  const ctx = { get: name => (name === 'planMode' ? planMode.service : undefined) }
  session.append('turn/start', { turn: 1 })
  session.append('plan/mode', { active: true })
  // A `/plan on` selected during the open turn parks as a pending intent.
  planMode.service.set(agent, true)
  const loggedBefore = events.length

  const store = new QuestionStore()
  installPluginHandler(store, ctx, agent, session)
  const settled = await exitReview(store, agent)

  check(
    'exitPlanReview rejects with PLAN_REVIEW_EXITED through the controller path',
    settled.error instanceof UserQuestionError && settled.error.code === 'PLAN_REVIEW_EXITED',
  )
  check('exitPlanReview aborts the calling agent turn', cancelled() === 1)
  check(
    'planMode.set(agent, false) replaces the queued ON',
    planMode.setCalls.includes(true) && planMode.setCalls.at(-1) === false && planMode.pending() === false,
    `calls=${JSON.stringify(planMode.setCalls)} pending=${String(planMode.pending())}`,
  )
  check(
    'no direct plan/mode append races the pending intent',
    events.length === loggedBefore,
    JSON.stringify(events.slice(loggedBefore)),
  )
  planMode.commitPending()
  check(
    'the next pre-step commits OFF and does not resurrect plan mode',
    foldPlanActive(events) === false,
    JSON.stringify(events),
  )
  check('the exited review leaves no question parked', store.getSnapshot() === null)
}

// ---- no controller / no handler: raw event append still leaves plan mode --
{
  const { agent, session, events, cancelled } = makeAgent()
  session.append('turn/start', { turn: 1 })
  session.append('plan/mode', { active: true })
  const loggedBefore = events.length

  const store = new QuestionStore()
  const settled = await exitReview(store, agent)

  check(
    'without a handler the fallback still rejects and aborts',
    settled.error instanceof UserQuestionError && settled.error.code === 'PLAN_REVIEW_EXITED' && cancelled() === 1,
  )
  check(
    'without a handler the fallback appends plan/mode off directly',
    events.length === loggedBefore + 1 &&
    events.at(-1).type === 'plan/mode' && events.at(-1).data.active === false,
    JSON.stringify(events.slice(loggedBefore)),
  )
  check(
    'the fallback path leaves plan mode folded off',
    foldPlanActive(events) === false,
    JSON.stringify(events),
  )
}

if (failed > 0) process.exit(failed)
console.log('plan-review exit verified (controller replaces queued ON; raw append remains the no-controller fallback)')
