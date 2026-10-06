import React from 'react'
import { Box, Text, useAnimationFrame } from '../ui.js'
import wrapText from '../ink/wrap-text.js'
import type { ChannelUi as Channel } from '../adapter/channel/ui-policy.js'
import type { ChannelGoal, TodoPanelItem } from '../dsh-adapter/channel.js'
import { t } from '../i18n.js'
import { primaryComboString } from '../utils/keymap.js'
import { formatGoalBudget, formatGoalBudgetCompact } from '../channel/goal-command.js'

/** Maximum todo rows shown before the overflow line. */
const MAX_TODOS = 8

const PHASE_LABEL: Record<ChannelGoal['phase'], string> = {
  active: '● active',
  paused: '⏸ paused',
  blocked: '⛔ blocked',
  complete: '✓ complete',
}

/** Compact phase marker for the status-footer chip. */
const PHASE_GLYPH: Record<ChannelGoal['phase'], string> = {
  active: '●',
  paused: '⏸',
  blocked: '⛔',
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
 * Compact goal chip for the status footer: phase glyph + rounds (a goal a
 * backend budgets by tokens: tokens used / budget instead), colored by
 * phase. `minimal` swaps the glyph for a text form, per the minimal-mode
 * no-emoji contract.
 */
export function GoalStatusChip({ goal, minimal = false }: { goal: ChannelGoal; minimal?: boolean }): React.ReactNode {
  const progress = goal.budget === undefined ? `${goal.roundsStarted}/${goal.maxGoalRounds}` : formatGoalBudgetCompact(goal.budget)
  return (
    <Text color={phaseColor(goal.phase)} dimColor={goal.phase === 'complete'}>
      {minimal
        ? `goal ${progress}`
        : `${PHASE_GLYPH[goal.phase]} ${progress}`}
    </Text>
  )
}

function PhaseBadge({
  phase,
  roundsStarted,
  maxGoalRounds,
  budget,
  elapsed,
}: {
  phase: ChannelGoal['phase']
  roundsStarted: number
  maxGoalRounds: number
  /** A token/time budget the backend reports: shown instead of the rounds
   *  (its own time used replaces the panel's wall clock). */
  budget?: ChannelGoal['budget']
  /** Wall-clock age of the goal, from the panel's own timer. */
  elapsed?: string
}): React.ReactNode {
  const color = phaseColor(phase)
  if (budget !== undefined) {
    return (
      <Text color={color} dimColor={phase === 'complete'}>
        {PHASE_LABEL[phase]} · {formatGoalBudget(budget)}
      </Text>
    )
  }
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
  variant = 'default',
  visible = true,
  maxTodos,
  wrapWidth,
}: {
  channel: Channel
  /** Fold the whole todo section to its summary header line. */
  collapsed?: boolean
  /** Toggle the fold (click on the header row; shares the hotkey state). */
  onToggle?: () => void
  /** 'panel' = 侧栏 Todo Panel 形态：更紧凑（去外层 padding 与折叠
   *  提示行），计时走共享动画时钟（visible=false 时零订阅）。 */
  variant?: 'default' | 'panel'
  /** 侧栏 visible 契约：非 active Panel 时 false——暂停本地计时，
   *  store（channel.goal/todos）照常更新，重新打开直接读最新值。 */
  visible?: boolean
  /** 覆盖 MAX_TODOS（panel variant 按宿主高度传入）。 */
  maxTodos?: number
  /** panel variant：todo 行按此宽度折行——单条最多 2 行，超出部分截断
   *  加省略号；maxTodos 预算按「行」折算，放不下仍走「…N more」。缺省
   *  （default 形态）不折行，保持单行 truncate 的 chat 页现状。 */
  wrapWidth?: number
}): React.ReactNode {
  const goal = channel.goal
  const allTodos = channel.todos ?? []
  const doneCount = allTodos.filter(todo => todo.status === 'completed').length
  // Completed rows are useful progress while a turn is running, but become
  // stale footer noise once the agent is idle. Keep unfinished work visible;
  // the header count carries the done summary either way.
  // panel 形态不自动隐藏完成行：侧栏折叠头常驻显示 ✓ done/total，用户
  // 「点开」是显式展开动作——idle 时把完成行过滤光就是「明明有 9 个、
  // 点开一条都没有」（完成行以 dim 呈现，进度语义不丢）。default 形态
  // （chat 页底部 chrome）保留原 auto-fold。
  const todos = variant === 'panel'
    ? allTodos
    : channel.working
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
  const goalOpen = goal !== undefined && goal.phase !== 'complete'
  // Panel 形态：计时挂在共享动画时钟上（ClockProvider 单一定时源，
  // 终端失焦自动降频），visible=false 时传 null——零订阅。时钟只负责
  // 驱动重渲染；读数仍按墙钟（Date.now()）算，隐藏期间计时冻结的只是
  // 显示，重新打开立刻显示真实经过时间（mountPolicy=enabled 下面板
  // 保持挂载，startRef 不会重置）。
  const [clockRef] = useAnimationFrame(variant === 'panel' && goalOpen && visible ? 1000 : null)
  React.useEffect(() => {
    // default 形态保留原来的本地 1s 计时（底部 chrome 的既有行为）。
    if (variant === 'panel') return
    // Tick only while the goal is open; a complete goal freezes the last
    // elapsed reading instead of counting past the finish line.
    if (goal === undefined || goal.phase === 'complete') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [goal, variant])
  const elapsed = goal !== undefined && startRef.current !== undefined
    ? formatDuration((variant === 'panel' ? Date.now() : now) - startRef.current.at)
    : undefined

  // All-completed idle snapshot with no goal: nothing left to narrate —
  // the whole panel folds away (historical behavior).
  const anyUnfinished = allTodos.some(todo => todo.status !== 'completed')
  const showTodoSection = allTodos.length > 0 &&
    (channel.working || anyUnfinished || goal !== undefined || variant === 'panel')
  if (goal === undefined && !showTodoSection) return null

  const budget = maxTodos ?? MAX_TODOS
  // 折行形态（panel）：每条 todo 占 1~2 行，预算按「行」折算——放不下
  // 的整条让位给「…N more」，不撑破面板高度（§16.6 盒高恒定）。cap：
  // 折出 >2 行时保留第一行、其余拼回一行截断加省略号（wrapText truncate）。
  // 单行形态（default）：与原 slice 语义逐字节一致。
  const display: Array<{ todo: (typeof todos)[number]; lines: string[] }> = []
  if (wrapWidth !== undefined && wrapWidth > 4) {
    let used = 0
    for (const todo of todos) {
      const wrapped = wrapText(todo.content, wrapWidth, 'wrap').split('\n')
      const lines = wrapped.length <= 2
        ? wrapped
        : [wrapped[0]!, wrapText(wrapped.slice(1).join(''), wrapWidth, 'truncate')!]
      if (display.length > 0 && used + lines.length > budget) break
      display.push({ todo, lines })
      used += lines.length
    }
  } else {
    for (const todo of todos.slice(0, budget)) display.push({ todo, lines: [todo.content] })
  }
  const visibleTodos = display
  const hidden = todos.length - display.length
  // Collapsed preview: the live task when one runs, else the next open row.
  const preview = allTodos.find(todo => todo.status === 'in_progress')
    ?? allTodos.find(todo => todo.status !== 'completed')

  return (
    <Box
      ref={variant === 'panel' ? clockRef : undefined}
      flexDirection="column"
      paddingLeft={variant === 'panel' ? 1 : 2}
      paddingRight={variant === 'panel' ? 1 : 2}
      paddingTop={1}
    >
      {goal !== undefined && (
        <Box flexDirection="column">
          {/* 行盒显式 height={1}：窄屏下与截断文本同行的布局会被量出虚高
              （行内出现幽灵空行，实测窄终端里 🎯 行与折叠头之间多出空行），
              钉死单行高度可消除；本面板各行本就设计为单行（内容均
              truncate）。 */}
          <Box flexDirection="row" width="100%" height={1}>
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
                budget={goal.budget}
                elapsed={elapsed}
              />
            </Box>
          </Box>
          {goal.phase === 'blocked' && goal.blockedReason !== undefined && (
            <Box flexDirection="row" marginTop={1} height={1}>
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
            height={1}
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
              {visibleTodos.map((item, index) => {
                const last = index === visibleTodos.length - 1 && hidden === 0
                return item.lines.map((line, li) => (
                  <Box key={li} flexDirection="row" height={1}>
                    {li === 0 ? (
                      <>
                        <BranchPrefix last={last} />
                        <TodoGlyph status={item.todo.status} />
                      </>
                    ) : (
                      // 折行续行前缀按树形语义分支：'│' 对齐首行树形前缀的
                      // 干（col 0）——仅非末条（├─，下面还有兄弟，树干要继续
                      // 通下去）；末条（└─，树到此为止）续行用 5 格空格，
                      // 不得再挂干。后随格数与首行正文对齐（前缀 3 + glyph 2
                      // = 5 格）。todo 的折行是渲染前 wrapText 预算好的（不像
                      // jobs 由 ink 在列内部折、加不了前缀），逐行手写不会断。
                      <Text dimColor>{last ? '     ' : '\u2502    '}</Text>
                    )}
                    <Text wrap="truncate" dimColor={item.todo.status === 'completed'}>
                      {line}
                    </Text>
                  </Box>
                ))
              })}
              {hidden > 0 && (
                <Box flexDirection="row" height={1}>
                  <BranchPrefix last />
                  <Text dimColor>… {hidden} more</Text>
                </Box>
              )}
              {/* Fold affordance under the list — only while expanded; the
                  collapsed line already IS the folded state. Panel 形态省略：
                  折叠键归侧栏宿主，底部 hint 行已有说明。 */}
              {variant !== 'panel' && (
                <Text dimColor>  {t('goal-todo-fold-hint', { key: primaryComboString('todoFold') })}</Text>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
