/**
 * subagentDetailMemory：Detail 场景的 page/scroll 跨挂载记忆。主屏 Agent
 * View 盖过 Detail 时（Chat 的整屏 early-return）组件会卸载；设计 §4.1
 * 要求「从 Detail 进入返回同一 Detail page 和 scroll」，这里按 agentId 存
 * 最后一次的页码与滚动位置，重挂载时恢复。有界：只保留最近若干代理。
 */

export interface SubagentDetailSnapshot {
  readonly page: string
  readonly scrollTop: number
}

const MEMORY_CAP = 16
const memory = new Map<string, SubagentDetailSnapshot>()

export const subagentDetailMemory = {
  read(agentId: string): SubagentDetailSnapshot | undefined {
    return memory.get(agentId)
  },
  /** 常规退出（返回 Dashboard / 关面板）不带走记忆：只有主屏 Agent View
   *  的往返才恢复页码与滚动，重新从 Dashboard 进入是全新一次浏览。 */
  clear(agentId: string): void {
    memory.delete(agentId)
  },
  save(agentId: string, snapshot: SubagentDetailSnapshot): void {
    // LRU 触碰：删除重插，超量淘汰最旧。
    memory.delete(agentId)
    memory.set(agentId, snapshot)
    while (memory.size > MEMORY_CAP) {
      const oldest = memory.keys().next().value
      if (oldest === undefined) break
      memory.delete(oldest)
    }
  },
}
