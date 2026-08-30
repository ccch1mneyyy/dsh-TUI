import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { SearchBox } from './SearchBox.js'
import { listWindow } from './listWindow.js'
import { historyEntryId, type HistoryEntry } from '../history.js'

/**
 * The ctrl+r history search dialog, in the shape of Claude Code's
 * HistorySearchDialog/FuzzyPicker: a permission-colored Pane with a bold
 * title, the ⌕ SearchBox, the filtered history as ListItem rows (newest
 * first), and the ↑/↓ · Enter · Esc hint line. Keyboard handling lives in
 * the caller (Chat).
 */
export function HistorySearchDialog({
  query,
  cursorOffset,
  matches,
  focusIndex,
  onPick,
}: {
  query: string
  cursorOffset: number
  matches: readonly HistoryEntry[]
  focusIndex: number
  /** 鼠标点击行（fullscreen）：上报绝对索引——Chat 用与 Enter 相同的
   *  填入/提交路径处理。 */
  onPick?: (index: number) => void
}): React.ReactNode {
  const isTerminalFocused = useTerminalFocus()
  const { rows: terminalRows } = useTerminalSize()
  // 焦点窗口化按行预算：每项恒 2 行（命令 + age 描述，ListItem 保证单行
  // 截断），容器 gap={1} 项间再空 1 行。只数项数会把焦点裁出浮层（二次
  // 审查实证）。
  // 框架行：浮层预留 8 + Pane 2 + 标题 1 + gap 1 + SearchBox 3（圆角边框）
  // + gap 1 + gap 1 + 页脚 1 = 18。
  const { start, end } = listWindow(
    matches.map(() => 2),
    focusIndex,
    Math.max(terminalRows - 18, 2),
    1,
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Text bold color="permission">
          {t('history-search-title')}
        </Text>
        <SearchBox
          query={query}
          cursorOffset={cursorOffset}
          isFocused
          isTerminalFocused={isTerminalFocused}
          placeholder={t('history-search-placeholder')}
        />
        {matches.length === 0 ? (
          <Text dimColor>{t('history-search-empty')}</Text>
        ) : (
          matches.slice(start, end).map((entry, index) => {
            const absoluteIndex = start + index
            return (
              <ListItem
                key={historyEntryId(entry, absoluteIndex)}
                isFocused={absoluteIndex === focusIndex}
                // The SearchBox owns the native-cursor declaration while this
                // dialog is open — result rows must not park the cursor on
                // themselves, or IME preedit lands on a list row.
                declareCursor={false}
                description={formatRelativeAge(entry.ts)}
                showScrollUp={absoluteIndex === start && start > 0}
                showScrollDown={absoluteIndex === end - 1 && end < matches.length}
                onClick={onPick ? () => onPick(absoluteIndex) : undefined}
              >
                {entry.text}
              </ListItem>
            )
          })
        )}
        <Text dimColor italic>
          <HintLine text={t('hint-history-search')} />
        </Text>
      </Box>
    </Pane>
  )
}

/** Relative age like CC's formatRelativeTimeAgo ("now" / "5m ago" / …), localized. */
function formatRelativeAge(ts: number): string {
  const elapsed = Date.now() - ts
  if (elapsed < 60_000) return t('time-now')
  if (elapsed < 3_600_000) return t('time-minutes-ago', { n: Math.floor(elapsed / 60_000) })
  if (elapsed < 86_400_000) return t('time-hours-ago', { n: Math.floor(elapsed / 3_600_000) })
  return t('time-days-ago', { n: Math.floor(elapsed / 86_400_000) })
}
