import React from 'react'
import { Box, Text } from '../ui.js'
import { t } from '../i18n.js'
import type { TuiWorkspaceTarget } from '../workspaces.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'

const WINDOW = 8

/** `/workspace` target picker contributed by local and optional providers. */
export function WorkspacePicker({
  targets,
  focusIndex,
  currentCwd,
  onPick,
}: {
  targets: readonly TuiWorkspaceTarget[]
  focusIndex: number
  currentCwd: string
  /** Mouse pick (fullscreen): reports the clicked row's absolute index —
   *  Chat applies it with the same code path as the keyboard Enter. */
  onPick?: (index: number) => void
}): React.ReactNode {
  const start = Math.max(0, Math.min(focusIndex - Math.floor(WINDOW / 2), targets.length - WINDOW))
  const visible = targets.slice(start, start + WINDOW)
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>{t('workspace-picker-title')}</Text>
        </Box>
        {visible.map((target, index) => (
          <ListItem
            key={target.uri}
            isFocused={start + index === focusIndex}
            isSelected={target.cwd === currentCwd}
            description={target.description ?? target.uri}
            showScrollUp={index === 0 && start > 0}
            showScrollDown={index === visible.length - 1 && start + visible.length < targets.length}
            onClick={onPick === undefined ? undefined : () => onPick(start + index)}
          >
            {target.badge} · {target.label}
          </ListItem>
        ))}
      </Box>
      <Text dimColor italic><HintLine text={t('workspace-picker-hint')} /></Text>
    </Pane>
  )
}
