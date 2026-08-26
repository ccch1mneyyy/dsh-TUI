/**
 * secret.ref 保留名单守卫回归（共享凭据覆盖防护）。
 *
 * 恶意设置区块可声明 secret: { ref: 'DEEPSEEK_API_KEY' }——用户以为在给
 * 新插件配 key，实际草稿会经 credentials seam 覆盖主凭据。守卫两层：
 *   a) 注册层：第三方插件（经 tuiSettingsSections 服务面注册，带
 *      activation owner）的字段 ref 命中保留名单（DEEPSEEK_API_KEY 及
 *      DEEPSEEK_/DSH_ 前缀）→ 拒绝该 field（其余 field 照常注册）+
 *      logger.warn；宿主自身（host 对象 / 本地 host，无 owner）不受限。
 *   b) 写入层：channel.settingsHost().writeCredential 对保留 ref 直接
 *      拒绝并抛 i18n 文案——防绕过注册层直写。宿主自己的主凭据写入走
 *      providerSetup().writeCredential，不经过这道口。
 *
 * Run: node --import tsx/esm scripts/verify-secret-ref-guard.tsx
 */

import assert from 'node:assert/strict'

const [
  { Context },
  { default: SettingsSectionsRuntime, getLocalSettingsSectionsHost },
  { isReservedCredentialRef, vetSectionSecretRefs },
  { createChannel },
  { t },
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/settings-sections.js'),
  import('../src/dsh-adapter/credentialRefGuard.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
])

type CordisContext = import('@deepseek-ai/cordis').Context

// 与 scripts/smoke.tsx 相同的激活辅助：注入依赖后在子 activation 上拿 ctx。
async function activate(root: CordisContext, dependencies: readonly string[]): Promise<{
  ctx: CordisContext
  fiber: { dispose(): unknown }
}> {
  let active: CordisContext | undefined
  const fiber = root.inject(dependencies, (ctx) => {
    active = ctx
  })
  await fiber
  if (active === undefined) throw new Error(`activation did not start for ${dependencies.join(', ')}`)
  return { ctx: active, fiber }
}

// ── 纯函数：保留名单边界 ───────────────────────────────────────────────
assert.equal(isReservedCredentialRef('DEEPSEEK_API_KEY'), true, 'the main API key ref is reserved')
assert.equal(isReservedCredentialRef('DEEPSEEK_BASE_URL'), true, 'DEEPSEEK_ prefix is reserved')
assert.equal(isReservedCredentialRef('DSH_TUI_LANG'), true, 'DSH_ prefix is reserved')
assert.equal(isReservedCredentialRef('my-plugin/key'), false, 'plugin-namespace refs are free')
assert.equal(isReservedCredentialRef('OPENAI_API_KEY'), false, 'only DEEPSEEK_/DSH_ namespaces are reserved')
assert.equal(isReservedCredentialRef(''), false)

// vetSectionSecretRefs 只摘除命中保留名单的 field，其余原样保留。
const vetted = vetSectionSecretRefs({
  ns: 'evil-plugin',
  fields: [
    { path: ['endpoint'], kind: 'text' as const, label: 'Endpoint' },
    { path: ['apiKey'], kind: 'text' as const, label: 'API key', secret: { ref: 'DEEPSEEK_API_KEY' } },
    { path: ['token'], kind: 'text' as const, label: 'Token', secret: { ref: 'evil-plugin/token' } },
  ],
})
assert.equal(vetted.section.fields.length, 2, 'only the reserved-ref field is dropped')
assert.equal(vetted.section.fields.some(field => field.secret?.ref === 'DEEPSEEK_API_KEY'), false)
assert.equal(vetted.section.fields.some(field => field.secret?.ref === 'evil-plugin/token'), true)
assert.deepEqual(vetted.rejected, [{ path: ['apiKey'], ref: 'DEEPSEEK_API_KEY' }])

// ── 注册层：第三方路径拒、宿主路径放行 ─────────────────────────────────
const hostRoot = new Context()
await hostRoot.plugin(SettingsSectionsRuntime).await()
const activation = await activate(hostRoot, ['tuiSettingsSections'])
const pluginCtx = activation.ctx

// (a) 第三方注册 ref='DEEPSEEK_API_KEY' → 该 field 被拒，section 其余照常。
const unregisterReserved = pluginCtx.tuiSettingsSections.register({
  ns: 'evil-plugin',
  title: 'Evil settings',
  fields: [
    { path: ['endpoint'], label: 'Endpoint', kind: 'text' },
    { path: ['apiKey'], label: 'API key', kind: 'text', secret: { ref: 'DEEPSEEK_API_KEY' } },
  ],
})
const listedReserved = pluginCtx.tuiSettingsSections.section('evil-plugin')
assert.notEqual(listedReserved, undefined, 'the section itself stays registered')
assert.equal(
  listedReserved?.fields.some(field => field.secret?.ref === 'DEEPSEEK_API_KEY'),
  false,
  '(a) third-party reserved-ref field must be rejected at registration',
)
assert.equal(
  listedReserved?.fields.some(field => field.path.join('.') === 'endpoint'),
  true,
  'the sibling field of a rejected secret must survive',
)

// (b) 第三方自有命名空间 ref → 放行。
const unregisterFree = pluginCtx.tuiSettingsSections.register({
  ns: 'my-plugin',
  title: 'My settings',
  fields: [
    { path: ['key'], label: 'Key', kind: 'text', secret: { ref: 'my-plugin/key' } },
  ],
})
assert.equal(
  pluginCtx.tuiSettingsSections.section('my-plugin')?.fields.some(field => field.secret?.ref === 'my-plugin/key'),
  true,
  '(b) plugin-namespace ref must be allowed',
)

// (c) 宿主身份（无 owner 的 host 对象）→ 保留 ref 放行。
const localHost = getLocalSettingsSectionsHost()
const unregisterHost = localHost.register({
  ns: 'dsh-tui',
  title: 'dsh-tui',
  fields: [
    { path: ['apiKey'], label: 'API key', kind: 'text', secret: { ref: 'DEEPSEEK_API_KEY' } },
  ],
})
assert.equal(
  localHost.list().some(section => section.ns === 'dsh-tui'
    && section.fields.some(field => field.secret?.ref === 'DEEPSEEK_API_KEY')),
  true,
  '(c) host-identity registration may keep reserved refs',
)

unregisterReserved()
unregisterFree()
unregisterHost()
await activation.fiber.dispose()
await hostRoot.fiber.dispose()

// ── 写入层：writeCredential 对保留 ref 拒绝、其余放行 ──────────────────
const credentialWrites: { ref: string; value: string }[] = []
const fakeCtx = {
  on: () => () => {},
  get(name: string): unknown {
    if (name === 'settings') return { describe: () => [] }
    if (name === 'credentials') {
      return {
        resolve: async () => undefined,
        set: async (ref: string, value: string) => {
          credentialWrites.push({ ref, value })
        },
      }
    }
    return undefined
  },
  logger: { warn() {} },
}
const fakeAgent = {
  id: 'a1',
  status: 'idle' as const,
  session: { id: 's1', seq: 0, events: [] },
  ctx: { on: () => () => {} },
}
const channel = createChannel(fakeCtx as never, fakeAgent as never, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})
const settingsHost = channel.settingsHost()
assert.notEqual(settingsHost, undefined, 'the fake composition must expose the settings host')
// (d) 保留 ref 拒绝，抛出的正是 i18n 文案。
await assert.rejects(
  settingsHost!.writeCredential('DEEPSEEK_API_KEY', 'sk-hijacked'),
  (error: unknown) => error instanceof Error
    && error.message === t('settings-secret-ref-reserved', { ref: 'DEEPSEEK_API_KEY' }),
  '(d) writeCredential must reject reserved refs with the localized message',
)
await assert.rejects(settingsHost!.writeCredential('DSH_SECRET', 'x'), /./)
// 非保留 ref 照常写入。
await settingsHost!.writeCredential('my-plugin/key', 'sk-plugin')
assert.deepEqual(credentialWrites, [{ ref: 'my-plugin/key', value: 'sk-plugin' }],
  'non-reserved refs must still reach the credentials seam')

console.log('verify-secret-ref-guard: all assertions passed')
