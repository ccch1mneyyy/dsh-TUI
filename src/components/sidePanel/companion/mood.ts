/**
 * resolveCompanionMood（设计分文档 §2 + v2.1 修订）：Companion 不需要
 * 事件总线——workingActivity 投影已经是折叠好的会话级状态，审批/问卷
 * 有独立 store 快照，失败任务未读数来自 PanelStore 的 jobs badge。
 * Bridge 退化为这个纯函数：无订阅、无缓冲、可单测。
 *
 * v2.1 对输入的收敛（评审 §九）：attention 只取已有可靠投影——
 * approvalPending / questionPending（Chat 的审批与问卷 store 快照）与
 * failedJobsUnread（PanelStore badge）。subagentsWaiting / lastTurnError
 * 目前没有可靠投影，V1 不引入（'error' 心情保留在类型里作前瞻兼容，
 * V1 不发射）。
 */
import type { ActivityView } from '../../../dsh-adapter/activity-store.js'
import type { SpinnerMode } from '../../../adapter/ports/channel-display.js'

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
  /** 有待处理的审批 / 问卷 / 失败后台任务未读。 */
  | 'attention'
  /** 回合完成 / goal 完成 / star / 节日彩蛋（短暂）。 */
  | 'celebrate'
  /** 最近一回合以错误结束（V1 不发射——没有可靠投影；类型预留）。 */
  | 'error'

export interface CompanionAttention {
  readonly approvalPending: boolean
  readonly questionPending: boolean
  readonly failedJobsUnread: number
}

export interface CompanionMoodInputs {
  readonly working: boolean
  readonly spinnerMode: SpinnerMode
  /** workingActivity 投影（activity 插件未装时缺省，退回 working +
   *  spinnerMode 也能给出 waiting / thinking / working / responding）。 */
  readonly activity: ActivityView | undefined
  readonly attention: CompanionAttention
  readonly lastInputAt: number
  readonly celebration: {
    readonly kind: 'star' | 'holiday' | 'turn-done' | 'goal-done'
    readonly until: number
  } | undefined
  /** 0 = 不入睡。 */
  readonly sleepAfterMs: number
}

export interface CompanionMoodState {
  readonly mood: CompanionMood
  /** 当前心情进入的时刻（墙钟 ms）；心情不变时保留。 */
  readonly since: number
  /** 皮肤气泡文案（activity.phrase ?? label+detail，已是 zh/en 双语；
   *  宽度截断在皮肤侧）。非工作/注意态为 undefined。 */
  readonly bubble?: string
}

function hasAttention(attention: CompanionAttention): boolean {
  return attention.approvalPending || attention.questionPending || attention.failedJobsUnread > 0
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

/** 纯映射：优先级 attention > celebrate > 工作态 > sleeping > idle。 */
export function resolveCompanionMood(inputs: CompanionMoodInputs, now: number): CompanionMood {
  if (hasAttention(inputs.attention)) return 'attention'
  if (inputs.celebration !== undefined && now < inputs.celebration.until) return 'celebrate'
  if (inputs.working) return workingMood(inputs)
  if (inputs.sleepAfterMs > 0 && now - inputs.lastInputAt >= inputs.sleepAfterMs) return 'sleeping'
  return 'idle'
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

/** 状态步进：心情不变时保留 since；bubble 跟随当前输入。 */
export function stepCompanionMood(
  prev: CompanionMoodState,
  inputs: CompanionMoodInputs,
  now: number,
): CompanionMoodState {
  const mood = resolveCompanionMood(inputs, now)
  const bubble = mood === 'sleeping' || mood === 'idle' ? undefined : bubbleOf(inputs)
  return mood === prev.mood
    ? { mood, since: prev.since, bubble }
    : { mood, since: now, bubble }
}

export const initialCompanionMoodState: CompanionMoodState = { mood: 'idle', since: 0 }
