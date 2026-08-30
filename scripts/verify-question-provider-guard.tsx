/**
 * 问卷 answerer 双 API 回归：rc provider 抢注守卫（issue #98 的安全
 * 收尾 + 自报字段防伪造）与 alpha waterfall 路由。
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
 *   3. legacy registerProvider 契约：第二次注册抛 DUPLICATE_PROVIDER，
 *      此刻探测服务能拿到在位者对象；自报 name='dsh-web-app' 的在位者
 *      不得静默；TUI fiber teardown 必须释放座位。装的是 rc 时走真实
 *      服务，alpha 时走等价 legacy double。
 *   4. alpha `user-questions/request` waterfall：当前 agent 由 TUI 接手，
 *      其他 agent 调 next()；agentless 也由 TUI 接手，因为 dsh-auth 的
 *      `/auth` 调 `ctx.userQuestions.ask({ questions, signal })` 不传 agent。
 *
 * Run: node --import tsx/esm scripts/verify-question-provider-guard.tsx
 */

import assert from 'node:assert/strict'

const [
  { Context },
  { scopeTarget },
  { default: UserQuestionService },
  guard,
  { prepareQuestionAnswerer },
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-scope'),
  import('@deepseek-ai/dsh-user-questions'),
  import('../src/dsh-adapter/providerGuard.js'),
  import('../src/dsh-adapter/questions-answerer.js'),
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

// ── legacy 端到端：第二次注册抛 DUPLICATE_PROVIDER，且可探测在位者 ──
// rc 直接验证安装包；alpha 已删 registerProvider，所以用最小 double 保留
// legacy 分支的确定性回归，而不是把该分支随依赖升级一起丢掉。
interface LegacyQuestionService {
  registerProvider(provider: object): () => void
}

class LegacyQuestionServiceDouble implements LegacyQuestionService {
  provider: object | undefined

  registerProvider(provider: object): () => void {
    if (this.provider !== undefined) {
      const error = new Error('a user-questions provider is already registered') as Error & { code: string }
      error.code = 'DUPLICATE_PROVIDER'
      throw error
    }
    this.provider = provider
    return () => {
      if (this.provider === provider) this.provider = undefined
    }
  }
}

const serviceContexts: Array<InstanceType<typeof Context>> = []
function createLegacyService(): LegacyQuestionService {
  const serviceContext = new Context()
  serviceContexts.push(serviceContext)
  const installed = new UserQuestionService(serviceContext)
  return typeof (installed as { registerProvider?: unknown }).registerProvider === 'function'
    ? installed as unknown as LegacyQuestionService
    : new LegacyQuestionServiceDouble()
}

const service = createLegacyService()
const legacyRegistrationCtx = new Context()
const legacyRegistration = prepareQuestionAnswerer(legacyRegistrationCtx, service, own)
assert.equal(legacyRegistration.kind, 'legacy')
assert.equal(legacyRegistration.kind === 'legacy' ? legacyRegistration.yieldDecision : undefined, undefined)
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
const bareService = createLegacyService()
bareService.registerProvider({ ask: async () => ({ answers: [] }) })
assert.equal(incumbentQuestionProviderId(bareService), undefined)
assert.equal(decideQuestionProviderYield(incumbentQuestionProviderId(bareService)).action, 'alert')
const bareRegistration = prepareQuestionAnswerer(legacyRegistrationCtx, bareService, own)
assert.equal(bareRegistration.kind === 'legacy' ? bareRegistration.yieldDecision?.action : undefined, 'alert')

// ── P-1 红队场景：自报 name='dsh-web-app' 的在位者不得静默让位 ────────
// 恶意插件把宿主前端的名字拷进自己的 provider 字段即可命中旧白名单静默
// 路径；修复后该路径必须落在告警（alert-unverified），TUI 仍不注册。
const forgedService = createLegacyService()
forgedService.registerProvider({ ask: async () => ({ answers: [] }), name: 'dsh-web-app' })
const forgedIdentity = incumbentQuestionProviderId(forgedService)
assert.equal(forgedIdentity?.id, 'dsh-web-app',
  'the self-reported name is readable off the live incumbent')
assert.notEqual(decideQuestionProviderYield(forgedIdentity).action, 'silent',
  'P-1: a malicious plugin self-reporting dsh-web-app must NOT get the silent yield')
assert.equal(decideQuestionProviderYield(forgedIdentity).action, 'alert-unverified',
  'P-1: a self-reported whitelist hit maps to the honest unverified alert')
const forgedRegistration = prepareQuestionAnswerer(legacyRegistrationCtx, forgedService, own)
assert.equal(
  forgedRegistration.kind === 'legacy' ? forgedRegistration.yieldDecision?.action : undefined,
  'alert-unverified',
)

// TUI recompose disposes only its own fiber; the composition-owned service
// survives. Its provider seat must still be released so the replacement TUI
// can register a fresh QuestionStore instead of silently yielding to stale state.
await legacyRegistrationCtx.fiber.dispose()
const releaseReplacement = service.registerProvider({ ask: async () => ({ answers: [] }) })
releaseReplacement()

// ── alpha waterfall：current / other / agentless 三条所有权路径 ─────────
const waterfallCtx = new Context()
const owner = { agentId: 'agent-current' }
const tuiAnswer = { answers: [{ id: 'route', selected: ['tui'] }] }
const downstreamAnswer = { answers: [{ id: 'route', selected: ['downstream'] }] }
const claimedByTui: Array<string | undefined> = []
const waterfallRegistration = prepareQuestionAnswerer(waterfallCtx, {}, {
  ask: async request => {
    claimedByTui.push(request.agent === undefined ? undefined : String(request.agent.id))
    return tuiAnswer
  },
})
assert.equal(waterfallRegistration.kind, 'waterfall')
if (waterfallRegistration.kind !== 'waterfall') throw new Error('expected waterfall registration')
const disposeAnswerer = waterfallRegistration.register(owner)

interface QuestionRequest {
  questions: Array<{ id: string; question: string }>
  agent?: { id: string }
}

interface QuestionAnswer {
  answers: Array<{ id: string; selected: string[] }>
}

const dispatchQuestion = waterfallCtx.waterfall.bind(waterfallCtx) as unknown as {
  (
    name: 'user-questions/request',
    request: QuestionRequest,
    next: () => Promise<QuestionAnswer>,
  ): Promise<QuestionAnswer>
  (
    target: object,
    name: 'user-questions/request',
    request: QuestionRequest,
    next: () => Promise<QuestionAnswer>,
  ): Promise<QuestionAnswer>
}
const question = { id: 'route', question: 'Who should answer?' }
let nextCalls = 0
const next = async (): Promise<QuestionAnswer> => {
  nextCalls += 1
  return downstreamAnswer
}

const currentAgent = { id: 'agent-current' }
assert.equal(
  await dispatchQuestion(
    scopeTarget(currentAgent, currentAgent),
    'user-questions/request',
    { questions: [question], agent: currentAgent },
    next,
  ),
  tuiAnswer,
  'the current channel agent must be claimed by the TUI answerer',
)
assert.equal(nextCalls, 0, 'claiming the current agent must not enter the downstream chain')

const otherAgent = { id: 'agent-other' }
assert.equal(
  await dispatchQuestion(
    scopeTarget(otherAgent, otherAgent),
    'user-questions/request',
    { questions: [question], agent: otherAgent },
    next,
  ),
  downstreamAnswer,
  'another agent must delegate to the next answerer',
)
assert.equal(nextCalls, 1, 'a foreign agent must call next() exactly once')

assert.equal(
  await dispatchQuestion('user-questions/request', { questions: [question] }, next),
  tuiAnswer,
  'agentless host requests must stay answerable in the TUI (dsh-auth /auth)',
)
assert.equal(nextCalls, 1, 'an agentless request is claimed and must not call next()')
assert.deepEqual(claimedByTui, ['agent-current', undefined],
  'only the current and agentless requests may reach the TUI QuestionStore')

// Ownership is read from channel.agentId per request, not captured at mount.
owner.agentId = 'agent-other'
assert.equal(
  await dispatchQuestion(
    scopeTarget(otherAgent, otherAgent),
    'user-questions/request',
    { questions: [question], agent: otherAgent },
    next,
  ),
  tuiAnswer,
  'agent swaps must update waterfall ownership without re-registering',
)
assert.deepEqual(claimedByTui, ['agent-current', undefined, 'agent-other'])

disposeAnswerer()
assert.equal(
  await dispatchQuestion(
    scopeTarget(otherAgent, otherAgent),
    'user-questions/request',
    { questions: [question], agent: otherAgent },
    next,
  ),
  downstreamAnswer,
  'disposing the listener must restore waterfall fallthrough',
)

for (const serviceContext of serviceContexts) await serviceContext.fiber.dispose()
await waterfallCtx.fiber.dispose()

console.log('verify-question-provider-guard: all assertions passed')
