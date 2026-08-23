import React from 'react'
import { Text } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import type { LocalCommand } from '../commands.js'
import { localizedDescription } from '../commands.js'
import { t } from '../i18n.js'
import { POINTER } from '../cc/figures.js'
import { SuggestionCard, cardContentWidth, splitQueryMatch } from './SuggestionCard.js'

/**
 * The slash-command suggestion overlay, mirroring Claude Code's
 * `PromptInputFooterSuggestions.tsx` (command layout only) wrapped in the
 * shared rounded `SuggestionCard`:
 *
 *   ╭─ 命令 · 共 12 项 ──────────────────────╮
 *   │ ❯ compact  Compact the conversation …  │   ← 选中：❯ + 加粗 + suggestion 色
 *   │   compare  Compare selected messages … │   ← 名字里命中输入的段提亮
 *   │ ↑2 · ↓3                                 │   ← 仅当列表被窗口裁剪
 *   ╰─────────────────────────────────────────╯
 *
 * 未选中行整体 dim，唯独名字里匹配当前查询 token 的前缀以正常亮度提亮
 * （bold 与 dim 在终端互斥，故提亮用非 dim 而非加粗）；选中行整行
 * suggestion 色、名字加粗、前置 ❯ 指针。
 */
export function CommandSuggestions({
  commands,
  selectedIndex,
  columns,
  query = '',
  accent,
  onPick,
  onWheelStep,
}: {
  commands: readonly (LocalCommand & { descriptionKey?: string })[]
  selectedIndex: number
  columns: number
  /** 原始 `/…` 输入；其最后一段 token 用于名字前缀高亮。 */
  query?: string
  accent?: 'promptBorder' | 'planMode'
  /** 鼠标点击行（fullscreen）：上报过滤后列表的绝对索引（与键盘
   *  selectedIndex 同一索引空间），接受路径由 PromptInput 复用。 */
  onPick?: (index: number) => void
  /** 滚轮步进（fullscreen）：±1 移动选中行。 */
  onWheelStep?: (step: 1 | -1) => void
}): React.ReactNode {
  if (commands.length === 0) return null

  // Cap the command name column at 40% of the card's content width to ensure
  // the description has space (same ratio as Claude Code).
  const usable = cardContentWidth(columns)
  const maxNameWidth = Math.floor(usable * 0.4)
  const nameWidth = Math.min(
    Math.max(...commands.map(c => stringWidth(c.name))) + 5,
    maxNameWidth,
  )

  const maxVisible = 5
  const startIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      commands.length - maxVisible,
    ),
  )
  const visible = commands.slice(startIndex, startIndex + maxVisible)
  const above = startIndex
  const below = commands.length - (startIndex + visible.length)
  // 前缀高亮取查询的最后一段 token（`/plan of` 高亮 `of` 命中的段）。
  const queryToken = query.replace(/^\//, '').match(/[^ \t]*$/)?.[0] ?? ''

  const title = `${t('sugg-commands-title')} · ${t('sugg-count', { n: commands.length })}`
  const footer =
    above > 0 || below > 0
      ? [
          above > 0 ? t('sugg-more-above', { n: above }) : null,
          below > 0 ? t('sugg-more-below', { n: below }) : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ')
      : null

  return (
    <SuggestionCard
      title={title}
      columns={columns}
      accent={accent}
      footer={footer}
      onRowPick={onPick ? index => onPick(startIndex + index) : undefined}
      onWheelStep={onWheelStep}
      rows={visible.map(command => {
        const isSelected = command.name === commands[selectedIndex]?.name
        const tagText = command.tag ? `[${command.tag}] ` : ''
        const tagWidth = stringWidth(tagText)
        // 行预算：内容宽 − 前导空格 1 − 指针列 2。
        const descriptionWidth = Math.max(0, usable - 3 - nameWidth - tagWidth)
        const rawDescription = localizedDescription(command)
        const description =
          stringWidth(rawDescription) > descriptionWidth
            ? truncateToWidth(rawDescription, descriptionWidth - 1) + '…'
            : rawDescription
        const parts = splitQueryMatch(command.name, queryToken)
        const padAfter = Math.max(0, nameWidth - stringWidth(command.name))
        return (
          <Text key={command.name} wrap="truncate">
            {' '}
            {isSelected ? (
              <Text color="suggestion" bold>{`${POINTER} ${command.name}${' '.repeat(padAfter)}`}</Text>
            ) : parts ? (
              // 嵌套 Text 会继承父级 dim（本 fork 的 dimColor 是颜色替换，
              // dim={false} 盖不掉），故高亮段必须与 dim 段平铺为兄弟。
              <>
                <Text dimColor>{`  ${parts.before}`}</Text>
                <Text>{parts.match}</Text>
                <Text dimColor>{`${parts.after}${' '.repeat(padAfter)}`}</Text>
              </>
            ) : (
              <Text dimColor>{`  ${command.name}${' '.repeat(padAfter)}`}</Text>
            )}
            {tagText ? <Text dimColor>{tagText}</Text> : null}
            <Text color={isSelected ? 'suggestion' : undefined} dimColor={!isSelected}>
              {description}
            </Text>
          </Text>
        )
      })}
    />
  )
}