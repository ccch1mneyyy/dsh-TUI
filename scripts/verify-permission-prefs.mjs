/**
 * Focused regression for the two upstream-facing behaviors added alongside
 * verify-permission-modes.mjs:
 *
 *   A. permissionPrefs.ts — the ~/.dsh-tui/permission.json round trip and
 *      its validation (safe command tokens only, junk reads as absent).
 *   B. channel/upstream-retry.ts — pure helpers (route selection, ops
 *      shape, policy freshness) and the ensureUpstreamRetry settings flow
 *      over a fake settings service (skip when absent/ns missing, one
 *      SETTINGS_CONFLICT retry, notify on success, quiet on refusal).
 *   C. the channel-level wiring — durable permission/preset events teach
 *      the preference (including ones the official /permission command
 *      appended on its own), in-plan switches do not, a fresh session is
 *      seeded with the remembered preset through the service write path,
 *      a session whose only plane events ARE the composition's own creation
 *      pin (dsh-permission-presets `session/created` → pinInitialPermission)
 *      still seeds, a session that ran a turn or switched to another
 *      identity does not, and the DSH_PERMISSION_MODE launch pin outranks
 *      the file.
 *
 * Runs against the compiled channel (imports ../lib/types/…). Run after
 * pnpm build: node scripts/verify-permission-prefs.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-permission-prefs-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }))

const { readPermissionPref, writePermissionPref } = await import('../lib/types/permissionPrefs.js')
const {
  ensureUpstreamRetry,
  routesWithoutRetryPolicy,
  upstreamRetryOps,
  upstreamRetryPolicy,
  UPSTREAM_RETRY_MAX_RETRIES,
  UPSTREAM_RETRYABLE_CODES,
} = await import('../lib/types/dsh-adapter/channel/upstream-retry.js')
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 90))
}

const prefFile = () => join(isolatedHome, '.dsh-tui', 'permission.json')
const clearPref = () => { try { unlinkSync(prefFile()) } catch { /* absent */ } }

// ---- A. permissionPrefs round trip and validation -------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-prefs-unit-'))
  try {
    check('absent pref reads undefined', readPermissionPref(dir) === undefined)
    check('write reports success', writePermissionPref('danger-full-access', dir) === true)
    check('round trip keeps the identity', readPermissionPref(dir) === 'danger-full-access')
    const raw = JSON.parse(readFileSync(join(dir, 'permission.json'), 'utf8'))
    check('file shape is { permission }', raw.permission === 'danger-full-access')
    writeFileSync(join(dir, 'permission.json'), '{not json', 'utf8')
    check('corrupt file reads undefined', readPermissionPref(dir) === undefined)
    writeFileSync(join(dir, 'permission.json'), JSON.stringify({ permission: 'not safe' }), 'utf8')
    check('unsafe token reads undefined', readPermissionPref(dir) === undefined)
    writeFileSync(join(dir, 'permission.json'), JSON.stringify({ permission: '  ' }), 'utf8')
    check('blank identity reads undefined', readPermissionPref(dir) === undefined)
    writeFileSync(join(dir, 'permission.json'), JSON.stringify(['danger-full-access']), 'utf8')
    check('non-object document reads undefined', readPermissionPref(dir) === undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- B. upstream-retry helpers and the settings ensure flow ---------------
{
  check('policy retries 5 times', upstreamRetryPolicy().maxRetries === UPSTREAM_RETRY_MAX_RETRIES && UPSTREAM_RETRY_MAX_RETRIES === 5)
  check('policy covers the stock codes plus STREAM_CLOSED',
    UPSTREAM_RETRYABLE_CODES.includes('STREAM_CLOSED') && UPSTREAM_RETRYABLE_CODES.includes('TRANSPORT') && UPSTREAM_RETRYABLE_CODES.includes('EMPTY_RESPONSE'))
  const first = upstreamRetryPolicy()
  const second = upstreamRetryPolicy()
  check('policy objects are fresh per call', first !== second && JSON.stringify(first) === JSON.stringify(second))
  const section = {
    providers: {
      zhipu: { baseURL: 'https://example', models: [] },
      deepseek: { baseURL: 'https://example', retryPolicy: { mode: 'always' } },
      broken: null,
      relay: 'scalar',
    },
  }
  check('routes without a retryPolicy are selected exactly', JSON.stringify(routesWithoutRetryPolicy(section)) === JSON.stringify(['zhipu', 'broken', 'relay']))
  check('non-object sections select nothing', routesWithoutRetryPolicy(undefined).length === 0 && routesWithoutRetryPolicy('nope').length === 0 && routesWithoutRetryPolicy({ providers: 7 }).length === 0)
  const ops = upstreamRetryOps(['zhipu', 'relay'])
  check('ops address the retryPolicy field', JSON.stringify(ops[0]?.path) === JSON.stringify(['providers', 'zhipu', 'retryPolicy']) && ops[0]?.op === 'set')
  check('ops carry the widened policy', ops[1]?.value?.retryableCodes?.includes('STREAM_CLOSED') === true && ops[1]?.value?.maxRetries === 5)
  check('wanted filtering keeps only requested routes', JSON.stringify(routesWithoutRetryPolicy(section, ['zhipu', 'deepseek'])) === JSON.stringify(['zhipu']))
  check('wanted filtering drops unknown routes', routesWithoutRetryPolicy(section, ['native-adapter-route']).length === 0)

  // A settings fake whose describe() reflects successful mutations, so
  // idempotency (a seeded route drops out) is observable.
  const makeSettings = (rows, behavior = {}) => {
    const live = rows.map(row => ({ ...row, value: structuredClone(row.value) }))
    const mutations = []
    const notifies = []
    const warnings = []
    const apply = (ns, opsToApply) => {
      const row = live.find(candidate => candidate.ns === ns)
      if (row === undefined) return
      for (const op of opsToApply) {
        let node = row.value
        for (const key of op.path.slice(0, -1)) {
          if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
          node = node[key]
        }
        node[op.path[op.path.length - 1]] = structuredClone(op.value)
      }
    }
    const settings = {
      describe: () => live,
      mutate: async (ns, opsToApply, revision) => {
        mutations.push({ ns, opsToApply, revision, attempt: mutations.length + 1 })
        if (behavior.conflictOnce && mutations.length === 1) { const error = new Error('stale'); error.code = 'SETTINGS_CONFLICT'; throw error }
        if (behavior.refuse) throw new Error('refused')
        apply(ns, opsToApply)
      },
    }
    const ctx = {
      on: () => () => {},
      get: name => (name === 'settings' ? settings : undefined),
      logger: { warn: message => warnings.push(String(message)) },
    }
    const notify = (text, options) => notifies.push({ text, options })
    return { settings, ctx, notify, mutations: () => mutations, notifies, warnings }
  }

  {
    const env = makeSettings([{ ns: 'llm-pi-ai', revision: 4, value: section }])
    await ensureUpstreamRetry(env.ctx, env.notify, ['zhipu'])
    check('ensure mutates the llm-pi-ai namespace once', env.mutations().length === 1 && env.mutations()[0]?.ns === 'llm-pi-ai')
    check('ensure seeds exactly the requested unclaimed route', env.mutations()[0]?.opsToApply?.length === 1 && env.mutations()[0]?.opsToApply?.[0]?.path?.[1] === 'zhipu', JSON.stringify(env.mutations()[0]?.opsToApply?.map(op => op.path?.[1])))
    check('ensure passes the observed revision', env.mutations()[0]?.revision === 4)
    check('ensure notifies once on success, naming the route', env.notifies.length === 1 && env.notifies[0]?.options?.color === 'success' && env.notifies[0]?.text?.includes('zhipu') === true)
    // The write landed in the resolved section: a second seeding for the
    // same route (the next bind) is a read-only no-op.
    await ensureUpstreamRetry(env.ctx, env.notify, ['zhipu'])
    check('a seeded route drops out of later seedings', env.mutations().length === 1 && env.notifies.length === 1)
  }
  {
    const env = makeSettings([{ ns: 'llm-pi-ai', revision: 2, value: section }], { conflictOnce: true })
    await ensureUpstreamRetry(env.ctx, env.notify, ['zhipu', 'relay'])
    check('a stale revision is retried exactly once', env.mutations().length === 2 && env.mutations()[1]?.revision === 2 && env.mutations()[1]?.opsToApply?.length === 2)
  }
  {
    const env = makeSettings([{ ns: 'llm-pi-ai', revision: 2, value: section }], { refuse: true })
    await ensureUpstreamRetry(env.ctx, env.notify, ['zhipu'])
    check('a refused write warns and never throws', env.warnings.length === 1 && env.notifies.length === 0 && env.mutations().length === 1)
  }
  {
    const env = makeSettings([{ ns: 'llm-pi-ai', revision: 2, value: { providers: { deepseek: { retryPolicy: { mode: 'always' } } } } }])
    await ensureUpstreamRetry(env.ctx, env.notify, ['deepseek'])
    check('routes that already declare a policy are left alone', env.mutations().length === 0 && env.notifies.length === 0)
  }
  {
    const env = makeSettings([{ ns: 'llm-pi-ai', revision: 2, value: section }])
    await ensureUpstreamRetry(env.ctx, env.notify, ['native-adapter-route'])
    check('a route the section does not know writes nothing', env.mutations().length === 0 && env.notifies.length === 0)
  }
  {
    const env = makeSettings([{ ns: 'other-ns', revision: 1, value: {} }])
    await ensureUpstreamRetry(env.ctx, env.notify, ['zhipu'])
    check('a missing llm-pi-ai namespace writes nothing', env.mutations().length === 0)
  }
  {
    const ctx = { on: () => () => {}, get: () => undefined, logger: { warn: () => {} } }
    const notified = []
    await ensureUpstreamRetry(ctx, text => notified.push(text), ['zhipu'])
    check('no settings service writes nothing', notified.length === 0)
  }
}

// ---- C. channel-level persistence, seeding, and the deployment pin --------
const makeEnv = ({ history = [], withCommand = false, settings, options, defaultPreset = 'workspace-write' } = {}) => {
  const commands = []
  const warnings = []
  const handlers = new Map()
  const events = [...history]
  const registry = {
    // The composition default dsh-permission-presets pins into every fresh
    // session (mirrors the service's `defaultPreset` getter); undefined models
    // a service that does not answer it at all (null = omit the getter).
    ...(defaultPreset === null ? {} : { defaultPreset }),
    names: ['read-only', 'workspace-write', 'auto', 'safe'],
    entries: new Map([
      ['read-only', { value: 'read-only', name: 'Read only' }],
      ['workspace-write', { value: 'workspace-write', name: 'Workspace write' }],
      ['auto', { value: 'auto', name: 'Auto' }],
      ['safe', { value: 'safe', name: 'Safe' }],
    ]),
    // Mirrors the real service derive(): folded knob state over the
    // composition defaults, so a fresh session reads its effective preset
    // (never undefined) exactly like dsh-permission-presets does.
    current(subject) {
      const bundles = {
        'read-only': ['read-only', 'ask'],
        'workspace-write': ['workspace-write', 'ask'],
        auto: ['workspace-write', 'ask'],
        safe: ['workspace-write', 'ask'],
      }
      let sandbox
      let approval
      let preset
      for (const event of (Array.isArray(subject) ? subject : subject?.events ?? [])) {
        if (event.type === 'sandbox/mode') sandbox = event.data?.mode
        if (event.type === 'approval/policy') approval = event.data?.policy
        if (event.type === 'permission/preset' && typeof event.data?.preset === 'string') preset = event.data.preset
      }
      sandbox ??= 'workspace-write'
      approval ??= 'ask'
      if (preset !== undefined && bundles[preset]?.[0] === sandbox && bundles[preset]?.[1] === approval) return preset
      for (const [name, spec] of Object.entries(bundles)) {
        if (spec[0] === sandbox && spec[1] === approval) return name
      }
      return 'custom'
    },
    optionOf(name) { return this.entries.get(name) },
    resolve(name) {
      const bundles = {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        auto: { sandbox: 'workspace-write', approval: 'ask' },
        safe: { sandbox: 'workspace-write', approval: 'ask' },
      }
      return { ...bundles[name] }
    },
    set(session, name) {
      if (!this.entries.has(name)) throw new Error(`unknown preset ${name}`)
      session.append('permission/preset', { preset: name })
    },
  }
  const services = {
    planMode: { get: () => ({}) },
    commands: {
      list: () => [],
      find: (_agent, name) => (withCommand && name === 'permission' ? { name: 'permission' } : undefined),
      execute: async () => undefined,
    },
    approval: { setPolicy: (agent, policy) => agent.session.append('approval/policy', { policy }) },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    permissionPresets: registry,
    ...(settings === undefined ? {} : { settings }),
  }
  const ctx = {
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event) },
    get: name => services[name],
    logger: { warn: message => warnings.push(String(message)) },
  }
  const agent = {
    id: 'a1',
    status: 'idle',
    ...(options === undefined ? {} : { options }),
    session: {
      id: 's1',
      seq: 0,
      events,
      append(type, data) {
        const event = { type, seq: events.length + 1, time: Date.now(), data }
        events.push(event)
        handlers.get('session/event')?.(agent.session, event)
      },
    },
    ctx: { on: () => () => {} },
  }
  return { ctx, agent, registry, commands, warnings, events }
}

const baseOptions = { model: 'deepseek-chat', cwd: '/tmp', provider: 'deepseek', activity: false }
const AUTO_SEED = [
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'approval/policy', data: { policy: 'ask' } },
  { type: 'permission/preset', data: { preset: 'auto' } },
]

{
  clearPref()
  const env = makeEnv({ history: AUTO_SEED })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check('observer: no switch leaves no preference file', !existsSync(prefFile()))
  // The official /permission command appending on its own (typed input,
  // another UI over the same registry) is the primary teaching path.
  env.agent.session.append('permission/preset', { preset: 'safe' })
  await settle()
  check('observer: durable identity switches teach the preference', readPermissionPref() === 'safe', readPermissionPref())
  // In-plan switches are transient: the exit restore re-seats the pre-plan
  // preset, so the file must keep the last out-of-plan identity.
  env.agent.session.append('plan/mode', { active: true })
  env.agent.session.append('permission/preset', { preset: 'read-only' })
  await settle()
  check('observer: in-plan switches do not teach the preference', readPermissionPref() === 'safe', readPermissionPref())
  env.agent.session.append('plan/mode', { active: false })
  env.agent.session.append('permission/preset', { preset: 'safe' })
  await settle()
  check('observer: post-plan restore teaches again', readPermissionPref() === 'safe')
}

{
  clearPref()
  writePermissionPref('auto')
  const env = makeEnv()
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  const taught = env.events.some(event => event.type === 'permission/preset' && event.data?.preset === 'auto')
  check('seed: a fresh session adopts the remembered preset', taught, JSON.stringify(env.events.map(event => event.type)))
  check('seed: the derived mode follows the identity', channel.mode.id === 'permission:auto', channel.mode.id)
}

{
  clearPref()
  writePermissionPref('safe')
  const env = makeEnv({ history: [{ type: 'sandbox/mode', data: { mode: 'read-only' } }] })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  const untouched = !env.events.some(event => event.type === 'permission/preset')
  check('seed: a session with its own plane events is left alone', untouched)
}

// The composition writes permission/preset + sandbox/mode + approval/policy
// into EVERY fresh session at creation (`session/created` →
// pinInitialPermission), so holding those events is not a user choice: a
// still-untouched session must seed, or the remembered pick could never apply.
{
  clearPref()
  writePermissionPref('safe')
  const env = makeEnv({
    history: [
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ],
  })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check(
    'seed: the composition creation pin does not block the remembered preset',
    env.events.some(event => event.type === 'permission/preset' && event.data?.preset === 'safe'),
    JSON.stringify(env.events.map(event => event.type)),
  )
}

{
  clearPref()
  writePermissionPref('safe')
  const env = makeEnv({
    history: [
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
      { type: 'turn/start', data: {} },
    ],
  })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check(
    'seed: a session that ran a turn keeps its own planes',
    !env.events.some(event => event.type === 'permission/preset' && event.data?.preset === 'safe'),
  )
}

{
  clearPref()
  writePermissionPref('auto')
  const env = makeEnv({
    history: [
      { type: 'permission/preset', data: { preset: 'safe' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ],
  })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check(
    'seed: an identity the composition did not pin is a user choice',
    !env.events.some(event => event.type === 'permission/preset' && event.data?.preset === 'auto'),
  )
}

// Fail-closed: without the composition default the pin cannot be recognized,
// so plane events count as a user choice again — the guard must not turn an
// unknown default into a seed.
{
  clearPref()
  writePermissionPref('safe')
  const env = makeEnv({
    defaultPreset: null,
    history: [
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ],
  })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check(
    'seed: an unknown composition default fails closed (no seed)',
    !env.events.some(event => event.type === 'permission/preset' && event.data?.preset === 'safe'),
  )
}

{
  clearPref()
  writePermissionPref('auto')
  process.env.DSH_PERMISSION_MODE = 'workspace-write'
  const env = makeEnv()
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check('seed: a DSH_PERMISSION_MODE pin outranks the file', !env.events.some(event => event.type === 'permission/preset'))
  delete process.env.DSH_PERMISSION_MODE
}

{
  clearPref()
  writePermissionPref('gone-from-the-roster')
  const env = makeEnv()
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check('seed: an identity off the mounted roster is skipped', !env.events.some(event => event.type === 'permission/preset'))
  clearPref()
}

// ---- D. upstream retry follows the route the session actually uses --------
{
  const mutations = []
  const section = {
    providers: {
      zhipu: { baseURL: 'https://zhipu.example', models: [] },
      deepseek: { baseURL: 'https://deepseek.example', models: [], retryPolicy: { mode: 'always' } },
    },
  }
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 7, value: section }],
    mutate: async (ns, opsToApply, revision) => { mutations.push({ ns, opsToApply, revision }) },
  }
  const env = makeEnv({
    settings,
    options: { provider: 'zhipu', model: 'glm-5.3' },
  })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  const seeded = mutations[0]?.opsToApply ?? []
  check('retry: the bind seeds the route in use', mutations.length === 1 && seeded.length === 1 && seeded[0]?.path?.[1] === 'zhipu', JSON.stringify(seeded.map(op => op.path)))
  check('retry: routes with their own policy and dormant channels stay untouched', !JSON.stringify(seeded).includes('deepseek'))
}

if (failed > 0) {
  console.error(`permission-prefs verification failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('permission-prefs verification passed')
}
