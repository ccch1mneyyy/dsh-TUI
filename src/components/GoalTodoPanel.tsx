import React from 'react'
import { Box, Text, useAnimationFrame } from '../ui.js'
import wrapText, { wrapTextLines } from '../ink/wrap-text.js'
import type { ChannelUi as Channel } from '../adapter/channel/ui-policy.js'
import type { ChannelGoal, TodoPanelItem } from '../dsh-adapter/channel.js'
import { t } from '../i18n.js'
import { primaryComboString } from '../utils/keymap.js'
import { formatGoalBudget, formatGoalBudgetCompact } from '../channel/goal-command.js'
import { useTooltip } from './Tooltip.js'
import type { DOMElement } from '../ink/dom.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { WheelEvent } from '../ink/events/wheel-event.js'

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
      <Text color={color} dimColor={phase === 'complete'} wrap="truncate">
        {PHASE_LABEL[phase]} · {formatGoalBudget(budget)}
      </Text>
    )
  }
  return (
    <Text color={color} dimColor={phase === 'complete'} wrap="truncate">
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

/** 目标首行前缀；display width 运行时算（emoji 宽度随终端数据源变化）。 */
const GOAL_GLYPH = '🎯 '
/** blocked 原因行前缀（与 §16 的树形装饰同宽）。 */
const BLOCKED_BAR = '│ '

/**
 * 面板内容宽：面板宽减去左右 padding 各 1。所有折行/截断都以显示单元
 * 宽（stringWidth）为准，不用 JS 字符串长度。
 */
export function goalPanelContentWidth(width: number): number {
  return Math.max(4, width - 2)
}

/** 目标折行宽：去掉首行 glyph 前缀，再留 1 格余量防 ink 二次折行。 */
export function goalObjectiveWidth(contentWidth: number): number {
  return Math.max(4, contentWidth - stringWidth(GOAL_GLYPH) - 1)
}

/** blocked 原因折行宽：去掉竖线前缀，同样留 1 格余量。 */
export function goalBlockedWidth(contentWidth: number): number {
  return Math.max(4, contentWidth - stringWidth(BLOCKED_BAR) - 1)
}

/** todo 折行：单条最多 2 行，超出部分拼回一行截断加省略号（现状语义）。 */
export function wrapTodoLines(content: string, width: number): string[] {
  const wrapped = wrapTextLines(content, width).map(line => line.text)
  if (wrapped.length <= 2) return wrapped
  return [wrapped[0]!, wrapText(wrapped.slice(1).join(''), width, 'truncate')!]
}

/**
 * panel 形态的逐行模型：拍平成「每行恰好一个终端行」，渲染时只切可视
 * 窗口（D-5：不用 ScrollBox——内容平移会让折叠头的点击命中错位）。
 * 纯函数、无 React：回归直接断言同一份行模型，避免「渲染一套、断言另一套」。
 */
export type GoalPanelRow =
  | { readonly kind: 'objective'; readonly text: string; readonly first: boolean; readonly softWrapContinuation?: number }
  | { readonly kind: 'status' }
  /** blocked 前的空行（与 default 形态的 marginTop 对应）。 */
  | { readonly kind: 'gap' }
  | { readonly kind: 'blocked'; readonly text: string; readonly softWrapContinuation?: number }
  /** ✓ done/total 折叠头（折叠时同一行带预览）。 */
  | { readonly kind: 'header' }
  | {
    readonly kind: 'todo'
    readonly text: string
    readonly status: TodoPanelItem['status']
    readonly first: boolean
    readonly last: boolean
  }

/**
 * panel 形态的行模型：目标/状态/blocked/折叠头/todo 全部拍平成逐行数据。
 * 面板可滚动，因此 todo 不再按高度截断（没有 `…N more`）——所有条目都
 * 进入模型，渲染时只挂载视口内的行。折叠时只保留固定行。
 */
export function buildGoalPanelRows(input: {
  goal: ChannelGoal | undefined
  todos: readonly TodoPanelItem[]
  showTodoSection: boolean
  collapsed: boolean
  contentWidth: number
  todoWidth: number
}): GoalPanelRow[] {
  const { goal, todos, showTodoSection, collapsed, contentWidth, todoWidth } = input
  const rows: GoalPanelRow[] = []
  if (goal !== undefined) {
    const objectiveWidth = goalObjectiveWidth(contentWidth)
    const objectiveLines = wrapTextLines(goal.objective, objectiveWidth)
    objectiveLines.forEach((line, index) => {
      rows.push({
        kind: 'objective', text: line.text, first: index === 0,
        // Signed content-end column is the renderer's copy contract: a
        // negative value restores the separator omitted at an exact fill.
        softWrapContinuation: line.continuation
          ? (line.gap ? -1 : 1) * (stringWidth(GOAL_GLYPH) + stringWidth(objectiveLines[index - 1]!.text))
          : undefined,
      })
    })
    rows.push({ kind: 'status' })
    if (goal.phase === 'blocked' && goal.blockedReason !== undefined) {
      rows.push({ kind: 'gap' })
      const blockedLines = wrapTextLines(goal.blockedReason.message, goalBlockedWidth(contentWidth))
      blockedLines.forEach((line, index) => {
        rows.push({
          kind: 'blocked', text: line.text,
          softWrapContinuation: line.continuation
            ? (line.gap ? -1 : 1) * (stringWidth(BLOCKED_BAR) + stringWidth(blockedLines[index - 1]!.text))
            : undefined,
        })
      })
    }
  }
  if (showTodoSection) rows.push({ kind: 'header' })
  if (!showTodoSection || collapsed) return rows

  // 全部 todo 进入模型（D-9 修订：可滚动后不再用 `…N more` 隐藏条目）。
  // 视口只挂载 slice 出来的行，列表再长也不会撑破盒高。
  todos.forEach((todo, index) => {
    const last = index === todos.length - 1
    wrapTodoLines(todo.content, todoWidth).forEach((text, lineIndex) => {
      rows.push({
        kind: 'todo',
        text,
        status: todo.status,
        first: lineIndex === 0,
        last,
      })
    })
  })
  return rows
}

/** panel 视口行数：height 含顶部 padding（height>1 时占 1 行；缺省不窗口化）。 */
export function goalPanelViewportRows(height: number | undefined): number {
  return height === undefined ? Number.POSITIVE_INFINITY : Math.max(1, height - (height > 1 ? 1 : 0))
}

/** panel 形态的滚动句柄：adapter 只把键交进来，不复制折行/窗口。 */
export interface GoalTodoPanelScrollHandle {
  scrollBy(delta: number): void
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
  idleDismissal = false,
  variant = 'default',
  visible = true,
  wrapWidth,
  width,
  height,
  scrollRef,
}: {
  channel: Channel
  /** Fold the whole todo section to its summary header line. */
  collapsed?: boolean
  /** Toggle the fold (click on the header row; shares the hotkey state). */
  onToggle?: () => void
  /** The host uses the idle toggle to dismiss this footer instead of folding. */
  idleDismissal?: boolean
  /** 'panel' = 侧栏 Todo Panel 形态：更紧凑（去外层 padding 与折叠
   *  提示行），计时走共享动画时钟（visible=false 时零订阅）。 */
  variant?: 'default' | 'panel'
  /** 侧栏 visible 契约：非 active Panel 时 false——暂停本地计时，
   *  store（channel.goal/todos）照常更新，重新打开直接读最新值。 */
  visible?: boolean
  /** panel variant：todo 行按此宽度折行——单条最多 2 行，超出部分截断
   *  加省略号；全部条目都进入行模型，靠滚动查看。缺省（default 形态）
   *  不折行，保持单行 truncate 的 chat 页现状。 */
  wrapWidth?: number
  /** panel variant：面板宽（含左右 padding）。缺省时按 wrapWidth 反推。 */
  width?: number
  /** panel variant：面板高（含顶部 padding）。缺省时不窗口化（直接挂载）。 */
  height?: number
  /** panel variant：滚动句柄（adapter 的 ↑/↓ 与滚轮走这里）。 */
  scrollRef?: React.Ref<GoalTodoPanelScrollHandle>
}): React.ReactNode {
  const goal = channel.goal
  const objectiveRef = React.useRef<DOMElement | null>(null)
  const goalTooltip = useTooltip(() => {
    // panel 形态目标完整可见、滚动就是全文入口——不挂 hover 全文（D-7）；
    // default 形态（chat 页底部 chrome）的 tooltip 原样保留。
    if (variant === 'panel') return ''
    const width = objectiveRef.current?.yogaNode?.getComputedWidth() ?? 0
    if (goal === undefined || width <= 0) return ''
    return stringWidth(goal.objective) > width || goal.objective.includes('\n')
      ? goal.objective
      : ''
  })
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

  // ── panel 几何 / 滚动（default 形态不读这些值） ─────────────────────────
  // 宽度、折行与视口全部按显示单元计；直接挂载（缺省 width/height）时退化
  // 为不窗口化，行为与旧面板一致，夹具可以直接断言行模型。
  const [scrollTop, setScrollTop] = React.useState(0)
  const panelWidth = width ?? (wrapWidth !== undefined ? wrapWidth + 8 : 80)
  const contentWidth = goalPanelContentWidth(panelWidth)
  const todoWidth = wrapWidth !== undefined && wrapWidth > 4 ? wrapWidth : Math.max(10, panelWidth - 8)
  const viewportRows = goalPanelViewportRows(height)
  const panelRows = variant === 'panel'
    ? buildGoalPanelRows({ goal, todos, showTodoSection, collapsed, contentWidth, todoWidth })
    : undefined
  const maxScroll = panelRows === undefined
    ? 0
    : Math.max(0, panelRows.length - viewportRows)
  // 渲染永远用 clamp 后的 top：state 短暂超过 maxScroll 也不会画出空白。
  const top = Math.min(scrollTop, maxScroll)
  const scrollBy = React.useCallback((delta: number) => {
    // 折叠头可能被滚出视口，onMouseLeave 不再触发——这里主动清 hover 底色。
    setHeaderHovered(false)
    setScrollTop(current => Math.max(0, Math.min(maxScroll, current + delta)))
  }, [maxScroll])
  React.useImperativeHandle(scrollRef, () => ({ scrollBy }), [scrollBy])
  // 切换会话或 goal 复位；同 id 的 revision 更新保留滚动位置。
  React.useEffect(() => {
    setScrollTop(0)
    setHeaderHovered(false)
  }, [channel.sessionId, goal?.id])
  // 内容变短 / 折叠 / resize：只收敛 offset，不强制归零。
  React.useEffect(() => {
    setScrollTop(current => Math.min(current, maxScroll))
  }, [maxScroll])

  if (goal === undefined && !showTodoSection) return null

  // Collapsed preview: the live task when one runs, else the next open row.
  const preview = allTodos.find(todo => todo.status === 'in_progress')
    ?? allTodos.find(todo => todo.status !== 'completed')
  // 折叠头两种形态共用同一份结构/行为（点击、hover、▸/▾、✓ done/total、
  // 折叠预览），避免面板形态与 chat 页形态漂移。
  const foldHeader = (key?: React.Key): React.ReactNode => (
    <Box
      key={key}
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
  )

  if (variant === 'panel' && panelRows !== undefined) {
    const objectiveIndent = ' '.repeat(stringWidth(GOAL_GLYPH))
    return (
      <Box
        ref={clockRef}
        flexDirection="column"
        width={width}
        height={height}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={height !== undefined && height > 1 ? 1 : 0}
        overflow="hidden"
        onWheel={(event: WheelEvent) => {
          if (event.deltaY !== 0) scrollBy(event.deltaY > 0 ? 1 : -1)
        }}
      >
        {panelRows.slice(top, top + viewportRows).map((row, index) => {
          switch (row.kind) {
            case 'objective':
              // 折行是渲染前预算好的（wrapTextLines），每行显式 height={1}；
              // 续行用等宽空格对齐首行正文。前提是终端与 stringWidth 对 🎯 的
              // 宽度取法一致：终端把它记成 1 格时，首行正文会比续行左移一格
              // （宽度表差异，面板侧无法同时对齐两种终端）。
              return (
                <Box key={index} flexDirection="row" height={1} softWrapContinuation={row.softWrapContinuation}>
                  {/* Include the panel's left padding in the exclusion without
                      reaching into the sibling chat pane. Glyphs stay put. */}
                  <Box noSelect marginLeft={-1} paddingLeft={1}>
                    <Text color="suggestion">{row.first ? GOAL_GLYPH : objectiveIndent}</Text>
                  </Box>
                  <Text bold wrap="truncate">{row.text}</Text>
                </Box>
              )
            case 'status':
              // 状态独占一行，不再和目标争宽（窄面板下 truncate 兜底）。
              return (
                <Box key={index} flexDirection="row" height={1}>
                  <PhaseBadge
                    phase={goal!.phase}
                    roundsStarted={goal!.roundsStarted}
                    maxGoalRounds={goal!.maxGoalRounds}
                    budget={goal!.budget}
                    elapsed={elapsed}
                  />
                </Box>
              )
            case 'gap':
              return <Box key={index} height={1} />
            case 'blocked':
              return (
                <Box key={index} flexDirection="row" height={1} softWrapContinuation={row.softWrapContinuation}>
                  <Box noSelect marginLeft={-1} paddingLeft={1}>
                    <Text dimColor>{BLOCKED_BAR}</Text>
                  </Box>
                  <Text color="error" wrap="truncate">{row.text}</Text>
                </Box>
              )
            case 'header':
              return foldHeader(index)
            case 'todo':
              return (
                <Box key={index} flexDirection="row" height={1}>
                  {row.first ? (
                    <>
                      <BranchPrefix last={row.last} />
                      <TodoGlyph status={row.status} />
                    </>
                  ) : (
                    // 续行前缀语义与 default 形态一致：非末条继续画干，末条
                    // 用 5 格空格（前缀 3 + glyph 2）与正文对齐。
                    <Text dimColor>{row.last ? '     ' : '\u2502    '}</Text>
                  )}
                  <Text wrap="truncate" dimColor={row.status === 'completed'}>
                    {row.text}
                  </Text>
                </Box>
              )
          }
        })}
      </Box>
    )
  }

  // ── default 形态的行预算（panel 形态渲染全部 todo，不走这段） ──
  const budget = MAX_TODOS
  // 折行形态（宿主传 wrapWidth 时）：每条 todo 占 1~2 行，预算按「行」
  // 折算——放不下的整条让位给「…N more」，不撑破盒高。cap：折出 >2 行时
  // 保留第一行、其余拼回一行截断加省略号（wrapText truncate）。
  // 单行形态（chat 页现状）：与原 slice 语义逐字节一致。
  const display: Array<{ todo: (typeof todos)[number]; lines: string[] }> = []
  if (wrapWidth !== undefined && wrapWidth > 4) {
    let used = 0
    for (const todo of todos) {
      const lines = wrapTodoLines(todo.content, wrapWidth)
      if (display.length > 0 && used + lines.length > budget) break
      display.push({ todo, lines })
      used += lines.length
    }
  } else {
    for (const todo of todos.slice(0, budget)) display.push({ todo, lines: [todo.content] })
  }
  const visibleTodos = display
  const hidden = todos.length - display.length

  return (
    <Box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      {goal !== undefined && (
        <Box flexDirection="column">
          {/* 行盒显式 height={1}：窄屏下与截断文本同行的布局会被量出虚高
              （行内出现幽灵空行，实测窄终端里 🎯 行与折叠头之间多出空行），
              钉死单行高度可消除；本面板各行本就设计为单行（内容均
              truncate）。 */}
          <Box flexDirection="row" width="100%" height={1}>
            <Text color="suggestion">{GOAL_GLYPH}</Text>
            <Box ref={objectiveRef} flexGrow={1} flexShrink={1} {...goalTooltip}>
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
              <Text dimColor>{BLOCKED_BAR}</Text>
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
          {foldHeader()}
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
                  collapsed line already IS the folded state. The panel variant
                  renders its own rows and omits this hint (the sidebar's bottom
                  hint row documents the fold keys). */}
              <Text dimColor>  {t(idleDismissal && !channel.working ? 'goal-todo-hide-hint' : 'goal-todo-fold-hint', { key: primaryComboString('todoFold') })}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
