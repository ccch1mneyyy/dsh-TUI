/**
 * /panel 无参的面板选择器：Pane + Select 行列出「已启用 ∩ 已注册」的
 * 面板（内置与插件同席——图标、标题、badge 状态点都来自 PanelStore），
 * 当前活动面板带 current 标记。Enter 打开并聚焦，Esc 取消。
 */
import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import { Pane } from '../design-system/Pane.js'
import { Select } from '../Select.js'
import { HintLine } from '../design-system/HintLine.js'
import { panelStore } from './PanelStore.js'
import type { SidePanelController } from './useSidePanel.js'

export interface PanelPickerRow {
  readonly id: string
  readonly title: string
  readonly icon?: string
  readonly badge?: { readonly level: 'info' | 'warning' | 'error'; readonly unread: number } | null
}

function badgeGlyph(level: 'info' | 'warning' | 'error'): string {
  if (level === 'warning') return '!'
  if (level === 'error') return '×'
  return '●'
}

function badgeColor(level: 'info' | 'warning' | 'error'): 'warning' | 'error' | 'accent' {
  if (level === 'warning') return 'warning'
  if (level === 'error') return 'error'
  return 'accent'
}

export function usePanelPickerRows(controller: SidePanelController): readonly PanelPickerRow[] {
  const entries = React.useSyncExternalStore(panelStore.subscribe, () => panelStore.list())
  return controller.enabledPanelIds
    .map(id => entries.find(entry => entry.definition.id === id))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .map(entry => ({
      id: entry.definition.id,
      title: entry.definition.titleKey !== undefined ? t(entry.definition.titleKey) : entry.definition.title ?? entry.definition.id,
      icon: entry.definition.icon,
      badge: entry.badge,
    }))
}

export function PanelPicker({
  rows,
  focusIndex,
  activeId,
  onPick,
}: {
  readonly rows: readonly PanelPickerRow[]
  readonly focusIndex: number
  readonly activeId: string | undefined
  readonly onPick?: (index: number) => void
}): React.ReactNode {
  return (
    <Pane color="accent">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('picker-title-panel')}
          </Text>
        </Box>
        <Select
          options={rows.map(row => ({
            value: row.id,
            label: (
              <Text>
                <Text dimColor>{(row.icon ?? row.title.slice(0, 1)) + ' '}</Text>
                {row.title}
                {row.badge != null && (
                  <Text color={badgeColor(row.badge.level)}>{' ' + badgeGlyph(row.badge.level)}</Text>
                )}
              </Text>
            ),
          }))}
          focusIndex={focusIndex}
          selectedValue={activeId}
          onPick={onPick}
        />
        <Text dimColor italic>
          <HintLine text={t('hint-confirm-exit')} />
        </Text>
      </Box>
    </Pane>
  )
}
