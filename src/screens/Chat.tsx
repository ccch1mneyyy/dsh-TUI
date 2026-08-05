import React from 'react'
import { Box, Text, useInput, useTerminalSize, ScrollBox, type ScrollBoxHandle } from '../ui.js'
import { POINTER } from '../cc/figures.js'
import { formatTokens } from '../cc/format.js'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { Channel, ChatRow } from '../channel.js'
import type { DOMElement } from '../ink/dom.js'
import { useSearchHighlight } from '../ink/hooks/use-search-highlight.js'
import { useTerminalTitle } from '../ink/hooks/use-terminal-title.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { NoSelect } from '../ink/components/NoSelect.js'
import instances from '../ink/instances.js'
import { LogoHeader, MessageList } from '../components/MessageList.js'
import { PromptInput } from '../components/PromptInput.js'
import { StatusLine } from './StatusLine.js'
import { WorkingSpinner, useThinkingStatus } from '../components/WorkingSpinner.js'
import { ActivityLine, contextPressurePct } from '../components/ActivityLine.js'
import { ModelPicker } from '../components/ModelPicker.js'
import { ResumePicker } from '../components/ResumePicker.js'
import { ThinkingToggle } from '../components/ThinkingToggle.js'
import { HistorySearchDialog } from '../components/HistorySearchDialog.js'
import { RewindPicker } from '../components/RewindPicker.js'
import { LoadingState } from '../components/design-system/LoadingState.js'
import { Pane } from '../components/design-system/Pane.js'
import { loadHistory, type HistoryEntry } from '../history.js'
import type { SessionRecord } from '../sessionHistory.js'

/** Row kinds the message-selection cursor can land on. */
const SELECTABLE_KINDS = new Set<ChatRow['kind']>([
  'user',
  'assistant',
  'tool',
  'reasoning',
  'interrupt',
  'local',
  'local-output',
])

/** Terminal-title spinner frames (CC's TITLE_ANIMATION_FRAMES). */
const TITLE_ANIMATION_FRAMES = ['⠂', '⠐']

/** Searchable transcript text for one row (`/` incsearch, CC semantics:
 *  user text, assistant text, thinking, tool args/results, local output). */
function searchableText(row: ChatRow): string {
  switch (row.kind) {
    case 'tool':
      return row.tool
        ? `${row.tool.name} ${row.tool.argsText} ${row.tool.resultText ?? ''} ${row.tool.errorText ?? ''}`
        : ''
    default:
      return row.text ?? ''
  }
}

/**
 * Main chat screen in the Claude Code layout: a scrollable transcript
 * (with the current turn's prompt pinned above the viewport while scrolled
 * up), transient notifications, the working spinner, the bordered prompt
 * input (with slash-command overlay) and the status line pinned at the
 * bottom.
 *
 * Ctrl+O toggles expanded detail globally; Shift+↑ enters message-selection
 * mode (↑/↓ move, Enter expands the selected row, Esc exits); Ctrl+C
 * interrupts the running turn, or (when idle) asks for a second Ctrl+C to
 * exit; Enter while scrolled up jumps back to the bottom.
 */
export function Chat({
  channel,
  onExit,
}: {
  channel: Channel
  onExit(): void
}) {
  // Re-render whenever the channel mutates; rows/status are read fresh below.
  React.useSyncExternalStore(channel.subscribe, () => channel.version)
  const [expanded, setExpanded] = React.useState(false)
  const [helpOpen, setHelpOpen] = React.useState(false)
  const [handle, setHandle] = React.useState<ScrollBoxHandle | null>(null)
  const [selectionActive, setSelectionActive] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<number | null>(null)
  const [expandedRows, setExpandedRows] = React.useState<ReadonlySet<number>>(
    () => new Set(),
  )
  const [modelPickerOpen, setModelPickerOpen] = React.useState(false)
  const [models, setModels] = React.useState<readonly LlmModelInfo[]>([])
  const [modelIndex, setModelIndex] = React.useState(0)
  const [resumePickerOpen, setResumePickerOpen] = React.useState(false)
  const [resumeSessions, setResumeSessions] = React.useState<readonly SessionRecord[]>([])
  const [resumeIndex, setResumeIndex] = React.useState(0)
  const [showAllMessages, setShowAllMessages] = React.useState(false)
  const [thinkingVisible, setThinkingVisible] = React.useState(true)
  const [thinkingOpen, setThinkingOpen] = React.useState(false)
  const [thinkingFocus, setThinkingFocus] = React.useState(0)
  /** Mid-conversation toggle waiting for Enter confirmation (CC semantics). */
  const [thinkingConfirm, setThinkingConfirm] = React.useState<boolean | null>(null)
  /** ctrl+r history search dialog (ported from CC's HistorySearchDialog). */
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [historyQuery, setHistoryQuery] = React.useState('')
  const [historyCursor, setHistoryCursor] = React.useState(0)
  const [historyFocus, setHistoryFocus] = React.useState(0)
  const [historyEntries, setHistoryEntries] = React.useState<readonly HistoryEntry[]>([])
  const [historyFill, setHistoryFill] = React.useState<string | null>(null)
  /** Double-Esc rewind picker (CC rewind): open state + focused row + confirm. */
  const [rewindOpen, setRewindOpen] = React.useState(false)
  const [rewindIndex, setRewindIndex] = React.useState(0)
  const [rewindConfirm, setRewindConfirm] = React.useState<ChatRow | null>(null)
  /** `/` transcript search (less-style incsearch, ported from CC's REPL). */
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [searchCursor, setSearchCursor] = React.useState(0)
  const [searchCount, setSearchCount] = React.useState(0)
  const [searchCurrent, setSearchCurrent] = React.useState(0)
  const searchAnchorRef = React.useRef(0)
  const rowRefsRef = React.useRef(new Map<number, DOMElement>())
  const { setQuery: setHighlight } = useSearchHighlight()

  // Sticky (pinned-to-bottom) scroll state, subscribed imperatively so
  // wheel events don't re-render React — only the header/pill flip.
  const isSticky = React.useSyncExternalStore(
    cb => (handle ? handle.subscribe(cb) : () => {}),
    () => (handle ? handle.isSticky() : true),
  )

  // "N new messages" pill: messages arriving while the user scrolled up.
  const baseAtScrollAway = React.useRef<number | null>(null)
  React.useEffect(() => {
    if (isSticky) {
      baseAtScrollAway.current = null
    } else if (baseAtScrollAway.current === null) {
      baseAtScrollAway.current = channel.rows.length
    }
  }, [isSticky, channel.rows.length])
  const newCount =
    baseAtScrollAway.current === null
      ? 0
      : Math.max(0, channel.rows.length - baseAtScrollAway.current)
  const showPill = !isSticky && newCount > 0

  // Idle Ctrl+C: first press arms an exit, second press exits (CC's
  // double-press semantics, simplified). Under Windows ConPTY the key
  // arrives as stdin data (key.ctrl && input === 'c') — the useInput
  // branch below is the only path; SIGINT is not emitted.
  const exitPendingRef = React.useRef(false)
  const exitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestExit = () => {
    if (exitPendingRef.current) {
      onExit()
    } else {
      exitPendingRef.current = true
      channel.notify('Press Ctrl+C again to exit')
      exitTimerRef.current = setTimeout(() => {
        exitPendingRef.current = false
      }, 3000)
    }
  }
  React.useEffect(() => {
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    }
  }, [])

  // Spinner timing refs, fed from channel state each render (the spinner
  // only mounts while working, so values are stable for the mount).
  const responseLengthRef = React.useRef(0)
  const loadingStartTimeRef = React.useRef(0)
  const totalPausedMsRef = React.useRef(0)
  const pauseStartTimeRef = React.useRef<number | null>(null)
  responseLengthRef.current = channel.responseChars
  loadingStartTimeRef.current = channel.turnStart
  const thinkingStatus = useThinkingStatus(channel.spinnerMode === 'thinking')

  // Terminal tab title (ported from CC's AnimatedTerminalTitle): the session
  // title when set, else "dsh-cc"; a `⠂/⠐` spinner prefix while a turn is
  // working (960ms cadence, only while the terminal is focused), a static
  // `✦` otherwise. cc-tui brands the idle prefix with the DeepSeek whale.
  const [titleFrame, setTitleFrame] = React.useState(0)
  const terminalFocused = useTerminalFocus()
  React.useEffect(() => {
    if (!channel.working || !terminalFocused) return
    const interval = setInterval(() => {
      setTitleFrame(f => (f + 1) % TITLE_ANIMATION_FRAMES.length)
    }, 960)
    return () => clearInterval(interval)
  }, [channel.working, terminalFocused])
  const titlePrefix = channel.working
    ? (TITLE_ANIMATION_FRAMES[titleFrame] ?? '✦')
    : '✦'
  useTerminalTitle(
    `${titlePrefix} 🐋 ${channel.sessionTitle ?? 'dsh-cc'}`,
  )

  /** Dispatch a local command; false lets the input flow to the model. */
  const runCommand = (name: string): boolean => {
    switch (name) {
      case 'clear':
        channel.clear()
        // channel.clear() resets row ids to 0; stale expanded/selection
        // state would mis-highlight fresh rows (known-limitation fix).
        setExpandedRows(new Set())
        setSelectedId(null)
        setSelectionActive(false)
        return true
      case 'compact':
        channel.compact()
        return true
      case 'help':
        setHelpOpen(true)
        return true
      case 'model':
        setHelpOpen(false)
        setModelPickerOpen(true)
        void channel.listModels().then(list => {
          setModels(list)
          const index = list.findIndex(model => model.id === channel.model)
          setModelIndex(index >= 0 ? index : 0)
        })
        return true
      case 'thinking':
        setHelpOpen(false)
        setThinkingOpen(true)
        setThinkingFocus(thinkingVisible ? 0 : 1)
        return true
      case 'tokens': {
        const usage = `Tokens: ${formatTokens(channel.tokens.input)} in · ${formatTokens(channel.tokens.output)} out`
        if (channel.contextWindow === undefined) {
          channel.notify(usage)
        } else {
          const percent = Math.max(
            0,
            Math.min(100, Math.round((channel.tokens.input / channel.contextWindow) * 100)),
          )
          channel.notify(
            `${usage} · ${percent}% of context`,
          )
        }
        return true
      }
      case 'resume': {
        setHelpOpen(false)
        void (async () => {
          const sessions = await channel.listSessions()
          setResumeSessions(sessions)
          if (sessions.length === 0) {
            channel.notify('No previous sessions found')
            return
          }
          setResumePickerOpen(true)
          const index = sessions.findIndex(session => session.id === channel.agentId)
          setResumeIndex(index >= 0 ? index : 0)
        })()
        return true
      }
      case 'exit':
        onExit()
        return true
      default:
        return false
    }
  }

  // === Message-selection mode (CC's Shift+↑ message actions) ===
  // NOTE: rows is a live in-place array on the channel (no new reference per
  // update), so derived lists must be computed per render — a useMemo keyed
  // on `channel.rows` would freeze at the first empty snapshot forever.
  const selectableRows = channel.rows.filter(row =>
    SELECTABLE_KINDS.has(row.kind),
  )

  // ctrl+r history search: substring match on the query, newest first.
  const historyMatches = React.useMemo(() => {
    const q = historyQuery.trim().toLowerCase()
    return q ? historyEntries.filter(e => e.text.toLowerCase().includes(q)) : historyEntries
  }, [historyEntries, historyQuery])

  // Double-Esc rewind: the user's own messages, newest first (CC lists the
  // selectable user turns; steering side-questions are excluded). Computed
  // per render — `channel.rows` is a live in-place array (see selectableRows).
  const rewindRows = channel.rows
    .filter(row => row.kind === 'user' && row.label === undefined)
    .reverse()
  /** Open the rewind picker (from PromptInput's double-Esc on an empty input). */
  const openRewind = () => {
    if (rewindRows.length === 0) {
      channel.notify('Nothing to rewind yet')
      return
    }
    setRewindIndex(0)
    setRewindConfirm(null)
    setRewindOpen(true)
  }
  /** Execute the confirmed rewind; the message comes back into the input. */
  const performRewind = async (row: ChatRow) => {
    const text = await channel.rewindTo(row)
    if (text !== null) {
      // CC puts the restored message back in the prompt for re-editing.
      setHistoryFill(text)
      channel.notify('Rewound — edit and press Enter to resend')
    }
  }

  // `/` transcript search: rows whose searchable text contains the query.
  // Computed per render — `channel.rows` is a live in-place array (see
  // selectableRows); a useMemo would freeze the match list at mount.
  const searchMatches = (() => {
    const q = searchQuery.toLowerCase()
    if (!q) return []
    return channel.rows
      .map((row, index) => ({ row, index, text: searchableText(row).toLowerCase() }))
      .filter(m => m.text.includes(q))
  })()

  // Incsearch: highlight all matches (screen-space overlay) and keep the
  // current match row in view as the query changes (CC semantics).
  React.useEffect(() => {
    if (!searchOpen) return
    setHighlight(searchQuery)
    const count = searchMatches.length
    setSearchCount(count)
    const current = Math.min(searchCurrent, Math.max(0, count - 1))
    setSearchCurrent(current)
    const target = searchMatches[current]
    if (target) {
      const el = rowRefsRef.current.get(target.row.id)
      if (el) handle?.scrollToElement(el)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchOpen])

  // n/N navigation: move the current match into view.
  React.useEffect(() => {
    if (!searchOpen) return
    const target = searchMatches[searchCurrent]
    if (target) {
      const el = rowRefsRef.current.get(target.row.id)
      if (el) handle?.scrollToElement(el)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchCurrent])

  const enterSelection = () => {
    setSelectionActive(true)
    const last = selectableRows[selectableRows.length - 1]
    setSelectedId(last ? last.id : null)
  }
  const moveSelection = (delta: 1 | -1) => {
    if (selectedId === null) return
    const index = selectableRows.findIndex(row => row.id === selectedId)
    if (index < 0) return
    const next = selectableRows[index + delta]
    if (next) setSelectedId(next.id)
  }
  const toggleRowExpanded = (rowId: number) => {
    setExpandedRows(previous => {
      const next = new Set(previous)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }

  useInput((input, key, event) => {
    if (searchOpen) {
      // Transcript search bar (less-style): edit the query, Enter commits
      // (query persists for n/N), Esc/ctrl+c cancels back to the anchor.
      if (key.escape || (key.ctrl && input === 'c')) {
        setSearchOpen(false)
        setHighlight('')
        handle?.scrollTo(searchAnchorRef.current)
      } else if (key.return) {
        // Enter commits; 0-match junk queries don't persist (CC behavior).
        if (searchCount === 0) setSearchQuery('')
        setSearchOpen(false)
      } else if (key.backspace) {
        if (searchCursor > 0) {
          setSearchQuery(searchQuery.slice(0, searchCursor - 1) + searchQuery.slice(searchCursor))
          setSearchCursor(searchCursor - 1)
        }
      } else if (key.delete) {
        if (searchCursor < searchQuery.length) {
          setSearchQuery(searchQuery.slice(0, searchCursor) + searchQuery.slice(searchCursor + 1))
        }
      } else if (key.leftArrow) {
        setSearchCursor(c => Math.max(0, c - 1))
      } else if (key.rightArrow) {
        setSearchCursor(c => Math.min(searchQuery.length, c + 1))
      } else if (key.home) {
        setSearchCursor(0)
      } else if (key.end) {
        setSearchCursor(searchQuery.length)
      } else if (!key.ctrl && !key.meta && input) {
        const next = searchQuery.slice(0, searchCursor) + input + searchQuery.slice(searchCursor)
        setSearchQuery(next)
        setSearchCursor(searchCursor + input.length)
      }
      event?.stopImmediatePropagation()
      return
    }
    // After Enter closed the search bar, n/N keep walking the matches
    // (CC: "Query persists across bar open/close so n/N keep working").
    // Transcript mode only — in prompt mode n/N are ordinary input chars.
    if (expanded && input === 'n' && searchQuery && searchCount > 0 && !key.ctrl && !key.meta) {
      setSearchCurrent(i => (i >= searchCount - 1 ? 0 : i + 1))
      event?.stopImmediatePropagation()
      return
    }
    if (expanded && input === 'N' && searchQuery && searchCount > 0 && !key.ctrl && !key.meta) {
      setSearchCurrent(i => (i <= 0 ? searchCount - 1 : i - 1))
      event?.stopImmediatePropagation()
      return
    }
    if (thinkingOpen) {
      if (thinkingConfirm !== null) {
        // Confirmation state: Enter applies, Esc backs out to the select.
        if (key.return) {
          const enabled = thinkingConfirm
          setThinkingVisible(enabled)
          setThinkingConfirm(null)
          setThinkingOpen(false)
          channel.notify(`Thinking ${enabled ? 'on' : 'off'}`)
        } else if (key.escape) {
          setThinkingConfirm(null)
        }
      } else if (key.upArrow || key.downArrow) {
        setThinkingFocus(index => (index === 0 ? 1 : 0))
      } else if (key.return) {
        const enabled = thinkingFocus === 0
        const midConversation = channel.rows.some(row => row.kind === 'assistant')
        if (midConversation && enabled !== thinkingVisible) {
          setThinkingConfirm(enabled)
        } else {
          setThinkingVisible(enabled)
          setThinkingOpen(false)
          channel.notify(`Thinking ${enabled ? 'on' : 'off'}`)
        }
      } else if (key.escape) {
        setThinkingOpen(false)
      }
      return
    }
    if (resumePickerOpen) {
      if (key.upArrow) {
        setResumeIndex(index => (index <= 0 ? resumeSessions.length - 1 : index - 1))
      } else if (key.downArrow) {
        setResumeIndex(index => (index >= resumeSessions.length - 1 ? 0 : index + 1))
      } else if (key.return) {
        const session = resumeSessions[resumeIndex]
        if (session) {
          channel.setResumeTarget(session.id)
          channel.notify(`Session marked · run dsh-cc --resume to open`)
        }
        setResumePickerOpen(false)
      } else if (key.escape) {
        setResumePickerOpen(false)
      }
      return
    }
    if (modelPickerOpen) {
      if (key.upArrow) {
        setModelIndex(index => (index <= 0 ? models.length - 1 : index - 1))
      } else if (key.downArrow) {
        setModelIndex(index => (index >= models.length - 1 ? 0 : index + 1))
      } else if (key.return) {
        const model = models[modelIndex]
        if (model) {
          channel.notify(`Model set to ${model.name} · restart dsh-cc to apply`)
        }
        setModelPickerOpen(false)
      } else if (key.escape) {
        setModelPickerOpen(false)
      }
      return
    }
    if (historyOpen) {
      if (key.escape) {
        setHistoryOpen(false)
      } else if (key.ctrl && (input === 'c' || input === 'd')) {
        // CC's history search cancels on ctrl+c/ctrl+d too.
        setHistoryOpen(false)
      } else if (key.return) {
        const entry = historyMatches[historyFocus]
        if (entry) {
          setHistoryFill(entry.text)
          setHistoryOpen(false)
        }
      } else if (key.upArrow) {
        setHistoryFocus(index =>
          historyMatches.length === 0 ? 0 : (index <= 0 ? historyMatches.length - 1 : index - 1),
        )
      } else if (key.downArrow) {
        setHistoryFocus(index =>
          historyMatches.length === 0 ? 0 : (index >= historyMatches.length - 1 ? 0 : index + 1),
        )
      } else if (key.ctrl && input === 'r') {
        // CC's historySearch:next — repeat ctrl+r walks to the next match.
        setHistoryFocus(index =>
          historyMatches.length === 0 ? 0 : (index >= historyMatches.length - 1 ? 0 : index + 1),
        )
      } else if (key.backspace) {
        if (historyCursor > 0) {
          const next = historyQuery.slice(0, historyCursor - 1) + historyQuery.slice(historyCursor)
          setHistoryQuery(next)
          setHistoryCursor(historyCursor - 1)
          setHistoryFocus(0)
        }
      } else if (key.delete) {
        if (historyCursor < historyQuery.length) {
          setHistoryQuery(historyQuery.slice(0, historyCursor) + historyQuery.slice(historyCursor + 1))
          setHistoryFocus(0)
        }
      } else if (key.leftArrow) {
        setHistoryCursor(cursor => Math.max(0, cursor - 1))
      } else if (key.rightArrow) {
        setHistoryCursor(cursor => Math.min(historyQuery.length, cursor + 1))
      } else if (key.home) {
        setHistoryCursor(0)
      } else if (key.end) {
        setHistoryCursor(historyQuery.length)
      } else if (!key.ctrl && !key.meta && input) {
        const next = historyQuery.slice(0, historyCursor) + input + historyQuery.slice(historyCursor)
        setHistoryQuery(next)
        setHistoryCursor(historyCursor + input.length)
        setHistoryFocus(0)
      }
      return
    }
    if (rewindOpen) {
      if (rewindConfirm !== null) {
        // Confirmation state: Enter rewinds, Esc backs out to the list.
        if (key.return) {
          const row = rewindConfirm
          setRewindOpen(false)
          setRewindConfirm(null)
          void performRewind(row)
        } else if (key.escape) {
          setRewindConfirm(null)
        }
      } else if (key.upArrow) {
        setRewindIndex(index => (index <= 0 ? rewindRows.length - 1 : index - 1))
      } else if (key.downArrow) {
        setRewindIndex(index => (index >= rewindRows.length - 1 ? 0 : index + 1))
      } else if (key.return) {
        const row = rewindRows[rewindIndex]
        if (row) setRewindConfirm(row)
      } else if (key.escape) {
        setRewindOpen(false)
        setRewindConfirm(null)
      }
      return
    }
    if (key.ctrl && input === 'r' && !historyOpen && !helpOpen) {
      setHistoryQuery('')
      setHistoryCursor(0)
      setHistoryFocus(0)
      setHistoryEntries(loadHistory())
      setHistoryOpen(true)
      return
    }
    if (key.shift && key.upArrow && !selectionActive) {
      enterSelection()
    } else if (selectionActive) {
      if (key.upArrow) {
        moveSelection(-1)
      } else if (key.downArrow) {
        moveSelection(1)
      } else if (key.return && selectedId !== null) {
        toggleRowExpanded(selectedId)
      } else if (key.escape) {
        setSelectionActive(false)
        setSelectedId(null)
      }
    } else if (key.escape && channel.working) {
      // CC's chat:cancel — esc interrupts a running turn (the prompt input
      // only sees esc when idle, where it has the double-tap-clear meaning).
      channel.cancel()
      event?.stopImmediatePropagation()
    } else if (key.ctrl && input === 'o') {
      // Leaving transcript mode aborts an active search (CC: screen change
      // clears highlights).
      if (searchOpen) {
        setSearchOpen(false)
        setHighlight('')
      }
      setExpanded(previous => !previous)
    } else if (input === '/' && !key.ctrl && !key.meta) {
      // `/` in transcript mode (Ctrl+O expanded, CC's REPL semantics:
      // search is active on the transcript screen where `/` isn't a command).
      if (expanded) {
        searchAnchorRef.current = handle?.getScrollTop() ?? 0
        setSearchQuery('')
        setSearchCursor(0)
        setSearchCurrent(0)
        setSearchCount(0)
        setSearchOpen(true)
        event?.stopImmediatePropagation()
      }
    } else if (key.ctrl && input === 'c') {
      if (channel.working) {
        channel.cancel()
      } else {
        requestExit()
      }
    } else if (key.ctrl && input === 'd') {
      // CC's app:exit — time-based double press like ctrl+c; idle-only.
      if (channel.working) {
        channel.cancel()
      } else {
        requestExit()
      }
    } else if (key.ctrl && input === 'l') {
      // CC's app:redraw — clear the physical terminal and repaint.
      instances.get(process.stdout)?.forceRedraw()
    } else if (key.ctrl && input === 'e') {
      setShowAllMessages(previous => !previous)
    } else if (key.return && showPill) {
      handle?.scrollToBottom()
    }
  })

  // Working-activity line (spinner slot): context-pressure prefix shares the
  // StatusLine thresholds (amber ≥ 80, red ≥ 95).
  const activityWarnPct = contextPressurePct(channel.lastUsage, channel.contextWindow)

  return (
    <Box flexDirection="column" flexGrow={1} width="100%">
      {!isSticky && channel.lastUserText && (
        <StickyPromptHeader
          text={channel.lastUserText}
          onClick={() => {
            // Click jumps back to the pinned prompt (CC's StickyPromptHeader).
            const lastUser = [...channel.rows].reverse().find(row => row.kind === 'user')
            const el = lastUser ? rowRefsRef.current.get(lastUser.id) : undefined
            if (el) handle?.scrollToElement(el)
            else handle?.scrollToBottom()
          }}
        />
      )}
      <ScrollBox ref={setHandle} flexGrow={1} flexShrink={1} stickyScroll>
        <LogoHeader
          model={channel.model}
          effort={channel.reasoningEffort}
          cwd={channel.cwd}
        />
        <MessageList
          rows={channel.rows}
          expanded={expanded}
          expandedRows={expandedRows}
          selectedId={selectionActive ? selectedId : null}
          onToggleRow={toggleRowExpanded}
          model={channel.model}
          showAll={showAllMessages}
          thinkingVisible={thinkingVisible}
          onToggleAll={() => setShowAllMessages(previous => !previous)}
          registerRowRef={(rowId, el) => {
            if (el) rowRefsRef.current.set(rowId, el)
            else rowRefsRef.current.delete(rowId)
          }}
        />
      </ScrollBox>
      {showPill && (
        <NewMessagesPill
          count={newCount}
          onClick={() => handle?.scrollToBottom()}
        />
      )}
      {channel.working &&
        (channel.activityEnabled &&
        channel.workingActivity !== undefined &&
        channel.workingActivity.line !== '' &&
        channel.workingActivity.phase !== 'idle' ? (
          // The working-activity line REPLACES the CC random-verb spinner
          // while a turn runs: the plugin's live line (thinking copy /
          // running tool / narration) is the status, with the spinner
          // slot's token counter preserved as a suffix. Only real activity
          // data replaces the spinner — before the first event, or with
          // `activity: false`, the classic spinner still renders.
          <Box marginTop={1} paddingLeft={2}>
            <ActivityLine
              activity={channel.workingActivity}
              activityFrames={channel.activityFrames}
              warnPct={activityWarnPct}
              warnDanger={activityWarnPct !== undefined && activityWarnPct >= 95}
              suffix={` · ↓ ${channel.responseChars} tokens`}
            />
          </Box>
        ) : (
          <WorkingSpinner
            mode={channel.spinnerMode}
            hasActiveTools={channel.activeToolCount > 0}
            responseLengthRef={responseLengthRef}
            loadingStartTimeRef={loadingStartTimeRef}
            totalPausedMsRef={totalPausedMsRef}
            pauseStartTimeRef={pauseStartTimeRef}
            thinkingStatus={thinkingStatus}
          />
        ))}
      {thinkingOpen && (
        <ThinkingToggle
          currentValue={thinkingVisible}
          focusIndex={thinkingFocus}
          confirmationPending={thinkingConfirm}
        />
      )}
      {resumePickerOpen && resumeSessions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <ResumePicker
            sessions={resumeSessions}
            focusIndex={resumeIndex}
            currentSessionId={channel.agentId}
          />
        </Box>
      )}
      {modelPickerOpen && (
        <Box flexDirection="column" marginTop={1}>
          {models.length === 0 ? (
            <ModelPickerLoading />
          ) : (
            <ModelPicker
              models={models}
              focusIndex={modelIndex}
              currentModel={channel.model}
            />
          )}
        </Box>
      )}
      {historyOpen && (
        <Box flexDirection="column" marginTop={1}>
          <HistorySearchDialog
            query={historyQuery}
            cursorOffset={historyCursor}
            matches={historyMatches}
            focusIndex={historyFocus}
          />
        </Box>
      )}
      {rewindOpen && (
        <Box flexDirection="column" marginTop={1}>
          <RewindPicker
            rows={rewindRows}
            focusIndex={rewindIndex}
            confirmRow={rewindConfirm}
          />
        </Box>
      )}
      {searchOpen && <TranscriptSearchBar query={searchQuery} cursorOffset={searchCursor} count={searchCount} current={searchCurrent} />}
      <PromptInput
        channel={channel}
        helpOpen={helpOpen}
        onToggleHelp={() => setHelpOpen(previous => !previous)}
        onRunCommand={runCommand}
        selectionActive={selectionActive || modelPickerOpen || resumePickerOpen || thinkingOpen || historyOpen || rewindOpen || searchOpen}
        fillText={historyFill}
        onFillConsumed={() => setHistoryFill(null)}
        onRewindRequest={openRewind}
      />
      <StatusLine
        channel={channel}
        selectionActive={selectionActive}
        helpOpen={helpOpen}
      />
    </Box>
  )
}

/**
 * The pinned prompt header shown above the ScrollBox while the user has
 * scrolled up (ported from the leak's FullscreenLayout.StickyPromptHeader).
 * Fixed at 1 row so the ScrollBox never shifts when the text changes.
 */
function StickyPromptHeader({
  text,
  onClick,
}: {
  text: string
  onClick(): void
}): React.ReactNode {
  const [hover, setHover] = React.useState(false)
  return (
    <Box
      flexShrink={0}
      width="100%"
      height={1}
      paddingRight={1}
      backgroundColor={hover ? 'userMessageBackgroundHover' : 'userMessageBackground'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      <Text color="subtle" wrap="truncate-end">
        {POINTER} {text}
      </Text>
    </Box>
  )
}

/** The `↓ N new messages` pill shown while scrolled up with new content. */
function NewMessagesPill({
  count,
  onClick,
}: {
  count: number
  onClick: () => void
}): React.ReactNode {
  const [hover, setHover] = React.useState(false)
  return (
    <Box paddingX={2} paddingTop={1}>
      <Box
        backgroundColor={hover ? 'userMessageBackgroundHover' : 'background'}
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <Text color="inverseText" bold>
          {' '}↓ {count === 1 ? '1 new message' : `${count} new messages`}{' '}
        </Text>
      </Box>
    </Box>
  )
}

/** /model while the provider catalog is still loading (CC's LoadingState). */
function ModelPickerLoading(): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Text bold color="permission">
          Model
        </Text>
        <LoadingState
          message="Loading models"
          bold
          subtitle="Querying the provider…"
        />
      </Box>
    </Pane>
  )
}

/**
 * The `/` incsearch bar (ported from CC's REPL TranscriptSearchBar): a
 * single row above the prompt input with the query, a block cursor, and the
 * match counter (`current/count`) or a red `no matches` when nothing hits.
 */function TranscriptSearchBar({
  query,
  cursorOffset,
  count,
  current,
}: {
  query: string
  cursorOffset: number
  count: number
  current: number
}): React.ReactNode {
  const cursorChar = cursorOffset < query.length ? query[cursorOffset] : ' '
  return (
    // noSelect: the bar's own text must not match the search query (the
    // screen-space highlight would self-match, CC's searchHighlight.ts:76).
    <NoSelect
      borderTopDimColor
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      marginTop={1}
      paddingLeft={2}
      width="100%"
    >
      <Text>/</Text>
      <Text>{query.slice(0, cursorOffset)}</Text>
      <Text inverse>{cursorChar}</Text>
      {cursorOffset < query.length && <Text>{query.slice(cursorOffset + 1)}</Text>}
      <Box flexGrow={1} />
      {query && count === 0 ? (
        <Text color="error">no matches </Text>
      ) : count > 0 ? (
        <Text dimColor>
          {Math.min(current + 1, count)}/{count}{'  '}
        </Text>
      ) : null}
    </NoSelect>
  )
}
