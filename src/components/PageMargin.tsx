import React from 'react'
import { Box } from '../ui.js'
import {
  TerminalSizeContext,
  type TerminalSize,
} from '../ink/components/TerminalSizeContext.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import {
  getPageMarginSetting,
  resolvePageMargin,
  subscribePageMargin,
  type PageMarginSetting,
} from '../tuiDisplayPrefs.js'

/**
 * 整页边距（页边距 / page margin）：有些终端（Windows Terminal 的
 * PowerShell 等 profile 默认 8px padding、GUI 终端）自带内缩，另一些
 * （裸 WSL、tmux、SSH、部分嵌入宿主）完全没有——文字直接贴着屏幕四边，
 * 观感压抑。TUI 无法读取终端的 padding，所以在根布局自备一层小"页边距"。
 * 设置（`dsh-tui.pageMargin`）可以是预设名 none / slim / normal（默认，
 * 左右 2 列、上下 1 行）/ roomy，或自定义 `NxM`（左右各 N 列 × 上下各 M
 * 行，如 3x1）——解析与几何见 tuiDisplayPrefs。
 *
 * 实现策略（三层）：
 *
 * 1. 布局层：`PageMargin` 渲染一个 `paddingX/Y` 的根盒，所有屏幕
 *    （Chat 及其中所有 early-return 屏幕）自动内缩；
 * 2. 尺寸层：嵌套覆盖 `TerminalSizeContext`，向内报告的 columns/rows
 *    已扣除边距，因此所有用 `useTerminalSize()` 做内容宽度/高度数学的
 *    组件（换行宽度、虚拟化、输入区预算、表格布局……）无需各自知道
 *    边距存在——它们拿到的就是内容区尺寸；
 * 3. 坐标层：`PageInsetContext` 报告内容区相对屏幕原点的偏移，供少数
 *    以「屏幕坐标」做 absolute 定位的浮层（Tooltip、SessionBrowser
 *    右键菜单）补偿——它们的锚点来自指针事件（屏幕坐标），而 absolute
 *    盒子相对的是内缩后的内容区原点。
 *
 * 模式来源是 tuiDisplayPrefs 的模块级 store（applyPageMargin），不是
 * props：`.PageMargin` 位于 Chat 之上，/settings 的更改如果只走 channel
 * 的版本 bump 无法驱动它（那只重渲染 Chat 以下）。store 由 plugin 的
 * applyDisplay 镜像写入，模式变化时本组件重渲染并重布局。
 *
 * 注意：`PageMargin` 必须在「所有以屏幕原点为参照的组件之外」读取
 * TerminalSizeContext（它读到的就是真实终端尺寸）；AlternateScreen 等
 * 需要真实 rows 的组件放在它的外侧。verify 脚本直接挂载
 * `<AlternateScreen><Chat/></AlternateScreen>`（不经 plugin.ts 的树），
 * 因此测试默认无页边距——组件契约仍是「全宽可用」。
 */

/** 内容区相对屏幕原点的偏移（屏幕坐标 → 内容坐标的换算量）。 */
export type PageInset = { readonly x: number; readonly y: number }

/** 嵌套安全的 inset（若未来出现嵌套 PageMargin 会累加）。 */
export const PageInsetContext = React.createContext<PageInset>({ x: 0, y: 0 })

/**
 * 内容区相对屏幕原点的偏移。供"出血"（full-bleed）chrome 使用：页面级
 * 分割线、右侧滚动轨这类结构性元素直通终端边缘，而内容（文本、卡片）
 * 保持页边距内缩——常规排版设计的做法（内容列留边距、横线/滚动轨出血
 * 到版面边缘）。无 PageMargin 时恒为 {x:0, y:0}。
 */
export function usePageInset(): PageInset {
  return React.useContext(PageInsetContext)
}

/**
 * 根级页边距容器：给整棵 UI 加一圈可配置的小边距，并把「终端尺寸」收敛
 * 成「内容区尺寸」下传（见文件头三层策略）。flexGrow={1} 让它撑满
 * AlternateScreen 的定高盒（inline 无定高父级时为内容自然高，与现状
 * 一致）。
 */
export function PageMargin({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const setting: PageMarginSetting = React.useSyncExternalStore(
    subscribePageMargin,
    getPageMarginSetting,
  )
  const { x, y } = resolvePageMargin(setting)
  const size = useTerminalSize()
  const parentInset = React.useContext(PageInsetContext)
  const inner: TerminalSize = {
    columns: Math.max(1, size.columns - 2 * x),
    rows: Math.max(1, size.rows - 2 * y),
  }
  const inset: PageInset = {
    x: parentInset.x + x,
    y: parentInset.y + y,
  }
  return (
    <PageInsetContext.Provider value={inset}>
      <TerminalSizeContext.Provider value={inner}>
        <Box
          flexDirection="column"
          flexGrow={1}
          width="100%"
          paddingX={x}
          paddingY={y}
        >
          {/* 内容盒：ink 的百分比宽度按父盒「全宽」（含 padding）解析——
              直接 padding 的盒子里 width="100%" 会始终宽出 2·inset×（滚动轨
              曾被推到 x=100 出屏）。给子树一个确定数值宽的内容盒，% 就回到
              真实内容宽。 */}
          <Box flexDirection="column" flexGrow={1} width={inner.columns}>
            {children}
          </Box>
        </Box>
      </TerminalSizeContext.Provider>
    </PageInsetContext.Provider>
  )
}
