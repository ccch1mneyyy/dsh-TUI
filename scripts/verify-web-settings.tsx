/**
 * rc.2 web settings through the real Loader, Settings, channel and terminal form.
 * Search/Fetch use the official providers with intercepted transport and fake
 * credentials. No model, network, account login or real profile is accessed.
 * Run after pnpm build: node --import tsx/esm scripts/verify-web-settings.tsx
 */
import './lib/fake-home.mjs'
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [
  { default: assert }, { mkdtempSync, rmSync }, { tmpdir }, { join },
  { PassThrough, Writable }, React, { Terminal }, { render, AlternateScreen },
  { Settings: SettingsScreen }, { settled, viewportLines },
  { Context }, { default: Loader }, { default: Settings }, { default: Web }, WebApi,
  { default: ToolRuntime }, { default: SystemPrompt }, ToolWeb, { ToolCallId },
  { createSettingsHosts, webSettingsSections }, { SettingsForm, getPath }, { createChannel }, { disposeChannelOwner },
] = await Promise.all([
  import('node:assert/strict'), import('node:fs'), import('node:os'), import('node:path'),
  import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Settings.js'), import('./lib/term-test.mjs'),
  import('@deepseek-ai/cordis'), import('@deepseek-ai/cordis-plugin-loader'), import('@deepseek-ai/dsh-settings'),
  import('@deepseek-ai/dsh-web'), import('@deepseek-ai/dsh-web-deepseek-api'),
  import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-tool-web'), import('@deepseek-ai/dsh-llm'),
  import('../src/dsh-adapter/channel/settings-host.js'), import('../src/dsh-adapter/settingsEditor.js'),
  import('../src/dsh-adapter/channel.js'), import('../src/dsh-adapter/channel/owner.js'),
])
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { concreteService } from '../src/dsh-adapter/host-access.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-web-settings-'))
const root = new Context()
const originalFetch = globalThis.fetch
const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
let route = 'deepseek-official'
let responseStatus = 200
const prompt = 'What changed? '.repeat(20)
globalThis.fetch = async (input, init) => {
  const url = String(input)
  assert.match(url, /^https:\/\/web-fixture\.invalid\//, 'no request may reach a real endpoint')
  assert.equal(typeof init?.body, 'string')
  requests.push({ url, body: JSON.parse(init!.body as string), headers: new Headers(init?.headers) })
  return Response.json(responseStatus !== 200 ? { error: 'fixture error' } : url.endsWith('/search')
    ? { results: [{ title: 'Result', url: 'https://source.invalid', snippet: 'Source excerpt', date: null }] }
    : { content: '# Retrieved page\n\nBody' }, { status: responseStatus })
}
let channel: ReturnType<typeof createChannel> | undefined
try {
  assert.deepEqual(webSettingsSections([]), [], 'bare and non-DSH compositions expose no web controls')
  assert.deepEqual(webSettingsSections([{ ns: 'web', revision: 0, applies: 'restart', value: {}, user: {} }]), [],
    'older hosts do not expose a provider picker that cannot apply live')
  await root.plugin(Loader)
  root.provide('profileContext', { home })
  // Real mutation/revision/volatile handling, with only profile IO in memory.
  root.provide('configEditor', {
    entries: () => [...root.loader.entries()],
    configuration: () => [...root.loader.entries()].map(entry => ({ entry, inherited: {}, override: entry.options.config ?? {} })),
    async edit(entry, change) {
      await root.loader.update(entry.options.id, { config: change(entry.options.config ?? {}, {}) })
      await root.loader.await()
    },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'fixture-key' }) })
  root.provide('agents', { currentInitiator: () => ({ session: {
    requestContext: () => ({ provider: route }),
    deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }],
  } }) })
  root.provide('deepseekAccount', { resolveToken: async () => 'fixture-account-token' })
  await root.plugin(Settings)
  root.loader.builtins.web = Web
  root.loader.builtins.webApi = WebApi
  await root.loader.create({ id: 'web', name: 'cordis:web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } })
  await root.loader.create({ id: 'web-deepseek-api', name: 'cordis:webApi', config: { baseURL: 'https://web-fixture.invalid/tools' } })
  await root.loader.await()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(ToolWeb)
  root.web.registerSearchProvider({
    id: 'deepseek-official', available: () => true,
    search: async () => ({ sources: [{ url: 'https://legacy.invalid' }], truncated: false }),
  })
  root.web.registerFetchProvider({
    id: 'http', available: () => true,
    fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'text', content: 'legacy fetch' }, truncated: false }),
  })
  const host = createSettingsHosts(root).settingsHost()!
  const valueOf = (ns: string, key: string) => getPath(host.listNamespaces().find(view => view.ns === ns)?.value, [key])
  const agent = { id: 'fixture-agent', ctx: { on: () => () => {} }, status: 'idle',
    session: { id: 'fixture-session', seq: 0, events: [] }, inbox: { remove: () => true } } as unknown as Agent
  channel = createChannel({ get: (name: string) => name === 'settings' ? root.settings : undefined,
    on: () => () => {}, logger: { warn() {} } } as unknown as CordisContext,
  agent, { provider: 'deepseek-official', model: 'deepseek-flash', cwd: home, activity: false, upstreamRetry: false })
  const sections = channel.settingsSections()
  assert.deepEqual(sections.map(section => section.ns), ['web', 'web-deepseek-api'], 'DSH channel exposes available web forms')
  const formFor = (ns: string) => {
    const section = sections.find(section => section.ns === ns)!
    return new SettingsForm(host, host.listNamespaces().find(view => view.ns === ns), section.fields)
  }
  const field = (ns: string, key: string) => sections.find(section => section.ns === ns)!.fields.find(field => field.path[0] === key)!
  const choose = async (search: string, fetch: string) => {
    const form = formFor('web')
    form.edit(field('web', 'searchProvider'), search)
    form.edit(field('web', 'fetchProvider'), fetch)
    assert.equal(await form.save(), true, form.failureMessage)
  }
  const runtime = root.web
  assert.equal((await runtime.search({ query: 'legacy' })).sources[0]?.url, 'https://legacy.invalid')
  await choose('deepseek-search-api', 'deepseek-fetch-api')
  assert.ok(concreteService(root.web) === concreteService(runtime), 'saving provider choices keeps the live web service')
  const api = formFor('web-deepseek-api')
  api.edit(field('web-deepseek-api', 'count'), '3')
  assert.equal(valueOf('web-deepseek-api', 'count'), 10,
    'editing a form alone does not write before save')
  assert.equal(await api.save(), true, api.failureMessage)
  const result = await runtime.search({ query: 'fixture query' })
  assert.equal(result.sources[0]?.snippet, 'Source excerpt')
  assert.equal(requests.at(-1)?.body.count, 3, 'next request reads the saved result bound')
  assert.equal(requests.at(-1)?.body.ori_question, prompt.trim().slice(0, 128))
  assert.equal(requests.at(-1)?.headers.get('authorization'), 'Bearer fixture-key')
  assert.equal((await runtime.fetch({ url: 'https://page.invalid' })).body.kind, 'text')
  assert.equal(requests.at(-1)?.url, 'https://web-fixture.invalid/tools/fetch')
  for (const [name, args, expected] of [
    ['web_search', { queries: ['tool query'] }, 'Source excerpt'],
    ['web_fetch', { url: 'https://page.invalid' }, 'Retrieved page'],
  ] as const) {
    const result = await root.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(name), name, arguments: args })
    assert.equal(result.isError, false)
    assert.ok(result.content.some(block => block.type === 'text' && block.text.includes(expected)), 'official tool output retains API content')
    assert.ok(result.meta !== undefined, 'official tool result retains presentation metadata')
  }
  const changed = formFor('web-deepseek-api')
  changed.edit(field('web-deepseek-api', 'sendOriginalQuestion'), 'false')
  changed.edit(field('web-deepseek-api', 'baseURL'), 'https://web-fixture.invalid/changed-prefix')
  assert.equal(await changed.save(), true, changed.failureMessage)
  route = 'deepseek-account'
  await runtime.search({ query: 'account' })
  assert.equal(requests.at(-1)?.url, 'https://web-fixture.invalid/changed-prefix/search')
  assert.equal(requests.at(-1)?.body.ori_question, undefined)
  assert.equal(requests.at(-1)?.headers.get('x-dsh-auth-token'), 'fixture-account-token')
  assert.equal(requests.at(-1)?.headers.has('authorization'), false)
  responseStatus = 503
  await assert.rejects(runtime.search({ query: 'failed' }), { code: 'WEB_PROVIDER_ERROR' })
  responseStatus = 200
  const aborted = new AbortController()
  aborted.abort()
  const beforeAbort = requests.length
  await assert.rejects(runtime.fetch({ url: 'https://page.invalid' }, aborted.signal), { code: 'WEB_ABORTED' })
  assert.equal(requests.length, beforeAbort, 'cancelled operations do not dispatch')
  const invalid = formFor('web-deepseek-api')
  for (const count of ['0', '51', '1.5', 'NaN']) {
    invalid.edit(field('web-deepseek-api', 'count'), count)
    assert.equal(await invalid.save(), false, 'invalid result counts cannot be persisted')
  }
  await choose('deepseek-official', 'http')
  const beforeLegacy = requests.length
  assert.equal((await runtime.fetch({ url: 'https://page.invalid' })).body.kind, 'text')
  await runtime.search({ query: 'legacy again' })
  assert.equal(requests.length, beforeLegacy, 'switching back uses the original providers')

  class Input extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }
  for (const fullscreen of [false, true]) for (const columns of [80, 36]) {
    await choose('deepseek-official', 'http')
    const rows = 24
    const term = new Terminal({ cols: columns, rows, allowProposedApi: true })
    class Output extends Writable {
      columns = columns; rows = rows; isTTY = true
      _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) { term.write(String(chunk), done) }
    }
    const stdin = new Input()
    const screen = () => viewportLines(term, rows).join('\n')
    const content = <SettingsScreen channel={channel} onClose={() => {}} />
    const instance = await render(fullscreen ? <AlternateScreen>{content}</AlternateScreen> : content,
      { stdout: new Output(), stdin, stderr: new Writable({ write(_chunk, _encoding, done) { done() } }), patchConsole: false, exitOnCtrlC: false })
    try {
      assert.ok(await settled(() => screen().includes('Messages')), screen())
      stdin.write('\x1b[D')
      assert.ok(await settled(() => screen().includes('‹ Search API')), screen())
      assert.ok(await settled(() => valueOf('web', 'searchProvider') === 'deepseek-search-api'),
        'the terminal selector saves through the real settings service')
    } finally { await instance.unmount(); term.dispose() }
  }
  console.log('web settings OK: live routing, API parameters, account/key auth, cancellation, failure, legacy fallback and 4 terminal layouts')
} finally {
  if (channel !== undefined) disposeChannelOwner(channel)
  globalThis.fetch = originalFetch
  await root.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}
