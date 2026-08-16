/**
 * Focused regression coverage for the compiled Smart runtime bridge.
 *
 * The verifier uses synthetic package layouts for discovery and rejection
 * cases. Set DSH_SMART_RUNTIME_FIXTURE to an unpacked official v0.3.3
 * package (or its lib/index.js) to also exercise the pinned-hash success and
 * bridge-mount paths without redistributing the upstream payload here.
 *
 * Run after `pnpm build`:
 *   node scripts/verify-smart-runtime.mjs
 */
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

const fixture = process.env.DSH_SMART_RUNTIME_FIXTURE?.trim()
const testRoot = mkdtempSync(join(tmpdir(), 'dsh-tui-smart-runtime-'))
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalDshHome = process.env.DSH_HOME
const originalOverride = process.env.DSH_SMART_RUNTIME_PATH

process.env.HOME = testRoot
process.env.USERPROFILE = testRoot

after(() => {
  restoreEnv('HOME', originalHome)
  restoreEnv('USERPROFILE', originalUserProfile)
  restoreEnv('DSH_HOME', originalDshHome)
  restoreEnv('DSH_SMART_RUNTIME_PATH', originalOverride)
  rmSync(testRoot, { recursive: true, force: true })
})

const runtime = await import('../lib/types/dsh-adapter/smartRuntime.js')
const { writeSmartSession } = await import('../lib/types/smartPrefs.js')
const { resolveDshProfileName } = await import('../lib/types/update.js')

const {
  SUPER_INJECTOR_BUNDLE_SHA256,
  SUPER_INJECTOR_TOOL_NAMES,
  SUPER_INJECTOR_VERSION,
  TerminalWebServerCompat,
  apply,
  findSmartHostRuntime,
  verifySmartHostRuntime,
} = runtime

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function withEnv(changes, action) {
  const previous = Object.fromEntries(
    Object.keys(changes).map(name => [name, process.env[name]]),
  )
  for (const [name, value] of Object.entries(changes)) restoreEnv(name, value)
  try {
    return await action()
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value)
  }
}

function makePackage(
  packageRoot,
  {
    name = '@dsh-external/dsh-super-injector',
    version = SUPER_INJECTOR_VERSION,
    bundle = 'export function apply() {}\n',
  } = {},
) {
  const entry = join(packageRoot, 'lib', 'index.js')
  const packageFile = join(packageRoot, 'package.json')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(packageFile, `${JSON.stringify({ name, version, type: 'module' }, null, 2)}\n`)
  writeFileSync(entry, bundle)
  return { entry, packageFile }
}

function profilePackage(home, profile) {
  return join(
    home,
    'profiles',
    profile,
    'node_modules',
    '@dsh-external',
    'dsh-super-injector',
  )
}

function makeRuntimeContext({ services: initialServices = {} } = {}) {
  const services = new Map(Object.entries(initialServices))
  const listeners = new Map()
  const state = {
    effectLabels: [],
    infos: [],
    isolates: [],
    pluginCalls: [],
    provided: [],
    registeredTools: [],
    warnings: [],
  }
  const ctx = {
    tools: {
      register(tool) {
        state.registeredTools.push(tool)
        return () => {}
      },
    },
    effect(register, label) {
      state.effectLabels.push(label)
      return register()
    },
    on(event, listener) {
      assert.equal(listeners.has(event), false, `duplicate listener for ${event}`)
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    get(service) {
      return services.get(service)
    },
    isolate(service) {
      state.isolates.push(service)
      return ctx
    },
    provide(service, value) {
      services.set(service, value)
      state.provided.push({ service, value })
    },
    plugin(plugin, config) {
      state.pluginCalls.push({ plugin, config })
      return Promise.resolve()
    },
    logger: {
      info(message) {
        state.infos.push(String(message))
      },
      warn(message) {
        state.warnings.push(String(message))
      },
    },
  }
  ctx.root = ctx
  return { ctx, listeners, services, state }
}

function sessionWithSmart(id, enabled) {
  writeSmartSession(id, enabled)
  return {
    header: { id, seedLength: 0 },
    events: [{
      type: 'request/header',
      seq: 0,
      data: {
        header: {
          system: 'base',
        },
      },
    }],
  }
}

test('findSmartHostRuntime honors override, active-profile, and web-profile precedence', async () => {
  const home = join(testRoot, 'discovery-home')
  const override = makePackage(join(testRoot, 'discovery-override'))
  const active = makePackage(profilePackage(home, 'active'))
  const web = makePackage(profilePackage(home, 'web'))

  assert.deepEqual(findSmartHostRuntime(home, 'active', dirname(override.packageFile)), override)
  assert.deepEqual(findSmartHostRuntime(home, 'active', join(testRoot, 'missing-override')), active)

  await withEnv({ DSH_SMART_RUNTIME_PATH: dirname(override.packageFile) }, () => {
    assert.deepEqual(findSmartHostRuntime(home, 'active'), override)
  })

  const webOnlyHome = join(testRoot, 'web-only-home')
  const webOnly = makePackage(profilePackage(webOnlyHome, 'web'))
  await withEnv({ DSH_SMART_RUNTIME_PATH: undefined }, () => {
    assert.deepEqual(findSmartHostRuntime(webOnlyHome, 'active'), webOnly)
  })

  assert.notDeepEqual(active, web)
})

test('findSmartHostRuntime accepts direct entries and rejects incomplete layouts', async () => {
  const direct = makePackage(join(testRoot, 'direct-entry'))
  assert.deepEqual(
    findSmartHostRuntime(join(testRoot, 'empty-home'), 'active', direct.entry),
    direct,
  )

  const upperCase = makePackage(join(testRoot, 'upper-case-entry'))
  const upperCaseEntry = join(dirname(upperCase.entry), 'INDEX.JS')
  renameSync(upperCase.entry, upperCaseEntry)
  assert.deepEqual(
    findSmartHostRuntime(join(testRoot, 'empty-home'), 'active', upperCaseEntry),
    { ...upperCase, entry: upperCaseEntry },
  )

  const incomplete = profilePackage(join(testRoot, 'incomplete-home'), 'active')
  mkdirSync(incomplete, { recursive: true })
  writeFileSync(join(incomplete, 'package.json'), '{}\n')
  await withEnv({ DSH_SMART_RUNTIME_PATH: undefined }, () => {
    assert.equal(findSmartHostRuntime(join(testRoot, 'incomplete-home'), 'active'), undefined)
  })
})

test('verifySmartHostRuntime rejects unexpected package names', () => {
  const location = makePackage(join(testRoot, 'wrong-name'), { name: '@example/not-injector' })
  const result = verifySmartHostRuntime(location)
  assert.equal(result.ok, false)
  assert.match(result.reason, /unexpected package name/)
  assert.match(result.reason, /package\.json/)
})

test('verifySmartHostRuntime rejects unexpected versions', () => {
  const location = makePackage(join(testRoot, 'wrong-version'), { version: '0.3.2' })
  const result = verifySmartHostRuntime(location)
  assert.equal(result.ok, false)
  assert.match(result.reason, new RegExp(`expected Smart host runtime v${SUPER_INJECTOR_VERSION}`))
  assert.match(result.reason, /found 0\.3\.2/)
})

test('verifySmartHostRuntime rejects a host bundle with the wrong digest', () => {
  const location = makePackage(join(testRoot, 'wrong-hash'), {
    bundle: 'export function apply() { return "tampered" }\n',
  })
  const result = verifySmartHostRuntime(location)
  assert.equal(result.ok, false)
  assert.match(result.reason, /host bundle SHA-256 mismatch \([0-9a-f]{64}\)/)
  assert.equal(result.reason.includes(SUPER_INJECTOR_BUNDLE_SHA256), false)
})

test('verifySmartHostRuntime reports unreadable metadata without throwing', () => {
  const location = makePackage(join(testRoot, 'malformed-metadata'))
  writeFileSync(location.packageFile, '{not-json\n')
  const result = verifySmartHostRuntime(location)
  assert.equal(result.ok, false)
  assert.equal(typeof result.reason, 'string')
  assert.notEqual(result.reason.length, 0)
})

test('TerminalWebServerCompat tracks each route kind and disposes by ownership', () => {
  const server = new TerminalWebServerCompat()
  const exactA = { kind: 'exact', path: '/settings', handler: { id: 'a' } }
  const exactB = { kind: 'exact', path: '/settings', handler: { id: 'b' } }
  const prefix = { kind: 'prefix', path: '/api/', handler: { id: 'prefix' } }
  const upgrade = { kind: 'upgrade', path: '/socket', handler: { id: 'upgrade' } }

  const disposeExactA = server.register(exactA)
  const disposePrefix = server.register(prefix)
  const disposeUpgrade = server.register(upgrade)
  assert.equal(server.exact.get('/settings'), exactA)
  assert.equal(server.prefixes.get('/api/'), prefix)
  assert.equal(server.upgrades.get('/socket'), upgrade)
  assert.equal(server.listen, undefined)

  const disposeExactB = server.register(exactB)
  disposeExactA()
  assert.equal(server.exact.get('/settings'), exactB)
  disposeExactB()
  disposeExactB()
  disposePrefix()
  disposeUpgrade()
  assert.equal(server.exact.size, 0)
  assert.equal(server.prefixes.size, 0)
  assert.equal(server.upgrades.size, 0)
})

test('missing optional host stays inactive and Smart-only tools are filtered outside Smart', async () => {
  const home = join(testRoot, 'missing-runtime-home')
  const fake = makeRuntimeContext()
  await withEnv({
    DSH_HOME: home,
    DSH_SMART_RUNTIME_PATH: join(testRoot, 'missing-runtime-override'),
  }, () => apply(fake.ctx))

  assert.equal(fake.state.pluginCalls.length, 0)
  assert.deepEqual(fake.state.isolates, [])
  assert.equal(fake.state.registeredTools.length, 1)
  assert.equal(fake.state.registeredTools[0].name, 'dev_smart_status')
  assert.deepEqual(fake.state.effectLabels, ['dsh-tui-smart-runtime: dev_smart_status'])
  assert.equal(fake.state.warnings.length, 1)
  assert.match(fake.state.warnings[0], /optional host runtime v0\.3\.3 payload not found/)

  const status = await fake.state.registeredTools[0].execute({}, {})
  assert.match(status, /host=router-only:/)
  assert.match(status, /browser-ui=unavailable in the terminal profile/)

  const assemble = fake.listeners.get('system-prompt/assemble')
  assert.equal(typeof assemble, 'function')
  const regularTools = [{ name: 'read' }, { name: 'bash' }]
  const smartTools = [
    { name: 'dev_smart_status' },
    ...SUPER_INJECTOR_TOOL_NAMES.map(name => ({ name })),
  ]
  const assembly = {
    sections: [{ name: 'base', text: 'base prompt' }],
    contexts: [
      { name: 'workspace', text: 'workspace context' },
      { name: 'dsh-super-injector', text: 'host management context' },
    ],
    tools: [...regularTools, ...smartTools],
  }

  const off = await assemble(
    undefined,
    { agent: { session: sessionWithSmart('smart-off', false) } },
    async () => assembly,
  )
  assert.notEqual(off, assembly)
  assert.deepEqual(off.tools, regularTools)
  assert.equal(off.sections, assembly.sections)
  assert.deepEqual(off.contexts, [{ name: 'workspace', text: 'workspace context' }])
  assert.equal(assembly.tools.length, regularTools.length + smartTools.length)

  const on = await assemble(
    undefined,
    { agent: { session: sessionWithSmart('smart-on', true) } },
    async () => assembly,
  )
  assert.equal(on, assembly)

  const noAgent = await assemble(undefined, {}, async () => assembly)
  assert.deepEqual(noAgent.tools, regularTools)
  assert.deepEqual(noAgent.contexts, [{ name: 'workspace', text: 'workspace context' }])
})

test('unverified optional host never mounts or provisions a webServer', async () => {
  const home = join(testRoot, 'rejected-runtime-home')
  const packageRoot = join(testRoot, 'rejected-runtime-package')
  const location = makePackage(packageRoot, {
    bundle: 'export function apply() { throw new Error("not trusted") }\n',
  })
  const fake = makeRuntimeContext()
  await withEnv({
    DSH_HOME: home,
    DSH_SMART_RUNTIME_PATH: packageRoot,
  }, () => apply(fake.ctx))

  assert.equal(fake.state.pluginCalls.length, 0)
  assert.deepEqual(fake.state.isolates, [])
  assert.deepEqual(fake.state.provided, [])
  assert.equal(fake.state.warnings.length, 1)
  assert.match(fake.state.warnings[0], /refusing unverified host runtime payload/)
  assert.match(fake.state.warnings[0], /SHA-256 mismatch/)

  const status = await fake.state.registeredTools[0].execute({}, {})
  assert.match(status, /host=failed: host bundle SHA-256 mismatch/)
  assert.match(status, new RegExp(`source=${location.entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

if (fixture === undefined || fixture === '') {
  test.skip('official v0.3.3 fixture passes pinned hash and mounts through the TUI bridge', () => {})
} else {
  test('official v0.3.3 fixture passes pinned hash and mounts through the TUI bridge', async () => {
    const home = join(testRoot, 'verified-runtime-home')
    const location = findSmartHostRuntime(home, 'fixture-profile', fixture)
    assert.notEqual(location, undefined, `fixture is not a complete package layout: ${fixture}`)
    assert.deepEqual(verifySmartHostRuntime(location), { ok: true })

    const fake = makeRuntimeContext()
    await withEnv({
      DSH_HOME: home,
      DSH_SMART_RUNTIME_PATH: fixture,
    }, () => apply(fake.ctx))
    await Promise.resolve()

    assert.deepEqual(fake.state.isolates, ['webServer'])
    assert.equal(fake.state.provided.length, 1)
    assert.equal(fake.state.provided[0].service, 'webServer')
    assert.ok(fake.state.provided[0].value instanceof TerminalWebServerCompat)
    assert.equal(fake.services.get('webServer'), fake.state.provided[0].value)
    assert.equal(fake.state.pluginCalls.length, 1)
    assert.equal(typeof fake.state.pluginCalls[0].plugin.apply, 'function')

    const expectedProfile = resolveDshProfileName() ?? 'dsh-tui'
    assert.deepEqual(fake.state.pluginCalls[0].config, {
      registryFile: join(home, 'super-injector', 'smart-registry.json'),
      profileNodeModules: join(home, 'profiles', expectedProfile, 'node_modules'),
      autoRestore: true,
      intervalMs: 1500,
      watches: [],
    })

    const status = await fake.state.registeredTools[0].execute({}, {})
    assert.match(status, /host=active: verified upstream v0\.3\.3 host tools active/)
    assert.match(status, /browser-ui=unavailable in the terminal profile/)
    assert.equal(fake.state.infos.length, 1)
    assert.match(fake.state.infos[0], /host runtime v0\.3\.3 active/)
  })
}
