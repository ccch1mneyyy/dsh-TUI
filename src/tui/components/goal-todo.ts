/**
 * Goal/todo dock panel for the chat screen (plan §1.2, research §6.2): the
 * imperative port of the React `src/components/GoalTodoPanel.tsx`, which the
 * renderer boundary makes unimportable.
 *
 * Rendering contract over `GoalTodoProjection`:
 * - goal block: `🎯 objective` plus a right-aligned phase badge
 *   (`● active · 1/5 · 47s`); a blocked goal adds its reason on a `│` line.
 * - todo section: a fold header (`▾ ✓ done/total`, `▸` when collapsed) above
 *   at most MAX_TODOS branch-prefixed rows and a `… N more` overflow line;
 *   collapsed folds the section to the header line plus the in-progress (or
 *   next open) task preview.
 * - completed rows show only while the agent is working; idle filters them
 *   out (the header count keeps the summary). No goal and an all-completed
 *   idle list folds the whole panel away (`visible === false`, zero rows).
 *
 * The elapsed clock is component-local, matching the source semantics: the
 * goal id's first appearance starts the wall clock, `complete` freezes the
 * last reading, and a 1s unref'd interval repaints only while a live goal
 * exists. `dispose()` (and any goal-id change or clear, e.g. session
 * replacement) leaves no timer behind. State arrives via
 * `update(GoalTodoProjection)` — the component never touches the Channel,
 * Cordis, or business timers; the fold state is ChatScreen UI-local and
 * arrives via `setCollapsed` (Ctrl/Cmd+Q and the fold-header toggle share
 * it).
 */
import chalk from 'chalk'
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from '../public.js'
import type { GoalTodoProjection } from '../view-model.js'
import type { ChannelGoal, TodoPanelItem } from '../../dsh-adapter/channel.js'
import { formatDuration } from '../../cc/format.js'
import { t } from '../../i18n.js'
import { modLabel } from '../../utils/modifiers.js'
import { getActiveTheme, type Theme } from '../../theme.js'

/** Maximum todo rows shown before the overflow line. */
const MAX_TODOS = 8

/** Elapsed repaint cadence while a live goal is on screen. */
const CLOCK_TICK_MS = 1000

const PHASE_LABEL: Record<ChannelGoal['phase'], string> = {
  active: '● active',
  paused: '⏸ paused',
  blocked: '⛔ blocked',
  complete: '✓ complete',
}

/** Apply one Theme color value (`rgb(r,g,b)` / `#hex` / `ansi:<name>`). */
function paint(color: string, text: string): string {
  if (color.startsWith('#')) return chalk.hex(color)(text)
  const rgb = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/.exec(color)
  if (rgb !== null) return chalk.rgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))(text)
  if (color.startsWith('ansi:')) {
    const named = (chalk as unknown as Record<string, unknown>)[color.slice('ansi:'.length)]
    if (typeof named === 'function') return (named as (value: string) => string)(text)
  }
  return text
}

/** Phase color: active green, paused amber, blocked red, complete dim. */
function phasePainter(phase: ChannelGoal['phase'], theme: Theme): (text: string) => string {
  switch (phase) {
    case 'active':
      return (text) => paint(theme.success, text)
    case 'paused':
      return (text) => paint(theme.warning, text)
    case 'blocked':
      return (text) => paint(theme.error, text)
    default:
      return (text) => chalk.dim(text)
  }
}

/**
 * The panel's own visibility rule (the dock entry predicate and the render
 * early-return share it): a live goal always shows; a bare todo list shows
 * only while it still narrates something — mid-turn, or with unfinished work.
 */
function panelVisible(
  goal: ChannelGoal | undefined,
  allTodos: readonly TodoPanelItem[],
  working: boolean,
): boolean {
  if (goal !== undefined) return true
  if (allTodos.length === 0) return false
  return working || allTodos.some((todo) => todo.status !== 'completed')
}

/** Badge-pinned composition: the objective truncates, the badge never does. */
function goalRow(left: string, badge: string, width: number): string {
  if (width <= 0) return ''
  const badgeWidth = visibleWidth(badge)
  const leftWidth = visibleWidth(left)
  if (leftWidth + badgeWidth + 1 <= width) {
    return left + ' '.repeat(width - leftWidth - badgeWidth) + badge
  }
  if (badgeWidth + 1 >= width) return truncateToWidth(badge, width, '')
  return `${truncateToWidth(left, width - badgeWidth - 1, '')} ${badge}`
}

export class GoalTodoView implements Component {
  private vm: GoalTodoProjection
  private readonly ui: TUI
  private collapsed = false
  /** Goal id the elapsed clock is currently bound to. */
  private clockGoalId: string | undefined
  private goalStartAt: number | undefined
  /** Frozen elapsed reading once the goal completes. */
  private frozenElapsedMs: number | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(ui: TUI, vm: GoalTodoProjection) {
    this.ui = ui
    this.vm = vm
    this.syncClock(vm.goal)
  }

  /** Feed the latest goal/todo projection (the chat tick drives refresh). */
  update(vm: GoalTodoProjection): void {
    this.syncClock(vm.goal)
    this.vm = vm
    this.invalidate()
    this.ui.requestRender()
  }

  /** ChatScreen owns the fold state; the hotkey and the fold-header toggle
   *  share it and arrive here (research §6.2). */
  setCollapsed(collapsed: boolean): void {
    if (this.collapsed === collapsed) return
    this.collapsed = collapsed
    this.invalidate()
    this.ui.requestRender()
  }

  /** Dock visibility predicate: false exactly when render() yields no rows. */
  get visible(): boolean {
    return panelVisible(this.vm.goal, this.vm.todos, this.vm.working)
  }

  invalidate(): void {
    // No cached state — render() derives everything from the projection.
  }

  /** Stop the elapsed clock (session replacement already stopped it via
   *  update(); this covers screen teardown). */
  dispose(): void {
    this.stopClock()
  }

  render(width: number): string[] {
    const contentWidth = width - 4
    if (contentWidth <= 0) return []
    const { goal, working } = this.vm
    const allTodos = this.vm.todos
    if (!panelVisible(goal, allTodos, working)) return []

    const theme = getActiveTheme()
    const dim = (text: string): string => chalk.dim(text)

    // Completed rows are useful progress while a turn runs but stale noise
    // once idle; the fold header's done/total count carries the summary.
    const todos = working
      ? allTodos
      : allTodos.filter((todo) => todo.status !== 'completed')
    const doneCount = allTodos.reduce((count, todo) => count + (todo.status === 'completed' ? 1 : 0), 0)

    const lines: string[] = ['']

    if (goal !== undefined) {
      const elapsed = this.elapsedText()
      const badge = phasePainter(goal.phase, theme)(
        `${PHASE_LABEL[goal.phase]} · ${goal.roundsStarted}/${goal.maxGoalRounds}${elapsed === undefined ? '' : ` · ${elapsed}`}`,
      )
      lines.push(goalRow(`🎯 ${chalk.bold(goal.objective)}`, badge, contentWidth))
      if (goal.phase === 'blocked' && goal.blockedReason !== undefined) {
        lines.push(truncateToWidth(`${dim('│ ')}${paint(theme.error, goal.blockedReason.message)}`, contentWidth, ''))
      }
    }

    // The todo section folds away when nothing is left to narrate (idle,
    // all completed, no goal keeping it up).
    const anyUnfinished = allTodos.some((todo) => todo.status !== 'completed')
    const showTodoSection = allTodos.length > 0 && (working || anyUnfinished || goal !== undefined)
    if (showTodoSection) {
      if (goal !== undefined) lines.push('')
      const header = `${dim(this.collapsed ? '▸' : '▾')} ${dim(`✓ ${doneCount}/${allTodos.length}`)}`
      if (this.collapsed) {
        // Collapsed preview: the live task when one runs, else the next open row.
        const preview = allTodos.find((todo) => todo.status === 'in_progress')
          ?? allTodos.find((todo) => todo.status !== 'completed')
        if (preview === undefined) {
          lines.push(truncateToWidth(header, contentWidth, ''))
        } else {
          const glyph = preview.status === 'in_progress'
            ? paint(theme.suggestion, '● ')
            : dim('○ ')
          const prefix = `${header} ${glyph}`
          lines.push(`${prefix}${truncateToWidth(preview.content, contentWidth - visibleWidth(prefix), '')}`)
        }
      } else {
        lines.push(truncateToWidth(header, contentWidth, ''))
        const visible = todos.slice(0, MAX_TODOS)
        const hidden = todos.length - visible.length
        visible.forEach((todo, index) => {
          const last = index === visible.length - 1 && hidden === 0
          const branch = dim(last ? '└─ ' : '├─ ')
          const glyph = todo.status === 'in_progress'
            ? paint(theme.suggestion, '● ')
            : dim(todo.status === 'completed' ? '✓ ' : '○ ')
          const prefix = branch + glyph
          const content = truncateToWidth(todo.content, contentWidth - visibleWidth(prefix), '')
          lines.push(`${prefix}${todo.status === 'completed' ? dim(content) : content}`)
        })
        if (hidden > 0) lines.push(dim(`└─ … ${hidden} more`))
        lines.push(dim(`  ${t('goal-todo-fold-hint', { mod: modLabel })}`))
      }
    }

    // Source padding: one blank row on top, two columns on the left.
    return lines.map((line) => (line === '' ? '' : `  ${line}`))
  }

  /** Live or frozen elapsed reading for the phase badge. */
  private elapsedText(): string | undefined {
    if (this.clockGoalId === undefined) return undefined
    const elapsed = this.frozenElapsedMs ?? Date.now() - (this.goalStartAt ?? Date.now())
    return formatDuration(Math.max(0, elapsed))
  }

  /**
   * Bind the elapsed clock to the incoming goal: a new goal id restarts the
   * base time, `complete` freezes the last reading and stops the timer, a
   * cleared goal drops every trace — session replacement therefore leaves no
   * stale timer even without dispose().
   */
  private syncClock(goal: ChannelGoal | undefined): void {
    if (goal === undefined) {
      this.clockGoalId = undefined
      this.goalStartAt = undefined
      this.frozenElapsedMs = undefined
      this.stopClock()
      return
    }
    if (goal.id !== this.clockGoalId) {
      this.clockGoalId = goal.id
      this.goalStartAt = Date.now()
      this.frozenElapsedMs = undefined
    }
    if (goal.phase === 'complete') {
      if (this.frozenElapsedMs === undefined) {
        this.frozenElapsedMs = Math.max(0, Date.now() - (this.goalStartAt ?? Date.now()))
      }
      this.stopClock()
      return
    }
    // Live again under the same id (e.g. a resume after a paused reading):
    // drop any frozen reading so the badge counts from the original base,
    // mirroring the source's startRef semantics.
    this.frozenElapsedMs = undefined
    this.startClock()
  }

  private startClock(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      this.invalidate()
      this.ui.requestRender()
    }, CLOCK_TICK_MS)
    this.timer.unref?.()
  }

  private stopClock(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}
