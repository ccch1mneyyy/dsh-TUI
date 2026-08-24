import React from 'react'
import { Box, Text } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { WheelEvent } from '../ink/events/wheel-event.js'

/**
 * `/` 命令菜单与 `@` 文件菜单共用的圆角卡片外壳（与输入框 EffortInputBorder
 * 同款 ╭╮╰╯ 视觉语言）：
 *
 *   ╭─ 标题 ─────────────────────╮
 *   │ ❯ 行内容 …                 │
 *   │   行内容 …                 │
 *   │ ↑2 · ↓3                    │  ← 仅当列表被裁剪
 *   ╰────────────────────────────╯
 *
 * 底边 ╰╯ 直接坐在输入框顶边 ╭╮ 的上一行（PromptInput 的浮层包装去掉了
 * 底部留白），卡片与输入框连成一体，读作"挂在输入框上的下拉"。边框色
 * 跟随输入框 idle 色（plan 模式下整套面板一起变 sage 绿）。
 *
 * 每一行的左右 │ 由本组件包在行外——侧边框若是内容列旁的单行 Text，只
 * 会画在自己那一行（行高的首行），多行列表的中段行会裸奔无边框。
 * 卡片左右各占 2 列（│ + 1 空格），行内容的可用宽度由
 * {@link cardContentWidth} 统一计算，CJK 截断契约（verify-cjk-truncate）
 * 按该宽度钉住。
 */
export function SuggestionCard({
  title,
  columns,
  accent,
  footer,
  rows,
  onRowPick,
  onWheelStep,
}: {
  /** 嵌在顶边框里的标题（已本地化、含计数）。 */
  title: string
  columns: number
  /** 边框色（主题 token）；缺省 promptBorder。 */
  accent?: 'promptBorder' | 'planMode'
  /** 底部 dim 提示行（滚动指示）；null/undefined 时不渲染。 */
  footer?: string | null
  /** 已渲染的行内容（每行一个节点），本组件为各行补上左右边框。 */
  rows: readonly React.ReactNode[]
  /**
   * 鼠标点击行（fullscreen）：上报行索引——命令/文件补全用它接受该项
   * （与 Tab/Enter 同路径）。未提供时行为不变。
   */
  onRowPick?: (index: number) => void
  /**
   * 滚轮在菜单上滚动（fullscreen）：每次滚动上报 ±1 步——补全菜单用它
   * 移动选中行（窗口随之滚动）。位置路由保证只有菜单下的滚轮到达这里。
   */
  onWheelStep?: (step: 1 | -1) => void
}): React.ReactNode {
  const inner = Math.max(0, columns - 2)
  const lead = `─ ${title} `
  // 标题放不下（极窄终端）时退化为素边框，不做半截标题。
  const titleFits = stringWidth(lead) + 1 <= inner
  const top = titleFits
    ? `╭${lead}${'─'.repeat(inner - stringWidth(lead))}╮`
    : `╭${'─'.repeat(inner)}╮`
  const borderColor = accent ?? 'promptBorder'
  const [hoveredRow, setHoveredRow] = React.useState(-1)
  const handleWheel = React.useCallback((e: WheelEvent) => {
    if (e.deltaY !== 0) onWheelStep?.(e.deltaY > 0 ? 1 : -1)
  }, [onWheelStep])
  return (
    // onWheel 直接挂 ink-box host：ThemedBox/Box 是 react-compiler 编译
    // 产物，只显式透传 onClick/hover/onKeyDown——onWheel 会落进 style
    // rest 被丢弃（ScrollBox 同因直接写 host 元素）。
    <ink-box
      style={{ flexDirection: 'column', width: '100%', flexShrink: 0 }}
      onWheel={onWheelStep !== undefined ? handleWheel : undefined}
    >
      <Text color={borderColor} wrap="truncate-end">{top}</Text>
      {rows.map((row, index) => (
        <Box
          key={index}
          flexDirection="row"
          width="100%"
          onClick={onRowPick ? () => onRowPick(index) : undefined}
          onMouseEnter={onRowPick ? () => setHoveredRow(index) : undefined}
          onMouseLeave={onRowPick ? () => setHoveredRow(current => (current === index ? -1 : current)) : undefined}
        >
          <Text color={borderColor}>│</Text>
          {/* flexGrow 钉住右侧 │ 在最后一列；行内容自行按 cardContentWidth 截断。 */}
          <Box
            flexDirection="column"
            flexGrow={1}
            minWidth={0}
            backgroundColor={onRowPick !== undefined && hoveredRow === index ? 'userMessageBackgroundHover' : undefined}
          >
            {row}
          </Box>
          <Text color={borderColor}>│</Text>
        </Box>
      ))}
      {footer ? (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>│</Text>
          <Box flexGrow={1} minWidth={0}>
            <Text dimColor wrap="truncate-end"> {footer}</Text>
          </Box>
          <Text color={borderColor}>│</Text>
        </Box>
      ) : null}
      <Text color={borderColor} wrap="truncate-end">{`╰${'─'.repeat(inner)}╯`}</Text>
    </ink-box>
  )
}

/**
 * 卡片内一行内容的可用显示宽度：总宽减去两侧 │ + 各 1 空格的内边距。
 * CommandSuggestions / FileSuggestions 的截断数学共用这一口径。
 */
export function cardContentWidth(columns: number): number {
  return Math.max(0, columns - 4)
}

/**
 * 把补全名按「命中的查询前缀」拆成三段（用于前缀高亮）。三级尝试，
 * 均大小写不敏感，与 completeCommands / 文件候选的过滤语义对齐：
 *   1. 整名前缀（文件查询是路径前缀，`src/re` 命中 `src/render`）；
 *   2. 最后一个空格 token 的前缀（嵌套命令 `model deepseek/…` 的
 *      `deepseek/` 查询——补全名带 `model ` 路径前缀）；
 *   3. 最后一个 `/` 段的前缀（`/model deepseek-v` 命中段
 *      `deepseek-v4-flash` 的开头）。
 * 查询为空、或都不命中（别名命中、过期候选）返回 null——渲染方整体 dim。
 */
export function splitQueryMatch(
  name: string,
  query: string,
): { before: string; match: string; after: string } | null {
  if (query === '') return null
  const lower = query.toLowerCase()
  const startsWith = (start: number): { before: string; match: string; after: string } | null => {
    const segment = name.slice(start)
    if (!segment.toLowerCase().startsWith(lower)) return null
    const matched = segment.slice(0, Math.min(query.length, segment.length))
    return {
      before: name.slice(0, start),
      match: matched,
      after: segment.slice(matched.length),
    }
  }
  const lastSpace = name.lastIndexOf(' ')
  return (
    startsWith(0)
    ?? (lastSpace >= 0 ? startsWith(lastSpace + 1) : null)
    ?? startsWith(name.lastIndexOf('/') + 1)
  )
}
