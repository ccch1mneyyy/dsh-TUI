import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { listWindow } from './listWindow.js'
import { useOverlayListRows } from './OverlayAbove.js'
import type { MigratePickerRow } from '../dsh-adapter/migrate/picker.js'

/**
 * `/migrate` source picker (SkillsPicker style): one row per foreign agent,
 * main line = label + scannable file count, description line = recent
 * activity badge or the store location hint. Enter (Chat) spawns the import
 * for the focused source; Esc closes. `/migrate <agent>` bypasses the picker.
 */
export function MigratePicker({
  rows,
  focusIndex,
  onPick,
}: {
  rows: readonly MigratePickerRow[]
  focusIndex: number
  /** Mouse pick (fullscreen): Chat applies the same path as keyboard Enter. */
  onPick?: (index: number) => void
}): React.ReactNode {
  // 每项恒占 2 行（主行 + 描述行），预算同 SkillsPicker（OverlayAbove 高度
  // 减 Pane 2 + 标题 2 + 页脚 1 + marginTop 1 = 6）。
  const listRows = useOverlayListRows(6)
  const { start, end } = listWindow(
    rows.map(() => 2),
    focusIndex,
    listRows,
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('picker-title-migrate')}
          </Text>
        </Box>
        {rows.length === 0 ? (
          <Text dimColor>{t('migrate-picker-empty')}</Text>
        ) : (
          rows.slice(start, end).map((row, index) => {
            const absoluteIndex = start + index
            const description = row.minutesAgo !== undefined
              ? t('migrate-picker-recent', { minutes: row.minutesAgo })
              : t('migrate-picker-cold')
            return (
              <ListItem
                key={row.agentId}
                isFocused={absoluteIndex === focusIndex}
                description={description}
                showScrollUp={absoluteIndex === start && start > 0}
                showScrollDown={absoluteIndex === end - 1 && end < rows.length}
                onClick={onPick ? () => onPick(absoluteIndex) : undefined}
              >
                {`${row.label} · ${t('migrate-picker-count', { n: row.count })}`}
              </ListItem>
            )
          })
        )}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('migrate-picker-hint')} />
      </Text>
    </Pane>
  )
}
