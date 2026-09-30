/**
 * 长正文折叠的纯函数面（issue #1212）。
 *
 * ApprovalPanel 的命令/理由与 AskUserQuestionPanel 的问题正文共用这条规则：
 * 固定高度的全屏帧（AlternateScreen 写死 height=终端行数）在 alt-screen 下
 * 没有 scrollback，被挤出行外的决策行（问题、选项、提示）无法找回。所以
 * 决策行优先，弹性正文折成「前导行 + 计数标记」——正文再长也只占它预算内
 * 的行数，绝不把决策行推出帧底。
 *
 * 按显示列硬换行（wrap-ansi，与渲染器同一条依赖）后按行折叠，调用方负责
 * 减去根内边距得到真实渲染宽度。
 */

import wrapAnsi from 'wrap-ansi'

/** `text` 按 `width` 显示列硬换行后的显示行。 */
export function wrapText(text: string, width: number): string[] {
  const wrapped = wrapAnsi(text, Math.max(1, width), { hard: true, trim: false, wordWrap: true })
  return wrapped.split('\n')
}

/** 折叠结果：要渲染的行 + 标记行后隐藏的行数。 */
export type FoldedLines = { shown: string[]; folded: number; marker: boolean }

/**
 * 把 `lines` 折进 `budget` 个渲染行：装得下就原样返回；否则保留前导行 +
 * 一个计数标记行。预算为 0 时什么都不渲染——决策行已占满，一个没有内容的
 * 标记只会再把它们挤出去；预算为 1 时只渲染标记行（正文全部折叠，但用户
 * 知道还有内容）。
 */
export function foldLines(lines: readonly string[], budget: number): FoldedLines {
  if (lines.length <= Math.max(budget, 0)) return { shown: [...lines], folded: 0, marker: false }
  if (budget <= 0) return { shown: [], folded: lines.length, marker: false }
  if (budget === 1) return { shown: [], folded: lines.length, marker: true }
  return { shown: lines.slice(0, budget - 1), folded: lines.length - (budget - 1), marker: true }
}

/** 折叠块的渲染行数（标记行占预算）。 */
export function foldedRows(view: FoldedLines): number {
  return view.shown.length + (view.marker ? 1 : 0)
}
