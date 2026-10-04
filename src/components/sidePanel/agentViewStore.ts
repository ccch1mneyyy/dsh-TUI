/**
 * agentViewStore：面板/详情 → Chat 的主屏 Agent View 打开请求通道（镜像
 * jobsFocusStore 的三行 store 模式）。agents 侧栏面板与 Detail 场景自己没有
 * Chat 的场景 state，主屏查看动作经这里请求；Chat 订阅后压入来源栈。
 *
 * surface 记录请求来自侧栏面板还是整屏形态，Esc 返回时回到同一形态。
 */

export interface AgentViewRequest {
  readonly agentId: string
  readonly source: 'agents-dashboard' | 'agent-detail'
  /** 请求来自侧栏 agents 面板（Esc 返回面板而非整屏形态）。 */
  readonly panel: boolean
  readonly nonce: number
}

let snapshot: AgentViewRequest | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

export const agentViewStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  get(): AgentViewRequest | null {
    return snapshot
  },
  request(agentId: string, source: AgentViewRequest['source'], panel: boolean): void {
    snapshot = Object.freeze({ agentId, source, panel, nonce: (snapshot?.nonce ?? 0) + 1 })
    emit()
  },
}
