import { markChannelReadDirty } from '../../adapter/channel/read-view.js'
import type { ChannelState } from './types.js'

export type SessionResetState = Pick<
  ChannelState,
  | 'rows'
  | 'todos'
  | 'pending'
  | 'goal'
  | 'sessionTitle'
  | 'sessionColor'
  | 'tokens'
  | 'mainCost'
  | 'subagentCost'
  | 'responseChars'
  | 'activeToolCount'
  | 'lastUserText'
  | 'working'
  | 'compaction'
  | 'cancelPending'
  | 'spinnerMode'
  | 'tps'
  | 'tpsSamples'
  | 'lastUsage'
  | 'contextSegments'
  /** Staged "Send to Chat" contexts belong to the composer that staged them:
   *  an adopted session must never carry the previous conversation's chips
   *  (or hand its model a panel context the user staged elsewhere). */
  | 'attachedContexts'
>

/**
 * Reset the projection facts shared by every foreground session adoption.
 * Target-specific route, cwd, preset, loaded-context and status fields stay
 * with the caller: not every adoption has the same semantics for those.
 */
export function resetSessionProjection(
  state: SessionResetState,
  rowIds: { value: number },
  resetProjector: () => void,
  resetSubagents: () => void,
  resetJobs: () => void,
): void {
  resetProjector()
  rowIds.value = 0
  state.rows.length = 0
  markChannelReadDirty(state.rows)
  resetSubagents()
  resetJobs()
  state.todos = []
  state.pending = []
  state.goal = undefined
  state.sessionTitle = ''
  state.sessionColor = ''
  state.tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  // 会话级费用累计与 tokens 同生命周期：换会话/换模型/rewind 一律清零后
  // 由 replay 重建（模型切换的 replay 会按 request/header 还原各请求模型）。
  state.mainCost = {}
  state.subagentCost = []
  state.responseChars = 0
  state.activeToolCount = 0
  state.lastUserText = ''
  state.working = false
  // The adoption path settles any in-flight compaction before it takes the
  // new session over; a row that survived it would describe the old one.
  state.compaction = undefined
  state.cancelPending = false
  state.spinnerMode = 'requesting'
  state.tps = undefined
  state.tpsSamples = []
  state.lastUsage = undefined
  state.attachedContexts = []
  state.contextSegments = {
    system: 0,
    prompt: 0,
    assistant: 0,
    thinking: 0,
    tools: 0,
  }
}
