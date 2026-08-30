import React from 'react'
import { Box, Text } from '../ui.js'
import type { Channel, ChannelGoal, TodoPanelItem } from '../dsh-adapter/channel.js'
import { t } from '../i18n.js'
import { modLabel } from '../utils/modifiers.js'

/** Maximum todo rows shown before the overflow line. */
const MAX_TODOS = 8

const PHASE_LABEL: Record<ChannelGoal['phase'], string> = {
  active: '● active',
  paused: '⏸ paused',
  blocked: '× blocked',
  complete: '✓ complete',
}

/** Compact phase marker for the status-footer chip. */
const PHASE_GLYPH: Record<ChannelGoal['phase'], string> = {
  active: '●',
  paused: '⏸',
  blocked: '×',
  complete: '✓',
}

function phaseColor(phase: ChannelGoal['phase']): 'success' | 'warning' | 'error' | undefined {
  if (phase === 'active') return 'success'
  if (phase === 'paused') return 'warning'
  if (phase === 'blocked') return 'error'
  return undefined
}

/** `47s` under a minute, `3m12s` after — same shape as the subagent cards. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/**
 * Compact goal chip for the status footer: phase glyph + rounds, colored by
 * phase. `minimal` swaps the glyph for a text form, per the minimal-mode
 * no-emoji contract.
 */
export function GoalStatusChip({ goal, minimal = false }: { goal: ChannelGoal; minimal?: boolean }): React.ReactNode {
  return (
    <Text color={phaseColor(goal.phase)} dimColor={goal.phase === 'complete'}>
      {minimal
        ? `goal ${goal.roundsStarted}/${goal.maxGoalRounds}`
        : `${PHASE_GLYPH[goal.phase]} ${goal.roundsStarted}/${goal.maxGoalRounds}`}
    </Text>
  )
}

function PhaseBadge({
  phase,
  roundsStarted,
  maxGoalRounds,
  elapsed,
}: {
  phase: ChannelGoal['phase']
  roundsStarted: number
  maxGoalRounds: number
  /** Wall-clock age of the goal, from the panel's own timer. */
  elapsed?: string
}): React.ReactNode {
  const color = phaseColor(phase)
  return (
    <Text color={color} dimColor={phase === 'complete'}>
      {PHASE_LABEL[phase]} · {roundsStarted}/{maxGoalRounds}
      {elapsed !== undefined ? ` · ${elapsed}` : ''}
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
 * Mind-map style branch prefix: `├─` for every row but the last, which
 * closes with `└─`. The whole panel reads as one tree — the goal is the
 * root and each todo hangs off it.
 */
function BranchPrefix({ last }: { last: boolean }): React.ReactNode {
  return <Text dimColor>{last ? '└─ ' : '├─ '}</Text>
}

/**
 * Live goal + todo panel above the prompt input. Data rides on the channel:
 * `channel.goal` is folded from `goal/change` context events and
 * `channel.todos` from `todo/write` whole-list snapshots, so every model
 * update re-renders this panel in real time (no polling). Renders nothing
 * while both slots are empty.
 *
 * The todo section folds two ways: completed rows fold automatically once
 * the agent goes idle (the header's `✓ done/total` count keeps the
 * summary), and `collapsed` folds the whole section to that single header
 * line any time — including mid-turn, where the line still previews the
 * in-progress task. `onToggle` is the click affordance for the header row;
 * the ctrl/cmd+q hotkey in Chat drives the same state.
 *
 * Goal elapsed time is the panel's own wall clock (started when the goal
 * id first appears, frozen on completion) — deliberately not derived from
 * session-event timestamps.
 */
export function GoalTodoPanel({
  channel,
  collapsed = false,
  onToggle,
}: {
  channel: Channel
  /** Fold the whole todo section to its summary header line. */
  collapsed?: boolean
  /** Toggle the fold (click on the header row; shares the hotkey state). */
  onToggle?: () => void
}): React.ReactNode {
  const goal = channel.goal
  const allTodos = channel.todos ?? []
  const doneCount = allTodos.filter(todo => todo.status === 'completed').length
  // Completed rows are useful progress while a turn is running, but become
  // stale footer noise once the agent is idle. Keep unfinished work visible;
  // the header count carries the done summary either way.
  const todos = channel.working
    ? allTodos
    : allTodos.filter(todo => todo.status !== 'completed')

  // Local goal timer: remember when this goal id first rendered. Written in
  // render (idempotent lazy ref init) so a fresh mount with a live goal
  // starts counting immediately.
  const startRef = React.useRef<{ id: string; at: number } | undefined>(undefined)
  if (goal !== undefined && startRef.current?.id !== goal.id) {
    startRef.current = { id: goal.id, at: Date.now() }
  }
  const [now, setNow] = React.useState(() => Date.now())
  // Hover tint for the clickable todo fold header (mouse affordance).
  const [headerHovered, setHeaderHovered] = React.useState(false)
  React.useEffect(() => {
    // Tick only while the goal is open; a complete goal freezes the last
    // elapsed reading instead of counting past the finish line.
    if (goal === undefined || goal.phase === 'complete') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [goal])
  const elapsed = goal !== undefined && startRef.current !== undefined
    ? formatDuration(now - startRef.current.at)
    : undefined

  // All-completed idle snapshot with no goal: nothing left to narrate —
  // the whole panel folds away (historical behavior).
  const anyUnfinished = allTodos.some(todo => todo.status !== 'completed')
  const showTodoSection = allTodos.length > 0 && (channel.working || anyUnfinished || goal !== undefined)
  if (goal === undefined && !showTodoSection) return null

  const visible = todos.slice(0, MAX_TODOS)
  const hidden = todos.length - visible.length
  // Collapsed preview: the live task when one runs, else the next open row.
  const preview = allTodos.find(todo => todo.status === 'in_progress')
    ?? allTodos.find(todo => todo.status !== 'completed')

  return (
    <Box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
      {goal !== undefined && (
        <Box flexDirection="column" marginBottom={showTodoSection ? 1 : 0}>
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
                elapsed={elapsed}
              />
            </Box>
          </Box>
          {goal.phase === 'blocked' && goal.blockedReason !== undefined && (
            <Box flexDirection="row" marginTop={1}>
              <Text dimColor>│ </Text>
              <Text color="error" wrap="truncate">
                {goal.blockedReason.message}
              </Text>
            </Box>
          )}
        </Box>
      )}
      {showTodoSection && (
        <Box flexDirection="column">
          {/* Fold header: done/total summary, clickable, doubles as the
              collapsed line (with the live-task preview). */}
          <Box
            flexDirection="row"
            onClick={onToggle}
            onMouseEnter={() => setHeaderHovered(true)}
            onMouseLeave={() => setHeaderHovered(false)}
            backgroundColor={headerHovered ? 'userMessageBackgroundHover' : undefined}
          >
            <Text dimColor>{collapsed ? '▸' : '▾'} </Text>
            <Text dimColor>✓ {doneCount}/{allTodos.length}</Text>
            {collapsed && preview !== undefined && (
              <Box flexGrow={1} flexShrink={1} marginLeft={1}>
                {preview.status === 'in_progress' ? (
                  <Text wrap="truncate">
                    <Text color="suggestion">● </Text>
                    {preview.content}
                  </Text>
                ) : (
                  <Text wrap="truncate" dimColor>
                    ○ {preview.content}
                  </Text>
                )}
              </Box>
            )}
          </Box>
          {!collapsed && (
            <Box flexDirection="column">
              {visible.map((todo, index) => {
                const last = index === visible.length - 1 && hidden === 0
                return (
                  <Box key={index} flexDirection="row">
                    <BranchPrefix last={last} />
                    <TodoGlyph status={todo.status} />
                    <Text wrap="truncate" dimColor={todo.status === 'completed'}>
                      {todo.content}
                    </Text>
                  </Box>
                )
              })}
              {hidden > 0 && (
                <Box flexDirection="row">
                  <BranchPrefix last />
                  <Text dimColor>… {hidden} more</Text>
                </Box>
              )}
              {/* Fold affordance under the list — only while expanded; the
                  collapsed line already IS the folded state. */}
              <Text dimColor>  {t('goal-todo-fold-hint', { mod: modLabel })}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
