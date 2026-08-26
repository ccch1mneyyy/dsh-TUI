/**
 * 问卷 provider 抢注守卫回归（issue #98 的安全收尾）。
 *
 * dsh-user-questions 的 DUPLICATE_PROVIDER 错误只带固定 message + code，
 * 不携带在位者身份；服务对象运行时把在位 provider 存在 `provider`
 * 属性上（TS 私有、结构可达）。守卫契约：
 *   1. 纯判定函数 decideQuestionProviderYield：在位者是宿主前端白名单
 *      （dsh-web-app / dsh-tui）→ 静默让位；任何第三方 id → 告警；
 *      无身份信息 → 保守默认告警。
 *   2. 在位者身份提取 incumbentQuestionProviderId：本 TUI 注册时打上的
 *      私有 symbol 标记可识别自身（重启/recompose 场景）；在位者显式
 *      携带 name/hostId/id 标记时可读出；裸 { ask } provider 无身份。
 *   3. 对真实 UserQuestionService 的端到端：第二次 registerProvider 抛
 *      DUPLICATE_PROVIDER，此刻探测服务能拿到在位者对象。
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

// ── 纯判定：白名单在位 → 静默；第三方/无身份 → 告警 ───────────────────
assert.equal(decideQuestionProviderYield('dsh-web-app').action, 'silent',
  'dsh-web-app incumbent must yield silently (issue #98 compat)')
assert.equal(decideQuestionProviderYield('dsh-tui').action, 'silent',
  'this TUI (recompose leftover) must yield silently')
assert.equal(decideQuestionProviderYield('evil-quiz-hijacker').action, 'alert',
  'any third-party incumbent must raise the alert path')
assert.equal(decideQuestionProviderYield(undefined).action, 'alert',
  'unknown identity must default to the alert path (conservative)')
assert.equal(decideQuestionProviderYield('evil-quiz-hijacker').incumbentId, 'evil-quiz-hijacker',
  'alert decisions must carry the incumbent id for the notice text')
assert.equal(decideQuestionProviderYield(undefined).incumbentId, undefined)

// ── 身份提取：本 TUI 的 symbol 标记 ────────────────────────────────────
const own: { ask(request: never): Promise<never> } = { ask: async request => request }
tagTuiQuestionProvider(own)
assert.equal(incumbentQuestionProviderId({ provider: own }), 'dsh-tui',
  'the symbol-tagged provider must be recognized as this TUI')

// ── 身份提取：在位者显式标记 / 裸 provider ─────────────────────────────
assert.equal(
  incumbentQuestionProviderId({ provider: { ask: async () => ({ answers: [] }), name: 'dsh-web-app' } }),
  'dsh-web-app',
  'an explicit name marker must be honored (future host cooperation)',
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
assert.equal(incumbentQuestionProviderId(service), 'dsh-tui',
  'the live service must expose the incumbent through its provider property')
assert.equal(decideQuestionProviderYield(incumbentQuestionProviderId(service)).action, 'silent')

// 换成无身份在位者：同样的探测路径落到保守告警。
const bareCtx = new Context()
const bareService = new UserQuestionService(bareCtx)
bareService.registerProvider({ ask: async () => ({ answers: [] }) })
assert.equal(incumbentQuestionProviderId(bareService), undefined)
assert.equal(decideQuestionProviderYield(incumbentQuestionProviderId(bareService)).action, 'alert')

await ctx.fiber.dispose()
await bareCtx.fiber.dispose()

console.log('verify-question-provider-guard: all assertions passed')
