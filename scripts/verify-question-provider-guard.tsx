/**
 * 问卷 provider 抢注守卫回归（issue #98 的安全收尾 + 自报字段防伪造）。
 *
 * dsh-user-questions 的 DUPLICATE_PROVIDER 错误只带固定 message + code，
 * 不携带在位者身份；服务对象运行时把在位 provider 存在 `provider`
 * 属性上（TS 私有、结构可达）。守卫契约：
 *   1. 纯判定函数 decideQuestionProviderYield：静默让位只授予宿主可
 *      验证的白名单在位者（verified: true，来自本 TUI 的私有 symbol
 *      标记）；在位者【自报】的 name/hostId/id 命中白名单也不得静默
 *      ——字段可被任意插件拷贝伪造（红队 P-1），改走 alert-unverified
 *      诚实告知；第三方 id / 无身份信息 → 保守告警。
 *   2. 在位者身份提取 incumbentQuestionProviderId：返回
 *      { id, verified }——symbol 标记 verified: true（进程内不可伪造），
 *      自报字段 verified: false；裸 { ask } provider 无身份。
 *   3. 对真实 UserQuestionService 的端到端：第二次 registerProvider 抛
 *      DUPLICATE_PROVIDER，此刻探测服务能拿到在位者对象；自报
 *      name='dsh-web-app' 的在位者不得静默。
 *
 * Run: node --import tsx/esm scripts/verify-question-provider-guard.tsx
 */

import assert from 'node:assert/strict'

const [
  { Context },
  { default: UserQuestionService },
  guard,
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-user-questions'),
  import('../src/dsh-adapter/providerGuard.js'),
])

const {
  decideQuestionProviderYield,
  incumbentQuestionProviderId,
  tagTuiQuestionProvider,
  QUESTION_PROVIDER_HOST_WHITELIST,
} = guard

// ── 白名单本身就是宿主前端集合 ─────────────────────────────────────────
assert.deepEqual(
  [...QUESTION_PROVIDER_HOST_WHITELIST].sort(),
  ['dsh-tui', 'dsh-web-app'],
  'host whitelist must be exactly dsh-tui + dsh-web-app',
)

// ── 纯判定：宿主验证的白名单在位 → 静默；自报白名单名 → 诚实告警 ────
assert.equal(decideQuestionProviderYield({ id: 'dsh-tui', verified: true }).action, 'silent',
  'the symbol-verified TUI (recompose leftover) must yield silently')
assert.equal(decideQuestionProviderYield({ id: 'dsh-web-app', verified: true }).action, 'silent',
  'any host-verified whitelisted identity earns the silent yield')
assert.equal(decideQuestionProviderYield({ id: 'dsh-web-app', verified: false }).action, 'alert-unverified',
  'P-1: a self-reported whitelisted name is forgeable — honest alert, never silent')
assert.equal(decideQuestionProviderYield({ id: 'evil-quiz-hijacker', verified: false }).action, 'alert',
  'any third-party self-reported incumbent must raise the alert path')
assert.equal(decideQuestionProviderYield({ id: 'evil-quiz-hijacker', verified: true }).action, 'alert',
  'a verified identity outside the whitelist still alerts')
assert.equal(decideQuestionProviderYield(undefined).action, 'alert',
  'unknown identity must default to the alert path (conservative)')
assert.equal(decideQuestionProviderYield({ id: 'evil-quiz-hijacker', verified: false }).incumbentId, 'evil-quiz-hijacker',
  'alert decisions must carry the incumbent id for the notice text')
assert.equal(decideQuestionProviderYield({ id: 'dsh-web-app', verified: false }).incumbentId, 'dsh-web-app',
  'the unverified-host alert must carry the self-reported id for the notice text')
assert.equal(decideQuestionProviderYield(undefined).incumbentId, undefined)

// ── 身份提取：本 TUI 的 symbol 标记（宿主可验证） ─────────────────────
const own: { ask(request: never): Promise<never> } = { ask: async request => request }
tagTuiQuestionProvider(own)
assert.deepEqual(incumbentQuestionProviderId({ provider: own }), { id: 'dsh-tui', verified: true },
  'the symbol-tagged provider must be recognized as this TUI, host-verified')

// ── 身份提取：在位者自报字段可读但不可信 / 裸 provider ────────────────
assert.deepEqual(
  incumbentQuestionProviderId({ provider: { ask: async () => ({ answers: [] }), name: 'dsh-web-app' } }),
  { id: 'dsh-web-app', verified: false },
  'an explicit name marker is readable but never host-verified',
)
assert.equal(
  incumbentQuestionProviderId({ provider: { ask: async () => ({ answers: [] }) } }),
  undefined,
  'a bare provider object carries no identity → conservative alert',
)
assert.equal(incumbentQuestionProviderId({}), undefined,
  'a service without any incumbent must probe as no identity')
assert.equal(incumbentQuestionProviderId({ provider: null }), undefined)

// 无标记的对象拿不到 symbol 标记值：第三方无法通过拷贝字段伪造 dsh-tui。
const impostor = { ask: async () => ({ answers: [] }) }
assert.equal(incumbentQuestionProviderId({ provider: impostor }), undefined)

// ── 端到端：真实服务的第二次注册抛 DUPLICATE_PROVIDER，且可探测在位者 ──
const ctx = new Context()
const service = new UserQuestionService(ctx)
service.registerProvider(own)
let duplicateCode: string | undefined
try {
  service.registerProvider({ ask: async () => ({ answers: [] }) })
} catch (error) {
  duplicateCode = (error as { code?: string }).code
}
assert.equal(duplicateCode, 'DUPLICATE_PROVIDER')
// 抢注失败后服务上仍在位的是 symbol 标记过的自身 provider。
assert.deepEqual(incumbentQuestionProviderId(service), { id: 'dsh-tui', verified: true },
  'the live service must expose the incumbent through its provider property')
assert.equal(decideQuestionProviderYield(incumbentQuestionProviderId(service)).action, 'silent',
  'the symbol-verified incumbent keeps the silent yield')

// 换成无身份在位者：同样的探测路径落到保守告警。
const bareCtx = new Context()
const bareService = new UserQuestionService(bareCtx)
bareService.registerProvider({ ask: async () => ({ answers: [] }) })
assert.equal(incumbentQuestionProviderId(bareService), undefined)
assert.equal(decideQuestionProviderYield(incumbentQuestionProviderId(bareService)).action, 'alert')

// ── P-1 红队场景：自报 name='dsh-web-app' 的在位者不得静默让位 ────────
// 恶意插件把宿主前端的名字拷进自己的 provider 字段即可命中旧白名单静默
// 路径；修复后该路径必须落在告警（alert-unverified），TUI 仍不注册。
const forgedCtx = new Context()
const forgedService = new UserQuestionService(forgedCtx)
forgedService.registerProvider({ ask: async () => ({ answers: [] }), name: 'dsh-web-app' })
const forgedIdentity = incumbentQuestionProviderId(forgedService)
assert.equal(forgedIdentity?.id, 'dsh-web-app',
  'the self-reported name is readable off the live incumbent')
assert.notEqual(decideQuestionProviderYield(forgedIdentity).action, 'silent',
  'P-1: a malicious plugin self-reporting dsh-web-app must NOT get the silent yield')
assert.equal(decideQuestionProviderYield(forgedIdentity).action, 'alert-unverified',
  'P-1: a self-reported whitelist hit maps to the honest unverified alert')

await ctx.fiber.dispose()
await bareCtx.fiber.dispose()
await forgedCtx.fiber.dispose()

console.log('verify-question-provider-guard: all assertions passed')
