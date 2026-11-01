/**
 * verify-onboarding-provider-plan — 首次引导"账号与模型接入"的判定回归。
 *
 * 钉住的契约（都是纯函数，不需要终端、channel 或凭据库）：
 *
 *   A. 目录归约：`modelRefsOf` 只取 diff 需要的身份，保持目录顺序。
 *   B. 三分支：基线差分 0 个 → `none`、1 个 → `auto`、多个 → `ask`——这正是
 *      产品口径"没有就不问、只有一个直接设为默认、多个才问"。
 *   C. 差分幂等：同一基线重复调用结果一致；基线里已有的模型不再算"新增"。
 *   D. provider 过滤：登录某个账号时只看它的模型，不把别的账号顺带算进来。
 *   E. 默认预选：当前路由若在新增里就选它（重新登录当前 provider 不该挪默认），
 *      否则取第一个。
 *   G. 多 provider：`multiProvider` 与首现顺序分组。
 *
 * （没有 F 组：多个新增时引导只问"哪个当默认"，不做多选——登录后的模型全部可用，
 * 没有可保存的"接入子集"。单选的落点由 verify-onboarding-wizard 的 J4/J8/J10/J18 钉住。）
 *
 * 运行：node --import tsx/esm scripts/verify-onboarding-provider-plan.ts
 */
import {
  addedModelRefs,
  addedProviderOrder,
  modelRefKey,
  modelRefsOf,
  planModelAdoption,
  type ProviderModelRef,
} from '../src/components/onboardingProviderPlan.js'

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const ref = (provider: string, id: string, name = id): ProviderModelRef => ({ provider, id, name })

// ── A. 目录归约 ────────────────────────────────────────────────────────────
{
  const rows = modelRefsOf([
    { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { provider: 'xai', id: 'grok-4', name: 'Grok 4' },
  ])
  check('A1 modelRefsOf 取身份、保序',
    rows.length === 2 && rows[0]!.provider === 'deepseek'
    && rows[0]!.name === 'DeepSeek Chat' && rows[1]!.id === 'grok-4')
  check('A2 modelRefKey 是 provider/id', modelRefKey(ref('a', 'b')) === 'a/b')
}

// ── B. 0 / 1 / N 三分支 ────────────────────────────────────────────────────
{
  const none = planModelAdoption({ baseline: [ref('deepseek', 'deepseek-chat')], current: [ref('deepseek', 'deepseek-chat')] })
  check('B1 没有新增 → none，且不给默认',
    none.decision === 'none' && none.added.length === 0 && none.defaultPick === undefined)

  const one = planModelAdoption({
    baseline: [],
    current: [ref('xai', 'grok-4')],
    provider: 'xai',
  })
  check('B2 只有一个新增 → auto，并把它作为默认',
    one.decision === 'auto' && one.added.length === 1 && one.defaultPick?.id === 'grok-4')

  const many = planModelAdoption({
    baseline: [],
    current: [ref('xai', 'grok-4'), ref('xai', 'grok-4-mini'), ref('xai', 'grok-3')],
    provider: 'xai',
  })
  check('B3 多个新增 → ask',
    many.decision === 'ask' && many.added.length === 3 && many.provider === 'xai')
}

// ── C. 差分幂等 / 基线语义 ─────────────────────────────────────────────────
{
  const baseline = [ref('deepseek', 'deepseek-chat'), ref('deepseek', 'deepseek-reasoner')]
  const current = [
    ref('deepseek', 'deepseek-chat'),
    ref('deepseek', 'deepseek-reasoner'),
    ref('deepseek', 'deepseek-coder'),
    ref('deepseek', 'deepseek-coder'), // 目录里重复的一行只能算一次
  ]
  const first = addedModelRefs(baseline, current)
  const second = addedModelRefs(baseline, current)
  check('C1 基线里已有的不算新增，重复行去重',
    first.length === 1 && first[0]!.id === 'deepseek-coder',
    JSON.stringify(first))
  check('C2 同一基线重复调用结果一致（幂等）',
    JSON.stringify(first) === JSON.stringify(second))
  check('C3 基线为空时全部算新增（空目录 → 登录后满目录），重复行仍去重',
    addedModelRefs([], current).length === 3)
}

// ── D. provider 过滤 ───────────────────────────────────────────────────────
{
  const baseline: readonly ProviderModelRef[] = []
  const current = [ref('xai', 'grok-4'), ref('anthropic', 'claude-sonnet-4-5'), ref('xai', 'grok-3')]
  const plan = planModelAdoption({ baseline, current, provider: 'xai' })
  check('D1 只统计被登录的 provider',
    plan.added.length === 2 && plan.added.every(row => row.provider === 'xai'))
  check('D2 不过滤时两个 provider 都进（multiProvider=true）',
    planModelAdoption({ baseline, current }).multiProvider === true)
}

// ── E. 默认预选 ────────────────────────────────────────────────────────────
{
  const baseline: readonly ProviderModelRef[] = []
  const current = [ref('xai', 'grok-3'), ref('deepseek', 'deepseek-chat'), ref('xai', 'grok-4')]
  const live = planModelAdoption({
    baseline,
    current,
    currentRoute: { provider: 'deepseek', id: 'deepseek-chat' },
  })
  check('E1 当前路由在新增里 → 预选它（不在列表头也不挪）',
    live.defaultPick?.provider === 'deepseek' && live.defaultPick?.id === 'deepseek-chat')
  const noLive = planModelAdoption({ baseline, current })
  check('E2 当前路由不在新增里 → 预选第一个', noLive.defaultPick?.id === 'grok-3')
  const inactive = planModelAdoption({
    baseline,
    current,
    currentRoute: { provider: 'openai', id: 'gpt-5.6' },
  })
  check('E3 当前路由已不在目录里 → 仍回退第一个', inactive.defaultPick?.id === 'grok-3')
}

// ── G. 多 provider 分组 ────────────────────────────────────────────────────
{
  const added = [ref('xai', 'grok-4'), ref('deepseek', 'deepseek-chat'), ref('xai', 'grok-3')]
  check('G1 分组按首现顺序',
    JSON.stringify(addedProviderOrder(added)) === JSON.stringify(['xai', 'deepseek']))
  check('G2 同一批新增里每个 provider 的行互不串扰',
    added.filter(row => row.provider === 'xai').length === 2
    && added.filter(row => row.provider === 'deepseek').length === 1)
}

if (failures === 0) console.log(`\nverify-onboarding-provider-plan: ${checks} checks, all passed`)
else console.error(`\nverify-onboarding-provider-plan: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)
