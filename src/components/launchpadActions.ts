import { stringWidth } from '../ink/stringWidth.js'
import { kernelDisplayName } from './kernelCatalog.js'

/**
 * 落地页的一个动作入口（第四版：状态驱动的"下一步建议"）。
 *
 * 动作走命令名（第七版表 + 内核入口：continue / home / settings / backend
 * / jobs / update / star / help）——除 backend 外全部是既有命令；backend 打开
 * 内核选择器（选择器渲染与 runCommand 处理在 Chat 侧）。它把"当前状态下最
 * 可能的下一步"摆到台面上。知道了名字，键盘用户直接敲；鼠标用户点一下，
 * 两条路落到同一个 `runCommand`。
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
 * 第七版：每个字段都来自**既有**数据源（不造假）：
 *   - `lastSessionTitle`：会话名册（`channel.agentViewRows`，含持久化会话）
 *     里最近一条**可继续**会话的标题；没有就没有 Continue（不放假动作）；
 *   - `jobsRunning`：`channel.backgroundJobs` 里有 running/stopping 的任务；
 *   - `updateAvailable`：`checkForTuiUpdate()`（src/update.ts，与 /update
 *     同一条判定）在启动页挂起时异步探得的新版本；
 *   - `starDue`：`usageStats`（~/.dsh-tui/usage.json）有**未报过的**已达档
 *     里程碑（首档 24h）且本进程尚未 star 成功——口径与开屏求 star 弹窗
 *     完全一致（pendingStarMilestone + starred）。
 */
export interface LaunchpadActionState {
  /** 最近一条可继续会话的标题；没有（或为空）视为"无历史"，整格不画。 */
  readonly lastSessionTitle?: string | undefined
  /** 有后台任务在跑（条件位①）。 */
  readonly jobsRunning: boolean
  /** 检测到可用更新（条件位②）。 */
  readonly updateAvailable: boolean
  /** 用量到档且从未 star（条件位③）。 */
  readonly starDue: boolean
  /** 当前内核（channel.backendCapabilities.backendId；缺省 = 未知 → 内核
   *  入口用短标签，不带名。阶段A由 Chat 侧接线）。 */
  readonly backendId?: string | undefined
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
/**
 * 会话与工作区（第七版合并入口）：历史会话与工作区本来就是同一个界面
 * （`/home` 的会话名册 = 工作区首页，见 Chat 的 resume/home/agentview 合一
 * 注释），两个按钮进同一个页面——用户实测后要求合并只留一个。命令用
 * 既有的 `home` 那条。
 */
const SESSIONS_WORKSPACE: LaunchpadAction = {
  id: 'sessions-workspace',
  labelKey: 'launchpad-action-sessions-workspace',
  command: 'home',
}
/** Settings（用户拍板的第三格）。 */
const SETTINGS: LaunchpadAction = {
  id: 'settings',
  labelKey: 'launchpad-action-settings',
  command: 'settings',
}
/**
 * 内核（第四格，固定入口）：打开内核选择器。当前内核已知时带名
 * （「内核 · Claude」），未知（接线前）用短标签——kernelCatalog 的
 * displayName 是品牌名的唯一来源。
 */
const BACKEND: LaunchpadAction = {
  id: 'backend',
  labelKey: 'launchpad-action-backend',
  command: 'backend',
}
/** 条件位①：有后台任务在跑。 */
const JOBS: LaunchpadAction = {
  id: 'jobs',
  labelKey: 'launchpad-action-jobs',
  command: 'jobs',
}
/** 条件位②：检测到可用更新。 */
const UPDATE: LaunchpadAction = {
  id: 'update',
  labelKey: 'launchpad-action-update',
  command: 'update',
}
/** 条件位③：用量到档且从未 star。 */
const STAR: LaunchpadAction = {
  id: 'star',
  labelKey: 'launchpad-action-star',
  command: 'star',
}
/** Help（? 快捷键与命令）——条件位的兜底。 */
const HELP: LaunchpadAction = {
  id: 'help',
  labelKey: 'launchpad-action-help',
  command: 'help',
}

/**
 * 落地页第七版的核心纯函数：按状态快照决定入口行放什么。
 *
 * 版面（用户拍板的四格 + 内核入口；第一格条件性缺席，最多五格）：
 *
 *   1. `继续「<标题>」` —— 有可继续会话才画（无历史不放假动作）；
 *      快捷键 Alt+R（keymap 的 `continue` 动作，见 utils/keymap.ts）。
 *   2. `会话与工作区` —— 历史会话 + 工作区合并入口；命令用既有 `home`。
 *   3. `设置` —— /settings。
 *   4. `内核` —— 打开内核选择器（backendId 已知时「内核 · Claude」；选择
 *      器本体在 Chat 侧渲染）。窄屏装不下时它排在条件位**之后**被裁——
 *      fitChips 整条取舍，条件位先让位。
 *   5. 条件位，**按优先级取第一个成立者**（同时成立时高优先级胜出，
 *      回归按这张优先级表驱动）：
 *        ① jobsRunning → `后台任务`（/jobs）
 *        ② updateAvailable → `有新版本`（/update，走既有更新路径）
 *        ③ starDue → `投喂一颗 Star`（/star）
 *        ④ 都不成立 → `帮助`（/help）兜底。
 *
 * 第六版的 doctor 入口已删（第七版）：它的输出属于转录区，天然把人带进
 * 对话页，不适合留在"Esc 必须回启动页"的这一屏；首启/配置问题专属按钮
 * 也随之退役——首启由引导向导（盖在落地页之上）承担，provider 配置经
 * 向导或 /settings 可达。输出恒 ≤5 条。
 *
 * 纯函数：不改入参、不读环境、同样输入恒同样输出——表驱动回归钉死每个状态。
 */
export function resolveLaunchpadActions(state: LaunchpadActionState): readonly LaunchpadAction[] {
  const conditional = state.jobsRunning
    ? JOBS
    : state.updateAvailable
      ? UPDATE
      : state.starDue
        ? STAR
        : HELP
  // 内核入口：当前内核已知 → 带名（「内核 · Claude」）；未知（Chat 侧接线
  // 前）→ 短标签。显示名走 kernelCatalog，与选择器和重启通知同源。
  const backend = state.backendId === undefined
    ? BACKEND
    : { ...BACKEND, labelKey: 'launchpad-action-backend-named', values: { name: kernelDisplayName(state.backendId) } }
  const title = truncateContinueTitle(state.lastSessionTitle ?? '')
  if (title !== '') {
    return [
      { ...CONTINUE, labelKey: 'launchpad-action-continue-titled', values: { title } },
      SESSIONS_WORKSPACE,
      SETTINGS,
      backend,
      conditional,
    ]
  }
  return [SESSIONS_WORKSPACE, SETTINGS, backend, conditional]
}
