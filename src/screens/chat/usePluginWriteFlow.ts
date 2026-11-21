/**
 * `/plugin` 的两个写入浮层共用的骨架（C-5 抽自 C-4 的安装六件套）。
 *
 * 两处浮层（`plugin-install` 与 `plugin-manage`）的**差异**只有三条：关掉浮层时
 * 要不要停掉已经交给服务的写入、Enter 该调流程的哪个方法、以及未预料到的异常用
 * 哪一行报。其余全是同一件事：
 *
 * - 异步步骤态住在 Chat 里（ref 是回调里的真源，state 只驱动重绘）——浮层只渲染它；
 * - 流程自己把每一行写进转录（按发起时的 binding 加栅栏），这里只保存「下一步问什么」；
 * - `busy` 表示正在跑一次写入/取消，此时除 Esc 外不接键；
 * - `done` 没有可问的：先把 `busy` 摘掉再收浮层，否则收尾清理会去取消一个已经结算的
 *   写入，并打出一行与刚发生的事矛盾的说明；
 * - 迟到的回答属于**已经不在场的那次流程**（取消 A、另起 B，A 的 inspect 才回来）：
 *   既不能改当前这次的状态，也不能替它收起浮层。
 *
 * 抽出来的理由是这两处必须**逐字同款**：栅栏与收尾的每一条都是踩过的坑
 * （C-4 的自审与两轮独立审查各修过其中一处），复制一份就等于给下一次修正留两个
 * 落点。行为面由 `verify-plugin-manager-chat.tsx` 的三段（无头 / 真面板 / 生产接线）
 * 兜住。
 */
import React from 'react'
import type { ChatOverlay, ChatOverlayAction } from '../chatOverlay.js'

/** 一次写入浮层的步骤态：流程、当前步骤、以及是否正有一次调用在飞。 */
export interface PluginWriteFlowView<Step, Flow> {
  readonly flow: Flow
  readonly step: Step
  readonly busy: boolean
}

/**
 * 本骨架服务的浮层。两者都不带自己的字段：一次写入的「要做什么、服务怎么答、
 * 进度到哪」全在流程的步骤态与转录里，所以开浮层只要一个 kind。
 */
export type PluginWriteOverlayKind = 'plugin-install' | 'plugin-manage'

export interface PluginWriteFlowOptions<Step, Flow> {
  /** 这个骨架服务哪个浮层；只有它开着时收尾清理才生效。 */
  readonly overlayKind: PluginWriteOverlayKind
  /** 当前浮层（`undefined` = 都没开）。 */
  readonly overlay: ChatOverlay | undefined
  readonly dispatchOverlay: React.Dispatch<ChatOverlayAction>
  /** 意外异常的落点：一行进转录（标题由调用方绑定，两处都是 `/plugin`）。 */
  readonly pushLocal: (lines: readonly string[]) => void
  /** 流程还没问出第一步时占位用的步骤；`busy` 期间浮层不渲染它。 */
  readonly initialStep: Step
  /**
   * 关掉浮层时必须停掉的在途写入。装链路有取消面（服务会回滚 profile），
   * manage 三个动作没有——服务不提供，写也是一次就结算的 profile 操作，
   * 所以那一侧不传这个回调：`undefined` 就是「关了浮层，写入照旧跑完」。
   */
  readonly cancelOnClose?: ((flow: Flow) => Promise<Step>) | undefined
  /** 未预料到的 rejection 用哪一行报；流程自己已经兜住已知路径。 */
  readonly failureLine: (error: unknown) => string
  /** 流程结算（step.kind === 'done'）时通知宿主刷新相关视图。 */
  readonly onDone?: (() => void) | undefined
}

export interface PluginWriteFlow<Step, Flow> {
  /** 当前步骤态；浮层未开时为 `undefined`。 */
  readonly view: PluginWriteFlowView<Step, Flow> | undefined
  /** 开浮层并跑 `flow.begin()`。 */
  readonly start: (flow: Flow, begin: Promise<Step>) => void
  /** 把「下一个 promise」当作答案：置 `busy`、加栅栏、结算。 */
  readonly run: (next: Promise<Step>) => void
  /** 收起浮层（不改流程状态）。 */
  readonly close: () => void
}

export function usePluginWriteFlow<Step extends { readonly kind: string }, Flow extends { dispose(): void }>(
  options: PluginWriteFlowOptions<Step, Flow>,
): PluginWriteFlow<Step, Flow> {
  const ref = React.useRef<PluginWriteFlowView<Step, Flow> | undefined>(undefined)
  const [view, setView] = React.useState<PluginWriteFlowView<Step, Flow> | undefined>(undefined)
  const paneOpen = options.overlay?.kind === options.overlayKind
  /** 浮层状态的真源：回调里读它，state 只负责重绘。 */
  const store = (next: PluginWriteFlowView<Step, Flow> | undefined): void => {
    ref.current = next
    setView(next)
  }
  /** 浮层关闭即收尾：在途写入该停的必须停，否则 profile 会停在半写状态。 */
  React.useEffect(() => {
    if (!paneOpen) return
    return () => {
      const closing = ref.current
      store(undefined)
      closing?.flow.dispose()
      if (closing?.busy === true && options.cancelOnClose !== undefined) void options.cancelOnClose(closing.flow)
    }
  }, [paneOpen])
  const close = (): void => {
    options.dispatchOverlay({ type: 'close' })
  }
  /** 流程的下一步：`done` 没有可问的，直接收起浮层。 */
  const settle = (flow: Flow, step: Step): void => {
    const current = ref.current
    // A completed write refreshes views even when its overlay is gone or was
    // replaced: the write still landed, and this callback only bumps a
    // revision (it cannot update or close the current overlay).
    if (step.kind === 'done') options.onDone?.()
    // 迟到的回答属于已经不在场的那次流程：既不能改当前这次的状态，也不能替它收起
    // 浮层——那会让在跑的写入失去它的取消入口。
    if (current === undefined || current.flow !== flow) return
    if (step.kind === 'done') {
      // 收尾前先把「在跑」摘掉：浮层 effect 的清理据此决定要不要取消——结算完了
      // 还留着 busy，清理就会去取消一个服务那边早已删掉的请求，并打出一行
      // 「没有在跑的写入」，与刚发生的事矛盾。
      store({ ...current, step, busy: false })
      close()
      return
    }
    store({ ...current, step, busy: false })
  }
  /**
   * 流程自己兜住每一次服务调用；这里再兜一层，是防「没预料到的抛出」把进程
   * 带走（未处理的 rejection 会杀掉进程守卫），代价是一行说明加收起浮层。
   */
  const guard = (flow: Flow, next: Promise<Step>): void => {
    void next.then(step => settle(flow, step)).catch((error: unknown) => {
      // 异常路径同样核对身份：一次早已被取代的流程不该收起现在的浮层。
      if (ref.current?.flow !== flow) return
      options.pushLocal([options.failureLine(error)])
      close()
    })
  }
  return {
    view,
    start: (flow, begin) => {
      options.dispatchOverlay({ type: 'open', overlay: { kind: options.overlayKind } })
      store({ flow, step: options.initialStep, busy: true })
      guard(flow, begin)
    },
    run: (next) => {
      const current = ref.current
      if (current === undefined) return
      store({ ...current, busy: true })
      guard(current.flow, next)
    },
    close,
  }
}
