/**
 * Pure derivation for the first-run onboarding wizard, kept free of React and
 * channel state so `scripts/verify-onboarding-wizard.tsx` can drive it
 * headless (the `modelGroups.ts` precedent, for the same reason: the parts
 * worth pinning are the ones with an opinion, not the JSX).
 *
 * @module dsh-tui/components/onboardingModel
 */
import { t } from '../i18n.js'
import type { LlmModelInfo, LlmProviderInfo } from '../adapter/ports/channel-view.js'
import type { BalanceResult } from '../adapter/ports/channel-catalog.js'

/** 引导的四个配置域，按"先解决拦路的事、再解决好不好看、最后解决怎么用"排。 */
export const ONBOARDING_STEPS = ['apikey', 'look', 'model', 'keys'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/**
 * 步骤条需要的**最小**尺寸：四步的标题横排（`❯ API Key 与连通性 · ...`）
 * 在 76 列下会被截成残句，在 8 行下会把内容挤没——那时整条不画，进度改由
 * 头部那行"第 N / 4 步"承担（信息不丢，只是换了个地方）。
 */
export const STEP_BAR_MIN_COLUMNS = 76
export const STEP_BAR_MIN_ROWS = 10

/** 第四步（招式卡）里的一张卡。 */
export interface TutorialCard {
  /** 稳定 id（"试过没有"记在它上面）。 */
  readonly id: string
  readonly titleKey: string
  readonly descKey: string
  /**
   * 可试的命令名（不含斜杠）；`undefined` = 只能读的键位卡。
   *
   * 键位卡故意不给"试一下"：`Esc` / `Ctrl+C` 只有在真回合里才有意义，在引导
   * 里按下去要么没反应、要么把引导关掉——那是在骗人。命令卡则真的能开：
   * 交给 Chat 的 `runCommand`，与手敲 `/help` 走同一条路。
   */
  readonly command?: string
  /** 键位卡的按键动作 id（`utils/keymap` 的 `ShortcutActionId`）。 */
  readonly action?: 'cancel'
  // 注意：'cancel' 必须同时出现在 `utils/keymap.ts` 的 `ShortcutActionId`
  // 联合里，否则 `effectiveComboDisplay(card.action)` 通不过编译（Esc/Ctrl+C
  // 是硬绑定，不在可重绑动作表内——所以这里只登记它，不参与重映射）。
  /** 纯字面量的键（`/` / `?` 这类不是可重绑动作的）。 */
  readonly literal?: string
}

/**
 * 招式卡表：四张能**直接试用**的命令卡 + 两张只能读的键位卡。
 * 顺序 = 使用频率，不按重要性；第一张是用户最先会需要的。
 */
export const TUTORIAL_CARDS: readonly TutorialCard[] = [
  { id: 'cmd', titleKey: 'onboarding-card-cmd-title', descKey: 'onboarding-card-cmd-desc', literal: '/' },
  { id: 'help', titleKey: 'onboarding-card-help-title', descKey: 'onboarding-card-help-desc', command: 'help', literal: '?' },
  { id: 'model', titleKey: 'onboarding-card-model-title', descKey: 'onboarding-card-model-desc', command: 'model' },
  { id: 'sessions', titleKey: 'onboarding-card-sessions-title', descKey: 'onboarding-card-sessions-desc', command: 'home' },
  { id: 'rewind', titleKey: 'onboarding-card-rewind-title', descKey: 'onboarding-card-rewind-desc', command: 'rewind' },
  { id: 'interrupt', titleKey: 'onboarding-card-interrupt-title', descKey: 'onboarding-card-interrupt-desc', action: 'cancel' },
]

/**
 * 每一步的标题与说明 key，**写成字面量表而不是拼串**。
 *
 * 拼串（`` `onboarding-step-${step}-title` ``）能跑，但 `verify-i18n` 的死键
 * 检查是**文本**检查：它按引号字面量找引用，拼出来的键在源码里不存在，只能
 * 靠登记 `DYNAMIC_PREFIXES` 放行——那是一张"这里不检查"的白名单，放行一次就
 * 少一处保护。这里总共只有八条，写成表既能被检查器看见，也让"哪一步用哪条
 * 文案"一眼可读。
 */
const STEP_TEXT: Readonly<Record<OnboardingStep, { readonly title: string; readonly desc: string }>> = {
  apikey: { title: 'onboarding-step-apikey-title', desc: 'onboarding-step-apikey-desc' },
  look: { title: 'onboarding-step-look-title', desc: 'onboarding-step-look-desc' },
  model: { title: 'onboarding-step-model-title', desc: 'onboarding-step-model-desc' },
  keys: { title: 'onboarding-step-keys-title', desc: 'onboarding-step-keys-desc' },
}

/**
 * 某一步的标题 key。
 * @param step - 步骤 id。
 * @returns 该步标题的 i18n key。
 */
export function stepTitleKey(step: OnboardingStep): string {
  return STEP_TEXT[step].title
}

/**
 * 某一步的说明 key。
 * @param step - 步骤 id。
 * @returns 该步说明的 i18n key。
 */
export function stepDescKey(step: OnboardingStep): string {
  return STEP_TEXT[step].desc
}

/** provider 分组（首现顺序，名字用注册表的，取不到就退回 route key）。 */
export function modelGroupsOf(
  models: readonly LlmModelInfo[],
  providers: readonly LlmProviderInfo[],
): readonly { provider: string; label: string; count: number }[] {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const model of models) {
    if (!counts.has(model.provider)) {
      order.push(model.provider)
      counts.set(model.provider, 0)
    }
    counts.set(model.provider, counts.get(model.provider)! + 1)
  }
  return order.map(provider => ({
    provider,
    label: providers.find(info => info.id === provider)?.name ?? provider,
    count: counts.get(provider)!,
  }))
}

/**
 * 余额显示串：取第一条，币种码直接用接口给的（不猜符号）。
 *
 * @param result - `channel.balanceInfo()` 的返回值。
 * @returns `"CNY 110.00"` 这类串；没有可用条目时 `null`。
 */
export function formatBalance(result: BalanceResult): string | null {
  if (!result.ok) return null
  const first = result.balances[0]
  if (first === undefined) return null
  return `${first.currency} ${first.total.toFixed(2)}`
}

/**
 * 连通性失败分类 → 可执行的下一步。
 *
 * 分类口径与 `BalanceResult.reason` 一一对应，因为"检查网络"这种话对
 * `unauthorized` 的用户毫无用处——五种原因要指向五个不同的动作，这正是
 * `BalanceResult` 分了五类的原因。
 *
 * @param reason - `BalanceResult.reason`。
 * @param status - 非 2xx 时的状态码。
 * @returns 给用户看的排查方向。
 */
export function connFailText(reason: string, status?: number): string {
  switch (reason) {
    case 'no-key': return t('onboarding-conn-fail-no-key')
    case 'network': return t('onboarding-conn-fail-network')
    case 'unauthorized': return t('onboarding-conn-fail-unauthorized')
    case 'http': return t('onboarding-conn-fail-http', { status: status ?? 0 })
    case 'invalid': return t('onboarding-conn-fail-invalid')
    default: return t('onboarding-conn-fail-unknown')
  }
}

/**
 * 凭证来源的显示文案。`CredentialStatus.source` 是 adapter 自己的口径
 * （`'env'` / `'config'` / 其他），这里只做展示映射，认不出的值一律走
 * "未知"而不是把原始串丢到界面上——那个串属于 adapter 内部词汇。
 *
 * @param source - `CredentialStatus.source`。
 * @returns 一句中文/英文来源说明。
 */
export function credentialSourceText(source: string | undefined): string {
  if (source === 'env') return t('onboarding-key-source-env')
  if (source === 'config') return t('onboarding-key-source-config')
  return t('onboarding-key-source-unknown')
}
