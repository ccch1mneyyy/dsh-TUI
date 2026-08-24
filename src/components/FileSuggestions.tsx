import React from 'react'
import { Text } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import type { FileCandidate } from '../utils/fileSuggestions.js'
import { t } from '../i18n.js'
import { POINTER } from '../cc/figures.js'
import { SuggestionCard, cardContentWidth, splitQueryMatch } from './SuggestionCard.js'

/**
 * The `@` file-completion overlay in CC's suggestion style, wrapped in the
 * shared rounded `SuggestionCard` (与 `/` 命令菜单同一视觉语言):
 *
 *   ╭─ 文件 · 共 12 项 ──────────────────────╮
 *   │ ❯ ▸ src/components/     directory     │
 *   │   + README.md           file          │
 *   ╰─────────────────────────────────────────╯
 *
 * Full relative path (directory suffix stripped) + a `file`/`directory`
 * description; the selected row renders `❯` + bold in the theme's
 * `suggestion` color, others dim with the query-matched prefix of the name
 * highlighted (non-dim). The name column is padded to a fixed display width
 * so the description column keeps its contract at narrow terminals (pinned
 * by verify-cjk-truncate.tsx); every pad/truncate uses display width, so CJK
 * names never split a glyph.
 */
export function FileSuggestions({
  files,
  selectedIndex,
  columns,
  query = '',
  accent,
  onPick,
  onWheelStep,
}: {
  files: readonly FileCandidate[]
  selectedIndex: number
  columns: number
  /** `@` 触发 token 里已输入的查询（`mention.query`），用于名字前缀高亮。 */
  query?: string
  accent?: 'promptBorder' | 'planMode'
  /** 鼠标点击行（fullscreen）：上报过滤后列表的绝对索引（与键盘
   *  selectedIndex 同一索引空间），接受路径由 PromptInput 复用。 */
  onPick?: (index: number) => void
  /** 滚轮步进（fullscreen）：±1 移动选中行。 */
  onWheelStep?: (step: 1 | -1) => void
}): React.ReactNode {
  if (files.length === 0) return null

  const usable = cardContentWidth(columns)
  const maxVisible = 6
  const safeIndex = Math.min(Math.max(0, selectedIndex), files.length - 1)
  const startIndex = Math.max(
    0,
    Math.min(
      safeIndex - Math.floor(maxVisible / 2),
      Math.max(0, files.length - maxVisible),
    ),
  )
  const visible = files.slice(startIndex, startIndex + maxVisible)
  const above = startIndex
  const below = files.length - (startIndex + visible.length)

  const nameOf = (file: FileCandidate): string =>
    file.kind === 'directory' && file.path.endsWith('/')
      ? file.path.slice(0, -1)
      : file.path

  const NAME_COLUMN = 20
  // 行预算：内容宽 − 前导空格 1 − 指针列 2 − 图标列 2。
  const descriptionWidth = Math.max(0, usable - 25)

  const title = `${t('sugg-files-title')} · ${t('sugg-count', { n: files.length })}`
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
      rows={visible.map(file => {
        const isSelected = file.id === files[safeIndex]?.id
        const name = nameOf(file)
        const icon = file.kind === 'directory' ? '▸ ' : '+ '
        const padded = name + ' '.repeat(Math.max(1, NAME_COLUMN - stringWidth(name)))
        const description = file.kind === 'directory' ? 'directory' : 'file'
        const renderedDescription =
          stringWidth(description) > descriptionWidth
            ? truncateToWidth(description, Math.max(0, descriptionWidth - 1)) + '…'
            : description
        const parts = splitQueryMatch(name, query)
        const pad = ' '.repeat(Math.max(1, NAME_COLUMN - stringWidth(name)))
        return (
          <Text key={file.id} wrap="truncate">
            {' '}
            {isSelected ? (
              <Text color="suggestion" bold>{`${POINTER} ${icon}${padded}`}</Text>
            ) : parts ? (
              // 平铺兄弟 span：嵌套 Text 继承父级 dim，高亮段会被 dim 吞掉。
              <>
                <Text dimColor>{`  ${icon}${parts.before}`}</Text>
                <Text>{parts.match}</Text>
                <Text dimColor>{`${parts.after}${pad}`}</Text>
              </>
            ) : (
              <Text dimColor>{`  ${icon}${padded}`}</Text>
            )}
            <Text color={isSelected ? 'suggestion' : undefined} dimColor={!isSelected}>
              {renderedDescription}
            </Text>
          </Text>
        )
      })}
    />
  )
}
