/**
 * Backend OAuth logout through the production channel and UI handle.
 * Only the host OAuth API is fake; no real credentials, CLI or network.
 * Run: node --import tsx/esm scripts/verify-backend-logout.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSession } from '../src/agent/session.js'
import type { SessionCapabilities } from '../src/agent/capabilities.js'
import type { OAuthSetupHost } from '../src/adapter/ports/channel-settings.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-logout-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = home
process.env.DSH_TUI_LANG = 'en'
const [{ createChannel }, { channelCapabilities }, { LOCAL_COMMANDS }, { createChannelUi, createChannelUiLease }] = await Promise.all([
  import('../src/dsh-adapter/channel.js'),
  import('../src/channel/capabilities.js'),
  import('../src/commands.js'),
  import('../src/adapter/channel/ui.js'),
])
let passed = 0
const check = (label: string, ok: unknown): void => { assert.ok(ok, label); passed += 1; console.log('PASS ' + label) }
const context = (oauth?: OAuthSetupHost) => ({
  on: () => () => undefined,
  get: (name: string) => name === 'dshAuth' && oauth !== undefined ? { api: oauth } : undefined,
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
}) as never
const session = (capabilities: Omit<SessionCapabilities, 'native'> = {}, id = 'logout'): AgentSession => ({
  ref: { backendId: 'fixture', sessionId: id }, cwd: home, status: 'idle', capabilities: { ...capabilities, native: {} },
  history: async () => [], subscribe: () => () => undefined,
  submit: async () => ({ accepted: true }), cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }), dispose: async () => undefined,
})
const opts = { model: 'fixture', provider: '', cwd: home, activity: false, initialHistory: [] }

try {
  for (const provider of ['openai-codex', 'anthropic']) {
    const stored = new Set(['openai-codex', 'anthropic', 'unrelated'])
    const nativeLogin = Object.freeze({ unchanged: true })
    let calls = 0
    const oauth: OAuthSetupHost = {
      providers: async () => [],
      login: async () => { throw new Error('logout must not start login') },
      logout: async target => { calls += 1; assert.equal(target, provider); return stored.delete(target) },
    }
    const raw = createChannel(context(oauth), session({ auth: {
      oauthProvider: provider,
      status: async () => { throw new Error('logout must not query native account') },
      reconnect: async () => { throw new Error('logout must not reconnect native login') },
    } }), opts)
    const lease = createChannelUiLease(() => true)
    try {
      check(provider + ': /logout is offered by the auth capability', raw.commandList.some(command => command.name === 'logout'))
      const ui = createChannelUi(raw, 'legacy', lease)
      check(provider + ': live UI delegates storage-only logout', await ui.backendAuth()!.logout!())
      check(provider + ': only the matching OAuth provider was removed', calls === 1 && !stored.has(provider) && stored.has('unrelated') && stored.has(provider === 'anthropic' ? 'openai-codex' : 'anthropic'))
      check(provider + ': native state remains unchanged and restart boundary is explicit', nativeLogin.unchanged && raw.notifications.some(item => item.text.includes('native login is unchanged') && item.text.includes('Restart normally')))
      check(provider + ': missing host credential is reported without native fallback', await ui.backendAuth()!.logout!() === false && raw.notifications.some(item => item.text.includes('No ' + provider + ' dsh-auth credential')))
      const passive = createChannelUi(raw, 'passive-shadow', lease)
      assert.throws(() => passive.backendAuth()!.logout!(), /shadow|policy|mutate/iu)
      check(provider + ': a shadow UI cannot mutate host credentials', calls === 2)
      const retained = raw.backendAuth()!
      raw.releaseContributions()
      check(provider + ': a retired session host cannot erase credentials', await retained.logout!() === false && calls === 2)
    } finally { lease.dispose(); raw.releaseContributions() }
  }

  const absent = createChannel(context(), session(), opts)
  try { check('no auth capability means no logout entry or handle', !absent.commandList.some(command => command.name === 'logout') && absent.backendAuth() === undefined) }
  finally { absent.releaseContributions() }

  const nativeAuth = { oauthProvider: 'openai-codex', status: async () => ({ lines: [] }), reconnect: async () => { throw new Error('native reconnect must not run') } }
  const noHost = createChannel(context(), session({ auth: nativeAuth }), opts)
  try { check('missing OAuth host fails explicitly and leaves native auth alone', await noHost.backendAuth()!.logout!() === false && noHost.notifications.some(item => item.text.includes('No dsh-auth sign-in service'))) }
  finally { noHost.releaseContributions() }

  const failed = createChannel(context({ providers: async () => [], login: async () => { throw new Error('not login') }, logout: async () => { throw new Error('fixture store failure') } }), session({ auth: nativeAuth }), opts)
  try { check('host storage failure becomes a visible capability error', await failed.backendAuth()!.logout!() === false && failed.notifications.some(item => item.text.includes('fixture store failure'))) }
  finally { failed.releaseContributions() }

  let finish!: (removed: boolean) => void
  const late = createChannel(context({ providers: async () => [], login: async () => { throw new Error('not login') }, logout: () => new Promise(resolve => { finish = resolve }) }), session({ auth: nativeAuth }), { ...opts, openSession: async () => session({}, 'replacement') })
  try {
    const pending = late.backendAuth()!.logout!()
    check('a replacement session can open while host logout is pending', await late.newSession())
    const noticeCount = late.notifications.length
    finish(true)
    check('late logout settlement never notifies the replacement session', await pending && late.notifications.length === noticeCount)
  } finally { late.releaseContributions() }

  const dsh = channelCapabilities({ backendId: 'dsh', backendLabel: 'DSH', capabilities: { native: {} }, dsh: true })
  check('DSH keeps exactly its existing local command list', JSON.stringify(dsh.commands) === JSON.stringify(LOCAL_COMMANDS.map(command => command.name)))
  const older = createChannelUi({ backendAuth: () => ({ login: async () => undefined }) } as never, 'legacy', createChannelUiLease(() => true))
  check('an older optional auth handle remains callable without logout', older.backendAuth()!.logout === undefined)
} finally { rmSync(home, { recursive: true, force: true }) }
console.log('verify-backend-logout: ' + passed + ' PASS')
