import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import type { BackendChannelOption } from '../dsh-adapter/channel.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'

/**
 * 渠道档案选择器（/channel，仅 channels 能力的后端——即 Claude）：一行一个
 * 渠道（当前渠道打 ✓、行尾副行是映射规模），末尾两行固定动作——「从
 * settings.json 导入」与「查看映射」。
 *
 * 视觉照 KernelPicker/ColorPicker 先例（Pane color=permission + 标题 +
 * 行列表 + 底部提示行）；行是 ListItem 但 **styled=false**，❯ 焦点指针
 * 恒在、✓ 跟 activeId 走。键盘归宿主（Chat 的 overlay 分支）：↑/↓ 移焦点、
 * Enter 走确认路径、Esc 关掉，本组件不碰 useInput。
 *
 * 名册不冻在 overlay 里（rows 是 Chat 每渲染现读 channels.json 的派生值）：
 * 切换/导入后 ✓ 与行自己就刷新，选择器留在屏上（管理器姿态，与 /kernel
 * 的「选完即关」刻意不同——这里还要继续导入/查看）。
 *
 * 鼠标契约照仓库规矩：给了 onPick 行才可点（hover 底色随之出现），点击
 * 回的是**行号**——宿主把它喂给与键盘 Enter 完全相同的那条确认路径。
 */

/** 一行：渠道、或固定动作之一（导入 / 新增 / 管理 / 查看映射）。 */
export type ChannelPickerRow =
  | { readonly kind: 'channel'; readonly option: BackendChannelOption; readonly active: boolean }
  | { readonly kind: 'import' }
  | { readonly kind: 'add' }
  | { readonly kind: 'manage' }
  | { readonly kind: 'view' }

export function ChannelPicker({ rows, focusIndex, onPick }: {
  rows: readonly ChannelPickerRow[]
  focusIndex: number
  /** 鼠标点行（落到 Chat 同一条确认路径） */
  onPick?: (index: number) => void
}): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('channel-picker-title')}
          </Text>
        </Box>
        {!rows.some(row => row.kind === 'channel') && (
          <Box paddingLeft={2} marginBottom={1}>
            <Text dimColor wrap="truncate">
              {t('channel-empty-hint')}
            </Text>
          </Box>
        )}
        {rows.map((row, index) => {
          const focused = index === focusIndex
          if (row.kind === 'channel') {
            return (
              <ListItem
                key={row.option.id}
                isFocused={focused}
                isSelected={row.active}
                description={row.option.connection === undefined
                  ? t('channel-row-summary', { models: String(row.option.models.length), tiers: String(row.option.tiers.length) })
                  : t('channel-row-summary-conn', {
                    url: row.option.connection.baseUrl ?? t('channel-row-no-url'),
                    token: row.option.connection.hasToken ? '✓' : '—',
                    env: String(row.option.connection.envKeys.length),
                    models: String(row.option.models.length),
                    tiers: String(row.option.tiers.length),
                  })}
                styled={false}
                onClick={onPick === undefined ? undefined : () => onPick(index)}
              >
                <Text
                  color={row.active ? 'success' : focused ? 'suggestion' : undefined}
                  bold={focused}
                  wrap="truncate-end"
                >
                  {row.option.name}
                </Text>
              </ListItem>
            )
          }
          return (
            <ListItem
              key={row.kind}
              isFocused={focused}
              styled={false}
              onClick={onPick === undefined ? undefined : () => onPick(index)}
            >
              <Text color={focused ? 'suggestion' : undefined} bold={focused} wrap="truncate-end">
                {t(row.kind === 'import' ? 'channel-action-import'
                  : row.kind === 'add' ? 'channel-action-add'
                    : row.kind === 'manage' ? 'channel-action-manage'
                      : 'channel-action-view')}
              </Text>
            </ListItem>
          )
        })}
        <Text dimColor italic>
          <HintLine text={t('channel-picker-hint')} />
        </Text>
      </Box>
    </Pane>
  )
}
