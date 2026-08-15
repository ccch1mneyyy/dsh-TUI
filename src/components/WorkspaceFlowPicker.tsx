import React from 'react'
import { Box, Text } from '../ui.js'
import { t } from '../i18n.js'
import type { TuiWorkspaceChoice } from '../workspaces.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'

const WINDOW = 8

/** Generic nested choice surface returned by a workspace provider command. */
export function WorkspaceFlowPicker({
  title,
  choices,
  focusIndex,
  busy = false,
  input = null,
}: {
  title: string
  choices: readonly TuiWorkspaceChoice[]
  focusIndex: number
  busy?: boolean
  input?: { value: string; cursor: number; placeholder?: string } | null
}): React.ReactNode {
  const start = Math.max(0, Math.min(focusIndex - Math.floor(WINDOW / 2), choices.length - WINDOW))
  const visible = choices.slice(start, start + WINDOW)
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>{title}</Text>
        </Box>
        {visible.map((choice, index) => (
          <ListItem
            key={choice.id}
            isFocused={start + index === focusIndex}
            isSelected={false}
            description={choice.description}
            showScrollUp={index === 0 && start > 0}
            showScrollDown={index === visible.length - 1 && start + visible.length < choices.length}
          >
            {choice.badge ? `${choice.badge} · ` : ''}{choice.label}
          </ListItem>
        ))}
        {input !== null && (
          <Box marginTop={1}>
            <Text color="remember">❯ </Text>
            {input.value.length === 0 ? (
              <>
                <Text inverse> </Text>
                <Text dimColor>{input.placeholder ?? ''}</Text>
              </>
            ) : (
              <>
                <Text>{input.value.slice(0, input.cursor)}</Text>
                <Text inverse>{input.value[input.cursor] ?? ' '}</Text>
                <Text>{input.value.slice(input.cursor + 1)}</Text>
              </>
            )}
          </Box>
        )}
      </Box>
      <Text dimColor italic>
        <HintLine text={
          busy
            ? t('workspace-flow-loading')
            : input !== null
              ? t('workspace-flow-input-hint')
              : choices[focusIndex]?.input !== undefined
                ? t('workspace-flow-edit-hint')
                : t('workspace-flow-hint')
        } />
      </Text>
    </Pane>
  )
}
