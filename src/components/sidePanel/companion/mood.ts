/**
 * Companion 情绪管线（设计分文档 §2 + v2.1 + 2026-10 防闪烁平滑层）。
 *
 * 分四层，前两层纯派生、后两层近纯步进，全部可脱离组件单测：
 *
 *   信号 ──deriveCompanionMood──▶ 目标心情（瞬时信号直读：审批/失败/工作/庆祝/睡眠）
 *       ──deriveCompanionContext──▶ 并行上下文（music/conducting/building/compacting）
 *       ──resolveTargetSemantic──▶ 目标显示语义
 *       ──stepCompanionDisplay──▶ 显示语义（平滑器：防抖 + 最短停留 + 抢占）
 *   互动（戳/挠/拖拽/悬停）与通知气泡反应是独立覆盖层，由 CompanionPanel
 *   接线；演完回到**平滑后**的显示语义，不重新派生。
 *
 * 防闪烁五规则（用户实测：快速短工具调用让动画在 typing/idle/happy 间闪跳）：
 * 1. 派生与显示分离（本文件即实现，组件不外挂补丁层）。
 * 2. 优先级 attention > error > working > celebrate > idle 族；只有
 *    notification/error 语义允许立刻打断当前动画；happy 是回合完成的
 *    边沿一次性事件（只在 working→false 时由 Panel 触发一次），自带
 *    CELEBRATE_DWELL_MS 停留窗——若再过闸门会被截短，故同样立即切换。
 * 3. 离开活跃族（working/上下文）进 idle 族要 LEAVE_WORKING_SETTLE_MS 的
 *    稳定期；连发短工具的间隙典型 200–800ms，1500ms 覆盖住抖动又不至于
 *    让"停下来了"的反馈显得迟钝。进入 working 族不防抖（立刻切，有信息量）。
 * 4. 非抢占切换要 MIN_MOOD_DWELL_MS 最短停留（人眼对终端动画的感知下限
 *    量级，低于它就是闪）；同语义重派生**不重置**动画时钟（since 保留，
 *    elapsed 连续、不跳帧）。
 * 5. 互动层独立；idle 族（idle/idle-look/idle-spout/swim）按
 *    IDLE_ROTATE_MS 时间轮换，不跟信号边沿走。
 */
import type { ActivityView } from '../../../dsh-adapter/activity-store.js'
import type { SpinnerMode } from '../../../adapter/ports/channel-display.js'

// ---------------------------------------------------------------------------
// 量级常量（回归直接引用，勿在测试/组件里硬编码另一份）
// ---------------------------------------------------------------------------

/** 离开活跃族的防抖窗：目标稳定非工作这么久才切走（规则 3）。 */
export const LEAVE_WORKING_SETTLE_MS = 1500
/** 任何非抢占切换后的最短停留（规则 4）。 */
export const MIN_MOOD_DWELL_MS = 1000
/** 回合完成庆祝（happy）的停留窗；由 Panel 在 working→false 边沿armed。 */
export const CELEBRATE_DWELL_MS = 2500
/** idle 族动画的轮换周期（规则 5）。 */
export const IDLE_ROTATE_MS = 8000
/** 狂点判定窗口：窗口内 ≥TICKLE_MIN_CLICKS 次点击 → tickle。 */
export const TICKLE_WINDOW_MS = 900
export const TICKLE_MIN_CLICKS = 3
/** 通知气泡的展示时长（约数，按动画 tick 粒度收回）。 */
export const NOTIFICATION_BUBBLE_MS = 5000
/** 醒来（waking）反应的闪现时长。 */
export const WAKING_FLASH_MS = 1800
/** 顶箱子（carrying，gitBranch 变更闪现）时长。 */
export const CARRYING_FLASH_MS = 2500
/** Enter 戳一戳时完整活动行气泡的时长。 */
export const POKE_MS = 3000

// ---------------------------------------------------------------------------
// 目标心情（纯派生）
// ---------------------------------------------------------------------------

export type CompanionMood =
  /** 空闲超过 sleepAfter 且无未读事项。 */
  | 'sleeping'
  /** 空闲。 */
  | 'idle'
  /** 请求已发、首 token 未到。 */
  | 'waiting'
  /** 推理中。 */
  | 'thinking'
  /** 工具运行中。 */
  | 'working'
  /** 正文流式中。 */
  | 'responding'
  /** 有待处理的审批 / 问卷（失败任务不再折进来——那是 error）。 */
  | 'attention'
  /** 回合完成 / goal 完成 / star / 节日彩蛋（短暂）。 */
  | 'celebrate'
  /** 工具失败：后台任务失败未读或子代理 failed（官方素材表 error=工具失败）。 */
  | 'error'

export interface CompanionMoodInputs {
  readonly working: boolean
  readonly spinnerMode: SpinnerMode
  /** workingActivity 投影（activity 插件未装时缺省，退回 working +
   *  spinnerMode 也能给出 waiting / thinking / working / responding）。 */
  readonly activity: ActivityView | undefined
  /** 需要用户处理的事（审批/问卷）→ attention。 */
  readonly attention: { readonly approvalPending: boolean; readonly questionPending: boolean }
  /** 失败信号（后台任务失败未读 + failed 子代理数）→ error。 */
  readonly failures: { readonly failedJobsUnread: number; readonly failedSubagents: number }
  readonly lastInputAt: number
  readonly celebration: {
    readonly kind: 'star' | 'holiday' | 'turn-done' | 'goal-done'
    readonly until: number
  } | undefined
  /** 0 = 不入睡。 */
  readonly sleepAfterMs: number
}

export interface DerivedCompanionMood {
  readonly mood: CompanionMood
  /** 皮肤气泡文案（activity.phrase ?? label+detail；宽截断在皮肤侧）。
   *  非工作/注意态为 undefined。 */
  readonly bubble?: string
}

/** 工作态细分：activity 投影优先，缺省时 spinnerMode 兜底。 */
function workingMood(inputs: CompanionMoodInputs): CompanionMood {
  const activity = inputs.activity
  if (activity !== undefined && activity.phase !== 'idle' && activity.phase !== 'done') {
    if (activity.phase === 'waiting') return 'waiting'
    if (activity.phase === 'thinking') return 'thinking'
    return 'working'
  }
  switch (inputs.spinnerMode) {
    case 'requesting':
      return 'waiting'
    case 'thinking':
      return 'thinking'
    case 'responding':
      return 'responding'
    case 'tool-use':
    case 'tool-input':
      return 'working'
  }
}

/** 纯派生（规则 1 的第一层）：attention > error > working > celebrate >
 *  sleeping > idle。 */
export function deriveCompanionMood(inputs: CompanionMoodInputs, now: number): DerivedCompanionMood {
  let mood: CompanionMood
  if (inputs.attention.approvalPending || inputs.attention.questionPending) mood = 'attention'
  else if (inputs.failures.failedJobsUnread > 0 || inputs.failures.failedSubagents > 0) mood = 'error'
  else if (inputs.working) mood = workingMood(inputs)
  else if (inputs.celebration !== undefined && now < inputs.celebration.until) mood = 'celebrate'
  else if (inputs.sleepAfterMs > 0 && now - inputs.lastInputAt >= inputs.sleepAfterMs) mood = 'sleeping'
  else mood = 'idle'
  const bubble = mood === 'sleeping' || mood === 'idle' ? undefined : bubbleOf(inputs)
  return { mood, bubble }
}

function bubbleOf(inputs: CompanionMoodInputs): string | undefined {
  const activity = inputs.activity
  if (activity === undefined) return undefined
  if (activity.phrase !== undefined && activity.phrase !== '') return activity.phrase
  const label = activity.label ?? ''
  const detail = activity.detail ?? ''
  const combined = (label + (label !== '' && detail !== '' ? ' ' : '') + detail).trim()
  return combined === '' ? undefined : combined
}

// ---------------------------------------------------------------------------
// 并行上下文（music / conducting / building / compacting，纯派生）
// ---------------------------------------------------------------------------

export type CompanionContextKind = 'music' | 'conducting' | 'building' | 'compacting'

/** 结构化最小信号面：测试可用裸对象伪造，运行时来自 ChannelUi。 */
export interface CompanionContextInputs {
  readonly working: boolean
  readonly subagents: readonly { readonly status: string }[]
  readonly backgroundJobs: readonly { readonly status: string }[]
  /** ChannelUi.compaction：非空表示压缩进行中。 */
  readonly compaction: unknown
}

/** 子代理在跑数（starting/running）。 */
export function countRunningSubagents(subagents: readonly { readonly status: string }[]): number {
  return subagents.filter(s => s.status === 'starting' || s.status === 'running').length
}

/** 后台任务在跑数（running/stopping 都算活着）。 */
export function countRunningJobs(jobs: readonly { readonly status: string }[]): number {
  return jobs.filter(j => j.status === 'running' || j.status === 'stopping').length
}

/** 「会话」口径：主回合（working 计 1）+ 在跑子代理 + 在跑后台任务。 */
export function countSessionsRunning(
  working: boolean,
  runningSubagents: number,
  runningJobs: number,
): number {
  return (working ? 1 : 0) + runningSubagents + runningJobs
}

/** 素材包官方表：conducting=2+ 子代理；building=3+ 会话；music=1 子代理或
 *  2 会话；compacting=上下文压缩进行中（ChannelUi.compaction 是现成信号）。
 *  优先级：compacting > conducting > building > music（子代理专属动画最具体）。
 *  carrying（新建工作树/分支）没有推送信号，走 gitBranch 变更闪现（Panel 接线）。 */
export function deriveCompanionContext(inputs: CompanionContextInputs): CompanionContextKind | undefined {
  if (inputs.compaction !== undefined && inputs.compaction !== null) return 'compacting'
  const runningSubagents = countRunningSubagents(inputs.subagents)
  const sessions = countSessionsRunning(inputs.working, runningSubagents, countRunningJobs(inputs.backgroundJobs))
  if (runningSubagents >= 2) return 'conducting'
  if (sessions >= 3) return 'building'
  if (runningSubagents >= 1 || sessions >= 2) return 'music'
  return undefined
}

// ---------------------------------------------------------------------------
// 显示语义 + 平滑器（规则 2/3/4）
// ---------------------------------------------------------------------------

export type CompanionDisplaySemantic =
  | 'thinking'
  | 'typing'
  | 'notification'
  | 'error'
  | 'happy'
  | 'sleeping'
  | 'idle'
  | CompanionContextKind

export interface CompanionDisplayState {
  readonly semantic: CompanionDisplaySemantic
  /** 显示语义进入的时刻 = 动画时钟锚点；同语义重派生保留（不跳帧）。 */
  readonly since: number
  /** 目标最后一次离开活跃族的时刻；0 = 目标仍在活跃族。 */
  readonly activeLeftAt: number
}

export const initialCompanionDisplayState: CompanionDisplayState = {
  semantic: 'idle',
  since: 0,
  activeLeftAt: 0,
}

/** 活跃族 = working 细分 + 并行上下文（离开它们进 idle 族要防抖）。 */
const ACTIVE_SEMANTICS: ReadonlySet<string> = new Set([
  'thinking', 'typing', 'music', 'conducting', 'building', 'compacting',
])
/** working 细分（进入它不防抖——有信息量）。 */
const WORKING_SEMANTICS: ReadonlySet<string> = new Set(['thinking', 'typing'])
/** idle 族（settle 闸只对它们生效）。 */
const IDLE_FAMILY: ReadonlySet<string> = new Set(['idle', 'sleeping'])
/** 允许立刻打断的语义（规则 2）。 */
const IMMEDIATE_SEMANTICS: ReadonlySet<string> = new Set(['notification', 'error', 'happy'])

/** 目标心情 + 上下文 → 目标显示语义（纯函数）。attention/error/happy 直通；
 *  working 细分与 idle/sleeping 在有并行上下文时让位（music=官方表的
 *  juggling：主回合 + 子代理同时在跑时宠物该演"分身"而不是敲代码）。 */
export function resolveTargetSemantic(
  mood: CompanionMood,
  context: CompanionContextKind | undefined,
): CompanionDisplaySemantic {
  if (mood === 'attention') return 'notification'
  if (mood === 'error') return 'error'
  if (mood === 'celebrate') return 'happy'
  if (mood === 'waiting' || mood === 'thinking') return context ?? 'thinking'
  if (mood === 'working' || mood === 'responding') return context ?? 'typing'
  return context ?? (mood === 'sleeping' ? 'sleeping' : 'idle')
}

/** 平滑器（规则 2/3/4，近纯步进）：输入目标语义流 + 时钟，输出显示语义流。
 *
 * - 目标 == 当前显示：什么都不动（since 保留 → 动画 elapsed 连续）。
 * - 抢占（notification/error/happy）或进入 working 族：立刻切。
 * - 其余切换：settle（离开活跃族进 idle 族需 LEAVE_WORKING_SETTLE_MS 稳定）
 *   与 dwell（显示语义已停留 MIN_MOOD_DWELL_MS）双闸全开才切。
 * - realign：visible=false→true 时跳过闸门对齐当前目标（隐藏期间没走 tick）。
 */
export function stepCompanionDisplay(
  prev: CompanionDisplayState,
  target: CompanionDisplaySemantic,
  now: number,
  opts?: { readonly realign?: boolean },
): CompanionDisplayState {
  const targetActive = ACTIVE_SEMANTICS.has(target)
  const activeLeftAt = targetActive ? 0 : prev.activeLeftAt === 0 ? now : prev.activeLeftAt
  if (opts?.realign === true) return { semantic: target, since: now, activeLeftAt }
  if (target === prev.semantic) {
    return { semantic: prev.semantic, since: prev.since, activeLeftAt }
  }
  const immediate =
    IMMEDIATE_SEMANTICS.has(target) ||
    (WORKING_SEMANTICS.has(target) && !WORKING_SEMANTICS.has(prev.semantic))
  if (immediate) return { semantic: target, since: now, activeLeftAt }
  const settleOk = !IDLE_FAMILY.has(target) || now - activeLeftAt >= LEAVE_WORKING_SETTLE_MS
  const dwellOk = now - prev.since >= MIN_MOOD_DWELL_MS
  if (settleOk && dwellOk) return { semantic: target, since: now, activeLeftAt }
  return { semantic: prev.semantic, since: prev.since, activeLeftAt }
}

// ---------------------------------------------------------------------------
// 悬停驻留（hover dwell）：指针停够一会儿才换成悬停动画
// ---------------------------------------------------------------------------

/** 指针驻留多久才切到悬停动画（enter dwell）：400ms 内移开的划过不触发
 *  切换。约为 poke 动画（~70ms/帧）半轮的时长。 */
export const HOVER_ENTER_DWELL_MS = 400
/** 指针移开多久才切回非悬停档（leave settle）：短暂滑出面板（跨分区、
 *  贴边抖动）不打断动画。比 LEAVE_WORKING_SETTLE_MS（1500）短，悬停只是
 *  装饰，可以恢复得快一些。 */
export const HOVER_LEAVE_SETTLE_MS = 800

/** 悬停语义（CompanionPanel 的 hoverSemantic：面板内 = look，宠物本体 =
 *  notice）。 */
export type CompanionHoverSemantic = 'look' | 'notice'

export interface CompanionHoverState {
  /** 当前展示中的悬停语义；undefined = 未在演悬停档。 */
  readonly semantic: CompanionHoverSemantic | undefined
  /** 展示语义进入的时刻（动画时钟锚点；同语义保持不重置，elapsed 连续）。 */
  readonly since: number
  /** 最近一次的期望语义（zone 直读）。 */
  readonly desired: CompanionHoverSemantic | undefined
  /** 期望语义变为当前值的时刻（enter/leave 计时起点）。 */
  readonly desiredSince: number
}

export const initialCompanionHoverState: CompanionHoverState = {
  semantic: undefined,
  since: 0,
  desired: undefined,
  desiredSince: 0,
}

/** 悬停驻留平滑器（近纯步进，与 stepCompanionDisplay 同模式）：输入期望
 *  语义流（指针 zone 直读）+ 时钟，输出展示中的悬停语义流。
 *
 * - 期望 == 展示：什么都不动（since 保留 → 动画 elapsed 连续）。
 * - 移入/换档（look↔notice）：驻留满 HOVER_ENTER_DWELL_MS 才切；快速划过
 *  （enter 后未满窗就移开）全程不触发。
 * - 移开：迟滞满 HOVER_LEAVE_SETTLE_MS 才切回；窗口内折返 = 期望回到当前
 *  展示值 → 动画无缝续播（since 不重置）。
 * - 互动覆盖层（poke/tickle/爱心）不经过本函数：点击反馈即时性不受影响。
 */
export function stepCompanionHover(
  prev: CompanionHoverState,
  desired: CompanionHoverSemantic | undefined,
  now: number,
): CompanionHoverState {
  const desiredSince = desired === prev.desired ? prev.desiredSince : now
  if (desired === prev.semantic) {
    return { semantic: prev.semantic, since: prev.since, desired, desiredSince }
  }
  if (desired === undefined) {
    // 移开：迟滞窗外保持展示（指针折返不打断）；满窗切回非悬停档。
    if (now - desiredSince >= HOVER_LEAVE_SETTLE_MS) {
      return { semantic: undefined, since: prev.since, desired, desiredSince }
    }
    return { ...prev, desired, desiredSince }
  }
  // 移入/换档：驻留满窗才真正切到悬停动画（快速划过不触发）。
  if (now - desiredSince >= HOVER_ENTER_DWELL_MS) {
    return { semantic: desired, since: now, desired, desiredSince }
  }
  return { ...prev, desired, desiredSince }
}

// ---------------------------------------------------------------------------
// idle 族轮换（规则 5：按时间，不跟信号边沿）
// ---------------------------------------------------------------------------

/** idle 显示语义下的动画轮换槽序号：由进入 idle 的时刻与当前时钟决定，
 *  与信号无关；同一 idle 期内确定，跨 idle 期自然错开。 */
export function idleRotationIndex(idleSince: number, now: number, length: number): number {
  if (length <= 1 || idleSince <= 0) return 0
  const slot = Math.max(0, Math.floor((now - idleSince) / IDLE_ROTATE_MS))
  const offset = Math.abs(Math.floor(idleSince / 997)) % length
  return (slot + offset) % length
}

// ---------------------------------------------------------------------------
// 通知 → 反应（气泡层；动画键映射在 deepy.ts）
// ---------------------------------------------------------------------------

export type CompanionReactionKind = 'error' | 'warning' | 'success' | 'default'

/** NotificationItem.color → 反应档（error/warning/success/default）。
 *  没有更多语义字段可判（如"已打断"），default 档用 idle-look——见交付说明。 */
export function notificationReactionKind(color: string | undefined): CompanionReactionKind {
  if (color === 'error' || color === 'warning' || color === 'success') return color
  return 'default'
}

export interface CompanionNotification {
  readonly text: string
  readonly color?: string
}

export interface CompanionNotificationTracker {
  readonly seen: Set<object>
  armed: boolean
}

export function createNotificationTracker(): CompanionNotificationTracker {
  return { seen: new Set(), armed: false }
}

/** 渲染期步进：从尾部扫描未见过的条目（notify 追加在最后），返回最新一条
 *  （旧的让位——气泡同时只留最新）；首次调用只记账不发射（不弹历史旧账）。
 *  重建数组（slice/filter）但条目对象同引用时不会误报；条目被摘除时顺手
 *  清理 seen，防泄漏。 */
export function stepNotificationTracker(
  tracker: CompanionNotificationTracker,
  notifications: readonly CompanionNotification[],
  opts?: { readonly silent?: boolean },
): CompanionNotification | undefined {
  let newest: CompanionNotification | undefined
  let scanned = 0
  for (let index = notifications.length - 1; index >= 0 && scanned < 16; index -= 1) {
    const item = notifications[index]
    if (item === undefined) break
    scanned += 1
    if (tracker.seen.has(item)) break
    tracker.seen.add(item)
    newest = newest ?? item
  }
  if (tracker.seen.size > notifications.length + 8) {
    const live = new Set(notifications as readonly object[])
    for (const item of tracker.seen) {
      if (!live.has(item)) tracker.seen.delete(item)
    }
  }
  if (!tracker.armed || opts?.silent === true) {
    tracker.armed = true
    return undefined
  }
  return newest
}
