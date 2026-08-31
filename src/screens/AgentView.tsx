import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { SearchBox } from '../components/SearchBox.js'
import { SessionPreview } from '../components/sessions/SessionPreview.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { useAnimationFrame } from '../ink/hooks/use-animation-frame.js'
import { isMod, isPlainReturn } from '../utils/modifiers.js'
import { formatProject, formatWhen, spreadRow, tailWidth, truncateWidth } from '../sessions/format.js'
import { stringWidth } from '../ink/stringWidth.js'
import { t } from '../i18n.js'
import type { Channel } from '../dsh-adapter/channel.js'
import type { AgentViewRow, AgentViewStatus } from '../dsh-adapter/channel.js'
import type { PreviewEntry, SessionSummary } from '../dsh-adapter/sessions/index.js'
import type { ApprovalSnapshot } from '../dsh-adapter/approvals.js'
import { ApprovalPanel } from '../components/approvals/ApprovalPanel.js'
import { SpinnerGlyph } from '../components/Spinner/SpinnerGlyph.js'

/**
 * The agent view (CC's `claude agents`, dsh-tui edition): one screen for
 * every session in this process — the attached conversation, the background
 * sessions dispatched here, and the stopped sessions persisted on disk.
 * Rows are grouped by state (needs input first), each carrying a one-line
 * activity summary derived from the session's own output; the input at the
 * bottom dispatches new background sessions.
 *
 * Lifecycle honesty: background sessions live inside this TUI's process, so
 * they stop when the TUI exits — their logs survive and `/resume` (or the
 * view's Enter) brings them back. There is no supervisor process (v1).
 */

/** What the screen is doing with the focused row. */
type AgentViewMode = 'list' | 'rename' | 'confirm-stop'

/** Rows the layout cannot do without: header, model/cwd line, dispatch
 *  input, hints. */
const MANDATORY_LINES = 4
/** Terminal width below which the peek panel replaces the list. */
const SPLIT_MIN_COLUMNS = 100
/** How long the second Ctrl+X stays armed as "delete" (CC parity). */
const STOP_DELETE_WINDOW_MS = 2000

/** State presentation: the glyph and theme color per status. */
const STATUS_PRESENTATION: Readonly<Record<AgentViewStatus, { glyph: string; color?: 'warning' | 'suggestion' | 'success' | 'error' }>> = {
  'needs-input': { glyph: '✻', color: 'warning' },
  working: { glyph: '✽', color: 'suggestion' },
  completed: { glyph: '✓', color: 'success' },
  failed: { glyph: '✕', color: 'error' },
  idle: { glyph: '∙' },
  stopped: { glyph: '∙' },
}

/** The group order, from most to least urgent. */
const STATUS_ORDER: readonly AgentViewStatus[] = [
  'needs-input', 'working', 'failed', 'completed', 'idle', 'stopped',
]

/** The state group header, resolved through `t` at render time so a
 *  `/lang` switch repaints it immediately. */
function statusLabel(status: AgentViewStatus): string {
  switch (status) {
    case 'needs-input': return t('agentview-state-needs-input')
    case 'working': return t('agentview-state-working')
    case 'completed': return t('agentview-state-completed')
    case 'failed': return t('agentview-state-failed')
    case 'idle': return t('agentview-state-idle')
    case 'stopped': return t('agentview-state-stopped')
  }
}

/** A thrown value's message, for a notification that has to say something. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Rendered width of a hint: `HintLine` strips the `**` emphasis markers. */
function hintWidth(text: string): number {
  return stringWidth(text.replace(/\*\*/gu, ''))
}

/** The widest hint that fits, cut only when even the shortest will not. */
function fitHint(candidates: readonly string[], budget: number): string {
  for (const candidate of candidates) {
    if (hintWidth(candidate) <= budget) return candidate
  }
  return truncateWidth((candidates[candidates.length - 1] ?? '').replace(/\*\*/gu, ''), budget)
}

/** A minimal SessionSummary-shaped adapter so SessionPreview renders a row. */
function summaryForRow(row: AgentViewRow): SessionSummary {
  return {
    id: row.id,
    kind: { kind: 'root' },
    title: { text: row.title, source: 'fallback' },
    cwd: row.cwd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    bytes: undefined,
    hasPrompt: true,
    agentPreset: undefined,
    model: undefined,
    label: row.summary,
    branch: undefined,
    childCount: 0,
  }
}

/**
 * One row line: a state glyph (ANIMATED spinner for working sessions, CC's
 * `·✢*✶✻✽` cycle), a SHORT name, then the session's reply/activity
 * compressed to ONE line at the right of the name, and the age at the far
 * right. The fold already flattens whitespace, so a multi-paragraph reply
 * can never wrap the row; a summary that merely repeats the name (an
 * untitled session whose activity is still its own prompt) is hidden
 * instead of shown twice.
 */
function AgentViewRowLine({
  row,
  width,
  focused,
  now,
  spinnerFrame,
  spinnerTime,
}: {
  row: AgentViewRow
  width: number
  focused: boolean
  now: number
  /** Shared animation clock: the working glyph's frame (0 when idle). */
  spinnerFrame: number
  spinnerTime: number
}): React.ReactNode {
  const presentation = STATUS_PRESENTATION[row.status]
  // CC parity: the attached session with no title shows as "current
  // session", and a session that never did anything shows
  // "send a prompt to start" instead of a dash.
  const untitled = row.title === 'untitled'
  const title = untitled
    ? row.current ? t('agentview-current-session') : t('agentview-untitled')
    : row.title
  const marker = row.current && !untitled ? ` ${t('agentview-current-marker')}` : ''
  // The name column stays compact: a recorded title may be a long generated
  // sentence, and the row's job is to identify the session, not to quote it.
  const name = truncateWidth(title, Math.max(6, Math.min(28, Math.floor(width * 0.3))))
  const nameWidth = stringWidth(name) + stringWidth(marker)
  // The glyph column is two cells for every state (static glyph + space,
  // spinner glyph + its box padding), so the arithmetic is state-free.
  const leftWidth = 2 + nameWidth
  const right = formatWhen(row.updatedAt, now)
  const rightWidth = stringWidth(right)
  const summarySource =
    row.summary.length === 0
      ? (row.current || row.title === 'untitled') ? t('agentview-summary-empty') : ''
      : row.summary === row.title ? '' : row.summary
  const summaryBudget = Math.max(0, width - leftWidth - rightWidth - 3)
  const summary = summarySource.length > 0 && summaryBudget >= 8
    ? truncateWidth(summarySource, summaryBudget)
    : ''
  const gap = Math.max(1, width - leftWidth - stringWidth(summary) - rightWidth - 2)
  return (
    <Box flexDirection="row" backgroundColor={focused ? 'userMessageBackgroundHover' : undefined}>
      {row.status === 'working' ? (
        <SpinnerGlyph frame={spinnerFrame} messageColor="suggestion" reducedMotion={false} time={spinnerTime} />
      ) : (
        <Text color={presentation.color}>{`${presentation.glyph} `}</Text>
      )}
      <Text color={presentation.color} bold={focused}>
        {`${name}${marker}`}
      </Text>
      <Text dimColor>{`${' '.repeat(gap)}${summary}`}</Text>
      <Text dimColor>{` ${right}`}</Text>
    </Box>
  )
}

/**
 * The agent view screen — `/agentview`, `/bg`. Replaces the conversation
 * like the session browser does; every session keeps running behind it.
 */
export function AgentView({
  channel,
  home,
  approval,
  onApprove,
  returnSessionId,
  onClose,
}: {
  channel: Channel
  /** Home directory, for collapsing project paths to `~`. */
  home: string
  /** The parked approval ask (any agent's), so a background session's
   *  permission prompt is answerable without leaving the view. */
  approval: ApprovalSnapshot | null
  onApprove: (outcome: 'allowed-once' | 'rejected') => void
  /** Set when the view was opened by backgrounding the attached session
   *  (← / `/bg`): the view shows CC's "conversation moved to the
   *  background" notice and the final Esc RETURNS to that conversation
   *  instead of merely closing. */
  returnSessionId?: string
  onClose: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const isTerminalFocused = useTerminalFocus()

  const getRows = React.useCallback(() => channel.agentViewRows(), [channel])
  const subscribe = React.useCallback(
    (listener: () => void) => channel.subscribeAgentView(listener),
    [channel],
  )
  const agentRows = React.useSyncExternalStore(subscribe, getRows)

  const [focusId, setFocusId] = React.useState<string | undefined>(undefined)
  const [mode, setMode] = React.useState<AgentViewMode>('list')
  const [renameText, setRenameText] = React.useState('')
  const [dispatchText, setDispatchText] = React.useState('')
  const [notice, setNotice] = React.useState<{ text: string; tone: 'error' | 'info' } | undefined>()
  const [helpOpen, setHelpOpen] = React.useState(false)
  const [peekOpen, setPeekOpen] = React.useState(false)
  const [peek, setPeek] = React.useState<readonly PreviewEntry[]>([])
  const [peekLoading, setPeekLoading] = React.useState(false)
  const [replyText, setReplyText] = React.useState('')
  const [now, setNow] = React.useState(Date.now())
  // React batches every parsed key from one stdin chunk. Lock actions in a
  // ref so a repeated Enter cannot start the same async operation twice.
  const actionPendingRef = React.useRef(false)
  /**
   * The delete arm: which session was just stopped and until when the second
   * Ctrl+X still counts as "delete it". Bound to the STOPPED session's id —
   * never to the focused row — because stopping re-sorts the list and the
   * focus coordinate can land on a different row before the confirm lands.
   */
  const stopArmRef = React.useRef<{ id: string; deadline: number } | null>(null)

  // One clock per render pass: every relative time on screen must agree.
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // CC parity: working rows animate their glyph (the `·✢*✶✻✽` cycle). The
  // shared clock only runs while at least one row is working and pauses
  // otherwise, so an idle view costs no extra ticks.
  const workingCount = agentRows.filter(row => row.status === 'working').length
  const [, spinnerTime] = useAnimationFrame(workingCount > 0 ? 120 : null)
  const spinnerFrame = Math.floor(spinnerTime / 120)

  // The delete arm expires after its window without an explicit keystroke;
  // any other way out of confirm-stop clears the arm at the exit site.
  React.useEffect(() => {
    if (mode !== 'confirm-stop') return
    const arm = stopArmRef.current
    const remaining = (arm?.deadline ?? 0) - Date.now()
    const timer = setTimeout(() => {
      stopArmRef.current = null
      setMode('list')
    }, Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [mode])

  /**
   * Say something, on screen and in the transcript — both, like the session
   * browser: the line below the list is what the user reads now, the
   * transcript entry is what remains after they leave.
   */
  const report = React.useCallback(
    (text: string, tone: 'error' | 'info'): void => {
      setNotice({ text, tone })
      channel.notify(text, tone === 'error' ? { color: 'error' } : {})
    },
    [channel],
  )

  // Group rows by state in the canonical order; the flat id list is the
  // focus coordinate (a session id survives re-sorts, an index does not).
  const groups = React.useMemo(() => {
    const byStatus = new Map<AgentViewStatus, AgentViewRow[]>()
    for (const row of agentRows) {
      const bucket = byStatus.get(row.status) ?? []
      bucket.push(row)
      byStatus.set(row.status, bucket)
    }
    return STATUS_ORDER
      .filter(status => byStatus.has(status))
      .map(status => ({ status, rows: byStatus.get(status) as AgentViewRow[] }))
  }, [agentRows])
  const flatIds = React.useMemo(
    () => groups.flatMap(group => group.rows.map(row => row.id)),
    [groups],
  )
  const focusIndex = React.useMemo(() => {
    const found = flatIds.indexOf(focusId ?? '')
    return found >= 0 ? found : 0
  }, [flatIds, focusId])
  const focused = flatIds.length > 0 ? agentRows.find(row => row.id === flatIds[focusIndex]) : undefined

  // Preview follows the cursor. Keyed on the id so arrowing past a row does
  // not refetch the one it came from, and guarded on unmount so a slow read
  // landing after the cursor moved cannot overwrite a newer preview.
  React.useEffect(() => {
    if (!peekOpen || focused === undefined) return
    let live = true
    setPeekLoading(true)
    void channel
      .peekAgentSession(focused.id)
      .then(entries => (live ? entries : undefined))
      .catch(() => (live ? [] : undefined))
      .then((entries) => {
        if (entries === undefined) return
        setPeek(entries)
        setPeekLoading(false)
      })
    return () => {
      live = false
    }
  }, [channel, peekOpen, focused?.id])

  const step = (by: 1 | -1, times = 1): void => {
    if (flatIds.length === 0) return
    const next = Math.min(flatIds.length - 1, Math.max(0, focusIndex + by * times))
    setFocusId(flatIds[next])
  }

  const runAction = (action: () => Promise<void>): void => {
    if (actionPendingRef.current) return
    actionPendingRef.current = true
    void action().finally(() => {
      actionPendingRef.current = false
    })
  }

  /** Dispatch the input as a new background session; optionally attach. */
  const dispatch = (attach: boolean): void => {
    const text = dispatchText.trim()
    if (text.length === 0) return
    runAction(async () => {
      const result = await channel.dispatchBackgroundAgent(text)
      if (!result.ok) return
      setDispatchText('')
      report(t('agentview-dispatch-done'), 'info')
      if (attach) {
        const attached = await channel.attachToAgent(result.sessionId)
        if (attached.ok) {
          report(t('agentview-attached'), 'info')
          onClose()
        } else if (attached.reason !== 'cancelled') {
          const reason = attached.reason === 'failed' ? attached.error : t('agentview-attach-failed', { err: attached.reason })
          report(t('agentview-attach-failed', { err: reason }), 'error')
        }
      }
    })
  }

  const attach = (target: AgentViewRow): void => {
    runAction(async () => {
      const result = await channel.attachToAgent(target.id)
      if (result.ok) {
        report(t('agentview-attached'), 'info')
        onClose()
      } else if (result.reason !== 'cancelled') {
        const reason = result.reason === 'failed' ? result.error : result.reason
        report(t('agentview-attach-failed', { err: reason }), 'error')
      }
    })
  }

  const stop = (target: AgentViewRow): void => {
    if (target.current) {
      report(t('agentview-stop-failed'), 'error')
      return
    }
    runAction(async () => {
      const stopped = await channel.stopBackgroundAgent(target.id)
      if (stopped) {
        stopArmRef.current = { id: target.id, deadline: Date.now() + STOP_DELETE_WINDOW_MS }
        setMode('confirm-stop')
        report(t('agentview-stopped'), 'info')
      } else {
        report(t('agentview-stop-failed'), 'error')
      }
    })
  }

  const remove = (target: AgentViewRow): void => {
    setMode('list')
    runAction(async () => {
      try {
        const deleted = await channel.deleteSession(target.id)
        report(deleted ? t('agentview-deleted', { name: target.title }) : t('agentview-delete-failed', { name: target.title }), deleted ? 'info' : 'error')
      } catch (error) {
        report(t('agentview-delete-failed', { name: target.title }) + ` · ${message(error)}`, 'error')
      }
    })
  }

  const sendReply = (target: AgentViewRow): void => {
    const text = replyText.trim()
    if (text.length === 0) return
    runAction(async () => {
      try {
        const sent = await channel.replyToAgent(target.id, text)
        if (sent) {
          setReplyText('')
          report(t('agentview-reply-sent'), 'info')
        }
      } catch (error) {
        report(t('agentview-reply-failed', { err: message(error) }), 'error')
      }
    })
  }

  useInput((input, key) => {
    if (helpOpen) {
      if (key.escape || input === '?') setHelpOpen(false)
      return
    }
    // The parked approval panel owns the keyboard while it is up (its own
    // useInput answers the ask; Enter/Esc must not attach or exit here).
    if (approval !== null && mode === 'list') return
    if (actionPendingRef.current) return
    if (notice !== undefined) setNotice(undefined)
    if (mode === 'confirm-stop') {
      // The arm names the session that was stopped — NOT the focused row.
      // Only a second Ctrl+X deletes it; any other key (Enter included)
      // cancels, exactly as the confirm hint promises. The previous code
      // deleted `focused` on a plain Enter, and focus shifts when the
      // stopped row re-sorts — that is what ate a user's main session.
      const arm = stopArmRef.current
      if (arm !== null && key.ctrl && input === 'x' && Date.now() <= arm.deadline) {
        const target = agentRows.find(row => row.id === arm.id)
        stopArmRef.current = null
        if (target !== undefined) remove(target)
        else setMode('list')
      } else {
        stopArmRef.current = null
        setMode('list')
      }
      return
    }
    if (mode === 'rename') {
      if (isPlainReturn(key)) {
        setMode('list')
        const title = renameText.trim()
        if (focused !== undefined && title.length > 0) {
          runAction(async () => {
            try {
              const renamed = await channel.renameSessionTo(focused.id, title)
              report(renamed ? t('agentview-renamed', { title }) : t('agentview-rename-failed'), renamed ? 'info' : 'error')
            } catch (error) {
              report(`${t('agentview-rename-failed')} · ${message(error)}`, 'error')
            }
          })
        }
      } else if (key.escape) {
        setMode('list')
      } else if (key.backspace || key.delete) {
        setRenameText(text => text.slice(0, -1))
      } else if (!isMod(key) && !key.meta && input) {
        setRenameText(text => text + input.replace(/[\r\n]+/g, ' '))
      }
      return
    }

    if (peekOpen) {
      // The peek panel owns typing: arrows move rows, Enter sends the reply.
      if (key.upArrow) {
        step(-1)
      } else if (key.downArrow) {
        step(1)
      } else if (key.pageUp || key.pageDown) {
        step(key.pageDown ? 1 : -1, 3)
      } else if (isPlainReturn(key)) {
        if (focused !== undefined) sendReply(focused)
      } else if (key.escape || (input === ' ' && replyText.length === 0)) {
        setPeekOpen(false)
        setReplyText('')
      } else if (key.backspace || key.delete) {
        setReplyText(text => text.slice(0, -1))
      } else if (!isMod(key) && !key.meta && !key.super && input && !key.return) {
        const typed = input.replace(/\p{Cc}/gu, '')
        if (typed.length > 0) setReplyText(text => text + typed)
      }
      return
    }

    if (key.upArrow) {
      step(-1)
    } else if (key.downArrow) {
      step(1)
    } else if (key.wheelUp) {
      step(-1)
    } else if (key.wheelDown) {
      step(1)
    } else if (key.pageUp || key.pageDown) {
      step(key.pageDown ? 1 : -1, Math.max(1, Math.floor(listHeight / 2)))
    } else if (isPlainReturn(key) && !key.shift) {
      if (dispatchText.trim().length > 0) dispatch(false)
      else if (focused !== undefined) attach(focused)
    } else if (isPlainReturn(key) && key.shift) {
      if (dispatchText.trim().length > 0) dispatch(true)
      else if (focused !== undefined) attach(focused)
    } else if (key.rightArrow) {
      if (focused !== undefined) attach(focused)
    } else if (input === ' ' && dispatchText.length === 0) {
      // Space opens the peek panel for the focused row; with text in the
      // input it types a space (CC parity).
      setPeekOpen(true)
    } else if (key.ctrl && input === 'x') {
      if (focused !== undefined) stop(focused)
    } else if (key.ctrl && input === 'r' && focused !== undefined) {
      setRenameText(focused.title)
      setMode('rename')
    } else if (key.ctrl && input === 'c') {
      // CC parity: Ctrl+C clears the dispatch input, twice exits.
      if (dispatchText.length > 0) setDispatchText('')
      else onClose()
    } else if (input === '?') {
      setHelpOpen(true)
    } else if (key.escape) {
      if (dispatchText.length > 0) setDispatchText('')
      else if (returnSessionId !== undefined) {
        // CC parity: the final Esc returns to the conversation that was
        // backgrounded (the view's return target), not just closes.
        runAction(async () => {
          await channel.attachToAgent(returnSessionId)
          onClose()
        })
      } else {
        onClose()
      }
    } else if (key.backspace || key.delete) {
      setDispatchText(text => text.slice(0, -1))
    } else if (!isMod(key) && !key.meta && !key.super && input && !key.return) {
      const typed = input.replace(/\p{Cc}/gu, '')
      if (typed.length > 0) setDispatchText(text => text + typed)
    }
  })

  // ── layout ────────────────────────────────────────────────────────────────
  const approvalVisible = approval !== null && mode === 'list'
  const approvalLines = approvalVisible ? 7 : 0
  const returnLines = returnSessionId !== undefined ? 1 : 0
  const extraLines = (mode === 'list' ? 0 : 1) + (notice === undefined ? 0 : 1) + approvalLines + returnLines
  const ruleBudget = Math.max(0, Math.min(2, rows - MANDATORY_LINES - extraLines))
  const listHeight = Math.max(0, rows - MANDATORY_LINES - extraLines - ruleBudget)

  const splitPreview = peekOpen && columns >= SPLIT_MIN_COLUMNS
  const soloPreview = peekOpen && columns < SPLIT_MIN_COLUMNS
  const previewWidth = splitPreview ? Math.min(56, Math.floor(columns * 0.42)) : columns
  const listWidth = Math.max(20, columns - (splitPreview ? previewWidth : 0))

  // CC-style header: title line, then "model · cwd", then the state counts.
  const counts = [t('agentview-count-awaited', { n: agentRows.filter(row => row.status === 'needs-input').length })]
  counts.push(t('agentview-count-working', { n: agentRows.filter(row => row.status === 'working').length }))
  counts.push(t('agentview-count-completed', { n: agentRows.filter(row => row.status === 'completed').length }))
  const failed = agentRows.filter(row => row.status === 'failed').length
  if (failed > 0) counts.push(t('agentview-count-failed', { n: failed }))
  const heading = ` ${t('agentview-title')}`
  const header = spreadRow(heading, counts.join(' · '), Math.max(0, columns - 1))
  const subtitle = `${channel.model} · ${formatProject(channel.cwd, home)}`
  const inputBudget = Math.max(0, columns - 2)
  // The confirm hint names the session the arm actually targets — which can
  // differ from the focused row once the stopped row re-sorts.
  const armedId = stopArmRef.current?.id
  const armedTarget = armedId === undefined
    ? undefined
    : agentRows.find(row => row.id === armedId)
  const hint =
    mode === 'confirm-stop' && armedTarget !== undefined
      ? fitHint([t('agentview-stop-confirm', { name: armedTarget.title })], inputBudget)
      : mode === 'rename'
        ? fitHint([t('agentview-hint-rename')], inputBudget)
        : fitHint([t('agentview-hint-list')], inputBudget)

  // The help overlay replaces the whole screen while open.
  if (helpOpen) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexShrink={0}>
          <Text color="remember" bold>{` ${t('agentview-help-title')}`}</Text>
        </Box>
        <Divider width={columns} />
        <Box flexGrow={1} flexShrink={1}>
          {t('agentview-help').split('\n').map((line, index) => (
            <Text key={index} dimColor>{` ${line}`}</Text>
          ))}
        </Box>
        <Divider width={columns} />
        <Box flexShrink={0}>
          <Text dimColor italic><HintLine text={t('agentview-hint-help')} /></Text>
        </Box>
      </Box>
    )
  }

  // Visible slice of the grouped rows.
  const windowStart = Math.max(0, Math.min(focusIndex, Math.max(0, flatIds.length - listHeight)))
  const windowEnd = Math.min(flatIds.length, windowStart + listHeight)
  const returnNotice = returnSessionId !== undefined

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexShrink={0}>
        <Text color="remember" bold>{header.left}</Text>
        <Text dimColor>{`${' '.repeat(header.gap)}${header.right}`}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>{truncateWidth(` ${subtitle}`, Math.max(0, columns - 2))}</Text>
      </Box>
      {returnNotice && (
        <Box flexShrink={0}>
          <Text dimColor>
            {truncateWidth(t('agentview-bg-notice'), Math.max(0, columns - 2))}
          </Text>
        </Box>
      )}
      {ruleBudget > 0 && (<Box flexShrink={0}>
        <Divider width={columns} />
      </Box>)}

      {approvalVisible && (
        <Box flexShrink={0} flexDirection="column" height={approvalLines}>
          <ApprovalPanel
            approval={approval}
            background={approval.agentId !== channel.agentId}
            onDecide={onApprove}
          />
        </Box>
      )}

      <Box flexGrow={1} flexShrink={1}>
        {!soloPreview && (
          <Box flexDirection="column" width={listWidth} height={listHeight} flexShrink={0}>
            {agentRows.length === 0 && (
              <Text dimColor italic>{` ${truncateWidth(t('agentview-none'), listWidth - 2)}`}</Text>
            )}
            {groups.map((group) => {
              const groupStart = groups
                .slice(0, groups.indexOf(group))
                .reduce((total, g) => total + g.rows.length, 0)
              const groupEnd = groupStart + group.rows.length
              if (groupEnd <= windowStart || groupStart >= windowEnd) return null
              return (
                <Box key={group.status} flexDirection="column" flexShrink={0}>
                  <Text color="planMode" bold>
                    {truncateWidth(` ${statusLabel(group.status)}`, listWidth - 2)}
                  </Text>
                  {group.rows.map((row, rowIndex) => {
                    const flatIndex = groupStart + rowIndex
                    if (flatIndex < windowStart || flatIndex >= windowEnd) return null
                    return (
                      <AgentViewRowLine
                        key={row.id}
                        row={row}
                        width={listWidth - 2}
                        focused={flatIndex === focusIndex}
                        now={now}
                        spinnerFrame={spinnerFrame}
                        spinnerTime={spinnerTime}
                      />
                    )
                  })}
                </Box>
              )
            })}
          </Box>
        )}
        {(splitPreview || soloPreview) && focused !== undefined && (
          <Box flexDirection="column" width={previewWidth} flexShrink={0}>
            <SessionPreview
              session={summaryForRow(focused)}
              entries={peek}
              loading={peekLoading}
              width={previewWidth}
              height={Math.max(1, listHeight - (focused.live ? 1 : 0))}
              home={home}
              now={now}
            />
            {focused.live && (
              <Box flexShrink={0}>
                <SearchBox
                  query={tailWidth(replyText, inputBudget)}
                  isFocused
                  isTerminalFocused={isTerminalFocused}
                  placeholder={truncateWidth(t('agentview-hint-peek'), previewWidth - 4)}
                  prefix="❯"
                  width={Math.max(0, previewWidth - 2)}
                  borderless
                />
              </Box>
            )}
          </Box>
        )}
      </Box>

      {notice !== undefined && (
        <Box flexShrink={0}>
          <Text color={notice.tone === 'error' ? 'error' : 'success'}>
            {` ${truncateWidth(notice.text, Math.max(0, columns - 2))}`}
          </Text>
        </Box>
      )}

      {mode === 'rename' && (
        <Box flexShrink={0}>
          <SearchBox
            query={tailWidth(renameText, inputBudget)}
            isFocused
            isTerminalFocused={isTerminalFocused}
            placeholder={truncateWidth(t('agentview-rename-placeholder'), inputBudget)}
            prefix="✎"
            width={inputBudget}
            borderless
          />
        </Box>
      )}
      {mode !== 'rename' && (
        <Box flexShrink={0}>
          <SearchBox
            query={tailWidth(dispatchText, inputBudget)}
            isFocused={mode === 'list'}
            isTerminalFocused={isTerminalFocused}
            placeholder={truncateWidth(t('agentview-input-placeholder'), inputBudget)}
            prefix="❯"
            width={inputBudget}
            borderless
          />
        </Box>
      )}

      {ruleBudget > 1 && (<Box flexShrink={0}>
        <Divider width={columns} />
      </Box>)}
      <Box flexShrink={0}>
        <Text dimColor italic>
          <HintLine text={hint} />
        </Text>
      </Box>
    </Box>
  )
}
