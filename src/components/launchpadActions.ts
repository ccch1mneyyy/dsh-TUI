import { stringWidth } from '../ink/stringWidth.js'

/**
 * 落地页的一个动作入口（第四版：状态驱动的"下一步建议"）。
 *
 * 动作仍然全部走**既有命令名**（`continue` / `home` / `workspace` / `model` /
 * `setup` / `help`）——这一屏不新增行为，它只是把"当前状态下最可能的下一步"
 * 摆到台面上。知道了名字，键盘用户直接敲；鼠标用户点一下，两条路落到同一个
 * `runCommand`。
 */
export interface LaunchpadAction {
  /** 稳定的行标识（焦点、`key` 都用它）。 */
  readonly id: string
  /** i18n key：那一行的短标签。 */
  readonly labelKey: string
  /** i18n 插值参数（目前只有 Continue 带会话标题）。 */
  readonly values?: Readonly<Record<string, string>>
  /** 点击/回车时交给 `Chat.runCommand` 的命令名（不含斜杠）。 */
  readonly command: string
}

/**
 * resolveLaunchpadActions 的输入——一次启动的状态快照。
 *
 * 每个字段都来自**既有**数据源（不造假）：
 *   - `onboardingPending`：`onboardingPrefs.shouldOfferOnboarding`（`Chat`
 *     在 boot 时拿到的 `onboardingOnBoot` 及完成后的回落状态）；
 *   - `configProblem`：cordis.yml 里 `provider` 键没配（`channel.
 *     configuredProvider` 为空）——"没有可用 provider / 模型配置缺失"的
 *     启动期真信号；
 *   - `lastSessionTitle`：会话名册（`channel.agentViewRows`，含持久化会话）
 *     里最近一条**可继续**会话的标题；
 *   - `gitBranch`：`channel.gitBranch`。**只作记录**，不影响输出（见下）；
 *   - `justUpgraded`：仓库里没有"上次运行版本"的持久化标记，也没有可执行的
 *     What's New 页面——保留字段但**没有任何调用方会传**，传了也不会生成
 *     `What's New` 按钮（宁可少一个入口，不放假动作）。
 */
export interface LaunchpadActionState {
  /** 首启：引导（onboarding）还没完成。 */
  readonly onboardingPending: boolean
  /** 检测到配置问题（没有可用 provider / 模型配置缺失）。 */
  readonly configProblem: boolean
  /** 最近一条可继续会话的标题；没有（或为空）视为"无历史"。 */
  readonly lastSessionTitle?: string | undefined
  /**
   * 当前目录的 Git 分支。**不影响动作表**：仓库里没有"切分支"的可执行
   * 路径，用户举例里的 `Branch` 没有落地（报告里如实列出）；保留在状态
   * 里是为了契约显式——调用方传了也不许凭空长出一个点不动的按钮。
   */
  readonly gitBranch?: string | undefined
  /** 刚升级过。无数据源、无条件按钮，见 {@link LaunchpadActionState}。 */
  readonly justUpgraded?: boolean | undefined
}

/** Continue 标题的截断上限（显示宽度，含截断省略号）。 */
export const LAUNCHPAD_CONTINUE_TITLE_MAX = 16

/**
 * 截断会话标题：按显示宽度（CJK 双宽）从头部取，超宽补 `…`。
 * 纯函数、无副作用，表驱动回归直接钉它的边界。
 */
export function truncateContinueTitle(title: string, max = LAUNCHPAD_CONTINUE_TITLE_MAX): string {
  const clean = title.replace(/[\r\n]+/gu, ' ').trim()
  if (stringWidth(clean) <= max) return clean
  let width = 0
  let out = ''
  for (const ch of Array.from(clean)) {
    const w = stringWidth(ch)
    if (width + w > max - 1) break
    out += ch
    width += w
  }
  return out + '…'
}

/** Continue（不带标题时的短标签）。 */
const CONTINUE: LaunchpadAction = {
  id: 'continue',
  labelKey: 'launchpad-action-continue',
  command: 'continue',
}
/** Sessions（esc 那条路：/home 会话名册）。 */
const SESSIONS: LaunchpadAction = {
  id: 'sessions',
  labelKey: 'launchpad-action-sessions',
  command: 'home',
}
/** Workspace（切换项目/工作目录）。 */
const WORKSPACE: LaunchpadAction = {
  id: 'workspace',
  labelKey: 'launchpad-action-workspace',
  command: 'workspace',
}
/** Model（切换模型）。 */
const MODEL: LaunchpadAction = {
  id: 'model',
  labelKey: 'launchpad-action-model',
  command: 'model',
}
/** Help（? 快捷键与命令）。 */
const HELP: LaunchpadAction = {
  id: 'help',
  labelKey: 'launchpad-action-help',
  command: 'help',
}
/** 首启条件按钮：Quick Setup。 */
const QUICK_SETUP: LaunchpadAction = {
  id: 'setup',
  labelKey: 'launchpad-action-setup',
  command: 'setup',
}
/** 配置问题条件按钮：Set up provider。 */
const SET_UP_PROVIDER: LaunchpadAction = {
  id: 'setup',
  labelKey: 'launchpad-action-setup-provider',
  command: 'setup',
}

/**
 * 落地页第四版的核心纯函数：按状态快照决定四个位置放什么。
 *
 * 优先级表（每行"为什么这样排"）：
 *
 * | 状态 | 动作表 | 为什么 |
 * |---|---|---|
 * | 首启（引导未完成） | Quick Setup · Workspace · Model · Help | 刚安装最该做的是跑一遍引导；还没有历史可继续，Sessions 让位给 Help（装完最常查的就是键位表） |
 * | 配置问题 | Set up provider · Sessions · Workspace · Model | provider 缺失必须第一位修；其余三个常驻位保持不动，修完刷新即回常态 |
 * | 有上次会话 | Continue "<标题>" · Sessions · Workspace · Model | Continue 是最高频动作（用户原话）；Git 分支**不**占据一位——仓库没有切分支的可执行路径 |
 * | 常态（无上次会话） | Sessions · Workspace · Model · Help | 没有可继续的就去看历史；Help 补第四位 |
 *
 * `theme` / `lang` / `settings` **永远不在表里**（它们属于 Settings，落地页
 * 不设 Settings 按钮）；`setup` 只在上表前两行出现，onboarding 完成且配置
 * 正常后永久消失。输出恒 ≤4 条。
 *
 * 纯函数：不改入参、不读环境、同样输入恒同样输出——表驱动回归钉死每个状态。
 */
export function resolveLaunchpadActions(state: LaunchpadActionState): readonly LaunchpadAction[] {
  if (state.onboardingPending) {
    return [QUICK_SETUP, WORKSPACE, MODEL, HELP]
  }
  if (state.configProblem) {
    return [SET_UP_PROVIDER, SESSIONS, WORKSPACE, MODEL]
  }
  const title = truncateContinueTitle(state.lastSessionTitle ?? '')
  if (title !== '') {
    return [{ ...CONTINUE, labelKey: 'launchpad-action-continue-titled', values: { title } }, SESSIONS, WORKSPACE, MODEL]
  }
  return [SESSIONS, WORKSPACE, MODEL, HELP]
}
