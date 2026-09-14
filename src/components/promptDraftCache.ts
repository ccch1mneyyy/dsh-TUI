/**
 * 输入框草稿快照的纯函数面：快照类型 + 世代取值/匹配 + 图片绑定过滤。
 *
 * early-return 整屏视图（Ctrl+A / Ctrl+T / /settings 等）会整棵卸载
 * PromptInput 子树，组件本地编辑态随之丢失；Chat 在卸载瞬间把本类型的
 * 快照存进 `draftCacheRef`，返回主界面挂载时再用这里的三条判定决定回填
 * 什么（DESIGN D1）。本模块刻意不 import 任何运行时依赖（也不 import
 * PromptInput，避免循环依赖），因此组件与无头回归脚本都能直接引用和断言。
 */

/**
 * 一次卸载时刻的可回填草稿（DESIGN D1/D3/D4）：
 * value/cursor/foldBlock/expanded/vimEnabled/vimInsert 是 AC-4 定义的 6 项
 * 编辑态；images 是可见 `[Image #N]` token → staged stageId 的可序列化绑定
 * 对；bindingGeneration 是写入时的会话/世代栅栏。鼠标选区、拖拽锚点、补全
 * 菜单、历史遍历位置、编辑器滚动偏移、vim 撤销栈等瞬态交互态不在快照内。
 */
export interface PromptDraftSnapshot {
  /** 写入快照时的 binding generation（见 resolveBindingGeneration）。 */
  readonly bindingGeneration: number
  readonly value: string
  readonly cursor: number
  readonly foldBlock: { readonly start: number; readonly end: number } | null
  readonly expanded: boolean
  readonly vimEnabled: boolean
  readonly vimInsert: boolean
  /** token → stageId 的有序只读对，可序列化且不引入外部类型依赖。 */
  readonly images: ReadonlyArray<readonly [string, string]>
}

/**
 * 当前会话/世代的栅栏值，与 Chat.tsx 的 previewBindingGeneration 同一表达式：
 * agentBindingGeneration 跨每次 agent 替换单调递增（/resume 选其它会话、
 * /new、/bg、attach、rewind 等）且优先；部分测试/嵌入 channel 没有它时回退
 * stagedImageGeneration；两者都没有则为 0（DESIGN D1/D2）。
 */
export function resolveBindingGeneration(source: {
  readonly agentBindingGeneration?: number
  readonly stagedImageGeneration?: () => number
}): number {
  return source.agentBindingGeneration ?? source.stagedImageGeneration?.() ?? 0
}

/**
 * 快照是否可用于回填：快照存在，且写入世代仍等于当前世代（DESIGN D2）。
 * 类型守卫形式便于调用方判定后直接读取快照字段；不匹配时必须整份丢弃，
 * 不能把旧会话的草稿带进新会话。
 */
export function isUsableDraftSnapshot(
  snapshot: PromptDraftSnapshot | null | undefined,
  generation: number,
): snapshot is PromptDraftSnapshot {
  return snapshot !== null && snapshot !== undefined && snapshot.bindingGeneration === generation
}

/**
 * 图片绑定的二次校验（DESIGN D3）：只保留 `hasStagedImage(stageId) === true`
 * 的 token → stageId 对，#823 的会话切换清理回收过的 capability 不得复活；
 * 未通过的条目不报错，调用方保留可见 token 文本作惰性文本。缺少
 * hasStagedImage 能力（部分测试/嵌入 channel）视为全部不通过；畸形/缺失的
 * 条目静默丢弃。
 */
export function filterLiveImageBindings(
  images: ReadonlyArray<readonly [string, string]> | null | undefined,
  hasStagedImage?: (stageId: string) => boolean,
): ReadonlyArray<readonly [string, string]> {
  if (images === null || images === undefined) return []
  const live: Array<readonly [string, string]> = []
  for (const entry of images) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const [token, stageId] = entry
    if (typeof token !== 'string' || typeof stageId !== 'string') continue
    if (hasStagedImage?.(stageId) !== true) continue
    const pair: readonly [string, string] = [token, stageId]
    live.push(pair)
  }
  return live
}
