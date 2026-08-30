/**
 * Plan approval and /plan off restore pre-plan permissions; Shift+Tab keeps
 * its explicit target, including deferred in-turn changes. Covers resume,
 * unmatched/partial modes, service defaults, and non-reentrant publication.
 * Run after pnpm build: node scripts/verify-plan-exit-restore.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-plan-exit-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }))

const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/** Yield past the restore microtask (and any microtask it queues). */
const settleMicrotasks = async () => {
  await new Promise(resolve => queueMicrotask(resolve))
  await Promise.resolve()
}

/** Last-wins fold over the in-memory log, mirroring the channel's own. */
function fold(events, type, key) {
  let value
  for (const event of events) {
    if (event.type === type && typeof event.data?.[key] === 'string') value = event.data[key]
  }
  return value
}

/**
 * One recording environment (modeled on verify-effort-mode.mjs) with a
 * dsh-session-faithful reentrancy guard: append() throws when called while
 * an earlier append is still publishing to the session/event handler.
 */
function makeEnv({ withApproval = true, noopApproval = false, deferredPlan = false, history = [] } = {}) {
  const commands = []
  const approvalPolicies = []
  const appended = []
  const handlers = new Map()
  const events = [...history]
  let pendingPlan
  let publishing = false
  let reentrantAppends = 0
  const services = {
    planMode: { get: () => ({ pending: pendingPlan }) },
    commands: {
      list: () => [],
      find: (_agent, name) => name === 'plan'
        ? { name: 'plan', description: 'Toggle plan mode', handler() {} }
        : undefined,
      execute: async (agent, line, _signal) => {
        commands.push(line)
        if (line.startsWith('/plan')) {
          const active = !line.startsWith('/plan off')
          const commandId = `command-${commands.length}`
          agent.session.append('command/run', { commandId, name: 'plan', args: active ? '' : 'off' })
          if (deferredPlan) pendingPlan = active
          else agent.session.append('plan/mode', { active })
          agent.session.append('command/done', { commandId, kind: 'success' })
          return { result: { text: 'ok' } }
        }
        return undefined
      },
    },
    ...(withApproval
      ? {
          approval: {
            setPolicy(agent, policy) {
              approvalPolicies.push(policy)
              // noopApproval mirrors dsh-user-approval's no-op when the
              // target equals the service's configured default: the call
              // is recorded but NO durable event lands.
              if (!noopApproval) agent.session.append('approval/policy', { policy })
            },
          },
        }
      : {}),
  }
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
  const agent = {
    id: 'a1',
    status: 'idle',
    session: {
      id: 's1',
      seq: 0,
      events,
      append(type, data) {
        if (publishing) {
          reentrantAppends += 1
          throw new Error(`reentrant session append: ${type}`)
        }
        appended.push({ type, data })
        const event = { type, seq: events.length + 1, time: Date.now(), data }
        events.push(event)
        publishing = true
        try {
          handlers.get('session/event')?.(agent.session, event)
        } finally {
          publishing = false
        }
      },
    },
    ctx: { on: () => () => {} },
  }
  const commitPlan = () => {
    const active = pendingPlan
    pendingPlan = undefined
    if (active !== undefined) agent.session.append('plan/mode', { active })
  }
  // Model an aborted/rejected pre-step: the controller drops the pending
  // intent and never appends plan/mode, so the log keeps its prior state.
  const abortPlan = () => {
    pendingPlan = undefined
  }
  return { ctx, agent, commands, approvalPolicies, appended, events, services, commitPlan, abortPlan, reentrancy: () => reentrantAppends }
}

const baseOptions = {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
}

const FULL_PLAN_MODES = [
  { id: 'full', sandbox: 'danger-full-access', approval: 'never' },
  { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
]

// ---- custom full -> plan cycle: approve restores the prior mode ----------
{
  const { ctx, agent, appended, events, reentrancy } = makeEnv()
  const channel = createChannel(ctx, agent, { ...baseOptions, modes: FULL_PLAN_MODES })
  check('fresh session derives the full base mode', channel.mode.id === 'full' && channel.modeIndex === 0, `${channel.mode.id}/${channel.modeIndex}`)

  await channel.cycleMode()
  check('cycle lands on plan', channel.mode.id === 'plan' && channel.modeIndex === 1, `${channel.mode.id}/${channel.modeIndex}`)
  const loggedBeforeApprove = events.length

  // Upstream dsh-plan-mode appends plan/mode:false after the user approves.
  agent.session.append('plan/mode', { active: false })
  await settleMicrotasks()

  check(
    'approve restores the full base sandbox',
    fold(events, 'sandbox/mode', 'mode') === 'danger-full-access',
    JSON.stringify(appended.filter(e => e.type === 'sandbox/mode')),
  )
  check(
    'approve restores the full base approval policy',
    fold(events, 'approval/policy', 'policy') === 'never',
    JSON.stringify(appended.filter(e => e.type === 'approval/policy')),
  )
  check(
    'mode indicator agrees with the restored atoms',
    channel.mode.id === 'full' && channel.modeIndex === 0,
    `${channel.mode.id}/${channel.modeIndex}`,
  )
  check(
    'restore waited for the publication to unwind (no reentrant append)',
    reentrancy() === 0 && events.length > loggedBeforeApprove,
    `reentrant=${reentrancy()}`,
  )
  check(
    'restore announced the switch',
    channel.notifications.filter(n => n.text.includes('→')).length === 2,
    JSON.stringify(channel.notifications.map(n => n.text)),
  )
}

// ---- /plan off typed by the user restores the pre-plan mode ---------------
{
  const { ctx, agent, events, services } = makeEnv()
  const channel = createChannel(ctx, agent, { ...baseOptions, modes: FULL_PLAN_MODES })
  await channel.cycleMode()
  check('entered plan via the cycle', channel.mode.id === 'plan', channel.mode.id)

  // Manual /plan off bypasses applyMode.
  await services.commands.execute(agent, '/plan off')
  await settleMicrotasks()

  check(
    '/plan off restores the full base sandbox',
    fold(events, 'sandbox/mode', 'mode') === 'danger-full-access',
    JSON.stringify(events.filter(e => e.type === 'sandbox/mode')),
  )
  check(
    '/plan off restores the full base approval',
    fold(events, 'approval/policy', 'policy') === 'never',
    JSON.stringify(events.filter(e => e.type === 'approval/policy')),
  )
  check('mode indicator back on full', channel.mode.id === 'full' && channel.modeIndex === 0, `${channel.mode.id}/${channel.modeIndex}`)
}

// ---- Shift+Tab away from plan: no spurious intermediate restore ----------
{
  const { ctx, agent, commands, appended } = makeEnv()
  const channel = createChannel(ctx, agent, baseOptions)
  await channel.cycleMode()
  await channel.cycleMode()
  check('two cycles land on full', channel.mode.id === 'full' && channel.modeIndex === 2, `${channel.mode.id}/${channel.modeIndex}`)
  check(
    'cycling away dispatched exactly /plan then /plan off',
    commands.length === 2 && commands[0] === '/plan' && commands[1] === '/plan off',
    JSON.stringify(commands),
  )
  check(
    'sandbox sequence seeds default then plan then full (no restore flash)',
    appended.filter(e => e.type === 'sandbox/mode').map(e => e.data.mode).join(',') === 'workspace-write,read-only,danger-full-access',
    JSON.stringify(appended.filter(e => e.type === 'sandbox/mode')),
  )
  check(
    'exactly two switch notifications (no restore echo)',
    channel.notifications.filter(n => n.text.includes('→')).length === 2,
    JSON.stringify(channel.notifications.map(n => n.text)),
  )
}

// ---- built-in default cycle: approve restores modes[0] atoms --------------
{
  const { ctx, agent, appended } = makeEnv()
  const channel = createChannel(ctx, agent, baseOptions)
  await channel.cycleMode()
  check('entered built-in plan', channel.mode.id === 'plan', channel.mode.id)

  agent.session.append('plan/mode', { active: false })
  await settleMicrotasks()

  check(
    'approve appends the base workspace-write sandbox explicitly',
    appended.filter(e => e.type === 'sandbox/mode').map(e => e.data.mode).join(',') === 'workspace-write,read-only,workspace-write',
    JSON.stringify(appended.filter(e => e.type === 'sandbox/mode')),
  )
  check(
    'approval fold still reads ask (already in force, not re-applied)',
    appended.filter(e => e.type === 'approval/policy').map(e => e.data.policy).join(',') === 'ask',
    JSON.stringify(appended.filter(e => e.type === 'approval/policy')),
  )
  check('mode indicator back on default', channel.mode.id === 'default' && channel.modeIndex === 0, `${channel.mode.id}/${channel.modeIndex}`)
}

// ---- no-op approval service: the explicit event backstop still lands -----
{
  const { ctx, agent, events } = makeEnv({ noopApproval: true })
  const channel = createChannel(ctx, agent, {
    ...baseOptions,
    modes: [
      { id: 'quiet', sandbox: 'workspace-write', approval: 'ask' },
      { id: 'plan', plan: true, sandbox: 'read-only' },
    ],
  })
  await channel.cycleMode()
  check('entered plan (approval untouched)', channel.mode.id === 'plan', channel.mode.id)

  agent.session.append('plan/mode', { active: false })
  await settleMicrotasks()

  check(
    'setPolicy no-op still lands the explicit approval/policy event',
    fold(events, 'approval/policy', 'policy') === 'ask',
    JSON.stringify(events.filter(e => e.type === 'approval/policy')),
  )
  check(
    'sandbox restored to the quiet base mode',
    fold(events, 'sandbox/mode', 'mode') === 'workspace-write',
    JSON.stringify(events.filter(e => e.type === 'sandbox/mode')),
  )
  check('mode indicator back on quiet', channel.mode.id === 'quiet' && channel.modeIndex === 0, `${channel.mode.id}/${channel.modeIndex}`)
}

// ---- orphan plan/mode:false (no stint) restores nothing -------------------
{
  const { ctx, agent, appended } = makeEnv()
  const channel = createChannel(ctx, agent, baseOptions)
  agent.session.append('plan/mode', { active: false })
  await settleMicrotasks()
  check(
    'orphan false appends nothing beyond itself',
    appended.length === 1 && appended[0].type === 'plan/mode',
    JSON.stringify(appended),
  )
  check('mode stays default', channel.mode.id === 'default' && channel.modeIndex === 0, `${channel.mode.id}/${channel.modeIndex}`)
}

// Deferred /plan writes at pre-step, after the mode command has returned.
const FULL_PLAN_SAFE_MODES = [
  { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' },
  { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
  { id: 'safe', plan: false, sandbox: 'workspace-write', approval: 'ask' },
]
{
  const env = makeEnv({ deferredPlan: true })
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: FULL_PLAN_SAFE_MODES })
  await channel.cycleMode()
  env.commitPlan()
  await channel.cycleMode()
  env.commitPlan()
  await settleMicrotasks()
  check('deferred Shift+Tab exit keeps safe sandbox', fold(env.events, 'sandbox/mode', 'mode') === 'workspace-write')
  check('deferred Shift+Tab exit keeps approval enabled', fold(env.events, 'approval/policy', 'policy') === 'ask')
  check('deferred exit keeps safe indicator', channel.mode.id === 'safe', channel.mode.id)
}

// Cold channels recover from durable history before the deferred entry.
for (const resume of [false, true]) {
  const env = makeEnv({ deferredPlan: true })
  // Derive a non-base mode so an index-0 fallback cannot pass this test.
  env.agent.session.append('sandbox/mode', { mode: 'workspace-write' })
  env.agent.session.append('approval/policy', { policy: 'ask' })
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: [
    FULL_PLAN_SAFE_MODES[0], FULL_PLAN_SAFE_MODES[2], FULL_PLAN_SAFE_MODES[1],
  ] })
  await channel.cycleMode()
  env.commitPlan()
  const restored = resume ? makeEnv({ history: env.events }) : env
  if (resume) createChannel(restored.ctx, restored.agent, { ...baseOptions, modes: FULL_PLAN_SAFE_MODES })
  restored.agent.session.append('plan/mode', { active: false })
  await settleMicrotasks()
  check(`deferred entry restores pre-plan sandbox (resume=${resume})`, fold(restored.events, 'sandbox/mode', 'mode') === 'workspace-write')
  check(`deferred entry restores pre-plan approval (resume=${resume})`, fold(restored.events, 'approval/policy', 'policy') === 'ask')
}

// Manual /plan leaves an unmatched actual permission combination intact.
{
  const env = makeEnv()
  createChannel(env.ctx, env.agent, { ...baseOptions, modes: FULL_PLAN_MODES })
  env.agent.session.append('sandbox/mode', { mode: 'workspace-write' })
  env.agent.session.append('approval/policy', { policy: 'ask' })
  await env.services.commands.execute(env.agent, '/plan')
  await env.services.commands.execute(env.agent, '/plan off')
  await settleMicrotasks()
  check('unmatched mode never falls back to full access', fold(env.events, 'sandbox/mode', 'mode') === 'workspace-write')
  check('unmatched mode keeps approval', fold(env.events, 'approval/policy', 'policy') === 'ask')
}

// Partial specs do not erase the actual atoms that were active before plan.
{
  const env = makeEnv()
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: [
    { id: 'default', plan: false }, FULL_PLAN_MODES[1],
  ] })
  env.agent.session.append('sandbox/mode', { mode: 'workspace-write' })
  env.agent.session.append('approval/policy', { policy: 'never' })
  await channel.cycleMode()
  env.agent.session.append('plan/mode', { active: false })
  await settleMicrotasks()
  check('partial base restores actual sandbox', fold(env.events, 'sandbox/mode', 'mode') === 'workspace-write')
  check('partial base restores actual approval', fold(env.events, 'approval/policy', 'policy') === 'never')
  const count = env.events.length
  env.agent.session.append('plan/mode', { active: false })
  await settleMicrotasks()
  check('repeated exit does not restore an old stint', env.events.length === count + 1)
}

// Deployment defaults outrank the indicator's base fallback and survive resume.
{
  const env = makeEnv()
  env.services.sandboxPolicy = { defaultMode: 'workspace-write' }
  env.services.approval.effectivePolicy = () => 'ask'
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: FULL_PLAN_MODES })
  await channel.cycleMode()
  const resumed = makeEnv({ history: env.events })
  createChannel(resumed.ctx, resumed.agent, { ...baseOptions, modes: FULL_PLAN_MODES })
  resumed.agent.session.append('plan/mode', { active: false })
  await settleMicrotasks()
  check('resume restores recorded deployment sandbox', fold(resumed.events, 'sandbox/mode', 'mode') === 'workspace-write')
  check('resume restores recorded deployment approval', fold(resumed.events, 'approval/policy', 'policy') === 'ask')
}

// A same-tick explicit switch cancels an already queued automatic restore.
{
  const env = makeEnv()
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: FULL_PLAN_SAFE_MODES })
  await channel.cycleMode()
  env.agent.session.append('plan/mode', { active: false })
  await channel.cycleMode()
  await settleMicrotasks()
  check('reentry wins over queued restoration', fold(env.events, 'sandbox/mode', 'mode') === 'read-only')
  check('reentry leaves approval enabled', fold(env.events, 'approval/policy', 'policy') === 'ask')
}

// Immediate and deferred exits both retain the explicit target on later stints.
{
  const env = makeEnv({ deferredPlan: true })
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: FULL_PLAN_SAFE_MODES })
  await channel.cycleMode()
  env.commitPlan()
  await channel.cycleMode()
  env.commitPlan()
  await settleMicrotasks()
  await channel.cycleMode()
  await channel.cycleMode()
  env.commitPlan()
  await env.services.commands.execute(env.agent, '/plan off')
  env.commitPlan()
  await settleMicrotasks()
  check('consumed explicit exit does not suppress later manual exit', fold(env.events, 'sandbox/mode', 'mode') === 'danger-full-access')
}

// Old logs without known pre-plan permissions cannot authorize full access.
{
  const env = makeEnv({ history: [{ type: 'plan/mode', data: { active: true }, seq: 1 }] })
  createChannel(env.ctx, env.agent, { ...baseOptions, modes: FULL_PLAN_MODES })
  env.agent.session.append('plan/mode', { active: false })
  await settleMicrotasks()
  check('unknown historical permissions append no overrides', env.appended.length === 1)
}

// An abandoned deferred exit must not orphan the explicit-exit marker: a later
// mode action reconciles it, so the session recovers its pre-plan permissions
// instead of staying stuck in the plan sandbox.
{
  const env = makeEnv({ deferredPlan: true })
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: FULL_PLAN_SAFE_MODES })
  await channel.cycleMode()            // enter plan (deferred)
  env.commitPlan()                     // plan/mode:true lands; pre-plan = full
  await channel.cycleMode()            // deferred explicit exit: marker set + kept
  env.abortPlan()                      // pre-step aborted: plan/mode:false never lands
  await channel.cycleMode()            // later mode action reconciles the orphan
  env.agent.session.append('plan/mode', { active: false })
  await settleMicrotasks()
  check(
    'abandoned deferred exit does not strand the plan sandbox',
    fold(env.events, 'sandbox/mode', 'mode') === 'danger-full-access',
    fold(env.events, 'sandbox/mode', 'mode'),
  )
  check('reconciled session leaves the plan indicator', channel.mode.id !== 'plan', channel.mode.id)
}

process.exit(failed)
