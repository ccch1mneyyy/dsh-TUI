/**
 * Channel-level verification of the /effort API and the configurable
 * Shift+Tab session-mode cycle: creates a real Channel via createChannel
 * against a minimal fake ctx/agent (llm/commands/approval service stubs),
 * then asserts
 *   - listEfforts/setEffort against the stubbed adapter level list
 *     (the script redirects HOME to a throwaway directory before loading the
 *     compiled channel, so the real preference file is untouched);
 *   - cycleMode over the built-in default→plan→full cycle: /plan registry
 *     command dispatched, sandbox/mode + approval/policy session events
 *     appended (or setPolicy called), state.mode following each step;
 *   - a custom two-mode `modes` config cycles only those modes and skips the
 *     plan atom entirely; an atom-less entry list falls back to the defaults;
 *   - a leaf without the commands registry (no /plan) aborts the switch
 *     atomically — no sandbox/approval event lands.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-effort-mode.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-effort-mode-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }))

const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')

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
function makeEnv({ withCommands = true, withApproval = true } = {}) {
  const commands = []
  const approvalPolicies = []
  const appended = []
  const handlers = new Map()
  const events = []
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
    ...(withCommands
      ? {
          commands: {
            list: () => [],
            find: (_agent, name) => name === 'plan'
              ? { name: 'plan', description: 'Toggle plan mode', handler() {} }
              : undefined,
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
      ? { approval: { setPolicy: (agent, policy) => { approvalPolicies.push(policy); agent.session.append('approval/policy', { policy }) } } }
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
  return { ctx, agent, commands, approvalPolicies, appended, events }
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

process.exit(failed)
