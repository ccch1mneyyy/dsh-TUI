/**
 * 焦点居中的列表窗口：长列表只渲染焦点附近的一段，保证焦点行始终可见。
 * 瞬态面板走 OverlayAbove 零高度浮层后，超高部分会被 overflow 裁掉且焦点
 * 可能落在被裁区（P1 审查实证：30 行终端 30 个模型时焦点在索引 0 完全不
 * 可见），窗口化是硬要求。
 *
 * 按**行**而非项数预算：ListItem 带 description 时占两行（正文 + 描述），
 * 容器还可能有 gap 空行——只数项数会把焦点裁出屏外（二次审查实证：每项
 * 一行描述时索引 0 仍不可见）。调用方须保证每项行高固定（ListItem 对字符
 * 串内容 truncate + 压平换行后恒为 1 + (description ? 1 : 0) 行）。
 *
 * 扩展策略：从焦点项出发向两侧交替扩张，优先补累计行数较少的一侧（焦点
 * 大致居中）；任一侧再加会超预算或已到边界时停。焦点项本身超过 maxRows
 * 时仍单独返回焦点项——焦点可见性优先于预算。
 *
 * @param heights - 每项的固定行高（≥1）。
 * @param focusIndex - 键盘焦点项下标（越界自动 clamp）。
 * @param maxRows - 列表区可用行数（终端高减去浮层预留与面板框架行）。
 * @param gap - 相邻项之间的空行数（容器 gap，如 HistorySearchDialog 的 1）。
 * @returns [start, end) 切片区间。
 */
export function listWindow(
  heights: readonly number[],
  focusIndex: number,
  maxRows: number,
  gap = 0,
): { start: number; end: number } {
  if (heights.length === 0) return { start: 0, end: 0 }
  const focus = Math.min(Math.max(focusIndex, 0), heights.length - 1)
  let start = focus
  let end = focus + 1
  let upUsed = 0
  let downUsed = 0
  for (;;) {
    const up = start > 0 ? gap + heights[start - 1]! : Number.POSITIVE_INFINITY
    const down = end < heights.length ? gap + heights[end]! : Number.POSITIVE_INFINITY
    const used = heights[focus]! + upUsed + downUsed
    const canUp = used + up <= maxRows
    const canDown = used + down <= maxRows
    if (!canUp && !canDown) return { start, end }
    if (canUp && (!canDown || upUsed <= downUsed)) {
      start -= 1
      upUsed += up
    } else {
      end += 1
      downUsed += down
    }
  }
}
