import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import type { LlmModelInfo } from '../dsh-adapter/types.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { listWindow } from './listWindow.js'

/**
 * Model picker in the CC ModelPicker style: a permission-colored Pane with
 * the model list as Select rows (❯ focus pointer, ✓ on the active model,
 * descriptions), plus the Enter/Esc hint line. The DSH agent's model is
 * fixed at creation time, so a selection notifies "restart to apply".
 *
 * 长列表按焦点窗口化（Select 同款）：picker 经 OverlayAbove 浮层挂载后有
 * maxHeight 裁剪，全量渲染会让焦点行被裁掉（看不到焦点按 Enter）。
 */
export function ModelPicker({
  models,
  focusIndex,
  currentModel,
  onPick,
}: {
  models: readonly LlmModelInfo[]
  focusIndex: number
  currentModel: string
  /** Mouse pick (fullscreen): reports the clicked row's absolute index —
   *  Chat applies it with the same code path as the keyboard Enter. */
  onPick?: (index: number) => void
}): React.ReactNode {
  const { rows: terminalRows } = useTerminalSize()
  // 焦点窗口化按行预算：ListItem 带 description 时占 2 行（正文+描述，均
  // truncate 成单行），只数项数会把焦点裁出浮层（二次审查实证）。
  // 框架行：浮层预留 8 + Pane 2 + 标题 2 + 页脚 1 + 挂载包裹 marginTop 1 = 14。
  const { start, end } = listWindow(
    models.map(m => (m.description ? 2 : 1)),
    focusIndex,
    Math.max(terminalRows - 14, 2),
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('picker-title-model')}
          </Text>
        </Box>
        {models.slice(start, end).map((model, index) => {
          const absoluteIndex = start + index
          return (
            <ListItem
              key={`${model.provider}/${model.id}`}
              isFocused={absoluteIndex === focusIndex}
              isSelected={`${model.provider}/${model.id}` === currentModel}
              description={model.description}
              showScrollUp={absoluteIndex === start && start > 0}
              showScrollDown={absoluteIndex === end - 1 && end < models.length}
              onClick={onPick ? () => onPick(absoluteIndex) : undefined}
            >
              {model.provider} / {model.name}
            </ListItem>
          )
        })}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-confirm-exit')} />
      </Text>
    </Pane>
  )
}
