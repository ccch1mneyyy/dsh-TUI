/**
 * N9 + backend-owned login: production channel capability routing and one
 * Claude session over the fake SDK. DSH's synchronous template route stays
 * separate. No personal state, credentials, CLI process or network.
 * Run: node --import tsx/esm scripts/verify-init-capability.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSession } from '../src/agent/session.js'
import type { SessionCapabilities } from '../src/agent/capabilities.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-init-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
process.env.DSH_TUI_LANG = 'en'
const [{ createChannel }, { channelCapabilities }, { LOCAL_COMMANDS }, { openClaudeSession }, { fakeClaudeSdk, claudeDeps, tick }] = await Promise.all([
  import('../src/dsh-adapter/channel.js'),
  import('../src/channel/capabilities.js'),
  import('../src/commands.js'),
  import('../src/backends/claude/session.js'),
  import('./lib/claude-fake-sdk.js'),
])
let passed = 0
const check = (label: string, ok: unknown): void => { assert.ok(ok, label); passed += 1; console.log('PASS ' + label) }
const context = (oauth?: unknown) => ({
  on: () => () => undefined,
  get: (name: string) => name === 'dshAuth' && oauth !== undefined ? { api: oauth } : undefined,
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
}) as never
const session = (capabilities: Omit<SessionCapabilities, 'native'> = {}): AgentSession => ({
  ref: { backendId: 'fixture', sessionId: 'init' }, cwd: home, status: 'idle', capabilities: { ...capabilities, native: {} },
  history: async () => [], subscribe: () => () => undefined,
  submit: async () => ({ accepted: true }), cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }), dispose: async () => undefined,
})
const channel = (caps: Omit<SessionCapabilities, 'native'> = {}, oauth?: unknown) => createChannel(context(oauth), session(caps), { model: 'fixture', provider: '', cwd: home, activity: false, initialHistory: [] })

try {
  const absent = channel()
  try {
    check('no init capability means no backend host and no menu entry', absent.backendInit() === undefined && !absent.commandList.some(command => command.name === 'init'))
    check('unsupported init keeps the explicit unavailable result', absent.initWorkspace() === null && absent.notifications.length > 0)
  } finally { absent.releaseContributions() }

  let calls = 0
  const native = channel({ init: { run: async () => { calls += 1 } }, commands: { list: async () => [{ name: 'init', description: 'duplicate backend name' }] } })
  const init = native.backendInit()!
  try {
    check('the declared init capability appears in the local menu', native.backendCapabilities.init && native.commandList.some(command => command.name === 'init'))
    check('backendInit delegates to the production capability', await init.run() && calls === 1)
    await tick()
    check('local /init wins a backend command name collision', native.commandList.filter(command => command.name === 'init').length === 1 && native.commandList.find(command => command.name === 'init')?.origin !== 'backend')
  } finally { native.releaseContributions() }
  check('a released init host cannot act on the old session', await init.run() === false && calls === 1)

  const failed = channel({ init: { run: async () => { throw new Error('fixture init failed') } } })
  try { check('init rejection is reported instead of escaping the UI', await failed.backendInit()!.run() === false && failed.notifications.some(item => item.text.includes('fixture init failed'))) }
  finally { failed.releaseContributions() }

  const dsh = channelCapabilities({ backendId: 'dsh', backendLabel: 'DSH', capabilities: { native: {} }, dsh: true })
  check('DSH capability command list remains exactly the existing built-ins', dsh.init && JSON.stringify(dsh.commands) === JSON.stringify(LOCAL_COMMANDS.map(command => command.name)))

  // The new optional login method owns its flow. The callback offers OAuth
  // only when the host and provider are present; legacy auth still uses the
  // existing status -> present -> reconnect path unchanged.
  let statusCalls = 0
  let reconnects = 0
  const saved: (boolean | undefined)[] = []
  const oauth = {}
  const auth = { oauthProvider: 'fixture-provider', status: async () => { statusCalls += 1; return { lines: [] } }, reconnect: async () => { reconnects += 1 } }
  const ownLogin = channel({ auth: { ...auth, login: async present => { saved.push(await present?.()) } } }, oauth)
  try {
    await ownLogin.backendAuth()!.login(async (host, provider) => { assert.equal(host, oauth); assert.equal(provider, 'fixture-provider'); return 'added' })
    await ownLogin.backendAuth()!.login(async () => 'updated')
    await ownLogin.backendAuth()!.login(async () => 'cancelled')
    check('backend-owned login receives saved/updated/cancelled OAuth outcomes', JSON.stringify(saved) === JSON.stringify([true, true, false]))
    check('native login does not enter the legacy status/reconnect route', statusCalls === 0 && reconnects === 0)
  } finally { ownLogin.releaseContributions() }
  const noOAuth = channel({ auth: { ...auth, login: async present => { check('native login can run without a host OAuth callback', present === undefined) } } })
  try { await noOAuth.backendAuth()!.login(async () => { throw new Error('must not present') }) }
  finally { noOAuth.releaseContributions() }
  const legacy = channel({ auth }, oauth)
  try {
    await legacy.backendAuth()!.login(async () => 'added')
    check('auth without login keeps the original status/OAuth/reconnect path', statusCalls === 1 && reconnects === 1)
  } finally { legacy.releaseContributions() }

  const fake = fakeClaudeSdk()
  const claude = await openClaudeSession(claudeDeps(fake.sdk, { cwd: home }))
  try {
    check('Claude declares the optional init capability', claude.capabilities.init !== undefined)
    await claude.capabilities.init!.run()
    await tick()
    check('Claude init submits its actual CLI /init command', fake.queries[0]!.inputs.length === 1 && (fake.queries[0]!.inputs[0]!.message as { content: unknown }).content === '/init')
  } finally { await claude.dispose() }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log('\nverify-init-capability OK (' + passed + ' checks)')
