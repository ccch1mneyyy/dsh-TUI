/**
 * Permission-mode behavior regression — runs against the compiled channel
 * (imports ../lib/types/…), the same surface the TUI loads.
 *
 * Run after pnpm build: node scripts/verify-permission-modes.mjs
 *
 * Covers:
 *   1. snapshot freeze + receiver-safe registry + legacy/unavailable states
 *   2. runtime presets appended to the Shift+Tab cycle in stable order with
 *      canonical exclusions; switches use the official command
 *   3. async confirmation within the grace window
 *   4. unconfirmed switches fail closed and the cycle stays usable
 *   5. fresh sessions without a durable identity never ghost-select a
 *      permission-only dynamic mode
 *   6. plan round-trip keeps identity consistent with restored atoms AND
 *      returns to the user's own pre-plan preset when the registry still
 *      offers it (identity memory)
 *   7. unsafe configured identities are dropped with a warning
 *   8. a TUI /permission entry is surfaced when the service snapshot is
 *      usable (and only then)
 *   9. without the external /permission command, typed switches and cycle
 *      canonicalization go through the service write path (service.set)
 * 10. table-driven canonical resolution on renamed preset tables
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-permission-modes-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }))

const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const settleMicrotasks = async () => {
  await new Promise(resolve => queueMicrotask(resolve))
  await Promise.resolve()
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function fold(events, type, key) {
  let value
  for (const event of events) {
    if (event.type === type && typeof event.data?.[key] === 'string') value = event.data[key]
  }
  return value
}

function logOf(subject) {
  if (Array.isArray(subject)) return subject
  return subject?.events ?? []
}

/** Real registries derive current(session) from the session log; the fake
 *  mirrors that contract plus the official write path (`set`) and optional
 *  atom resolution (`resolve`) for table-driven canonical matching. */
function makeEnv({ modes, names, bundles, history = [], permission = {}, withCommand = true, noService = false } = {}) {
  const commands = []
  const appended = []
  const warnings = []
  const handlers = new Map()
  const events = [...history]
  let pendingPlan
  let publishing = false
  let reentrantAppends = 0
  const behavior = { delay: permission.delay ?? 0, confirm: permission.confirm ?? true }
  const defaultBundles = {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    auto: { sandbox: 'workspace-write', approval: 'ask' },
    safe: { sandbox: 'workspace-write', approval: 'ask' },
    ro: { sandbox: 'read-only', approval: 'ask' },
    ws: { sandbox: 'workspace-write', approval: 'ask' },
    full: { sandbox: 'danger-full-access', approval: 'never' },
  }
  const applyPreset = (session, preset) => {
    if (!behavior.confirm) return false
    if (!registry.entries.has(preset)) return false
    session.append('permission/preset', { preset })
    const spec = defaultBundles[preset]
    if (spec?.sandbox) session.append('sandbox/mode', { mode: spec.sandbox })
    if (spec?.approval) session.append('approval/policy', { policy: spec.approval })
    return true
  }
  class PermissionRegistry {
    names = names ?? ['read-only', 'workspace-write', 'auto', 'safe']
    entries = new Map([
      ['read-only', { value: 'read-only', name: 'Read only', description: 'No writes' }],
      ['workspace-write', { value: 'workspace-write', name: 'Workspace write', description: 'Write in the workspace' }],
      ['auto', { value: 'auto', name: 'Auto', description: 'Choose automatically' }],
      ['safe', { value: 'safe', name: 'Safe', description: 'Curated policy' }],
      ['ro', { value: 'ro', name: 'Read only' }],
      ['ws', { value: 'ws', name: 'Workspace write' }],
      ['full', { value: 'full', name: 'Full access' }],
    ])
    current(subject) {
      if (this !== registry) throw new Error('registry receiver lost')
      let value = 'auto'
      for (const event of logOf(subject)) {
        if (event.type === 'permission/preset' && typeof event.data?.preset === 'string') value = event.data.preset
      }
      return value
    }
    optionOf(name) {
      if (this !== registry) throw new Error('registry receiver lost')
      return this.entries.get(name)
    }
    resolve(name) {
      if (this !== registry) throw new Error('registry receiver lost')
      if (bundles === undefined) return { ...defaultBundles[name] }
      const spec = bundles[name]
      if (spec === undefined) throw new Error(`permission: unknown preset "${name}"`)
      return { ...spec, name: this.entries.get(name)?.name }
    }
    set(session, name) {
      if (behavior.delay > 0) {
        void (async () => {
          await sleep(behavior.delay)
          applyPreset(session, name)
        })()
        return
      }
      if (!this.entries.has(name)) throw new Error(`permission: unknown preset "${name}"`)
      applyPreset(session, name)
    }
  }
  const registry = new PermissionRegistry()
  const services = {
    planMode: { get: () => ({ pending: pendingPlan }) },
    commands: {
      list: () => [],
      find: (_agent, name) => {
        if (name === 'plan') return { name: 'plan', description: 'Toggle plan mode', handler() {} }
        if (withCommand && name === 'permission') return { name: 'permission', description: 'Set permission preset', handler() {} }
        return undefined
      },
      execute: async (agent, line, _signal) => {
        commands.push(line)
        if (line.startsWith('/plan')) {
          const active = !line.startsWith('/plan off')
          const commandId = `command-${commands.length}`
          agent.session.append('command/run', { commandId, name: 'plan', args: active ? '' : 'off' })
          agent.session.append('plan/mode', { active })
          agent.session.append('command/done', { commandId, kind: 'success' })
          return { result: { text: 'ok' } }
        }
        if (withCommand && line.startsWith('/permission ')) {
          const preset = line.slice('/permission '.length).trim()
          if (behavior.delay > 0) await sleep(behavior.delay)
          if (!behavior.confirm) return { result: { text: 'ok (but no event lands)' } }
          if (!registry.entries.has(preset)) return undefined
          const commandId = `command-${commands.length}`
          agent.session.append('command/run', { commandId, name: 'permission', args: preset })
          applyPreset(agent.session, preset)
          agent.session.append('command/done', { commandId, kind: 'success' })
          return { result: { text: 'ok' } }
        }
        return undefined
      },
    },
    approval: {
      setPolicy(agent, policy) {
        agent.session.append('approval/policy', { policy })
      },
    },
    sandboxPolicy: { defaultMode: 'workspace-write' },
  }
  if (!noService) services.permissionPresets = registry
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get(name) {
      return services[name]
    },
    logger: { warn(message) { warnings.push(String(message)) } },
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
  return { ctx, agent, registry, behavior, modes, commands, warnings, appended, events, reentrancy: () => reentrantAppends }
}

const baseOptions = { model: 'deepseek-chat', cwd: '/tmp', provider: 'deepseek', activity: false }

const AUTO_ONLY_NAMES = ['read-only', 'workspace-write', 'auto']
const AUTO_SEED = [
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'approval/policy', data: { policy: 'ask' } },
  { type: 'permission/preset', data: { preset: 'auto' } },
]

// ---- 1. snapshot semantics ------------------------------------------------
{
  const env = makeEnv()
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  const snapshot = channel.permissionPresets()
  check('runtime registry readable with receiver intact', snapshot.availability === 'runtime')
  check('options follow registry order', snapshot.options.map(o => o.value).join(',') === 'read-only,workspace-write,auto,safe')
  check('current identity resolved', snapshot.current?.value === 'auto' && snapshot.current.kind === 'preset')
  check('snapshot frozen', Object.isFrozen(snapshot) && Object.isFrozen(snapshot.options) && Object.isFrozen(snapshot.current))
  const first = channel.permissionPresets()
  env.events.push({ type: 'permission/preset', data: { preset: 'safe' } })
  check('earlier snapshot stays stable', first.current?.value === 'auto')
  check('next read observes the new state', channel.permissionPresets().current?.value === 'safe')
}
{
  const env = makeEnv({ noService: true })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  const snapshot = channel.permissionPresets()
  check('missing service keeps the legacy roster', snapshot.availability === 'legacy')
  check('legacy roster = the three canonical presets', snapshot.options.map(o => o.value).join(',') === 'read-only,workspace-write,danger-full-access')
}

// ---- 2. dynamic presets join the Shift+Tab cycle via /permission ----------
{
  const env = makeEnv({ history: AUTO_SEED })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  check('dynamic preset derived as current mode', channel.mode.id === 'permission:auto', channel.mode.id)

  await channel.cycleMode() // auto → safe
  check('cycle reaches the next dynamic preset', channel.mode.id === 'permission:safe', channel.mode.id)
  check('dynamic switch used the official command', env.commands.join(',') === '/permission safe', JSON.stringify(env.commands))

  await channel.cycleMode() // safe → default (wrap): static canonicalize first
  check('static default reached after wrap', channel.mode.id === 'default', channel.mode.id)
  check('third-party identity canonicalized via official command', env.commands.includes('/permission workspace-write'), JSON.stringify(env.commands))
  check('durable identity now matches the default atoms', fold(env.events, 'permission/preset', 'preset') === 'workspace-write')

  await channel.cycleMode() // default → plan
  check('plan reached through the cycle', channel.mode.id === 'plan', channel.mode.id)
  check('plan entry canonicalized identity to read-only', env.commands.includes('/permission read-only'), JSON.stringify(env.commands))
}

// ---- 3. async confirmation inside the grace window ------------------------
{
  const env = makeEnv({ history: AUTO_SEED, permission: { delay: 250 } })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  const started = Date.now()
  await channel.cycleMode()
  const elapsed = Date.now() - started
  check('async-confirmed dynamic switch succeeds', channel.mode.id === 'permission:safe', channel.mode.id)
  check('confirmation waited for the async event', elapsed >= 200 && elapsed < 1900, `${elapsed}ms`)
}

// ---- 4. unconfirmed switch fails closed, cycle stays usable ----------------
{
  const env = makeEnv({ history: AUTO_SEED, permission: { confirm: false } })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  const before = env.events.length
  await channel.cycleMode()
  check('unconfirmed switch leaves the mode unchanged', channel.mode.id === 'permission:auto', channel.mode.id)
  check('unconfirmed switch appends no mode events', env.events.length === before, `${env.events.length - before} appended`)
  check('failure is logged', env.warnings.some(w => w.includes('not confirmed')))
  env.behavior.confirm = true
  await channel.cycleMode()
  check('cycle recovers after a failed switch', channel.mode.id === 'permission:safe', channel.mode.id)
}

// ---- 5. fresh session never ghost-selects a dynamic mode ------------------
{
  const env = makeEnv()
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  check('empty session derives the static default', channel.mode.id === 'default' && channel.mode.permission === undefined, channel.mode.id)
}

// ---- 6. plan round-trip: consistent atoms AND pre-plan identity memory ----
{
  const env = makeEnv({
    history: AUTO_SEED,
    names: AUTO_ONLY_NAMES,
    modes: [
      { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
      { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    ],
  })
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: env.modes })
  check('dynamic identity visible before plan', channel.mode.permission === 'auto', channel.mode.id)
  await channel.cycleMode() // auto → plan
  check('plan entered through the official path', channel.mode.id === 'plan', channel.mode.id)
  check('plan entry canonicalized to read-only', env.commands.includes('/permission read-only'), JSON.stringify(env.commands))

  env.agent.session.append('plan/mode', { active: false }) // approval exits plan
  await settleMicrotasks()
  await settleMicrotasks()
  await settleMicrotasks()

  check('plan exit restores the original sandbox', fold(env.events, 'sandbox/mode', 'mode') === 'workspace-write')
  check('plan exit restores the original approval', fold(env.events, 'approval/policy', 'policy') === 'ask')
  check('plan exit returns to the remembered pre-plan preset', fold(env.events, 'permission/preset', 'preset') === 'auto', fold(env.events, 'permission/preset', 'preset'))
  check('identity restore used the service write path', env.commands.includes('/permission auto'), JSON.stringify(env.commands))
  check('mode indicator shows the remembered preset again', channel.mode.id === 'permission:auto', channel.mode.id)
  check('no reentrant appends during the restore', env.reentrancy() === 0)
}

// ---- 7. unsafe configured identities are dropped without starving cycle ----
{
  const env = makeEnv({
    history: [{ type: 'permission/preset', data: { preset: 'read-only' } }],
    modes: [
      { id: 'read', permission: 'read-only' },
      { id: 'invalid', permission: 'auto extra' },
      { id: 'auto', permission: 'auto' },
    ],
  })
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: env.modes })
  check('unsafe configured identity warns at load', env.warnings.some(w => w.includes('unsafe permission identity')))
  await channel.cycleMode()
  check('cycle skips the unsafe mode and reaches the next valid one', channel.mode.id === 'auto', channel.mode.id)
  check('switch used the official command only for the valid target', env.commands.join(',') === '/permission auto', JSON.stringify(env.commands))
}
{
  const env = makeEnv({
    noService: true,
    history: [{ type: 'permission/preset', data: { preset: 'auto' } }],
    modes: [{ id: 'invalid', permission: 'auto extra' }],
  })
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: env.modes })
  check('all-invalid configured roster falls back to defaults', channel.mode.id === 'default', channel.mode.id)
  check('all-invalid roster warns', env.warnings.some(w => w.includes('unsafe permission identity')))
}

// ---- 8. local /permission entry surfacing ---------------------------------
{
  const env = makeEnv({ noService: true })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  check('no service → no TUI /permission entry', !channel.commandList.some(c => c.name === 'permission'))
}
{
  const env = makeEnv()
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  check('usable service → TUI surfaces a /permission entry', channel.commandList.some(c => c.name === 'permission' && !c.external))
}

// ---- 9. no external command: service write fallback ------------------------
{
  const env = makeEnv({ history: AUTO_SEED, withCommand: false })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  check('entry still surfaced without the external command', channel.commandList.some(c => c.name === 'permission'))
  const ok = await channel.runPermissionPreset('safe')
  check('typed switch resolves through the service write path', ok === true && channel.mode.id === 'permission:safe', `${ok} / ${channel.mode.id}`)
  check('no external command was attempted', env.commands.length === 0, JSON.stringify(env.commands))
  check('durable identity folded from the service-written event', fold(env.events, 'permission/preset', 'preset') === 'safe')
}
{
  const env = makeEnv({
    history: AUTO_SEED,
    names: AUTO_ONLY_NAMES,
    withCommand: false,
    modes: [
      { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
      { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    ],
  })
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: env.modes })
  await channel.cycleMode() // auto → plan: canonicalization must use service.set
  check('cycle canonicalization works without the external command', channel.mode.id === 'plan', channel.mode.id)
  check('identity moved to read-only through the service', fold(env.events, 'permission/preset', 'preset') === 'read-only')
}

// ---- 10. table-driven canonical on a renamed preset table ------------------
{
  const renamed = { ro: { sandbox: 'read-only', approval: 'ask' }, ws: { sandbox: 'workspace-write', approval: 'ask' }, full: { sandbox: 'danger-full-access', approval: 'never' } }
  const env = makeEnv({
    names: ['ro', 'ws', 'full', 'auto'],
    bundles: renamed,
    history: AUTO_SEED,
    modes: [
      { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
      { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    ],
  })
  const channel = createChannel(env.ctx, env.agent, { ...baseOptions, modes: env.modes })
  // auto (declared bundle workspace-write+ask) → plan needs the renamed
  // canonical 'ro' for the read-only bundle.
  await channel.cycleMode()
  check('renamed table canonicalization reaches plan', channel.mode.id === 'plan', channel.mode.id)
  check('canonical switch targeted the renamed preset', env.commands.includes('/permission ro'), JSON.stringify(env.commands))
}

if (failed > 0) {
  console.error(`permission-modes verification failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('permission-modes verification passed')
}
