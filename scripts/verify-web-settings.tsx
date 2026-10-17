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
  { default: assert }, { mkdtempSync, rmSync, writeFileSync }, { tmpdir }, { join },
  { PassThrough, Writable }, React, { Terminal }, { render, AlternateScreen },
  { Settings: SettingsScreen }, { settled, viewportLines },
  { Context }, { default: Loader }, { default: Include }, { default: Settings }, { default: Web }, WebApi,
  { default: ToolRuntime }, { default: SystemPrompt }, ToolWeb, { ToolCallId },
  { createSettingsHosts, webSettingsSections }, { SettingsForm, getPath }, { createChannel }, { disposeChannelOwner },
] = await Promise.all([
  import('node:assert/strict'), import('node:fs'), import('node:os'), import('node:path'),
  import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Settings.js'), import('./lib/term-test.mjs'),
  import('@deepseek-ai/cordis'), import('@deepseek-ai/cordis-plugin-loader'), import('@deepseek-ai/cordis-plugin-include'), import('@deepseek-ai/dsh-settings'),
  import('@deepseek-ai/dsh-web'), import('@deepseek-ai/dsh-web-deepseek-api'),
  import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-tool-web'), import('@deepseek-ai/dsh-llm'),
  import('../src/dsh-adapter/channel/settings-host.js'), import('../src/dsh-adapter/settingsEditor.js'),
  import('../src/dsh-adapter/channel.js'), import('../src/dsh-adapter/channel/owner.js'),
])
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import { concreteService } from '../src/dsh-adapter/host-access.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-web-settings-'))
const root = new Context()
const originalFetch = globalThis.fetch
const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
let route = 'deepseek-official'
let responseStatus = 200
let profileWrites = 0
const credentialValues = new Map([['DEEPSEEK_API_KEY', 'fixture-key']])
const credentialWrites: Array<{ ref: string; value: string }> = []
let rejectCredentialWrite = false
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
  assert.deepEqual(webSettingsSections(root, []), [], 'bare and non-DSH compositions expose no web controls')
  assert.deepEqual(webSettingsSections(root, [{ ns: 'web', revision: 0, applies: 'restart', value: {}, user: {} }]), [],
    'older hosts do not expose a provider picker that cannot apply live')
  await root.plugin(Loader)
  root.provide('profileContext', { home })
  // Real mutation/revision/volatile handling, with only profile IO in memory.
  root.provide('configEditor', {
    entries: () => [...root.loader.entries()],
    configuration: () => [...root.loader.entries()].map(entry => ({ entry, inherited: {}, override: entry.options.config ?? {} })),
    async edit(entry, change) {
      profileWrites += 1
      await root.loader.update(entry.id, { config: change(entry.options.config ?? {}, {}) })
      await root.loader.await()
    },
  })
  root.provide('credentials', {
    resolve: async (ref: string) => credentialValues.has(ref) ? { value: credentialValues.get(ref)! } : undefined,
    set: async (ref: string, value: string) => {
      if (rejectCredentialWrite) throw new Error('fixture credential store is read-only')
      credentialWrites.push({ ref, value })
      credentialValues.set(ref, value)
    },
  })
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
  channel = createChannel({ get: (name: string) => ['settings', 'loader', 'web', 'credentials'].includes(name) ? root.get(name as never) : undefined,
    on: () => () => {}, logger: { warn() {} } } as unknown as CordisContext,
  agent, { provider: 'deepseek-official', model: 'deepseek-flash', cwd: home, activity: false, upstreamRetry: false })
  const { createChannelUi, createChannelUiLease } = await import('../src/adapter/channel/ui.js')
  const uiLease = createChannelUiLease(() => true)
  const uiChannel = createChannelUi(createChannelUi(channel, 'legacy', uiLease), 'legacy', uiLease)
  const sections = channel.settingsSections()
  assert.deepEqual(sections.map(section => section.ns), ['web', 'web-deepseek-api'], 'DSH channel exposes available web forms')
  const formFor = (ns: string) => {
    const section = sections.find(section => section.ns === ns)!
    return new SettingsForm(host, host.listNamespaces().find(view => view.ns === ns), section.fields)
  }
  const field = (ns: string, key: string) => sections.find(section => section.ns === ns)!.fields.find(field => field.path[0] === key)!
  assert.equal(sections.flatMap(section => section.fields).filter(field => field.path[0] === 'apiKeyEnv').length, 0,
    'web settings offer no variable-name input')
  const keyField = field('web', 'apiKey')
  assert.ok(keyField.secret, 'the single API key control uses the secret-field path')
  assert.equal(sections.flatMap(section => section.fields).filter(field => field.secret !== undefined).length, 1)
  const beforeKey = profileWrites
  const configured = JSON.stringify([...root.loader.entries()].map(entry => entry.options.config))
  const described = JSON.stringify(host.listNamespaces())
  const keyForm = formFor('web')
  keyForm.edit(keyField, 'sk-direct-fixture')
  assert.equal(await keyForm.save(), true, keyForm.failureMessage)
  assert.equal(credentialValues.get('DEEPSEEK_API_KEY') === 'sk-direct-fixture', true)
  assert.equal(credentialWrites.length, 1)
  assert.equal(profileWrites, beforeKey, 'key input never writes profile configuration')
  assert.equal(JSON.stringify([...root.loader.entries()].map(entry => entry.options.config)), configured)
  assert.equal(JSON.stringify(host.listNamespaces()), described, 'redacted settings contain no key literal')
  assert.equal(keyForm.field(keyField).text, '', 'saved key drafts are cleared')
  assert.equal(formFor('web').field(keyField).text, '', 'reopening never reads a key back')
  const blankKey = formFor('web')
  blankKey.edit(keyField, '')
  assert.equal(await blankKey.save(), true)
  assert.equal(credentialWrites.length, 1, 'blank input preserves the existing key')
  const refusedKey = formFor('web')
  refusedKey.edit(keyField, 'sk-refused-fixture')
  rejectCredentialWrite = true
  assert.equal(await refusedKey.save(), false, 'credential-store refusals reach the form')
  rejectCredentialWrite = false
  assert.equal(credentialWrites.length, 1)
  await assert.rejects(host.writeCredential('DEEPSEEK_API_KEY', 'sk-forged-fixture', { ...keyField.secret!.authorization }), /./,
    'plain metadata cannot forge access to a reserved credential')
  assert.equal(credentialWrites.length, 1)
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
  assert.equal(requests.at(-1)?.headers.get('authorization'), 'Bearer sk-direct-fixture')
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
    const output: string[] = []
    class Output extends Writable {
      columns = columns; rows = rows; isTTY = true
      _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) { output.push(String(chunk)); term.write(String(chunk), done) }
    }
    const stdin = new Input()
    const screen = () => viewportLines(term, rows).join('\n')
    const content = <SettingsScreen channel={uiChannel} onClose={() => {}} />
    const instance = await render(fullscreen ? <AlternateScreen>{content}</AlternateScreen> : content,
      { stdout: new Output(), stdin, stderr: new Writable({ write(_chunk, _encoding, done) { done() } }), patchConsole: false, exitOnCtrlC: false })
    try {
      assert.ok(await settled(() => screen().includes('Messages')), screen())
      stdin.write('\x1b[D')
      assert.ok(await settled(() => screen().includes('‹ Search API')), screen())
      assert.ok(await settled(() => valueOf('web', 'searchProvider') === 'deepseek-search-api'),
        'the terminal selector saves through the real settings service')
      stdin.write('\x1b[B')
      assert.ok(await settled(() => screen().split('\n').some(line => line.includes('❯') && line.includes('Fetch'))), screen())
      stdin.write('\x1b[B')
      assert.ok(await settled(() => screen().split('\n').some(line => line.includes('❯') && line.includes('API key'))), screen())
      stdin.write('\r')
      assert.ok(await settled(() => screen().includes('▌')), screen())
      const writes = credentialWrites.length
      stdin.write('sk-ui-fixture')
      assert.ok(await settled(() => screen().includes('••••')), screen())
      stdin.write('\r')
      assert.ok(await settled(() => credentialWrites.length === writes + 1), screen())
      assert.equal(output.join('').includes('sk-ui-fixture'), false, 'terminal output never echoes the key')
      assert.equal(screen().includes('Credential reference'), false)
      assert.equal(screen().includes('DEEPSEEK_API_KEY'), false)

    } finally { await instance.unmount(); term.dispose() }
  }
  let previous = { web: 'web', api: 'web-deepseek-api' }
  let decoys: string[] = []
  root.loader.builtins.decoy = { Config: WebApi.Config, apply() {} }
  for (const ids of [
    { web: 'custom-web', api: 'web-deepseek-api' },
    { web: 'web', api: 'custom-api' },
    { web: ' custom-web ', api: 'Custom.API' },
  ]) {
    root.loader.remove(previous.api)
    root.loader.remove(previous.web)
    for (const id of decoys) root.loader.remove(id)
    await root.loader.await()
    await root.loader.create({ id: ids.web, name: 'cordis:web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } })
    await root.loader.create({ id: ids.api, name: 'cordis:webApi', config: { baseURL: 'https://web-fixture.invalid/custom' } })
    // A different plugin may reuse an old row ID; it must not receive web edits.
    decoys = ['web', 'web-deepseek-api'].filter(id => id !== ids.web && id !== ids.api)
    for (const id of decoys) await root.loader.create({ id, name: 'cordis:decoy', config: { count: 19 } })
    await root.loader.await()
    const custom = channel.settingsSections()
    assert.deepEqual(custom.map(section => section.ns), [ids.web, ids.api], 'web forms follow their Config owners, not default row IDs')
    const selection = custom.find(section => section.ns === ids.web)!
    const selectionForm = new SettingsForm(host, host.listNamespaces().find(view => view.ns === ids.web), selection.fields)
    selectionForm.edit(selection.fields.find(field => field.path[0] === 'searchProvider')!, 'deepseek-search-api')
    selectionForm.edit(selection.fields.find(field => field.path[0] === 'fetchProvider')!, 'deepseek-fetch-api')
    assert.equal(await selectionForm.save(), true, selectionForm.failureMessage)
    const api = custom.find(section => section.ns === ids.api)!
    const apiForm = new SettingsForm(host, host.listNamespaces().find(view => view.ns === ids.api), api.fields)
    apiForm.edit(api.fields.find(field => field.path[0] === 'count')!, '7')
    assert.equal(await apiForm.save(), true, apiForm.failureMessage)
    assert.equal(valueOf(ids.web, 'searchProvider'), 'deepseek-search-api')
    assert.equal(valueOf(ids.api, 'count'), 7)
    for (const id of decoys) assert.equal(valueOf(id, 'count'), 19, 'unrelated namespaces remain unchanged')
    await root.web.search({ query: 'custom owner' })
    assert.equal(requests.at(-1)?.body.count, 7, 'the real provider reads its custom namespace after saving')
    previous = ids
  }
  root.loader.remove(previous.api)
  root.loader.remove(previous.web)
  for (const id of decoys) root.loader.remove(id)
  await root.loader.await()
  const includedFile = join(home, 'web-profile.json')
  writeFileSync(includedFile, JSON.stringify([
    { id: 'included-web', name: 'cordis:web', config: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' } },
    { id: 'included-api', name: 'cordis:webApi', config: { baseURL: 'https://web-fixture.invalid/included' } },
  ]))
  root.loader.builtins.include = Include
  await root.loader.create({ id: 'included', name: 'cordis:include', config: { path: pathToFileURL(includedFile).href } })
  await root.loader.await()
  assert.equal(root.loader.resolve('included:included-api').id, 'included:included-api', 'the fixture uses a real nested entry tree')
  const included = channel.settingsSections()
  assert.deepEqual(included.map(section => section.ns), ['included-web', 'included-api'], 'Include tree paths are not settings namespaces')
  const includedApi = included.find(section => section.ns === 'included-api')!
  const includedForm = new SettingsForm(host, host.listNamespaces().find(view => view.ns === includedApi.ns), includedApi.fields)
  includedForm.edit(includedApi.fields.find(field => field.path[0] === 'count')!, '9')
  assert.equal(await includedForm.save(), true, includedForm.failureMessage)
  assert.equal(valueOf('included-api', 'count'), 9)
  await root.web.search({ query: 'included owner' })
  assert.equal(requests.at(-1)?.body.count, 9, 'included Config owners receive the saved API settings')
  const staleField = included.flatMap(section => section.fields).find(field => field.secret !== undefined)!
  const beforeRedirect = credentialWrites.length
  await host.write('included-api', [{ op: 'set', path: ['apiKeyEnv'], value: 'TEST_SEARCH_KEY' }])
  await assert.rejects(host.writeCredential(staleField.secret!.ref, 'sk-stale-fixture', staleField.secret!.authorization), /./)
  assert.equal(credentialWrites.length, beforeRedirect, 'a changed credential target cannot redirect an open key editor')
  const freshSections = channel.settingsSections()
  const freshWeb = freshSections.find(section => section.ns === 'included-web')!
  const freshField = freshWeb.fields.find(field => field.secret !== undefined)!
  const freshForm = new SettingsForm(host, host.listNamespaces().find(view => view.ns === freshWeb.ns), freshWeb.fields)
  freshForm.edit(freshField, 'sk-custom-fixture')
  assert.equal(await freshForm.save(), true, freshForm.failureMessage)
  route = 'deepseek-official'
  await root.web.search({ query: 'saved key' })
  assert.equal(requests.at(-1)?.headers.get('authorization') === 'Bearer sk-custom-fixture', true,
    'the next API operation uses the key entered through the single key control')
  await assert.rejects(host.writeCredential(keyField.secret!.ref, 'sk-disposed-fixture', keyField.secret!.authorization), /./)
  assert.equal(credentialWrites.length, beforeRedirect + 1, 'disposed Config owners cannot write credentials')
  const Schema = (await import('@deepseek-ai/schemastery')).default
  root.loader.builtins.messages = {
    name: 'web-search-deepseek',
    Config: Schema.object({ apiKeyEnv: Schema.string().default('TEST_MESSAGES_KEY').volatile() }),
    apply() {},
  }
  await root.loader.create({ id: 'custom-messages', name: 'cordis:messages', config: {} })
  await root.loader.await()
  await host.write('included-web', [{ op: 'set', path: ['searchProvider'], value: 'deepseek-official' }])
  const messageSections = channel.settingsSections()
  const messageWeb = messageSections.find(section => section.ns === 'included-web')!
  assert.equal(messageSections.flatMap(section => section.fields).filter(field => field.secret !== undefined).length, 1,
    'Messages and Search API share one key input')
  const messageField = messageWeb.fields.find(field => field.secret !== undefined)!
  const messageForm = new SettingsForm(host, host.listNamespaces().find(view => view.ns === messageWeb.ns), messageWeb.fields)
  messageForm.edit(messageField, 'sk-messages-fixture')
  assert.equal(await messageForm.save(), true, messageForm.failureMessage)
  assert.equal(credentialWrites.at(-1)?.ref, 'TEST_MESSAGES_KEY', 'the key input follows the selected search API')
  assert.equal(credentialValues.get('TEST_SEARCH_KEY') === 'sk-custom-fixture', true, 'switching APIs preserves the other key')
  console.log('web settings OK: direct masked key input and credential-store writes, custom Config owners, live routing, API parameters, account/key auth, cancellation, failure, legacy fallback and 4 terminal layouts')
} finally {
  if (channel !== undefined) disposeChannelOwner(channel)
  globalThis.fetch = originalFetch
  await root.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}
