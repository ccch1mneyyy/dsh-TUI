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
 * `/migrate` source picker (multi-select, PRD revision): each row shows a
 * checkbox, the scannable file count, and a recent-activity badge. Keys
 * (Chat owns the logic): space toggles the focused source, `a` selects
 * all/none, Enter proceeds to the confirmation layer with the checked set
 * (the focused row when nothing is checked), Esc closes. While the rows are
 * still being collected it says so — the scan takes a moment on real stores
 * and "no sources available" would be a lie in that window.
 */
export function MigratePicker({
  rows,
  focusIndex,
  checked,
  loading = false,
  onPick,
}: {
  rows: readonly MigratePickerRow[]
  focusIndex: number
  /** Checked agent ids (multi-select state lives in Chat). */
  checked: ReadonlySet<string>
  /** Rows still loading: render the scanning line, not the empty state. */
  loading?: boolean
  /** Mouse pick (fullscreen): toggle the clicked row's checked state. */
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
        {loading ? (
          <Text dimColor>{t('migrate-picker-scanning')}</Text>
        ) : rows.length === 0 ? (
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
                {`${checked.has(row.agentId) ? '[x]' : '[ ]'} ${row.label} · ${t('migrate-picker-count', { n: row.count })}`}
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

/**
 * The second confirmation layer (PRD #2): one line per checked source with
 * its scannable count and the repeat-safe note. Keys (Chat): Enter imports,
 * `d` dry-runs, Esc returns to the picker with the checked set preserved.
 */
export function MigrateConfirm({
  rows,
}: {
  rows: readonly MigratePickerRow[]
}): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('migrate-confirm-title')}
          </Text>
        </Box>
        {rows.map(row => (
          <Box key={row.agentId} paddingLeft={1}>
            <Text>
              {t('migrate-confirm-line', { label: row.label, n: row.count })}
            </Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>{t('migrate-confirm-note')}</Text>
        </Box>
      </Box>
      <Text dimColor italic>
        <HintLine text={t('migrate-confirm-actions')} />
      </Text>
    </Pane>
  )
}
