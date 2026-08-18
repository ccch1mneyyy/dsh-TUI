/**
 * Channel-level verification of the /effort API and the configurable
 * Shift+Tab session-mode cycle: creates a real Channel via createChannel
 * against a minimal fake ctx/agent (llm/commands/approval service stubs),
 * then asserts
 *   - listEfforts/setEffort against the stubbed adapter level list
 *     (persistence lands in $HOME/.dsh-tui/effort.json — run under a throwaway
 *     HOME so the real preference file is untouched);
 *   - cycleMode over the built-in default→plan→full cycle: /plan registry
 *     command dispatched, sandbox/mode + approval/policy session events
 *     appended (or setPolicy called), state.mode following each step;
 *   - a custom two-mode `modes` config cycles only those modes and skips the
 *     plan atom entirely; an atom-less entry list falls back to the defaults;
 *   - a leaf without the commands registry (no /plan) aborts the switch
 *     atomically — no sandbox/approval event lands.
 *
 * Run with plain node against the compiled lib:
 *   HOME=$(mktemp -d) node scripts/verify-effort-mode.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/**
 * One recording environment: fresh command/approval/append logs, an llm stub
 * with efforts off/high/max (default high), a /plan-resolving registry stub,
 * and an agent whose session append both joins the log and replays through
 * the captured session/event handler (exactly what dsh-session + cordis do).
 */
function makeEnv({ withCommands = true, withApproval = true, withSandboxPolicy = true, withTools = true } = {}) {
  const commands = []
  const approvalPolicies = []
  const appended = []
  const handlers = new Map()
  const events = []
  const guards = []
  const llm = {
    resolveModelInfo: async () => ({
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off', description: 'No extra thinking' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    }),
  }
  const services = {
    llm,
    ...(withTools
      ? {
          tools: {
            guard(guard) {
              guards.push(guard)
              return () => {}
            },
          },
        }
      : {}),
    ...(withSandboxPolicy
      ? { sandboxPolicy: { defaultMode: 'workspace-write' } }
      : {}),
    ...(withCommands
      ? {
          commands: {
            list: () => [],
            find: (_agent, name) => (name === 'plan' ? { name: 'plan', handler() {} } : undefined),
            execute: async (agent, line, _signal) => {
              commands.push(line)
              if (line.startsWith('/plan')) {
                // Mirror dsh-plan-mode: the command toggles the durable
                // plan/mode event (enter unless the arg says off).
                agent.session.append('plan/mode', { active: !line.startsWith('/plan off') })
                return { result: { text: 'ok' } }
              }
              return undefined
            },
          },
        }
      : {}),
    ...(withApproval
      ? {
          approval: {
            config: { policy: 'ask' },
            setPolicy: (agent, policy) => { approvalPolicies.push(policy); agent.session.append('approval/policy', { policy }) },
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
        appended.push({ type, data })
        const event = { type, seq: events.length + 1, time: Date.now(), data }
        events.push(event)
        handlers.get('session/event')?.(agent.session, event)
      },
    },
    ctx: { on: () => () => {} },
  }
  return { ctx, agent, commands, approvalPolicies, appended, events, guards }
}

const baseOptions = {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
}

// ---- /effort API ---------------------------------------------------------
{
  const { ctx, agent } = makeEnv()
  const channel = createChannel(ctx, agent, baseOptions)

  const listed = await channel.listEfforts()
  check(
    'listEfforts returns adapter levels + default',
    listed.efforts.length === 3 && listed.efforts[0].id === 'off' && listed.defaultEffort === 'high',
    JSON.stringify(listed.efforts.map(e => e.id)),
  )

  const ok = await channel.setEffort('max')
  check('setEffort(max) → true', ok === true)
  check('state.reasoningEffort = max', channel.reasoningEffort === 'max', String(channel.reasoningEffort))
  const prefRaw = readFileSync(join(homedir(), '.dsh-tui', 'effort.json'), 'utf8')
  check('effort pref persisted', prefRaw.includes('max'), prefRaw)

  const before = channel.reasoningEffort
  const bad = await channel.setEffort('bogus')
  check('setEffort(bogus) → false', bad === false)
  check('reasoningEffort unchanged after invalid id', channel.reasoningEffort === before, `${before} → ${channel.reasoningEffort}`)
  check(
    'invalid-id notification fired',
    channel.notifications.some(n => n.text.includes('bogus')),
    JSON.stringify(channel.notifications.map(n => n.text)),
  )
}

// ---- default cycle: default → plan → full → default ----------------------
{
  const { ctx, agent, commands, approvalPolicies, appended } = makeEnv()
  const channel = createChannel(ctx, agent, baseOptions)
  check('fresh session derives base mode', channel.modeIndex === 0 && channel.mode.id === 'default', `${channel.modeIndex}/${channel.mode.id}`)

  await channel.cycleMode()
  check(
    'cycle 1 dispatches /plan (enter)',
    commands.length === 1 && commands[0] === '/plan',
    JSON.stringify(commands),
  )
  check(
    'cycle 1 appends sandbox read-only',
    appended.some(e => e.type === 'sandbox/mode' && e.data.mode === 'read-only'),
    JSON.stringify(appended.filter(e => e.type === 'sandbox/mode')),
  )
  check(
    'cycle 1 logs approval ask (fold undefined ≠ ask)',
    approvalPolicies.length === 1 && approvalPolicies[0] === 'ask',
    JSON.stringify(approvalPolicies),
  )
  check('cycle 1 lands on plan', channel.mode.id === 'plan' && channel.modeIndex === 1, `${channel.mode.id}/${channel.modeIndex}`)

  await channel.cycleMode()
  check(
    'cycle 2 dispatches /plan off',
    commands.length === 2 && commands[1] === '/plan off',
    JSON.stringify(commands),
  )
  check(
    'cycle 2 appends sandbox danger-full-access',
    appended.some(e => e.type === 'sandbox/mode' && e.data.mode === 'danger-full-access'),
  )
  check(
    'cycle 2 sets approval never',
    approvalPolicies.length === 2 && approvalPolicies[1] === 'never',
    JSON.stringify(approvalPolicies),
  )
  check('cycle 2 lands on full', channel.mode.id === 'full' && channel.modeIndex === 2, `${channel.mode.id}/${channel.modeIndex}`)

  await channel.cycleMode()
  check(
    'cycle 3 appends sandbox workspace-write',
    appended.some(e => e.type === 'sandbox/mode' && e.data.mode === 'workspace-write'),
  )
  check(
    'cycle 3 sets approval ask',
    approvalPolicies.length === 3 && approvalPolicies[2] === 'ask',
    JSON.stringify(approvalPolicies),
  )
  check('cycle 3 returns to default', channel.mode.id === 'default' && channel.modeIndex === 0, `${channel.mode.id}/${channel.modeIndex}`)
  check(
    'each switch notified',
    channel.notifications.filter(n => n.text.includes('→')).length === 3,
    JSON.stringify(channel.notifications.map(n => n.text)),
  )
}

// ---- custom two-mode cycle ------------------------------------------------
{
  const { ctx, agent, commands, appended } = makeEnv()
  const channel = createChannel(ctx, agent, {
    ...baseOptions,
    modes: [
      { id: 'rw', label: 'Read write', sandbox: 'workspace-write' },
      { id: 'ro', label: 'Read only', sandbox: 'read-only' },
    ],
  })
  await channel.cycleMode()
  check('custom cycle 1 → ro (index 1)', channel.mode.id === 'ro' && channel.modeIndex === 1, `${channel.mode.id}/${channel.modeIndex}`)
  await channel.cycleMode()
  check('custom cycle 2 → rw (index 0)', channel.mode.id === 'rw' && channel.modeIndex === 0, `${channel.mode.id}/${channel.modeIndex}`)
  check('custom cycle never dispatches /plan', commands.length === 0, JSON.stringify(commands))
  check(
    'custom cycle appended sandbox modes only',
    appended.every(e => e.type === 'sandbox/mode'),
    JSON.stringify(appended.map(e => e.type)),
  )
}

// ---- atom-less entries fall back to the defaults --------------------------
{
  const { ctx, agent, commands } = makeEnv()
  const channel = createChannel(ctx, agent, { ...baseOptions, modes: [{ id: 'noop' }] })
  check('atom-less config falls back to defaults', channel.mode.id === 'default', channel.mode.id)
  await channel.cycleMode()
  check(
    'fallback cycle still dispatches /plan',
    commands.length === 1 && commands[0] === '/plan',
    JSON.stringify(commands),
  )
  check('fallback cycle reaches plan', channel.mode.id === 'plan', channel.mode.id)
}

// ---- /plan unavailable aborts the whole switch ----------------------------
{
  const { ctx, agent, appended } = makeEnv({ withCommands: false })
  const channel = createChannel(ctx, agent, baseOptions)
  await channel.cycleMode()
  check(
    '/plan-less leaf appends nothing',
    appended.length === 0,
    JSON.stringify(appended),
  )
  check('mode unchanged after aborted switch', channel.mode.id === 'default', channel.mode.id)
  check(
    'abort warned',
    channel.notifications.some(n => n.text.includes('/plan')),
    JSON.stringify(channel.notifications.map(n => n.text)),
  )
}

// ---- bare /plan runs the same guard as Shift+Tab ---------------------------
{
  const { ctx, agent, approvalPolicies, appended } = makeEnv()
  const channel = createChannel(ctx, agent, baseOptions)
  // Simulate a non-default pre-plan state so the restore target is visible.
  agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
  agent.session.append('approval/policy', { policy: 'never' })
  await channel.runExternalCommand('plan', '')
  check(
    'bare /plan locks sandbox read-only',
    appended.some(e => e.type === 'sandbox/mode' && e.data.mode === 'read-only'),
    JSON.stringify(appended.filter(e => e.type === 'sandbox/mode')),
  )
  check(
    'bare /plan switches approval to ask',
    approvalPolicies.at(-1) === 'ask',
    JSON.stringify(approvalPolicies),
  )
  check('bare /plan lands mode indicator on plan', channel.mode.id === 'plan' && channel.modeIndex === 1, `${channel.mode.id}/${channel.modeIndex}`)
  check(
    'bare /plan posts the plan-lock notification',
    channel.notifications.some(n => n.text.includes('计划') || n.text.includes('Plan mode locked')),
    JSON.stringify(channel.notifications.map(n => n.text)),
  )

  await channel.runExternalCommand('plan', ' off')
  check(
    'bare /plan off restores pre-plan sandbox',
    appended.at(-2)?.type === 'sandbox/mode' && appended.at(-2)?.data.mode === 'danger-full-access',
    JSON.stringify(appended.filter(e => e.type === 'sandbox/mode')),
  )
  check(
    'bare /plan off restores pre-plan approval',
    approvalPolicies.at(-1) === 'never',
    JSON.stringify(approvalPolicies),
  )
  check('bare /plan off restores the pre-plan mode indicator', channel.mode.id === 'full' && channel.modeIndex === 2, `${channel.mode.id}/${channel.modeIndex}`)
}

// ---- plan-mode tool gate: mutations fail closed until approval -------------
{
  const { ctx, agent, guards } = makeEnv()
  const channel = createChannel(ctx, agent, baseOptions)
  check('tool guard registered', guards.length === 1, String(guards.length))
  const guard = guards[0]
  check('tool guard idle before plan mode', guard({ name: 'write', agent }) === undefined, String(guard({ name: 'write', agent })))
  await channel.runExternalCommand('plan', '')
  check(
    'tool guard blocks write in plan mode',
    typeof guard({ name: 'write', agent }) === 'string',
    String(guard({ name: 'write', agent })),
  )
  check(
    'tool guard blocks bash in plan mode',
    typeof guard({ name: 'bash', agent }) === 'string',
    String(guard({ name: 'bash', agent })),
  )
  check(
    'tool guard blocks unknown/MCP tools in plan mode',
    typeof guard({ name: 'mcp__example_mutate', agent }) === 'string',
    String(guard({ name: 'mcp__example_mutate', agent })),
  )
  check('tool guard allows read in plan mode', guard({ name: 'read', agent }) === undefined, String(guard({ name: 'read', agent })))
  check('tool guard allows exit_plan_mode', guard({ name: 'exit_plan_mode', agent }) === undefined, String(guard({ name: 'exit_plan_mode', agent })))
  check('tool guard allows ask_user_question', guard({ name: 'ask_user_question', agent }) === undefined, String(guard({ name: 'ask_user_question', agent })))
  await channel.runExternalCommand('plan', ' off')
  check('tool guard released after plan exit', guard({ name: 'write', agent }) === undefined, String(guard({ name: 'write', agent })))
}

// ---- resumed plan-active session re-asserts the lock, then restores --------
{
  const { ctx, agent, appended, approvalPolicies } = makeEnv()
  // Simulate a persisted session that entered plan mode before this boot.
  agent.session.events.push(
    { type: 'plan/mode', seq: 1, time: Date.now(), data: { active: true } },
  )
  const channel = createChannel(ctx, agent, baseOptions)
  check('resumed plan session derives plan mode', channel.mode.id === 'plan' && channel.modeIndex === 1, `${channel.mode.id}/${channel.modeIndex}`)
  check(
    'resumed plan session re-asserts sandbox read-only',
    appended.some(e => e.type === 'sandbox/mode' && e.data.mode === 'read-only'),
    JSON.stringify(appended),
  )
  check(
    'resumed plan session re-asserts approval ask',
    approvalPolicies.at(-1) === 'ask',
    JSON.stringify(approvalPolicies),
  )

  agent.session.append('plan/mode', { active: false })
  check(
    'resumed plan exit restores the base atoms',
    appended.some(e => e.type === 'sandbox/mode' && e.data.mode === 'workspace-write'),
    JSON.stringify(appended.filter(e => e.type === 'sandbox/mode')),
  )
  check('resumed plan exit lands on default', channel.mode.id === 'default' && channel.modeIndex === 0, `${channel.mode.id}/${channel.modeIndex}`)
}

// ---- custom plan mode honours only its declared enforcement atoms ----------
{
  const { ctx, agent, appended, approvalPolicies } = makeEnv()
  const channel = createChannel(ctx, agent, {
    ...baseOptions,
    modes: [
      { id: 'base', sandbox: 'workspace-write', approval: 'never' },
      { id: 'plan-soft-ro', plan: true, sandbox: 'read-only' },
    ],
  })
  await channel.runExternalCommand('plan', '')
  check(
    'custom plan mode applies its declared sandbox',
    appended.some(e => e.type === 'sandbox/mode' && e.data.mode === 'read-only'),
    JSON.stringify(appended),
  )
  check(
    'custom plan mode leaves undeclared approval untouched',
    approvalPolicies.length === 0,
    JSON.stringify(approvalPolicies),
  )
  check('custom plan mode derives its configured mode', channel.mode.id === 'plan-soft-ro' && channel.modeIndex === 1, `${channel.mode.id}/${channel.modeIndex}`)
}

// ---- Shift+Tab path keeps the single mode-switched notification ------------
{
  const { ctx, agent, commands } = makeEnv()
  const channel = createChannel(ctx, agent, baseOptions)
  await channel.cycleMode()
  check('Shift+Tab into plan dispatches /plan', commands.length === 1 && commands[0] === '/plan', JSON.stringify(commands))
  check(
    'Shift+Tab into plan does not double-notify the plan lock',
    channel.notifications.filter(n => n.text.includes('→')).length === 1,
    JSON.stringify(channel.notifications.map(n => n.text)),
  )
}

process.exit(failed)
