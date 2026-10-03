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
import type { ClickEvent } from '../ink/events/click-event.js'
import type { ChannelUi as Channel } from '../adapter/channel/ui-policy.js'
import type { CredentialStatus, EffortOption, LlmModelInfo, LlmProviderInfo } from '../adapter/ports/channel-view.js'
import type { BalanceResult } from '../adapter/ports/channel-catalog.js'
import type { TuiThemeHost } from '../dsh-adapter/themes.js'
import type { TuiWorkspaceTarget } from '../workspaces.js'

/** 一次连通性检查的状态机（第一步）。`idle` 只在一瞬间存在——挂载即开跑。 */
type ConnState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; models: number; balance: string | null }
  | { kind: 'fail'; reason: string; status?: number | undefined }

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
 */
export function Onboarding({
  channel,
  themeHost,
  onClose,
  onRunCommand,
  onApplyLang,
  initialStep = 0,
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
  /** 测试缝：直接落在某一步（探针不重复走前几步）。 */
  initialStep?: number
  /** 测试缝：外部注入一句提示（真机不传）。 */
  externalNotice?: string
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [stepIndex, setStepIndex] = React.useState(() =>
    Math.max(0, Math.min(initialStep, ONBOARDING_STEPS.length - 1)))
  const step = ONBOARDING_STEPS[stepIndex]!
  const [focusIndex, setFocusIndex] = React.useState(0)
  const [notice, setNotice] = React.useState<string | undefined>(externalNotice)

  // ── 第一步：凭证 + 连通性 ────────────────────────────────────────────
  const [credential, setCredential] = React.useState<CredentialStatus | undefined>(undefined)
  const [conn, setConn] = React.useState<ConnState>({ kind: 'idle' })
  const [checkNonce, setCheckNonce] = React.useState(0)
  React.useEffect(() => {
    let alive = true
    setCredential(undefined)
    setConn({ kind: 'running' })
    void (async () => {
      const status = await channel.describeCredential('DEEPSEEK_API_KEY').catch(() => undefined)
      if (!alive) return
      setCredential(status)
      const [models, balance] = await Promise.all([
        channel.listModels().catch(() => [] as readonly LlmModelInfo[]),
        channel.balanceInfo().catch(() => ({ ok: false, reason: 'network' }) as BalanceResult),
      ])
      if (!alive) return
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
  }, [channel])

  // ── 第四步：招式卡 ──────────────────────────────────────────────────
  const [tried, setTried] = React.useState<ReadonlySet<string>>(() => new Set())

  const finish = React.useCallback((outcome: 'skipped' | 'done'): void => {
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

  /** 当前这一步有多少可移动的行（决定 ↑/↓ 的上限与回车落点）。 */
  const rowCount = step === 'apikey'
    ? 1
    : step === 'look'
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
            : t('onboarding-workspace-failed', { name: target.label }))
        })
      }
      return
    }
    if (key.ctrl && input === 'c') {
      finish('skipped')
      event.stopImmediatePropagation()
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
            : t('onboarding-model-switch-failed', { name: model.name }))
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

    // 第一步：只有"重新检查"一个动作。
    if (step === 'apikey' && isPlainReturn(key)) {
      setCheckNonce(nonce => nonce + 1)
      return
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
        {step === 'apikey' && (
          <ApiKeyStep credential={credential} conn={conn} focusIndex={focusIndex} onRetry={() => setCheckNonce(n => n + 1)} onHover={setFocusIndex} />
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
                  : t('onboarding-model-switch-failed', { name: model.name }))
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
                  : t('onboarding-workspace-failed', { name: target.label }))
              })
            }}
          />
        </Box>
      )}
      {notice !== undefined && (
        <Box paddingX={2}>
          <Text color="success" wrap="truncate-end">{notice}</Text>
        </Box>
      )}
      <Divider bleed color="subtle" />
      <Box flexShrink={0} height={1} paddingX={2}>
        <Text dimColor italic>
          <HintLine text={t(onLast ? 'onboarding-hint-last' : 'onboarding-hint')} />
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

/** 第一步：凭证状态 + 真连通性检查。 */
function ApiKeyStep({
  credential,
  conn,
  focusIndex,
  onRetry,
  onHover,
}: {
  credential: CredentialStatus | undefined
  conn: ConnState
  focusIndex: number
  onRetry: () => void
  onHover: (index: number) => void
}): React.ReactNode {
  const configured = credential?.configured === true
  return (
    <Box flexDirection="column">
      <Box>
        {credential === undefined
          ? <Text dimColor>{t('onboarding-key-checking')}</Text>
          : configured
            ? <Text color="success">{'✓ ' + t('onboarding-key-configured')}</Text>
            : <Text color="warning">{'✗ ' + t('onboarding-key-missing')}</Text>}
      </Box>
      {credential !== undefined && configured && (
        <Text dimColor>
          {'  ' + credentialSourceText(credential.source)}
        </Text>
      )}
      {credential !== undefined && !configured && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{'  ' + t('onboarding-key-shape')}</Text>
          <Text dimColor>{'  ' + t('onboarding-key-howto-env')}</Text>
          <Text>{'    DEEPSEEK_API_KEY=sk-…      (PowerShell: $env:DEEPSEEK_API_KEY="sk-…")'}</Text>
          <Text dimColor>{'  ' + t('onboarding-key-howto-config')}</Text>
          <Text>{'    ~/.deepseek/config.json  { "apiKey": "sk-…" }'}</Text>
        </Box>
      )}
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
        {conn.kind === 'fail' && (
          <Box flexDirection="column">
            <Box><Text color="error">{'✗ ' + connFailText(conn.reason, conn.status)}</Text></Box>
            <Box marginTop={1} onMouseEnter={() => onHover(0)}>
              <ListItem
                isFocused={focusIndex === 0}
                declareCursor={false}
                onClick={(event: ClickEvent) => {
                  event.stopImmediatePropagation()
                  onRetry()
                }}
              >
                {t('onboarding-key-retry')}
              </ListItem>
            </Box>
          </Box>
        )}
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
