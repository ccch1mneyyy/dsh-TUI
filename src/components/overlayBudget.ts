/**
 * OverlayAbove 高度预算的纯计算。
 *
 * 浮层用 bottom:'100%' 钉在锚点顶边向上生长；渲染器对 y<0 的行只裁不移
 * （render-node-to-output.ts 刻意不再把浮层整体下移压住 composer）。所以
 * 浮层高度一旦超过锚点上方可画的行数，顶部就整行消失——短会话 + 高终端下
 * /model 的窗口按 terminalRows 预算，焦点行落在被裁区完全不可见（#493），
 * 供应商模型多时列表混乱（#698）。生产方必须把 maxHeight 钳到实际空间，
 * 这里是那条钳制的纯函数面，便于回归脚本直接断言不变量。
 */

/**
 * 锚点上方可画的行数。
 *
 * inline 模式根帧可以高于终端：可见视口是帧尾 terminalRows 行（外加 Ink
 * 的一行光标恢复行），帧顶被推进 scrollback 的部分不可画——与
 * ImagePreviewOverlay 的视口换算一致。
 *
 * @param anchorTop - 锚点在根帧内的绝对 top（沿祖先累加 yoga computedTop）。
 * @param rootHeight - 根帧高度。
 * @param terminalRows - 终端真实行数。
 * @returns 锚点顶边之上、视口之内的行数（≥0）。
 */
export function overlaySpaceAbove(input: {
  anchorTop: number
  rootHeight: number
  terminalRows: number
}): number {
  const { anchorTop, rootHeight, terminalRows } = input
  const viewportTop = rootHeight > terminalRows ? rootHeight - terminalRows + 1 : 0
  return Math.max(0, anchorTop - viewportTop)
}

/**
 * 浮层的有效 maxHeight：调用方声明的上限与锚点上方空间取小。
 *
 * 尚未量到空间（首次挂载前没有布局）时沿用声明值；量到后至少 1 行——0 行
 * maxHeight 在 yoga 里等于面板消失，用户以为 picker 没打开。
 *
 * @param maxHeight - 调用方声明的上限（可缺省）。
 * @param spaceAbove - overlaySpaceAbove 的结果（未量到时 undefined）。
 * @returns 传给浮层 Box 的 maxHeight（两者都缺省时 undefined）。
 */
export function clampOverlayHeight(
  maxHeight: number | undefined,
  spaceAbove: number | undefined,
): number | undefined {
  if (spaceAbove === undefined) return maxHeight
  const bound = maxHeight === undefined ? spaceAbove : Math.min(maxHeight, spaceAbove)
  return Math.max(1, bound)
}

/**
 * 测量振荡门：返回值 true 表示采纳 next（调用方负责把 next 计入 history）。
 *
 * #185 回归：OverlayAbove 每次 commit 重测 spaceAbove 并 setState。帧高 > 终端
 * 行数时（长转录顶进 scrollback），应用值会反馈进下一帧的测量输入，测得值在
 * 相邻 commit 间 A/B 翻跳；"等值 setState 是 no-op" 挡不住翻跳，每次 commit
 * 阶段的 dispatch 又排定下一次 commit，自持嵌套更新 >50 即抛 React #185。
 *
 * 合法变化"往前走"（10→11→12）；只有自持反馈会造成"一步之内回到旧值"
 * （A→B→A）。这是唯一能自持的形态：浮层自身零布局高度，单调漂移必然落在
 * 不动点上，而 A/B 翻跳可以永远转。门只拦后者。
 *
 * @param history - 最近两次测得值（≤2 项，旧值在前）。
 * @param next - 本次测得的值。
 * @param applied - 当前已应用的值（未量过时 undefined）。
 * @returns 是否应 dispatch next。
 */
export function acceptOverlayMeasurement(
  history: readonly number[],
  next: number,
  applied: number | undefined,
): boolean {
  // 已到该值：连 update 都不入队（入队的 no-op update 在繁忙帧里仍会
  // 触发一次调度，没必要）。
  if (next === applied) return false
  // 一步之内回到旧值 = A/B 翻跳（自身 setState 的布局反馈）：冻结。
  if (history.length === 2 && history[0] === next) return false
  return true
}