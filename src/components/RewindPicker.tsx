import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import type { ChatRow } from '../dsh-adapter/channel.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { listWindow } from './listWindow.js'

/**
 * Double-Esc rewind picker (CC's "Double-tap esc to rewind the code and/or
 * conversation to a previous point in time"): lists the user's past messages
 * newest-first; selecting one and confirming rewinds the conversation to
 * that point (the message comes back into the input for re-editing).
 */
export function RewindPicker({
  rows,
  focusIndex,
  confirmRow,
}: {
  rows: readonly ChatRow[]
  focusIndex: number
  confirmRow: ChatRow | null
}): React.ReactNode {
  if (confirmRow !== null) {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="remember" bold>
              {t('rewind-confirm-title')}
            </Text>
          </Box>
          <ListItem isFocused={false} description={t('rewind-confirm-desc')}>
            {preview(confirmRow.text)}
          </ListItem>
          <Text dimColor italic>
            <HintLine text={t('hint-rewind-back')} />
          </Text>
        </Box>
      </Pane>
    )
  }

  const { rows: terminalRows } = useTerminalSize()
  // 焦点窗口化按行预算：首项带 'last message' 描述占 2 行、其余 1 行
  //（ListItem 保证单行截断）。rewind 是不可见确认的高危操作，焦点必须
  // 始终在屏。框架行：浮层预留 8 + Pane 2 + 标题块 3 + 页脚 1 = 14。
  const { start, end } = listWindow(
    rows.map((_, i) => (i === 0 ? 2 : 1)),
    focusIndex,
    Math.max(terminalRows - 14, 2),
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('rewind-title')}
          </Text>
          <Text dimColor>{t('rewind-subtitle')}</Text>
        </Box>
        {rows.length === 0 ? (
          <ListItem isFocused={false}>{t('rewind-empty')}</ListItem>
        ) : (
          rows.slice(start, end).map((row, index) => {
            const absoluteIndex = start + index
            return (
              <ListItem
                key={row.id}
                isFocused={absoluteIndex === focusIndex}
                description={absoluteIndex === 0 ? t('rewind-last-message') : undefined}
                showScrollUp={absoluteIndex === start && start > 0}
                showScrollDown={absoluteIndex === end - 1 && end < rows.length}
              >
                {preview(row.text)}
              </ListItem>
            )
          })
        )}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-select-exit')} />
      </Text>
    </Pane>
  )
}

/** One-line preview of a message (newlines flattened, capped). */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`
}
