import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import type { LlmModelInfo } from '../dsh-adapter/types.js'
import type { ModelGroupRow } from '../modelGroups.js'
import { RECENTS_GROUP_PROVIDER, RECENTS_LABEL_PLACEHOLDER } from '../modelGroups.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { listWindow } from './listWindow.js'

/**
 * Model picker in the CC ModelPicker style: a permission-colored Pane with
 * the rows as Select entries (❯ focus pointer, ✓ on the active row,
 * descriptions), plus the Enter/Esc hint line. The DSH agent's model is
 * fixed at creation time, so a selection notifies "restart to apply".
 *
 * Two levels: the top level lists **provider groups** (registry display
 * name + model count, ✓ on the current provider's row) and drills in with
 * Enter; the second level lists that group's models and switches with
 * Enter — the same live-fork path the flat picker always had. A
 * single-group catalog skips the top level entirely (showBack=false, plain
 * confirm/exit hint), so single-provider setups keep the pre-grouping UX.
 *
 * 长列表按焦点窗口化（Select 同款）：picker 经 OverlayAbove 浮层挂载后有
 * maxHeight 裁剪，全量渲染会让焦点行被裁掉（看不到焦点按 Enter）。
 */
export function ModelPicker(props:
  | {
    /** Top level: provider groups; Enter/click drills into one. */
    groups: readonly ModelGroupRow[]
    focusIndex: number
    /** Current route key — its group row carries the ✓ marker. */
    currentProvider: string
    onPick?: (index: number) => void
  }
  | {
    /** Second level (or single-group fast path): one provider's models —
     *  or the mixed-provider recents list (`showProviderPrefix`). */
    models: readonly LlmModelInfo[]
    /** The group's display label as this pane's title (default: "Model"). */
    groupLabel?: string
    /** Multi-group catalogs show the back hint; the fast path keeps the plain one. */
    showBack: boolean
    /** Prefix each row with its provider (the recents group mixes providers). */
    showProviderPrefix?: boolean
    focusIndex: number
    /** `provider/model` of the current model — its row carries the ✓ marker. */
    currentModel: string
    onPick?: (index: number) => void
  }): React.ReactNode {
  const inGroups = 'groups' in props
  const { rows: terminalRows } = useTerminalSize()
  // Captured before the map: union narrowing does not survive into closures.
  const onPick = props.onPick
  // 焦点窗口化按行预算：ListItem 带 description 时占 2 行（正文+描述，均
  // truncate 成单行），只数项数会把焦点裁出浮层（二次审查实证）。
  // 框架行：浮层预留 8 + Pane 2 + 标题 2 + 页脚 1 + 挂载包裹 marginTop 1 = 14。
  const rowHeights = inGroups
    ? props.groups.map(() => 2)
    : props.models.map(m => (m.description ? 2 : 1))
  const rows = inGroups ? props.groups : props.models
  const { start, end } = listWindow(rowHeights, props.focusIndex, Math.max(terminalRows - 14, 2))
  const hint = inGroups
    ? t('hint-model-groups')
    : props.showBack ? t('hint-model-back') : t('hint-confirm-exit')
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {inGroups || props.groupLabel === undefined ? t('picker-title-model') : props.groupLabel}
          </Text>
        </Box>
        {rows.slice(start, end).map((row, index) => {
          const absoluteIndex = start + index
          return inGroups ? (
            <ListItem
              key={row.provider}
              isFocused={absoluteIndex === props.focusIndex}
              isSelected={row.provider === props.currentProvider}
              description={t('picker-group-count', { count: row.count })}
              showScrollUp={absoluteIndex === start && start > 0}
              showScrollDown={absoluteIndex === end - 1 && end < rows.length}
              onClick={onPick ? () => onPick(absoluteIndex) : undefined}
            >
              {row.label === RECENTS_LABEL_PLACEHOLDER && row.provider === RECENTS_GROUP_PROVIDER
                ? t('picker-group-recent')
                : row.label}
            </ListItem>
          ) : (
            <ListItem
              key={`${row.provider}/${row.id}`}
              isFocused={absoluteIndex === props.focusIndex}
              isSelected={`${row.provider}/${row.id}` === props.currentModel}
              description={row.description}
              showScrollUp={absoluteIndex === start && start > 0}
              showScrollDown={absoluteIndex === end - 1 && end < rows.length}
              onClick={onPick ? () => onPick(absoluteIndex) : undefined}
            >
              {props.showProviderPrefix === true ? `${row.provider} / ${row.name}` : row.name}
            </ListItem>
          )
        })}
      </Box>
      <Text dimColor italic>
        <HintLine text={hint} />
      </Text>
    </Pane>
  )
}
