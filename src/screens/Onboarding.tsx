import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { ListItem } from '../components/design-system/ListItem.js'
import { LangPicker } from '../components/LangPicker.js'
import { ThemePicker } from '../components/ThemePicker.js'
import { EffortSlider } from '../components/EffortSlider.js'
import { listWindow } from '../components/listWindow.js'
import { WorkspacePicker } from '../components/WorkspacePicker.js'
import { getThemeOptions } from '../components/ThemePicker.js'
import { useTheme } from '../components/design-system/ThemeProvider.js'
import { t, getLang, LANGS, type Lang } from '../i18n.js'
import { isPlainReturn } from '../utils/modifiers.js'
import { LoadingState } from '../components/design-system/LoadingState.js'
import {
  ONBOARDING_STEPS,
  STEP_BAR_MIN_COLUMNS,
  STEP_BAR_MIN_ROWS,
  TUTORIAL_CARDS,
  connFailText,
  credentialSourceText,
  formatBalance,
  modelGroupsOf,
  stepDescKey,
  stepTitleKey,
  type OnboardingStep,
  type TutorialCard,
} from '../components/onboardingModel.js'
import {
  addedProviderOrder,
  modelRefKey,
  modelRefsOf,
  planModelAdoption,
  type AdoptionPlan,
  type ProviderModelRef,
} from '../components/onboardingProviderPlan.js'
import {
  clearOnboardingDraft,
  nextOnboardingActionId,
  readOnboardingDraft,
  subscribeOnboardingDraft,
  writeOnboardingDraft,
  type OnboardingNotice,
  type OnboardingPendingAction,
} from '../onboardingDraft.js'
import type { ClickEvent } from '../ink/events/click-event.js'
import type { ChannelUi as Channel } from '../adapter/channel/ui-policy.js'
import type { CredentialStatus, EffortOption, LlmModelInfo, LlmProviderInfo } from '../adapter/ports/channel-view.js'
import type { BalanceResult } from '../adapter/ports/channel-catalog.js'
import type { OAuthProviderStatus } from '../adapter/ports/channel-settings.js'
import type { ProviderWizardOutcome } from '../dsh-adapter/providerWizard.js'
import type { TuiThemeHost } from '../dsh-adapter/themes.js'
import type { TuiWorkspaceTarget } from '../workspaces.js'

/** 一次连通性检查的状态机（第一步）。`idle` 只在一瞬间存在——挂载即开跑。 */
type ConnState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; models: number; balance: string | null }
  | { kind: 'fail'; reason: string; status?: number | undefined }

/**
 * 第一步的三层：动作列表 → 选账号登录 → 选默认模型（内联模态层）。
 *
 * `adopt` 只在"订阅登录之后真的有新模型、且不止一个"时出现——一个模型
 * 不问（直接设为默认），一个都没有也不问；加 key 的启用与切换由 `/provider`
 * 向导自己问，这里只报结果。三分支的判定在 `components/onboardingProviderPlan`
 * 里，是纯函数。
 *
 * 这一层**只选默认**，不做多选：登录后该 provider 的模型因凭据门控目录已经
 * 全部可用，`/model` 与第三步读的也是全量目录，没有一处会保存"接入哪几个"。
 */
type AccessPhase = 'actions' | 'signin' | 'adopt'

/** 动作行的 id（渲染顺序由 `accessActionIds` 决定，缺接缝的行不出现）。 */
type AccessActionId = 'signin' | 'add' | 'recheck' | 'next'

/** 选默认层的完整状态（取消即整块丢掉）。行 = 新增模型 + 末尾"保持当前模型"。 */
interface AdoptState {
  readonly plan: AdoptionPlan
  readonly index: number
}

/** 第二步的两块：语言还是主题（Tab 换）。 */
type LookPane = 'lang' | 'theme'

/** 第三步的三块：模型 / 强度 / 工作区（Tab 循环）。 */
type ModelZone = 'model' | 'effort' | 'workspace'

/**
 * 打断类键位卡上显示的键。
 *
 * `Esc` 与 `Ctrl+C` 是**硬绑定**，不在 `utils/keymap` 的可重绑动作表里
 * （那张表是可配置动作的白名单），所以这里不调 `effectiveComboDisplay`——
 * 那个函数的入参是 `ShortcutActionId`，塞一个不在表里的 id 进去是编译期
 * 就能抓到的错误，也正是它拦住我不去编一个不存在的动作。
 */
const CANCEL_COMBO = 'Esc · Ctrl+C'

/** 模型区的行数（分组层 = provider 数；列表层 = 该 provider 的模型数）。 */
function modelRowCount(
  models: readonly LlmModelInfo[] | null,
  group: string | undefined,
  providers: readonly LlmProviderInfo[],
): number {
  const listed = models ?? []
  if (group === undefined) return modelGroupsOf(listed, providers).length
  return listed.filter(model => model.provider === group).length
}

/** 登录状态的一句话（复用 /login 的四条既有文案，不另造一套词）。 */
function oauthStateText(row: OAuthProviderStatus): string {
  if (row.signedIn) {
    return row.expiresAt === undefined
      ? t('login-oauth-in-no-expiry')
      : t('login-oauth-in', { time: new Date(row.expiresAt).toISOString() })
  }
  return row.expired ? t('login-oauth-expired') : t('login-oauth-signed-out')
}

/**
 * 底部提示行：子层有子层自己的键位（选账号 / 选默认 / 返回），别拿骨架那句
 * "←/→ 换步骤"去糊弄一个正在子层里的人。
 */
function hintKeyFor(step: OnboardingStep, phase: AccessPhase, onLast: boolean): 'onboarding-hint' | 'onboarding-hint-last' | 'onboarding-access-signin-hint' | 'onboarding-access-adopt-hint' {
  if (step === 'access' && phase === 'signin') return 'onboarding-access-signin-hint'
  if (step === 'access' && phase === 'adopt') return 'onboarding-access-adopt-hint'
  return onLast ? 'onboarding-hint-last' : 'onboarding-hint'
}

/**
 * `/provider` 配好、key 也真的在的路由 id。`DEEPSEEK_API_KEY` 那一条跳过：它由
 * 第一步自己的凭证行报。只问"有没有"（`describeCredential` 不含秘密），不读值。
 */
async function configuredKeyRoutes(channel: Channel): Promise<readonly string[]> {
  let configured: readonly { readonly route: string; readonly ref: string }[]
  try {
    configured = channel.providerSetup?.()?.listConfiguredProviders() ?? []
  } catch {
    return []
  }
  const candidates = configured.filter(row => row.ref !== '' && row.ref !== 'DEEPSEEK_API_KEY')
  const present = await Promise.all(candidates.map(row =>
    channel.describeCredential(row.ref).then(status => status?.configured === true).catch(() => false)))
  return candidates.filter((_, index) => present[index]).map(row => row.route)
}

/**
 * Onboarding —— 首次运行的引导向导（`~/.dsh-tui/onboarding.json` 走一次性记账）。
 *
 * 身为一个屏幕，它跟 `SessionSupervisor` 同规矩：所有 hook 先跑完，再由
 * `Chat` 的渲染链提前 return。它**自己读 channel**（`describeCredential` /
 * `balanceInfo` / `listModels` / `listWorkspaces`…），不把十几份数据从 Chat
 * 传进来——那正是 supervisor 的做法。
 *
 * 键盘归它独占（`Chat` 在 `supervisorOpen` 那一层之前让位），所以每一步
 * 的 picker 都能借用同一份 `focusIndex`，不需要各自注册 `useInput`。
 *
 * **凭证永远只报"有没有"，不报值**：`describeCredential` 回的是不含秘密的
 * 元数据，界面上也照它的原样画。
 *
 * 第一步（账号与模型接入）会把**动作**交给 Chat 执行：订阅登录与 `/provider`
 * 的 key 流程都要用共享问答面板（设备码、授权 URL、密钥输入），而那套面板
 * 归 Chat 的 `questionStore`。面板挂起时本屏会被卸载、回答后重挂，所以进度
 * 落在 `src/onboardingDraft.ts`（模块级，不是 React state）——挂载时读回，
 * 动作回来时按"动作前的目录基线"做差分：订阅登录按 0/1/N 决定是否问默认模型，
 * 加 key 只报结果（向导已经问过）。
 */
export function Onboarding({
  channel,
  themeHost,
  onClose,
  onRunCommand,
  onApplyLang,
  onProviderSignIn,
  onProviderAddProvider,
  initialStep,
  externalNotice,
}: {
  channel: Channel
  themeHost?: TuiThemeHost
  /** 跳过 / 完成：把状态交回 Chat（它负责记账与切屏）。 */
  onClose: (outcome: 'skipped' | 'done') => void
  /** 招式卡的"试一下"：交给 Chat 的 `runCommand`（与手敲 `/help` 同一条路）。 */
  onRunCommand: (name: string) => void
  /**
   * 语言切换：交给 Chat 的 `applyLang`（写 `~/.dsh-tui/lang.json`、通知
   * settings 层、再 `setLang` 热换整棵 UI）。引导不自己写偏好文件——那套
   * 优先级（env > cordis.yml > 持久化）只有 Chat 手里那一份。
   */
  onApplyLang: (lang: Lang) => void
  /**
   * 订阅账号登录（第一步的动作行）：Chat 用既有的 `runOAuthLogin` +
   * `questionStore` 跑完整个 OAuth 流程，只把结果交回来。返回值口径与
   * `/provider` 的 `ProviderWizardOutcome` 一致。
   */
  onProviderSignIn?: (provider: string) => Promise<ProviderWizardOutcome>
  /**
   * "添加模型提供方（API key）"：Chat 用既有的 `runProviderWizard` 跑
   * `/provider` 的 add 流程（route / 端点 / key / 模型多选 / 回滚都在那里）。
   */
  onProviderAddProvider?: () => Promise<ProviderWizardOutcome>
  /** 测试缝：直接落在某一步（探针不重复走前几步；不给则从 draft 恢复）。 */
  initialStep?: number | undefined
  /** 测试缝：外部注入一句提示（真机不传）。 */
  externalNotice?: string
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  // 面板接管会把这一屏卸载再重挂：step/focus 先看 draft，只有显式传了
  // `initialStep`（测试缝）才由参数决定。
  const [restored] = React.useState(() => readOnboardingDraft())
  const [stepIndex, setStepIndex] = React.useState(() => {
    const seed = initialStep ?? restored?.step ?? 0
    return Math.max(0, Math.min(seed, ONBOARDING_STEPS.length - 1))
  })
  const step = ONBOARDING_STEPS[stepIndex]!
  const [focusIndex, setFocusIndex] = React.useState(initialStep === undefined ? restored?.focus ?? 0 : 0)
  // 提示行带语气：失败 / 取消不能用成功色画（重挂后从 draft 读回也一样）。
  const [notice, setNoticeState] = React.useState<OnboardingNotice | undefined>(
    externalNotice === undefined
      ? (initialStep === undefined ? restored?.notice : undefined)
      : { text: externalNotice, tone: 'success' })
  const setNotice = React.useCallback((text: string | undefined, tone: OnboardingNotice['tone'] = 'success'): OnboardingNotice | undefined => {
    const next = text === undefined ? undefined : { text, tone }
    setNoticeState(next)
    return next
  }, [])
  const aliveRef = React.useRef(true)
  /**
   * 当前在跑的那一单接入动作的归属 id。
   *
   * 异步准备（读目录）先于 draft 落盘：这段窗口里用户可能关屏、本屏被卸载，
   * 也可能又发起一单。归属登记在 `runProviderAction` 的 await 之前，`finish()`、
   * 卸载、发起新一单都会作废它；目录回来先验归属，作废了就不许写 draft、也不许
   * `start()`——否则迟到的回调会把已清空的 draft 复活，并替一个已经离开的用户
   * 跑完登录。
   */
  const actionOwnerRef = React.useRef<number | undefined>(undefined)
  React.useEffect(() => () => {
    aliveRef.current = false
    actionOwnerRef.current = undefined
  }, [])

  // ── 第一步：凭证 + 连通性 + 账号/模型接入 ────────────────────────────
  const [credential, setCredential] = React.useState<CredentialStatus | undefined>(undefined)
  const [conn, setConn] = React.useState<ConnState>({ kind: 'idle' })
  const [checkNonce, setCheckNonce] = React.useState(0)
  /** dsh-auth 的登录状态；`undefined` = 本组合没挂这个插件。 */
  const [oauth, setOauth] = React.useState<readonly OAuthProviderStatus[] | undefined>(undefined)
  /** 打开选账号层时重读登录状态的阀门（不连带重跑余额检查）。 */
  const [oauthNonce, setOauthNonce] = React.useState(0)
  /**
   * 用 `/provider` 配好、key 也在的路由（不含 `DEEPSEEK_API_KEY` 那一条）。
   * 第一步的余额检查只认 DeepSeek 官方 key：有了这些路由，缺 DeepSeek key
   * 就不再是"没有可用的凭证"。
   */
  const [keyRoutes, setKeyRoutes] = React.useState<readonly string[]>([])
  const [accessPhase, setAccessPhase] = React.useState<AccessPhase>('actions')
  const [signinIndex, setSigninIndex] = React.useState(0)
  const [adopt, setAdopt] = React.useState<AdoptState | undefined>(undefined)
  /**
   * 有一单接入动作在跑（draft 里有 `pending`）。问答面板会在两次提问之间关掉、
   * 本屏重挂回动作列表；这时登录 / 加 key 两行再发起一单，会和在跑的那一单
   * 并发提问、并发写盘，还会顶掉它的 `pending`，让它的结果无处结算。所以在跑
   * 期间这两行不接 Enter / 点击，并说一句"配置进行中"。
   */
  const [inFlight, setInFlight] = React.useState(() => readOnboardingDraft()?.pending !== undefined)
  /** 目录刷新阀门：接入成功后让第三步重读模型/提供方。 */
  const [catalogNonce, setCatalogNonce] = React.useState(0)
  /**
   * 第一步的动作清单在挂载后**会长出来**（`oauthProviderStatuses` / `providerSetup`
   * 是异步/懒解析的）：前几帧可能只有"重新检查 / 跳过"，之后"登录订阅账号 / 添加
   * 模型提供方"插到最前面。焦点因此按**动作 id**记，不按下标——否则用户的焦点
   * 会在清单变长的瞬间从"重新检查"静默变成"登录"，一次回车就点错东西。
   */
  // 每次渲染现读：channel 对象本身不换，按它 memo 会把"挂载时还没解析出来"的
  // 结果冻结在整个引导期间。
  const setupHost = channel.providerSetup?.()
  // 登录行的可见性与执行走**同一个**接缝：Chat 的 `onboardingSignIn` 取的是
  // `providerSetup()?.oauth`，而 `oauthProviderStatuses()` 只要求 dsh-auth——
  // 只看后者，"有 dsh-auth、没有 /provider 宿主服务"的组合会画出一行点了就报未挂载的死入口。
  const oauthMounted = setupHost?.oauth !== undefined
  const canSignIn = onProviderSignIn !== undefined && oauthMounted && (oauth?.length ?? 0) > 0
  const canConfigure = onProviderAddProvider !== undefined && setupHost !== undefined
  const accessActionIds = React.useMemo<readonly AccessActionId[]>(() => [
    ...(canSignIn ? ['signin' as const] : []),
    ...(canConfigure ? ['add' as const] : []),
    'recheck',
    'next',
  ], [canConfigure, canSignIn])
  const [accessFocusId, setAccessFocusId] = React.useState<AccessActionId | undefined>(() => {
    // 焦点按**动作 id**恢复，不按下标：清单是异步长出来的（先有"重新检查/跳过"，
    // 几帧后才长出"登录/加 key"），下标在清单变长后会指向另一个动作。
    // id 暂时不在清单里也没关系——`accessIndex` 会先落在第 0 行，等清单长出来
    // 再回到同一个动作上。
    const seed = restored?.focusId
    return seed === 'signin' || seed === 'add' || seed === 'recheck' || seed === 'next'
      ? seed
      : undefined
  })
  const accessIndex = accessFocusId === undefined
    ? 0
    : Math.max(0, accessActionIds.indexOf(accessFocusId))
  /**
   * DeepSeek 官方 key 之外已经能用的接入：已登录的订阅账号 + 配好 key 的路由。
   * 第一步的凭证行与余额检查都只针对 DeepSeek 官方 API，有这些接入时它们只是
   * 一条中性说明，不是失败。
   */
  const otherAccess = React.useMemo(() => [
    ...(oauth ?? []).filter(row => row.signedIn).map(row => row.provider),
    ...keyRoutes,
  ].filter((id, index, all) => all.indexOf(id) === index), [keyRoutes, oauth])
  /**
   * 已经有能用的东西了吗（DeepSeek 凭证已配置，或有别的接入）？有就不再往屏幕上
   * 堆"手工设置"的兜底文案——那是"这台机器现在什么都没有"时才需要的出路。
   */
  const accessReady = credential?.configured === true || otherAccess.length > 0
  React.useEffect(() => {
    let alive = true
    setCredential(undefined)
    setConn({ kind: 'running' })
    void (async () => {
      const status = await channel.describeCredential('DEEPSEEK_API_KEY').catch(() => undefined)
      if (!alive) return
      setCredential(status)
      const [models, balance, routes] = await Promise.all([
        channel.listModels().catch(() => [] as readonly LlmModelInfo[]),
        channel.balanceInfo().catch(() => ({ ok: false, reason: 'network' }) as BalanceResult),
        configuredKeyRoutes(channel),
      ])
      if (!alive) return
      setKeyRoutes(routes)
      // 连通性的判定口径：余额接口是唯一一次真的打服务端的调用，所以以它
      // 为准；模型列表只用来给成功态添一个数字（某些 provider 会走缓存）。
      setConn(balance.ok
        ? { kind: 'ok', models: models.length, balance: formatBalance(balance) }
        : {
            kind: 'fail',
            reason: balance.reason,
            status: balance.ok ? undefined : balance.status,
          })
    })()
    return () => {
      alive = false
    }
  }, [channel, checkNonce])
  // 登录状态单独读：重新检查、打开选账号层都会重读；`oauthMounted` 也在依赖里——
  // dsh-auth 晚于首帧组合进来时，登录行不必等用户点"重新检查"才出现。
  React.useEffect(() => {
    let alive = true
    void (channel.oauthProviderStatuses?.().catch(() => undefined) ?? Promise.resolve(undefined))
      .then((rows) => {
        if (alive) setOauth(rows)
      })
    return () => {
      alive = false
    }
  }, [channel, checkNonce, oauthMounted, oauthNonce])

  // ── 第二步：语言 + 主题 ──────────────────────────────────────────────
  const [themeName, setTheme] = useTheme()
  const [lookPane, setLookPane] = React.useState<LookPane>('lang')
  const [langIndex, setLangIndex] = React.useState(() => Math.max(0, LANGS.indexOf(getLang() as Lang)))
  const themeOptions = React.useMemo(() => getThemeOptions(themeHost), [themeHost])
  const [themeIndex, setThemeIndex] = React.useState(() => {
    const index = themeOptions.findIndex(option => option.value === themeName)
    return index >= 0 ? index : 0
  })

  // ── 第三步：模型 / 强度 / 工作区 ─────────────────────────────────────
  const [zone, setZone] = React.useState<ModelZone>('model')
  const [models, setModels] = React.useState<readonly LlmModelInfo[] | null>(null)
  const [providers, setProviders] = React.useState<readonly LlmProviderInfo[]>([])
  const [efforts, setEfforts] = React.useState<readonly EffortOption[]>([])
  const [effortIndex, setEffortIndex] = React.useState(0)
  const [workspaces, setWorkspaces] = React.useState<readonly TuiWorkspaceTarget[] | null>(null)
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false)
  const [workspaceIndex, setWorkspaceIndex] = React.useState(0)
  const [modelGroup, setModelGroup] = React.useState<string | undefined>(undefined)
  React.useEffect(() => {
    let alive = true
    void (async () => {
      const listed = await channel.listModels().catch(() => [] as readonly LlmModelInfo[])
      const providerInfos = await channel.listProviders().catch(() => [] as readonly LlmProviderInfo[])
      const { efforts: tiers, defaultEffort } = await channel.listEfforts()
        .catch(() => ({ efforts: [] as readonly EffortOption[], defaultEffort: undefined }))
      if (!alive) return
      setModels(listed)
      setProviders(providerInfos)
      setEfforts(tiers)
      const current = channel.reasoningEffort ?? defaultEffort
      const index = tiers.findIndex(tier => tier.id === current)
      setEffortIndex(index >= 0 ? index : 0)
    })()
    return () => {
      alive = false
    }
  }, [channel, catalogNonce])

  // ── 第四步：招式卡 ──────────────────────────────────────────────────
  const [tried, setTried] = React.useState<ReadonlySet<string>>(() => new Set())

  const finish = React.useCallback((outcome: 'skipped' | 'done'): void => {
    // 关屏即作废在跑的那一单：目录读取可能还在路上，它的迟到回调不许复活
    // draft、也不许再 `start()`。
    actionOwnerRef.current = undefined
    // 两条出口都收掉进度：跳过的下一次启动还要从第一步重问，完成的更不该
    // 留着旧的 draft 去影响 `/setup`。
    clearOnboardingDraft()
    onClose(outcome)
  }, [onClose])

  const goToStep = React.useCallback((next: number): void => {
    // 夹到**最后一格**，不是 `length`：越界会让 `step` 变成 undefined，
    // 正文整块消失、只剩一个没有内容的空步（`→` 在最后一步上就会踩到）。
    const clamped = Math.max(0, Math.min(next, ONBOARDING_STEPS.length - 1))
    setFocusIndex(0)
    setNotice(undefined)
    setStepIndex(clamped)
  }, [])

  /** 进入下一步；最后一步的"下一步"就是完成。 */
  const advance = React.useCallback((): void => {
    if (stepIndex >= ONBOARDING_STEPS.length - 1) {
      finish('done')
      return
    }
    goToStep(stepIndex + 1)
  }, [finish, goToStep, stepIndex])

  const openWorkspacePicker = React.useCallback((): void => {
    setWorkspaceOpen(true)
    setWorkspaceIndex(0)
    if (workspaces === null) {
      void channel.listWorkspaces().then((targets) => {
        setWorkspaces(targets)
        const index = targets.findIndex(target => target.cwd === channel.cwd)
        setWorkspaceIndex(index >= 0 ? index : 0)
      }).catch(() => setWorkspaces([]))
    }
  }, [channel, workspaces])

  const applyTheme = React.useCallback((index: number): void => {
    const option = themeOptions[index]
    if (option === undefined) return
    // 与 `/theme <name>` 同一条路：`setTheme` 自己校验并落盘 theme.json。
    setTheme(option.value)
  }, [setTheme, themeOptions])

  const pickCard = React.useCallback((card: TutorialCard, tryIt: boolean): void => {
    if (!tryIt || card.command === undefined) return
    setTried(previous => new Set(previous).add(card.id))
    onRunCommand(card.command)
  }, [onRunCommand])

  // ── 第一步的接入动作（订阅登录 / API key / 接入模型）──────────────────
  /** provider 显示名：注册表 → 登录状态 → 原始 id。 */
  const providerLabel = React.useCallback((id: string | undefined): string => {
    if (id === undefined) return ''
    return providers.find(entry => entry.id === id)?.name
      ?? oauth?.find(row => row.provider === id)?.label
      ?? id
  }, [oauth, providers])
  /**
   * 动作行的文案（登录行带上"已登录几 / 共几"的实况）。清单本身（`accessActionIds`）
   * 与"能不能用"（`accessReady`）在第一步的状态区上方算，那里要先于焦点状态。
   */
  const accessRows = React.useMemo(() => {
    const total = oauth?.length ?? 0
    const signedIn = (oauth ?? []).filter(row => row.signedIn).length
    const describe = (id: AccessActionId): { label: string; desc: string } => {
      switch (id) {
        case 'signin':
          return {
            label: t('onboarding-access-action-signin'),
            desc: inFlight
              ? t('onboarding-access-action-busy-desc')
              : t('onboarding-access-action-signin-desc', { signed: signedIn, total }),
          }
        case 'add':
          return {
            label: t('onboarding-access-action-add'),
            desc: inFlight ? t('onboarding-access-action-busy-desc') : t('onboarding-access-action-add-desc'),
          }
        case 'recheck':
          return {
            label: t('onboarding-access-action-recheck'),
            desc: t('onboarding-access-action-recheck-desc'),
          }
        case 'next':
          return {
            label: t('onboarding-access-action-next'),
            desc: t('onboarding-access-action-next-desc'),
          }
      }
    }
    return accessActionIds.map(id => ({ id, ...describe(id) }))
  }, [accessActionIds, inFlight, oauth])

  /**
   * 动作结束之后的唯一收口：读回动作前的目录基线 → 差分 → 0/1/N 决策（加 key 只报结果）。
   * 前提是 draft 里已经有 `completed`（动作真的跑完了），并且本实例还在挂；
   * `pending`/`completed` 同时清空，保证重挂、订阅回调、Promise 回调三条路
   * 径加起来只结算一次。
   */
  const settlePendingAction = React.useCallback(async (): Promise<void> => {
    const draft = readOnboardingDraft()
    const completion = draft?.completed
    // **动作跑完之前不结算**：问答面板可以在两次提问之间关闭（模型探测、profile
    // 写入都在提问之间），那时本屏会被重挂，而目录还没变——早结算就会读到旧
    // 目录、把结果丢掉。`completed` 由跑动作的那个实例在结束时写入（它同时把
    // `pending` 清掉，所以这里只认 `completed`）。
    if (draft === undefined || completion === undefined) return
    // 已经卸载的实例不许把这一单"吃掉"：面板挂起时本屏被卸载，重挂（或在挂）
    // 的那个实例才是该结算的人。这里先退出去，把 draft 原样留给它。
    if (!aliveRef.current) return
    writeOnboardingDraft({ pending: undefined, completed: undefined })
    // 取消/失败没有目录变化。具体原因只在流程自己的通知里，而整屏盖着时外面的
    // 通知条看不见，所以跑动作的实例把那一句带进了 completion，这里接着显示。
    if (completion.status === 'cancelled' || completion.status === 'failed') {
      const text = completion.status === 'cancelled'
        ? t('onboarding-access-cancelled')
        : completion.notice === undefined
          ? t('onboarding-access-action-failed')
          : t('onboarding-access-action-failed-reason', { reason: completion.notice })
      setAccessPhase('actions')
      writeOnboardingDraft({ baseline: [], notice: setNotice(text, completion.status === 'cancelled' ? 'warning' : 'error') })
      return
    }
    const models = await channel.listModels().catch(() => [] as readonly LlmModelInfo[])
    if (!aliveRef.current) return
    setCatalogNonce(nonce => nonce + 1)
    // 登录状态也可能刚变了：重跑一次状态读取（凭证 + 已登录账号 + 连通性）。
    setCheckNonce(nonce => nonce + 1)
    const plan = planModelAdoption({
      baseline: draft.baseline,
      current: modelRefsOf(models),
      ...(completion.kind === 'sign-in' && completion.provider !== undefined ? { provider: completion.provider } : {}),
      ...(channel.provider !== undefined && channel.model !== undefined
        ? { currentRoute: { provider: channel.provider, id: channel.model } }
        : {}),
    })
    const label = providerLabel(plan.provider ?? (completion.kind === 'sign-in' ? completion.provider : undefined))
    // 登出、改路由、删路由本来就不为新增：报流程自己的那一句（已登出 / 已删除…），
    // 不拿"没有新增模型"去描述它。目录与状态在上面已经重读。
    if (completion.status === 'changed' && plan.added.length === 0) {
      const text = completion.notice ?? t('onboarding-access-changed')
      writeOnboardingDraft({ baseline: [], notice: setNotice(text) })
      return
    }
    if (plan.decision === 'none') {
      const text = label === ''
        ? t('onboarding-access-added-none')
        : t('onboarding-access-added-none-for', { provider: label })
      writeOnboardingDraft({ baseline: [], notice: setNotice(text, 'warning') })
      return
    }
    if (completion.kind === 'add-provider') {
      // 加 key 跑的是 `/provider` 向导：启用哪些模型（模型多选）、要不要切过去
      // （provider-q-switch），向导自己已经问过并落了盘。这里只报结果——再走
      // auto / 接入层，会推翻用户在向导里选的「保持当前模型」，还把同一批模型再问一遍。
      const live = models.find(model => model.provider === channel.provider && model.id === channel.model)
      const text = t('onboarding-access-added-provider', {
        provider: label,
        n: plan.added.length,
        model: live?.name ?? channel.model,
      })
      writeOnboardingDraft({ baseline: [], notice: setNotice(text) })
      return
    }
    if (plan.decision === 'auto') {
      const pick = plan.added[0]!
      const ok = await channel.switchModel(pick.provider, pick.id).catch(() => false)
      if (!aliveRef.current) return
      const text = ok
        ? t('onboarding-access-added-auto', { name: pick.name, provider: providerLabel(pick.provider) })
        : t('onboarding-model-switch-failed', { name: pick.name })
      writeOnboardingDraft({ baseline: [], notice: setNotice(text, ok ? 'success' : 'error') })
      return
    }
    // 焦点先落在预选上（当前路由在新增里就是它，否则第一个新增模型）。
    const preferred = plan.defaultPick === undefined
      ? 0
      : Math.max(0, plan.added.findIndex(row => modelRefKey(row) === modelRefKey(plan.defaultPick!)))
    setAdopt({ plan, index: preferred })
    setAccessPhase('adopt')
  }, [channel, providerLabel, setNotice])

  /**
   * 跑一个接入动作：**先**把基线 + 意图写进 draft，再交给 Chat 的面板。
   * 顺序是关键——面板一挂起这一屏就卸载了，晚写的上下文没人接得住。
   * 读目录（`channel.listModels()`）是这段窗口里最慢的一步，所以归属在 await
   * 之前登记，目录回来先验归属：晚了就会先复活 draft、再替已经离开的用户跑登录。
   */
  const runProviderAction = React.useCallback(async (
    intent: Omit<OnboardingPendingAction, 'id'>,
    start: () => Promise<ProviderWizardOutcome>,
    /** 发起这一单的动作 id：重挂后按它把焦点放回同一行（不是按当时的行号）。 */
    focusId: AccessActionId,
  ): Promise<void> => {
    // 一次只跑一单（见 `inFlight`）。这里现读 draft 再拦一次：同一帧里连按两下时，
    // 第二下赶在重画之前，`inFlight` 还是旧值。
    if (readOnboardingDraft()?.pending !== undefined) return
    // 每单一个 id：引导关掉再开、又发起新动作时，上一单迟到的回调不能把
    // 新一单的 `pending` 覆盖成它自己的完成态。
    const pending: OnboardingPendingAction = { ...intent, id: nextOnboardingActionId() }
    // 归属先立、异步准备后行：读目录可能很慢，这段窗口里关屏/卸载/新一单都会
    // 作废这一单（见 `actionOwnerRef`）。校验点放在目录返回处，而不是等登录
    // 结束——晚一步就会先复活 draft、再替已经离开的用户跑一次 `start()`。
    actionOwnerRef.current = pending.id
    const baseline = modelRefsOf(await channel.listModels().catch(() => [] as readonly LlmModelInfo[]))
    if (!aliveRef.current || actionOwnerRef.current !== pending.id) return
    // 动作前的上下文先落盘：面板一挂起这一屏就卸载了，晚写的没人接得住。
    // `pending` 会一直留到动作结束——中途的重挂靠它知道"还有一单在跑"。
    writeOnboardingDraft({
      step: stepIndex,
      focus: accessIndex,
      focusId,
      baseline,
      pending,
      completed: undefined,
      notice: undefined,
    })
    // 流程的反馈（失败原因、登出/删除的结果）只走通知条：记下开跑前最后一条的
    // id，结束后取它之后最新的那一条带进 completion。
    const noticeMark = channel.notifications.at(-1)?.id
    const outcome = await start().catch(() => 'failed' as ProviderWizardOutcome)
    const status = outcome === 'cancelled' || outcome === 'failed' || outcome === 'added' ? outcome : 'changed'
    const latest = channel.notifications.at(-1)
    const notice = latest !== undefined && (noticeMark === undefined || latest.id > noticeMark) ? latest.text : undefined
    // 只有"桌上还是我这一单"才写完成态：引导已经被关掉（draft 清空），或者
    // 用户又发起了一单（pending.id 变了）时，这一单的结果没有归属，丢掉。
    if (readOnboardingDraft()?.pending?.id === pending.id) {
      writeOnboardingDraft({ completed: { ...pending, status, notice }, pending: undefined })
    }
    // 在挂的实例（可能是重挂出来的那一个）在这里结算；这里的实例已经卸载时，
    // settle 会早退，由订阅到 completed 的在挂实例接手。
    await settlePendingAction()
  }, [accessIndex, channel, settlePendingAction, stepIndex])

  /** 打开选账号层，顺手重读登录状态（账号可能在引导外刚登录/登出过）。 */
  const openSignIn = React.useCallback((): void => {
    setAccessPhase('signin')
    setOauthNonce(nonce => nonce + 1)
  }, [])

  const startSignIn = React.useCallback((provider: string): void => {
    if (onProviderSignIn === undefined) return
    setAccessPhase('actions')
    void runProviderAction({ kind: 'sign-in', provider }, () => onProviderSignIn(provider), 'signin')
  }, [onProviderSignIn, runProviderAction])

  const startAddProvider = React.useCallback((): void => {
    if (onProviderAddProvider === undefined) return
    void runProviderAction({ kind: 'add-provider' }, onProviderAddProvider, 'add')
  }, [onProviderAddProvider, runProviderAction])

  /** 动作行的落点（键盘 Enter 与鼠标点击共用）。在跑期间登录 / 加 key 不接。 */
  const runAccessAction = (id: AccessActionId): void => {
    if (id === 'signin') {
      if (!inFlight) openSignIn()
    } else if (id === 'add') {
      if (!inFlight) startAddProvider()
    } else if (id === 'recheck') setCheckNonce(nonce => nonce + 1)
    else advance()
  }

  /**
   * 选默认层的落点：`pick` 落成默认模型（`switchModel` 与第三步同一条路，写
   * model.json）；`undefined` = 保持当前模型。两条路都不撤回已经登录的东西——
   * 新模型本来就都可用了，这里只决定默认。
   */
  const applyAdoption = React.useCallback((pick: ProviderModelRef | undefined): void => {
    if (pick === undefined) {
      setAdopt(undefined)
      setAccessPhase('actions')
      writeOnboardingDraft({ baseline: [], notice: setNotice(t('onboarding-access-adopt-cancelled')) })
      return
    }
    void channel.switchModel(pick.provider, pick.id).then((ok) => {
      const text = ok
        ? t('onboarding-access-added-auto', { name: pick.name, provider: providerLabel(pick.provider) })
        : t('onboarding-model-switch-failed', { name: pick.name })
      // 落地判断先看还在不在：用户可能在 `switchModel` 解析前就退出了引导，
      // 那时既不该改状态，也不该给下一次 `/setup` 留一条过期提示。
      if (!aliveRef.current) return
      writeOnboardingDraft({ baseline: [], notice: setNotice(text, ok ? 'success' : 'error') })
      setCheckNonce(nonce => nonce + 1)
    }).catch(() => undefined).finally(() => {
      if (!aliveRef.current) return
      setAdopt(undefined)
      setAccessPhase('actions')
    })
  }, [channel, providerLabel, setNotice])

  /**
   * 结算入口。三种时序都要覆盖：
   *   1. 挂载时动作已经结束（面板在结束前关掉、或上一次挂载已卸载）→ 立刻结算；
   *   2. 动作还在跑（只有 pending）→ 什么都不做，等 completed；
   *   3. 动作在本实例在挂期间结束 → 订阅回调里结算。
   */
  React.useEffect(() => {
    const settleIfReady = (): void => {
      const draft = readOnboardingDraft()
      // "在跑"跟着 draft 走：开跑时写入 `pending`、结束时清掉，重挂的实例也看得到。
      setInFlight(draft?.pending !== undefined)
      if (draft?.completed === undefined) return
      setAccessPhase('actions')
      void settlePendingAction()
    }
    settleIfReady()
    return subscribeOnboardingDraft(settleIfReady)
  }, [settlePendingAction])

  // 进度（步骤 / 焦点）随变随存，卸载-重挂后从 draft 读回。
  React.useEffect(() => {
    writeOnboardingDraft({ step: stepIndex, focus: focusIndex, focusId: accessFocusId })
  }, [accessFocusId, focusIndex, stepIndex])

  /**
   * 第三步模型区的行数（分组层 = provider 数；列表层 = 该 provider 的模型数）。
   * 第一步的动作列表与选默认层各有自己的行数（`accessActionIds` / `adopt.plan.added`），不走这里。
   */
  const rowCount = step === 'look'
    ? (lookPane === 'lang' ? LANGS.length : themeOptions.length)
    : step === 'model'
      ? (zone === 'model' ? modelRowCount(models, modelGroup, providers) : zone === 'effort' ? efforts.length : 1)
      : TUTORIAL_CARDS.length

  useInput((input, key, event) => {
    // 工作区选择是引导内部的模态层：开着的时候键盘全归它。
    if (workspaceOpen) {
      const targets = workspaces ?? []
      if (key.escape) {
        setWorkspaceOpen(false)
        return
      }
      if (key.upArrow || key.downArrow) {
        setWorkspaceIndex(previous =>
          Math.max(0, Math.min(previous + (key.upArrow ? -1 : 1), Math.max(0, targets.length - 1))))
        return
      }
      if (isPlainReturn(key)) {
        const target = targets[workspaceIndex]
        setWorkspaceOpen(false)
        if (target === undefined) return
        void channel.switchWorkspace(target).then((ok) => {
          setWorkspaces(null)
          setNotice(ok
            ? t('onboarding-workspace-switched', { name: target.label })
            : t('onboarding-workspace-failed', { name: target.label }), ok ? 'success' : 'error')
        })
      }
      return
    }
    if (key.ctrl && input === 'c') {
      finish('skipped')
      event.stopImmediatePropagation()
      return
    }
    // 第一步的接入子层（选账号 / 选默认模型）：Esc 只退一层，不跳过整个引导。
    if (step === 'access' && accessPhase !== 'actions') {
      if (key.escape) {
        // 退出选默认层 = 保持当前模型：已经登录/写入的东西不撤回（它们本来就生效了），
        // 只是不再替用户选默认模型。
        if (accessPhase === 'signin') setAccessPhase('actions')
        else applyAdoption(undefined)
        event.stopImmediatePropagation()
        return
      }
      if (accessPhase === 'signin') {
        const count = (oauth?.length ?? 0) + 1
        if (key.upArrow || key.downArrow) {
          setSigninIndex(previous => Math.max(0, Math.min(previous + (key.upArrow ? -1 : 1), count - 1)))
          return
        }
        if (isPlainReturn(key)) {
          const row = oauth?.[signinIndex]
          if (row === undefined) setAccessPhase('actions')
          else startSignIn(row.provider)
          event.stopImmediatePropagation()
        }
        return
      }
      // 选默认层：单选，Enter 落点；末尾一行是"保持当前模型"。
      if (adopt === undefined) return
      if (key.upArrow || key.downArrow) {
        const last = adopt.plan.added.length
        setAdopt(previous => previous === undefined ? previous : ({
          ...previous,
          index: Math.max(0, Math.min(previous.index + (key.upArrow ? -1 : 1), last)),
        }))
        return
      }
      if (isPlainReturn(key)) {
        applyAdoption(adopt.plan.added[adopt.index])
        event.stopImmediatePropagation()
      }
      return
    }
    if (key.escape) {
      // 模型分组钻进去之后，Esc 先退一层。这条判定必须排在"跳过整个向导"**之前**：
      // 它原来写在 model 分支里（在全局 Esc 之后）永远轮不到，钻进去就成了单向门。
      if (step === 'model' && modelGroup !== undefined) {
        setModelGroup(undefined)
        setFocusIndex(0)
        event.stopImmediatePropagation()
        return
      }
      finish('skipped')
      event.stopImmediatePropagation()
      return
    }
    // 左右换步骤——引导自己的骨架，不跟任何 picker 抢（那些用 ↑/↓ 与
    // 各自的 ←/→；这里把它们让给 picker 的是 `lookPane === 'theme'` 与
    // `zone === 'effort'` 两个分支）。
    // 只有**真的有人接**的横向键才从骨架手里拿走：强度滑块与钻进去之后的
    // 模型层。语言 / 主题两个面板都是纯展示（`Select` / `ThemePicker` 都不
    // 注册 `useInput`，`onPick` 收的是 ClickEvent），把 ←/→ 让出去只会让它们
    // 变成死键——而底部提示写的是「←/→ 换步骤」。
    const horizontalOwnedByChild =
      (step === 'model' && zone === 'effort')
      || (step === 'model' && zone === 'model' && modelGroup !== undefined)
      // 接入子层自己吃 ↑/↓/Tab/Esc；←/→ 在这里没有意义，别把层级换掉。
      || (step === 'access' && accessPhase !== 'actions')
    if (!horizontalOwnedByChild && (key.leftArrow || key.rightArrow)) {
      goToStep(stepIndex + (key.leftArrow ? -1 : 1))
      event.stopImmediatePropagation()
      return
    }
    if (key.tab) {
      if (step === 'look') setLookPane(previous => (previous === 'lang' ? 'theme' : 'lang'))
      if (step === 'model') {
        setZone(previous => previous === 'model' ? 'effort' : previous === 'effort' ? 'workspace' : 'model')
      }
      event.stopImmediatePropagation()
      return
    }

    if (step === 'look') {
      if (key.upArrow || key.downArrow) {
        const count = lookPane === 'lang' ? LANGS.length : themeOptions.length
        setFocusIndex(previous => Math.max(0, Math.min(previous + (key.upArrow ? -1 : 1), count - 1)))
        // 主题**实时预览**：移动光标就换，回车只是把焦点钉住继续。这与
        // `/theme` picker 的"只换色块预览"不同——引导里用户是来试穿的，
        // 看不见整体效果就没法选。离开这一步不还原：`setTheme` 已经落盘，
        // 半途反悔的用户可以在 /settings 里改回去，而"悄悄退回原样"会让
        // 他刚看到的选择凭空消失。
        if (lookPane === 'theme') applyTheme(Math.max(0, Math.min(focusIndex + (key.upArrow ? -1 : 1), themeOptions.length - 1)))
        return
      }
      if (isPlainReturn(key)) {
        // 两个面板的键盘路径都归这里：picker 自己只处理鼠标点击。
        if (lookPane === 'theme') applyTheme(focusIndex)
        else {
          const lang = LANGS[Math.min(focusIndex, LANGS.length - 1)]
          if (lang !== undefined) onApplyLang(lang)
        }
        advance()
        return
      }
      return
    }

    if (step === 'model') {
      if (zone === 'effort') {
        if (isPlainReturn(key)) {
          // Enter 的语义 = "这一格到此为止、进入下一个区域"：滑块本身就是
          // 控件（←/→ 移动即 setEffort 生效），Enter 再去"应用"是空操作；
          // 而整个向导里 Enter 的分工都是"落点/前进"（钻分组、换模型、
          // 开工作区、完成），所以这里对齐 Tab 的走法把焦点交给下一个区域
          // （工作区），不给它第三种含义——否则滑块上的 Enter 就是死键。
          setZone('workspace')
          event.stopImmediatePropagation()
          return
        }
        if (key.leftArrow || key.rightArrow) {
          const next = Math.max(0, Math.min(effortIndex + (key.leftArrow ? -1 : 1), efforts.length - 1))
          setEffortIndex(next)
          const option = efforts[next]
          // 与 `/effort` 滑块同一条路：滑块本身就是控件，移动即生效。
          if (option !== undefined) {
            void channel.setEffort(option.id)
            setNotice(t('onboarding-effort-switched', { name: option.name }))
          }
          event.stopImmediatePropagation()
        }
        return
      }
      if (zone === 'workspace') {
        if (isPlainReturn(key)) openWorkspacePicker()
        return
      }
      // 模型区：第一层是 provider 分组，进去之后是模型列表。
      if (key.upArrow || key.downArrow) {
        setFocusIndex(previous =>
          Math.max(0, Math.min(previous + (key.upArrow ? -1 : 1), Math.max(0, rowCount - 1))))
        return
      }
      if (isPlainReturn(key)) {
        const groups = modelGroupsOf(models ?? [], providers)
        if (modelGroup === undefined) {
          const group = groups[focusIndex]
          if (group === undefined) return
          setModelGroup(group.provider)
          setFocusIndex(0)
          return
        }
        const model = (models ?? []).filter(entry => entry.provider === modelGroup)[focusIndex]
        if (model === undefined) return
        void channel.switchModel(model.provider, model.id).then((ok) => {
          setNotice(ok
            ? t('onboarding-model-switched', { name: model.name })
            : t('onboarding-model-switch-failed', { name: model.name }), ok ? 'success' : 'error')
        })
        return
      }
      return
    }

    if (step === 'keys') {
      if (key.upArrow || key.downArrow) {
        setFocusIndex(previous =>
          Math.max(0, Math.min(previous + (key.upArrow ? -1 : 1), TUTORIAL_CARDS.length - 1)))
        return
      }
      if (isPlainReturn(key)) {
        const card = TUTORIAL_CARDS[focusIndex]
        // 键位卡（没有命令的）不假装能试：Enter 归"完成"——底部那行
        // `onboarding-hint-last` 承诺的就是它，而它也是唯一会写
        // `~/.dsh-tui/onboarding.json` 的出口（Esc 走 skipped，刻意不记账）。
        // 命令卡保留"试一下"：那是这一屏真正的价值，不能为了出口把它换掉。
        if (card !== undefined && card.command !== undefined) pickCard(card, true)
        else advance()
        return
      }
      return
    }

    // 第一步（动作列表）：↑/↓ 移焦点，Enter 落在动作上。动作本身是异步的，
    // 面板一起就把这一屏交出去（进度在 draft 里，回来接着走）。
    if (step === 'access') {
      if (key.upArrow || key.downArrow) {
        const next = Math.max(0, Math.min(accessIndex + (key.upArrow ? -1 : 1), Math.max(0, accessActionIds.length - 1)))
        const id = accessActionIds[next]
        if (id !== undefined) setAccessFocusId(id)
        // 焦点也进 draft：面板挂起回来时停在同一行动作上。
        setFocusIndex(next)
        return
      }
      if (isPlainReturn(key)) {
        const action = accessActionIds[accessIndex]
        if (action !== undefined) runAccessAction(action)
        event.stopImmediatePropagation()
        return
      }
    }
  })

  const onLast = stepIndex >= ONBOARDING_STEPS.length - 1
  const showSteps = rows >= STEP_BAR_MIN_ROWS && columns >= STEP_BAR_MIN_COLUMNS

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box height={1} flexShrink={0} overflow="hidden">
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color="remember" bold>{t('onboarding-title')}</Text>
          <Text dimColor>{'  ' + t('onboarding-step-progress', { n: stepIndex + 1, total: ONBOARDING_STEPS.length })}</Text>
        </Box>
      </Box>
      <Divider bleed />
      {showSteps && (
        <Box flexShrink={0} overflow="hidden">
          {ONBOARDING_STEPS.map((entry, index) => (
            <Box key={entry} flexShrink={0}>
              <Text
                color={index === stepIndex ? 'suggestion' : index < stepIndex ? 'success' : undefined}
                dimColor={index > stepIndex}
              >
                {' ' + (index < stepIndex ? '✓' : index === stepIndex ? '❯' : '·') + ' ' + t(stepTitleKey(entry) as never)}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingX={2} paddingTop={1}>
        <Box marginBottom={1}>
          <Text dimColor wrap="truncate-end">{t(stepDescKey(step) as never)}</Text>
        </Box>
        {/* 子层（选账号 / 接入）把空间让给清单：状态块只在动作层画一次。 */}
        {step === 'access' && accessPhase === 'actions' && (
          <AccessStatus credential={credential} conn={conn} oauth={oauth} otherAccess={otherAccess} providerLabel={providerLabel} />
        )}
        {step === 'access' && accessPhase === 'actions' && (
          <Box flexDirection="column" marginTop={1}>
            {inFlight && (
              <Box marginBottom={1}>
                <LoadingState message={t('onboarding-access-in-flight')} dimColor />
              </Box>
            )}
            {accessRows.map((row, index) => (
              <Box key={row.id} flexDirection="column" onMouseEnter={() => setAccessFocusId(row.id)}>
                <ListItem
                  isFocused={accessIndex === index}
                  declareCursor={false}
                  onClick={(event: ClickEvent) => {
                    event.stopImmediatePropagation()
                    setAccessFocusId(row.id)
                    runAccessAction(row.id)
                  }}
                >
                  {row.label}
                </ListItem>
                <Text dimColor wrap="truncate-end">{'    ' + row.desc}</Text>
              </Box>
            ))}
            {(!canSignIn || !canConfigure) && !accessReady && (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor wrap="truncate-end">{'  ' + t('onboarding-access-fallback')}</Text>
                {!canSignIn && (
                  <Text dimColor wrap="truncate-end">{'    · ' + t('onboarding-access-fallback-signin')}</Text>
                )}
                {!canConfigure && (
                  <Text dimColor wrap="truncate-end">{'    · ' + t('onboarding-access-fallback-provider')}</Text>
                )}
                <Text dimColor wrap="truncate-end">{'  ' + t('onboarding-access-fallback-env')}</Text>
                <Text>{'    ' + t('onboarding-access-fallback-powershell')}</Text>
                <Text>{'    ' + t('onboarding-access-fallback-cmd')}</Text>
                <Text dimColor wrap="truncate-end">{'  ' + t('onboarding-access-fallback-store')}</Text>
                <Text>{'    ' + t('onboarding-access-fallback-store-path')}</Text>
              </Box>
            )}
          </Box>
        )}
        {step === 'access' && accessPhase === 'signin' && (
          <Box flexDirection="column" marginTop={1}>
            <Box marginBottom={1}><Text bold>{t('onboarding-access-signin-title')}</Text></Box>
            {(oauth ?? []).map((row, index) => (
              <Box key={row.provider} flexDirection="column" onMouseEnter={() => setSigninIndex(index)}>
                <ListItem
                  isFocused={signinIndex === index}
                  declareCursor={false}
                  onClick={(event: ClickEvent) => {
                    event.stopImmediatePropagation()
                    setSigninIndex(index)
                    startSignIn(row.provider)
                  }}
                >
                  {t('onboarding-access-oauth-row', { provider: row.provider, state: oauthStateText(row) })}
                </ListItem>
              </Box>
            ))}
            <Box onMouseEnter={() => setSigninIndex((oauth ?? []).length)}>
              <ListItem
                isFocused={signinIndex === (oauth ?? []).length}
                declareCursor={false}
                onClick={(event: ClickEvent) => {
                  event.stopImmediatePropagation()
                  setAccessPhase('actions')
                }}
              >
                {t('onboarding-access-back')}
              </ListItem>
            </Box>
          </Box>
        )}
        {step === 'access' && accessPhase === 'adopt' && adopt !== undefined && (
          <AdoptPanel
            adopt={adopt}
            providerLabel={providerLabel}
            currentModel={(models ?? []).find(model => model.provider === channel.provider && model.id === channel.model)?.name
              ?? channel.model}
            // 行预算 = 终端高 − 引导骨架 8 行（标题/两条 Divider/步进条/
            // paddingTop/步骤描述+其 marginBottom/提示行）− 面板框架 5 行
            // （marginTop/标题与说明各带 1 行 marginBottom）− 1 行余量；含末尾
            // 3 行操作区（marginTop + "保持当前模型" + 当前模型说明），80×24 下为 10 行。
            windowRows={Math.max(4, rows - 14)}
            onHover={(index) => setAdopt(previous => previous === undefined ? previous : ({ ...previous, index }))}
            onPick={applyAdoption}
          />
        )}
        {step === 'look' && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={4} marginBottom={1}>
              <PaneTab
                label={t('lang-picker-title')}
                active={lookPane === 'lang'}
                onClick={(event) => {
                  event.stopImmediatePropagation()
                  setLookPane('lang')
                }}
              />
              <PaneTab
                label={t('picker-title-theme')}
                active={lookPane === 'theme'}
                onClick={(event) => {
                  event.stopImmediatePropagation()
                  setLookPane('theme')
                }}
              />
              <Box><Text dimColor>{'  ' + t('onboarding-look-preview-note')}</Text></Box>
            </Box>
            {lookPane === 'lang' ? (
              <LangPicker
                focusIndex={Math.min(focusIndex, LANGS.length - 1)}
                currentLang={getLang()}
                onPick={(index) => {
                  setFocusIndex(index)
                  const lang = LANGS[index]
                  if (lang !== undefined) onApplyLang(lang)
                }}
              />
            ) : (
              <ThemePicker
                focusIndex={Math.min(focusIndex, Math.max(0, themeOptions.length - 1))}
                currentTheme={themeName}
                themeHost={themeHost}
                onPick={(index) => {
                  setFocusIndex(index)
                  applyTheme(index)
                }}
              />
            )}
          </Box>
        )}
        {step === 'model' && (
          <ModelStep
            channel={channel}
            models={models}
            providers={providers}
            modelGroup={modelGroup}
            zone={zone}
            focusIndex={focusIndex}
            efforts={efforts}
            effortIndex={effortIndex}
            workspaceLabel={channel.displayCwd}
            onFocus={setFocusIndex}
            onZone={setZone}
            onDrill={(provider) => {
              setModelGroup(provider)
              setFocusIndex(0)
            }}
            onBack={() => {
              setModelGroup(undefined)
              setFocusIndex(0)
            }}
            onModel={(model) => {
              void channel.switchModel(model.provider, model.id).then((ok) => {
                setNotice(ok
                  ? t('onboarding-model-switched', { name: model.name })
                  : t('onboarding-model-switch-failed', { name: model.name }), ok ? 'success' : 'error')
              })
            }}
            onEffort={(index) => {
              setEffortIndex(index)
              const option = efforts[index]
              if (option !== undefined) {
                void channel.setEffort(option.id)
                setNotice(t('onboarding-effort-switched', { name: option.name }))
              }
            }}
            onOpenWorkspace={openWorkspacePicker}
          />
        )}
        {step === 'keys' && (
          <TutorialCards
            focusIndex={focusIndex}
            tried={tried}
            onFocus={setFocusIndex}
            onPick={pickCard}
          />
        )}
      </Box>
      {workspaceOpen && (
        <Box flexDirection="column" paddingX={2}>
          <WorkspacePicker
            targets={workspaces ?? []}
            focusIndex={workspaceIndex}
            currentCwd={channel.cwd}
            onPick={(index) => {
              setWorkspaceIndex(index)
              const target = (workspaces ?? [])[index]
              setWorkspaceOpen(false)
              if (target === undefined) return
              void channel.switchWorkspace(target).then((ok) => {
                setWorkspaces(null)
                setNotice(ok
                  ? t('onboarding-workspace-switched', { name: target.label })
                  : t('onboarding-workspace-failed', { name: target.label }), ok ? 'success' : 'error')
              })
            }}
          />
        </Box>
      )}
      {notice !== undefined && (
        <Box paddingX={2}>
          <Text color={notice.tone} wrap="truncate-end">{notice.text}</Text>
        </Box>
      )}
      <Divider bleed color="subtle" />
      <Box flexShrink={0} height={1} paddingX={2}>
        <Text dimColor italic>
          <HintLine text={t(hintKeyFor(step, accessPhase, onLast))} />
        </Text>
      </Box>
    </Box>
  )
}

/**
 * 第二步顶部的面板标签（"[ 界面语言 ]" / "[ 颜色主题 ]"）。
 *
 * 以前只是两个纯 Text，视觉上像页签、鼠标却点不动——只有 Tab 能切，
 * 用户实测"颜色主题那里根本没法点"。现在照 ListItem 的既有鼠标契约做成
 * 可点 + 可悬停：只有真的挂了 onClick（可点）才给 onMouseEnter/Leave 与
 * hover 底色（userMessageBackgroundHover），hover 反馈就是"这里能点"的
 * 唯一暗示，契约与 ListItem/Select 完全一致。鼠标事件只在
 * AlternateScreen 里触发（Chat 非 fullscreen 时会包一层），与仓库既定
 * 前提一致。
 */
function PaneTab({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: (event: ClickEvent) => void
}): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  return (
    <Box
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      backgroundColor={hovered ? 'userMessageBackgroundHover' : undefined}
    >
      <Text color={active ? 'suggestion' : undefined}>{'[ ' + label + ' ]'}</Text>
    </Box>
  )
}

/**
 * 第一步的状态块：凭证 + 订阅登录 + 真连通性检查。
 *
 * 这里**只读**——动作在下面的动作行里，由 Chat 交给既有的登录/`/provider`
 * 流程执行。凭证只报"有没有"（`describeCredential` 不含秘密）；登录行只画
 * 掩码状态（provider + 已登录/过期/未登录）。
 *
 * 凭证行与余额检查只针对 DeepSeek 官方 API（`balanceInfo` 只认
 * `DEEPSEEK_API_KEY`）。已经有别的接入（`otherAccess`）时，缺这把 key 只是一条
 * 中性说明：刚登录 / 刚配好的人不该看到"没有可用的凭证"。
 *
 * 缺凭证时的文字兜底写的是**真实**的两条路：`$DSH_HOME/.credentials.yaml`
 * 的 `refs:` 段，以及平台各自的环境变量写法（PowerShell 的用户级持久化与
 * cmd 的 setx——一键安装包写的就是前者）。这里不再出现 v1 那条
 * `~/.deepseek/config.json`：DSH 没有读取方，写了也不生效。
 */
function AccessStatus({
  credential,
  conn,
  oauth,
  otherAccess,
  providerLabel,
}: {
  credential: CredentialStatus | undefined
  conn: ConnState
  oauth: readonly OAuthProviderStatus[] | undefined
  /** DeepSeek 官方 key 之外能用的接入（provider / 路由 id）。 */
  otherAccess: readonly string[]
  providerLabel: (id: string | undefined) => string
}): React.ReactNode {
  const configured = credential?.configured === true
  const signedIn = (oauth ?? []).filter(row => row.signedIn)
  const covered = otherAccess.length > 0
  const others = otherAccess.map(id => providerLabel(id)).join(', ')
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box>
          {credential === undefined
            ? <Text dimColor>{t('onboarding-key-checking')}</Text>
            : configured
              ? <Text color="success">{'✓ ' + t('onboarding-key-configured')}</Text>
              : covered
                ? <Text dimColor>{'· ' + t('onboarding-key-optional')}</Text>
                : <Text color="warning">{'✗ ' + t('onboarding-key-missing')}</Text>}
        </Box>
        {credential !== undefined && configured && (
          <Text dimColor>
            {'  ' + credentialSourceText(credential.source)}
          </Text>
        )}
        {oauth !== undefined && (
          signedIn.length > 0
            ? <Text color="success">
                {'✓ ' + t('onboarding-access-oauth-in', { n: signedIn.length, providers: signedIn.map(row => row.provider).join(', ') })}
              </Text>
            : <Text dimColor>{'· ' + t('onboarding-access-oauth-none')}</Text>
        )}
        {credential !== undefined && !configured && !covered && (
          <Text dimColor>{'  ' + t('onboarding-key-shape')}</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {conn.kind === 'running' && <LoadingState message={t('onboarding-conn-running')} dimColor />}
        {conn.kind === 'ok' && (
          <Box flexDirection="column">
            <Box><Text color="success">{'✓ ' + t('onboarding-conn-ok')}</Text></Box>
            <Text dimColor>{'  ' + t('onboarding-conn-models', { count: conn.models })}</Text>
            <Text dimColor>
              {'  ' + (conn.balance === null ? t('onboarding-conn-balance-none') : t('onboarding-conn-balance', { amount: conn.balance }))}
            </Text>
          </Box>
        )}
        {conn.kind === 'fail' && (conn.reason === 'no-key' && covered
          ? <Box><Text dimColor wrap="truncate-end">{'· ' + t('onboarding-conn-skipped', { providers: others })}</Text></Box>
          : <Box><Text color="error">{'✗ ' + connFailText(conn.reason, conn.status)}</Text></Box>)}
      </Box>
    </Box>
  )
}

/**
 * 选默认层：订阅登录之后新出现的模型里，哪一个当默认。
 *
 * 只有 N>1 才会走到这里（0 不问、1 直接落默认）。这些模型登录后已经全部可用
 * （凭据门控目录），所以这一层是**单选**，不问"接入哪些"——没有任何地方会保存
 * 那个子集。末尾一行是"保持当前模型"；Esc 同义。两条路都不撤回已经登录的东西。
 */
function AdoptPanel({
  adopt,
  providerLabel,
  currentModel,
  windowRows,
  onHover,
  onPick,
}: {
  adopt: AdoptState
  providerLabel: (id: string | undefined) => string
  /** 当前默认模型的显示名（"保持当前模型"那一行的说明）。 */
  currentModel: string | undefined
  /** 列表区可用行数（终端高减去引导骨架与面板框架；含末尾操作区）。 */
  windowRows: number
  onHover: (index: number) => void
  /** 落点：一个新模型，或 `undefined` = 保持当前模型。 */
  onPick: (row: ProviderModelRef | undefined) => void
}): React.ReactNode {
  const { plan } = adopt
  const label = providerLabel(plan.provider)
  // 一批跨多个 provider 时按 provider 数报数（标题里点名单个 provider 是假的）。
  const title = plan.multiProvider || label === ''
    ? t('onboarding-access-adopt-title-multi', {
        n: plan.added.length,
        providers: addedProviderOrder(plan.added).length,
      })
    : t('onboarding-access-adopt-title', { provider: label, n: plan.added.length })
  // 列表窗口化：模型可能几十个，全量渲染会把焦点行挤出屏幕（80×24 下 30 个
  // 模型时实测焦点行不可见），而 ↑/↓、Enter 仍作用在 `adopt.index` 上。末尾
  // "保持当前模型"是操作区，固定在窗口之外（marginTop + 行 + 说明，占 3 行）。
  const keepIndex = plan.added.length
  const { start, end } = listWindow(
    plan.added.map(() => 1),
    Math.min(adopt.index, Math.max(0, keepIndex - 1)),
    Math.max(1, windowRows - 3),
  )
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginBottom={1}>
        <Text bold>{title}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor wrap="truncate-end">{t('onboarding-access-adopt-note')}</Text>
      </Box>
      {plan.added.slice(start, end).map((row, offset) => {
        const index = start + offset
        return (
          <Box key={modelRefKey(row)} flexDirection="column" onMouseEnter={() => onHover(index)}>
            <ListItem
              isFocused={adopt.index === index}
              declareCursor={false}
              showScrollUp={index === start && start > 0}
              showScrollDown={index === end - 1 && end < plan.added.length}
              onClick={(event: ClickEvent) => {
                event.stopImmediatePropagation()
                onHover(index)
                onPick(row)
              }}
            >
              {row.name + '  ' + row.provider}
            </ListItem>
          </Box>
        )
      })}
      <Box flexDirection="column" marginTop={1} onMouseEnter={() => onHover(keepIndex)}>
        <ListItem
          isFocused={adopt.index === keepIndex}
          declareCursor={false}
          onClick={(event: ClickEvent) => {
            event.stopImmediatePropagation()
            onHover(keepIndex)
            onPick(undefined)
          }}
        >
          {t('provider-opt-switch-keep')}
        </ListItem>
        <Text dimColor wrap="truncate-end">
          {'    ' + (currentModel === undefined ? '' : t('provider-opt-switch-keep-desc', { model: currentModel }))}
        </Text>
      </Box>
    </Box>
  )
}

/** 第三步：模型 / 强度 / 工作区三块，Tab 换焦点区。 */
function ModelStep({
  channel,
  models,
  providers,
  modelGroup,
  zone,
  focusIndex,
  efforts,
  effortIndex,
  workspaceLabel,
  onFocus,
  onZone,
  onDrill,
  onBack,
  onModel,
  onEffort,
  onOpenWorkspace,
}: {
  channel: Channel
  models: readonly LlmModelInfo[] | null
  providers: readonly LlmProviderInfo[]
  modelGroup: string | undefined
  zone: ModelZone
  focusIndex: number
  efforts: readonly EffortOption[]
  effortIndex: number
  workspaceLabel: string
  onFocus: (index: number) => void
  onZone: (zone: ModelZone) => void
  onDrill: (provider: string) => void
  onBack: () => void
  onModel: (model: LlmModelInfo) => void
  onEffort: (index: number) => void
  onOpenWorkspace: () => void
}): React.ReactNode {
  if (models === null) return <Text dimColor>{t('onboarding-model-loading')}</Text>
  const groups = modelGroupsOf(models, providers)
  const rows = modelGroup === undefined ? groups : models.filter(model => model.provider === modelGroup)
  if (models.length === 0) return <Text dimColor>{t('onboarding-model-empty')}</Text>
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box>
          <Text color={zone === 'model' ? 'suggestion' : undefined} bold>
            {t('picker-title-model')}
          </Text>
          <Text dimColor>{'  ' + (modelGroup === undefined ? channel.provider : modelGroup)}</Text>
        </Box>
        {(() => {
          // 与 /model（ModelPicker）同一条窗口化路：按焦点切片，而不是硬截
          // 前 6 行——用户实测第 7 个及以后的 provider（deepseek-official 就
          // 排在那）被切掉，最该出现的分组反而不见。键盘 ↑/↓ 本就能走到
          // rowCount-1（见 modelRowCount），这里只是让渲染跟上焦点；窗口边
          // 缘用 ListItem 自带的 ▲/▼ 提示还有折叠项。每行恒 1 行高
          // （ListItem 压平换行），listWindow 按行预算即按项数预算。
          const windowRows = 6
          const focus = zone === 'model' ? Math.min(Math.max(focusIndex, 0), Math.max(0, rows.length - 1)) : 0
          const { start, end } = listWindow(rows.map(() => 1), focus, windowRows)
          return rows.slice(start, end).map((row, index) => {
            const absoluteIndex = start + index
            const isGroup = modelGroup === undefined
            const label = isGroup ? (row as { label: string }).label : (row as LlmModelInfo).name
            const key = isGroup ? (row as { provider: string }).provider : (row as LlmModelInfo).id
            const selected = isGroup
              ? (row as { provider: string }).provider === channel.provider
              : (row as LlmModelInfo).id === channel.model
            return (
              <Box key={key} onMouseEnter={() => { onZone('model'); onFocus(absoluteIndex) }}>
                <ListItem
                  isFocused={zone === 'model' && focusIndex === absoluteIndex}
                  isSelected={selected}
                  declareCursor={false}
                  showScrollUp={absoluteIndex === start && start > 0}
                  showScrollDown={absoluteIndex === end - 1 && end < rows.length}
                  onClick={(event: ClickEvent) => {
                    event.stopImmediatePropagation()
                    onZone('model')
                    onFocus(absoluteIndex)
                    if (isGroup) onDrill((row as { provider: string }).provider)
                    else onModel(row as LlmModelInfo)
                  }}
                >
                  {label}
                </ListItem>
              </Box>
            )
          })
        })()}
        {modelGroup !== undefined && (
          // 钻进去之后的**鼠标**出路：键盘是 Esc（Esc 先退一层，再按才跳过向导），
          // 但鼠标没有 Esc——没有这一行，点进来的人只能去点别的区域。
          <Box onMouseEnter={() => onZone('model')}>
            <ListItem
              isFocused={false}
              declareCursor={false}
              onClick={(event: ClickEvent) => {
                event.stopImmediatePropagation()
                onBack()
              }}
            >
              {t('onboarding-model-back')}
            </ListItem>
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <EffortSlider
          options={efforts}
          focusIndex={effortIndex}
          currentId={channel.reasoningEffort}
          onPick={(index) => {
            onZone('effort')
            onEffort(index)
          }}
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={zone === 'workspace' ? 'suggestion' : undefined} bold>
            {t('onboarding-model-workspace')}
          </Text>
          <Text dimColor>{'  ' + t('onboarding-model-workspace-note')}</Text>
        </Box>
        <Box onMouseEnter={() => onZone('workspace')}>
          <ListItem
            isFocused={zone === 'workspace'}
            isSelected
            declareCursor={false}
            onClick={(event: ClickEvent) => {
              event.stopImmediatePropagation()
              onZone('workspace')
              onOpenWorkspace()
            }}
          >
            {workspaceLabel}
          </ListItem>
        </Box>
      </Box>
    </Box>
  )
}

/** 第四步：招式卡。可试的命令卡多一个"试一下"，键位卡只读。 */
function TutorialCards({
  focusIndex,
  tried,
  onFocus,
  onPick,
}: {
  focusIndex: number
  tried: ReadonlySet<string>
  onFocus: (index: number) => void
  onPick: (card: TutorialCard, tryIt: boolean) => void
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>{t('onboarding-cards-title')}</Text>
      </Box>
      {TUTORIAL_CARDS.map((card, index) => {
        const isTried = tried.has(card.id)
        const combo = card.command !== undefined
          ? '/' + card.command
          : card.action !== undefined ? CANCEL_COMBO : (card.literal ?? '')
        return (
          <Box key={card.id} flexDirection="column" marginBottom={1} onMouseEnter={() => onFocus(index)}>
            <Box>
              <Text color={focusIndex === index ? 'suggestion' : undefined} bold>
                {t(card.titleKey as never)}
              </Text>
              {combo !== '' && <Text color="accent">{'  ' + combo}</Text>}
              {isTried && <Text color="success">{'  ' + t('onboarding-card-tried')}</Text>}
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor wrap="truncate-end">{t(card.descKey as never)}</Text>
            </Box>
            {card.command !== undefined && (
              <Box paddingLeft={2} onMouseEnter={() => onFocus(index)}>
                <ListItem
                  isFocused={focusIndex === index}
                  declareCursor={false}
                  onClick={(event: ClickEvent) => {
                    event.stopImmediatePropagation()
                    onFocus(index)
                    onPick(card, true)
                  }}
                >
                  {t('onboarding-card-try')}
                </ListItem>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
