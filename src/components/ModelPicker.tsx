import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'

/**
 * Model picker in the CC ModelPicker style: a permission-colored Pane with
 * the model list as Select rows (❯ focus pointer, ✓ on the active model,
 * descriptions), plus the Enter/Esc hint line. The DSH agent's model is
 * fixed at creation time, so a selection notifies "restart to apply".
 */
export function ModelPicker({
  models,
  focusIndex,
  currentModel,
}: {
  models: readonly LlmModelInfo[]
  focusIndex: number
  currentModel: string
}): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('picker-title-model')}
          </Text>
        </Box>
        {models.map((model, index) => (
          <ListItem
            key={`${model.provider}/${model.id}`}
            isFocused={index === focusIndex}
            isSelected={`${model.provider}/${model.id}` === currentModel}
            description={model.description}
          >
            {model.provider} / {model.name}
          </ListItem>
        ))}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-confirm-exit')} />
      </Text>
    </Pane>
  )
}
