import React from 'react'
import { Box, Text } from '../ui.js'
import type { Channel, ChannelGoal, TodoPanelItem } from '../channel.js'

/** Maximum todo rows shown before the overflow line. */
const MAX_TODOS = 8

const PHASE_LABEL: Record<ChannelGoal['phase'], string> = {
  active: '● active',
  paused: '⏸ paused',
  blocked: '⛔ blocked',
  complete: '✓ complete',
}

function PhaseBadge({
  phase,
  roundsStarted,
  maxGoalRounds,
}: {
  phase: ChannelGoal['phase']
  roundsStarted: number
  maxGoalRounds: number
}): React.ReactNode {
  const color =
    phase === 'active'
      ? 'success'
      : phase === 'paused'
        ? 'warning'
        : phase === 'blocked'
          ? 'error'
          : undefined
  return (
    <Text color={color} dimColor={phase === 'complete'}>
      {PHASE_LABEL[phase]} · {roundsStarted}/{maxGoalRounds}
    </Text>
  )
}

function TodoGlyph({ status }: { status: TodoPanelItem['status'] }): React.ReactNode {
  switch (status) {
    case 'in_progress':
      return <Text color="suggestion">● </Text>
    case 'completed':
      return <Text dimColor>✓ </Text>
    default:
      return <Text dimColor>○ </Text>
  }
}

/**
 * Live goal + todo panel above the prompt input. Data rides on the channel:
 * `channel.goal` is folded from `goal/change` context events and
 * `channel.todos` from `todo/write` whole-list snapshots, so every model
 * update re-renders this panel in real time (no polling). Renders nothing
 * while both slots are empty.
 */
export function GoalTodoPanel({ channel }: { channel: Channel }): React.ReactNode {
  const goal = channel.goal
  const todos = channel.todos ?? []
  if (goal === undefined && todos.length === 0) return null
  const visible = todos.slice(0, MAX_TODOS)
  const hidden = todos.length - visible.length
  return (
    <Box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
      {goal !== undefined && (
        <Box flexDirection="column" marginBottom={todos.length > 0 ? 1 : 0}>
          <Box flexDirection="row" width="100%">
            <Text color="suggestion">🎯 </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate">
                {goal.objective}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <PhaseBadge
                phase={goal.phase}
                roundsStarted={goal.roundsStarted}
                maxGoalRounds={goal.maxGoalRounds}
              />
            </Box>
          </Box>
          {goal.phase === 'blocked' && goal.blockedReason !== undefined && (
            <Box flexDirection="row" marginTop={1}>
              <Text color="error" wrap="truncate">
                {goal.blockedReason.message}
              </Text>
            </Box>
          )}
        </Box>
      )}
      {todos.length > 0 && (
        <Box flexDirection="column">
          {visible.map((todo, index) => (
            <Box key={index} flexDirection="row">
              <TodoGlyph status={todo.status} />
              <Text wrap="truncate" dimColor={todo.status === 'completed'}>
                {todo.content}
              </Text>
            </Box>
          ))}
          {hidden > 0 && <Text dimColor>… {hidden} more</Text>}
        </Box>
      )}
    </Box>
  )
}
