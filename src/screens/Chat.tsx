import React from 'react'
import { t, getLang, setLang, isLang, writeLangPref, subscribeLang, type I18nKey } from '../i18n.js'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTheme } from '../ui.js'
import { POINTER } from '../cc/figures.js'
import { isMod, isPlainReturnInput, modLabel } from '../utils/modifiers.js'
import { formatTokens } from '../cc/format.js'
import type { LlmModelInfo } from '../dsh-adapter/types.js'
import type { Channel, ChatRow, EffortOption, PresetOption } from '../dsh-adapter/channel.js'
import type { QuestionStore } from '../dsh-adapter/questions.js'
import { runProviderWizard } from '../dsh-adapter/providerWizard.js'
import { ApprovalStore } from '../dsh-adapter/approvals.js'
import { AskUserQuestionPanel } from '../components/questions/AskUserQuestionPanel.js'
import { ApprovalPanel } from '../components/approvals/ApprovalPanel.js'
import type { DOMElement } from '../ink/dom.js'
import { useSearchHighlight } from '../ink/hooks/use-search-highlight.js'
import { useTerminalTitle } from '../ink/hooks/use-terminal-title.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { useCopyOnSelect } from '../ink/hooks/use-copy-on-select.js'
import { useSelection } from '../ink/hooks/use-selection.js'
import { NoSelect } from '../ink/components/NoSelect.js'
import instances from '../ink/instances.js'
import { LogoHeader, MessageList } from '../components/MessageList.js'
import { PromptInput, type PromptController } from '../components/PromptInput.js'
import { GoalTodoPanel } from '../components/GoalTodoPanel.js'
import { LoadedContextPanel } from '../components/LoadedContextPanel.js'
import { StatusLine } from './StatusLine.js'
import { WorkingSpinner, useThinkingStatus } from '../components/WorkingSpinner.js'
import { ActivityLine, contextPressurePct } from '../components/ActivityLine.js'
import { ModelPicker } from '../components/ModelPicker.js'
import { ResumePicker, type ResumePickerMode } from '../components/ResumePicker.js'
import { WorkspacePicker } from '../components/WorkspacePicker.js'
import { WorkspaceFlowPicker } from '../components/WorkspaceFlowPicker.js'
import type { TuiWorkspaceCommandResult, TuiWorkspaceTarget } from '../workspaces.js'
import { ActivityPicker } from '../components/ActivityPicker.js'
import { EffortSlider } from '../components/EffortSlider.js'
import { PresetPicker } from '../components/PresetPicker.js'
import { ThemePicker, getThemeOptions } from '../components/ThemePicker.js'
import { AUTO_THEME_NAME, getAutoThemeBase } from '../theme.js'
import { FRAME_PRESETS, PRESET_NAMES } from '../components/activityFrames.js'
import { ThinkingToggle } from '../components/ThinkingToggle.js'
import { HistorySearchDialog } from '../components/HistorySearchDialog.js'
import { RewindPicker } from '../components/RewindPicker.js'
import { BtwPanel } from '../components/BtwPanel.js'
import { setClipboard } from '../ink/termio/osc.js'
import { TraceView, TRACE_WINDOW } from '../components/TraceView.js'
import {
  extendTrace,
  filterTraceEntries,
  TRACE_FILTERS,
  type TraceBuild,
  type TraceEntry,
  type TraceFilter,
} from '../dsh-adapter/trace.js'
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
  'compact',
])

/** Shared empty list for mode-gated derived rows (stable reference, so
 *  downstream consumers never see a changing prop when the mode is off). */
const NO_ROWS: readonly ChatRow[] = []

/** Shared empty list for the closed `/trace` view (see NO_ROWS). */
const NO_TRACE_ENTRIES: readonly TraceEntry[] = []

/** `max` → `Max` (effort levels arrive lower-case from the adapter). */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

/**
 * CC's built-in skill commands, driven through the DSH skill system: each
 * submits an activation prompt the model resolves via its skill catalog/load
 * tools (the corresponding SKILL.md ships under ~/.dsh/skills with dsh-tui).
 */
// i18n keys, not resolved strings: module scope evaluates before apply()'s
// setLang, so t() must run at the call site to follow the active language.
const SKILL_PROMPTS: Readonly<Record<string, I18nKey>> = {
  audit: 'skill-audit-prompt',
  bug: 'skill-bug-prompt',
  practice: 'skill-practice-prompt',
  review: 'skill-review-prompt',
  pr_comments: 'skill-pr-comments-prompt',
  'release-notes': 'skill-release-notes-prompt',
  'vuln-check': 'skill-vuln-check-prompt',
}

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
      return row.text
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

/**
 * Shared inert approval store for hosts that render Chat without an
 * approval seam (headless verify scripts). Never parked into, so its
 * snapshot stays null and the approval panel never mounts.
 */
let fallbackApprovalStore: ApprovalStore | undefined

export function Chat({
  channel,
  questionStore,
  approvalStore,
  onExit,
  onUpdate,
}: {
  channel: Channel
  questionStore: QuestionStore
  /**
   * The approval seam's UI store. Optional: hosts without an approval
   * channel (headless scripts, older embeds) render Chat without it and
   * simply never see an approval panel — the question panel keeps its seat.
   */
  approvalStore?: ApprovalStore
  onExit: () => void
  /** Update the installed package and restart the current TUI process. */
  onUpdate?: () => void
}) {
  // Re-render whenever the channel mutates; rows/status are read fresh below.
  React.useSyncExternalStore(channel.subscribe, () => channel.version)
  // Re-render on language switches so the whole UI hot-swaps its strings.
  React.useSyncExternalStore(subscribeLang, getLang)
  // The pending ask-user-question (DSH user-interaction seam): the model's
  // `ask_user_question` tool parks here until the panel is answered.
  const questionSnapshot = React.useSyncExternalStore(
    listener => questionStore.subscribe(listener),
    () => questionStore.getSnapshot(),
  )
  // The pending tool-approval ask (DSH approval seam): the permission layer
  // parks here until the panel decides; shown with priority over a pending
  // questionnaire since it gates a tool about to run. Hosts that pass no
  // approvalStore share one inert instance that never holds an ask.
  const approvals = approvalStore ?? (fallbackApprovalStore ??= new ApprovalStore())
  const approvalSnapshot = React.useSyncExternalStore(
    listener => approvals.subscribe(listener),
    () => approvals.getSnapshot(),
  )
  // When a questionnaire batch completes, fold a Q&A summary into the
  // transcript (the tool card itself is hidden from the message list).
  const questionOpenRef = React.useRef(questionSnapshot !== null)
  React.useEffect(() => {
    const wasOpen = questionOpenRef.current
    questionOpenRef.current = questionSnapshot !== null
    if (wasOpen && questionSnapshot === null) {
      for (const summary of questionStore.takeSummaries()) {
        channel.pushLocal(summary.title, summary.lines)
      }
    }
  }, [channel, questionSnapshot, questionStore])
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
  /** `/resume` session management (issue #112): plain selection, a delete
   *  confirmation (ctrl+d), or the inline rename input (ctrl+r). */
  const [resumeMode, setResumeMode] = React.useState<ResumePickerMode>('list')
  const [workspacePickerOpen, setWorkspacePickerOpen] = React.useState(false)
  const [workspaceTargets, setWorkspaceTargets] = React.useState<readonly TuiWorkspaceTarget[]>([])
  const [workspaceIndex, setWorkspaceIndex] = React.useState(0)
  const [workspaceFlow, setWorkspaceFlow] = React.useState<Extract<TuiWorkspaceCommandResult, { kind: 'choices' }> | null>(null)
  const [workspaceFlowIndex, setWorkspaceFlowIndex] = React.useState(0)
  const [workspaceFlowBusy, setWorkspaceFlowBusy] = React.useState(false)
  const [workspaceFlowInput, setWorkspaceFlowInput] = React.useState<{
    choiceId: string
    value: string
    cursor: number
    placeholder?: string
  } | null>(null)
  const workspaceFlowRequestRef = React.useRef(0)
  const workspaceFlowAbortRef = React.useRef<AbortController | null>(null)
  const [resumeRenameText, setResumeRenameText] = React.useState('')
  /** `/activity` indicator picker (pi extension's interactive select). */
  const [activityPickerOpen, setActivityPickerOpen] = React.useState(false)
  const [activityIndex, setActivityIndex] = React.useState(0)
  /** `/preset` agent-preset picker (issue #8): roster list loads async. */
  const [presetPickerOpen, setPresetPickerOpen] = React.useState(false)
  const [presetOptions, setPresetOptions] = React.useState<readonly PresetOption[]>([])
  const [presetIndex, setPresetIndex] = React.useState(0)
  /** `/effort` rheostat slider: adapter levels load async, focus moves ←/→. */
  const [effortSliderOpen, setEffortSliderOpen] = React.useState(false)
  const [effortOptions, setEffortOptions] = React.useState<readonly EffortOption[]>([])
  const [effortIndex, setEffortIndex] = React.useState(0)
  /** `/theme` color-theme picker (built-ins + ~/.dsh-tui/themes user themes). */
  const [themePickerOpen, setThemePickerOpen] = React.useState(false)
  const [themeIndex, setThemeIndex] = React.useState(0)
  const [themeName, setTheme] = useTheme()
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
  /** /btw side-question overlay (CC): pure UI state — the answer never
   *  enters the transcript or the session log. */
  const [btw, setBtw] = React.useState<{ question: string; answer: string; error?: string; done: boolean } | null>(null)
  const btwAbortRef = React.useRef<AbortController | null>(null)
  const closeBtw = () => {
    btwAbortRef.current?.abort()
    btwAbortRef.current = null
    setBtw(null)
  }
  React.useEffect(() => () => btwAbortRef.current?.abort(), [])
  /** `/trace` trajectory view (issue #80): open state + type filter + cursor.
   *  `traceFollowRef` pins the cursor to the newest entry while the view
   *  follows a running session; any upward scroll unpins it. */
  const [traceOpen, setTraceOpen] = React.useState(false)
  const [traceFilter, setTraceFilter] = React.useState<TraceFilter>('all')
  const [traceCursor, setTraceCursor] = React.useState(0)
  const traceFollowRef = React.useRef(true)
  const traceBuildRef = React.useRef<TraceBuild | null>(null)
  /** Startup context panel: expanded by header click or Ctrl+T. */
  const [loadedContextOpen, setLoadedContextOpen] = React.useState(false)
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

  // "N new messages" pill: new rows whose top edge is still BELOW the
  // viewport bottom. The count decrements as the user scrolls down through
  // them and hits 0 (pill hides) once every new row has been on screen —
  // no need to wait for the exact-bottom sticky restore. Chat anchors the
  // "seen up to" point by ROW ID (stable across loadOlder prepends, unlike
  // a rows.length index); MessageList owns the row offsets, so it computes
  // how many rows past that anchor lie below the viewport and reports it.
  const lastSeenRowIdRef = React.useRef<number | null>(null)
  const [unseenCount, setUnseenCount] = React.useState(0)
  React.useEffect(() => {
    if (isSticky) {
      lastSeenRowIdRef.current = null
      setUnseenCount(0)
    } else if (lastSeenRowIdRef.current === null) {
      lastSeenRowIdRef.current = channel.rows.length
        ? channel.rows[channel.rows.length - 1]!.id
        : -1
    }
  }, [isSticky, channel.rows])
  const showPill = !isSticky && unseenCount > 0

  // Idle Ctrl+C: first press arms an exit, second press exits (CC's
  // double-press semantics, simplified). Under Windows ConPTY the key
  // arrives as stdin data (key.ctrl && input === 'c') — the useInput
  // branch below is the only path; SIGINT is not emitted.
  const exitPendingRef = React.useRef(false)
  const exitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // Live view into the prompt's text for the Ctrl+C rule (clears text when
  // non-empty; the double-press exit only arms on an empty input).
  const promptControllerRef = React.useRef<PromptController | null>(null)
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
  // title when set, else "dsh-TUI"; a `⠂/⠐` spinner prefix while a turn is
  // working (960ms cadence, only while the terminal is focused), a static
  // `✦` otherwise. dsh-TUI brands the idle prefix with the DeepSeek whale.
  const [titleFrame, setTitleFrame] = React.useState(0)
  const terminalFocused = useTerminalFocus()
  // Mouse text selection auto-copy (CC's copy-on-select): active only in
  // fullscreen (<AlternateScreen> supplies mouse tracking); a no-op
  // subscription in inline mode, where selection belongs to the terminal.
  // The copy clears the highlight and posts a transient notification.
  useCopyOnSelect(text =>
    channel.notify(t('copied-chars', { n: text.length }), { timeoutMs: 1500 }),
  )
  const { clearSelection: clearMouseSelection, hasSelection: hasMouseSelection } =
    useSelection()
  React.useEffect(() => {
    if (!channel.working || !terminalFocused) return
    const interval = setInterval(() => {
      setTitleFrame(f => (f + 1) % TITLE_ANIMATION_FRAMES.length)
    }, 960)
    return () =>{  clearInterval(interval) }
  }, [channel.working, terminalFocused])
  const titlePrefix = channel.working
    ? (TITLE_ANIMATION_FRAMES[titleFrame] ?? '✦')
    : '✦'
  useTerminalTitle(
    `${titlePrefix} 🐋 ${channel.sessionTitle}`,
  )

  const handleWorkspaceResult = (result: TuiWorkspaceCommandResult): void => {
    workspaceFlowAbortRef.current = null
    setWorkspaceFlowBusy(false)
    setWorkspaceFlowInput(null)
    if (result.kind === 'target') {
      setWorkspaceFlow(null)
      void channel.switchWorkspace(result.target)
      return
    }
    if (result.choices.length === 0) {
      setWorkspaceFlow(null)
      channel.notify(t('workspace-command-empty'))
      return
    }
    setWorkspaceFlow(result)
    setWorkspaceFlowIndex(0)
  }

  const runWorkspaceFlowAction = (
    action: (signal: AbortSignal) => Promise<TuiWorkspaceCommandResult> | TuiWorkspaceCommandResult,
  ): void => {
    const request = ++workspaceFlowRequestRef.current
    const controller = new AbortController()
    workspaceFlowAbortRef.current = controller
    setWorkspaceFlowBusy(true)
    void Promise.resolve()
      .then(() => action(controller.signal))
      .then((result) => {
        if (request === workspaceFlowRequestRef.current) handleWorkspaceResult(result)
      })
      .catch((error: unknown) => {
        if (request !== workspaceFlowRequestRef.current) return
        workspaceFlowAbortRef.current = null
        setWorkspaceFlowBusy(false)
        channel.notify(
          t('workspace-command-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
      })
  }

  const openWorkspaceTarget = (reference: string): void => {
    void channel.resolveWorkspace(reference).then((target) => {
      if (target === undefined) {
        channel.notify(t('workspace-uri-invalid', { uri: reference }), { color: 'error', timeoutMs: 8000 })
        return
      }
      void channel.switchWorkspace(target)
    }).catch((error: unknown) => {
      channel.notify(
        t('workspace-uri-failed', { err: error instanceof Error ? error.message : String(error) }),
        { color: 'error', timeoutMs: 8000 },
      )
    })
  }

  const openWorkspaceResume = (): void => {
    void channel.listWorkspaces().then((targets) => {
      if (targets.length === 0) {
        channel.notify(t('workspace-none'))
        return
      }
      setWorkspaceTargets(targets)
      setWorkspaceIndex(Math.max(0, targets.findIndex(target => target.cwd === channel.cwd)))
      setWorkspacePickerOpen(true)
    }).catch((error: unknown) => {
      channel.notify(
        t('workspace-list-failed', { err: error instanceof Error ? error.message : String(error) }),
        { color: 'error' },
      )
    })
  }

  /**
   * Dispatch a slash command; false lets the input flow to the model.
   * Built-in names run the local switch; anything registered by a DSH
   * plugin (plan/goal/…) dispatches through the command registry, whose
   * result text lands as a notification. `rawInput` carries the text after
   * the command name (`/plan off` → ` off`).
   */
  const runCommand = (name: string, rawInput = ''): boolean => {
    switch (name) {
      case 'activity': {
        // Ported from the pi working-activity extension: bare `/activity`
        // opens the interactive indicator picker; `/activity frames <name>`
        // switches directly; `/activity frames` lists presets; `/activity
        // status` shows the current choice. The choice persists to
        // ~/.dsh-tui/working-activity.json and survives restarts.
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (parts[0] === 'status') {
          setHelpOpen(false)
          channel.pushLocal('/activity', [
            t('activity-current-preset', { name: channel.activityFrames ?? 'claude' }),
            t('activity-switch-hint'),
            t('activity-persist-hint'),
          ])
          return true
        }
        if (parts[0] === 'frames') {
          setHelpOpen(false)
          if (parts[1]) {
            channel.setActivityFrames(parts[1].toLowerCase())
            return true
          }
          const current = channel.activityFrames
          channel.pushLocal('/activity', [
            t('activity-current-direct', { name: current ?? 'claude' }),
            ...PRESET_NAMES.map(name =>
              `${name.padEnd(10)} ${name === 'random' ? t('activity-random-each') : FRAME_PRESETS[name].frames.slice(0, 5).join(' ')}${name === current ? t('activity-current-marker') : ''}`,
            ),
          ])
          return true
        }
        if (parts.length > 0) {
          channel.notify(t('activity-usage'), { color: 'warning' })
          return true
        }
        setHelpOpen(false)
        setActivityIndex(Math.max(0, PRESET_NAMES.indexOf(channel.activityFrames ?? 'random')))
        setActivityPickerOpen(true)
        return true
      }
      case 'preset': {
        // issue #8: bare `/preset` opens the roster picker (standard/code/
        // minimal/cordis plus any user-authored presets); `/preset <id>`
        // switches directly; `/preset status` shows the current choice. A
        // blank session swaps composition in place (official blank-only
        // rule); a started session is locked and the choice persists as the
        // default for future sessions (~/.dsh-tui/agent-preset.json).
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (parts[0] === 'status') {
          setHelpOpen(false)
          channel.pushLocal('/preset', [
            t('preset-current', { name: channel.agentPreset ?? t('preset-roster-missing') }),
            t('preset-switch-hint'),
            t('preset-persist-hint'),
            t('preset-lock-hint'),
          ])
          return true
        }
        if (parts.length > 0) {
          setHelpOpen(false)
          void channel.switchPreset(parts[0])
          return true
        }
        setHelpOpen(false)
        setPresetPickerOpen(true)
        void channel.listPresets().then((list) => {
          if (list.length === 0) {
            setPresetPickerOpen(false)
            channel.notify(t('preset-roster-unmounted'), { color: 'warning' })
            return
          }
          setPresetOptions(list)
          const index = list.findIndex(preset => preset.id === channel.agentPreset)
          setPresetIndex(index >= 0 ? index : 0)
        })
        return true
      }
      case 'effort': {
        // Bare `/effort` opens the rheostat slider over the live route's
        // adapter levels (←/→ applies each step immediately); `/effort <id>`
        // sets directly (validated by the channel); `/effort status` prints
        // the current level. The choice persists to ~/.dsh-tui/effort.json.
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (parts[0] === 'status') {
          setHelpOpen(false)
          channel.pushLocal('/effort', [
            t('effort-current', { name: channel.reasoningEffort ?? '—' }),
            t('effort-usage'),
          ])
          return true
        }
        if (parts.length > 0) {
          setHelpOpen(false)
          void channel.setEffort(parts[0])
          return true
        }
        setHelpOpen(false)
        void channel.listEfforts().then(({ efforts, defaultEffort }) => {
          // 0/1-tier routes were already notified by listEfforts.
          if (efforts.length <= 1) return
          setEffortOptions(efforts)
          const current = channel.reasoningEffort ?? defaultEffort
          const index = efforts.findIndex(effort => effort.id === current)
          setEffortIndex(index >= 0 ? index : 0)
          setEffortSliderOpen(true)
        })
        return true
      }
      case 'lang': {
        // `/lang` shows the current UI language, `/lang en|zh` switches
        // (hot-swap, persisted to ~/.dsh-tui/lang.json). Precedence on next
        // launch: DSH_TUI_LANG > cordis.yml `lang` > the persisted choice.
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (parts[0] === 'status') {
          setHelpOpen(false)
          channel.pushLocal('/lang', [
            t('lang-current', { lang: getLang() }),
            t('lang-switch-hint'),
            t('lang-persist-hint'),
          ])
          return true
        }
        if (parts.length > 0) {
          setHelpOpen(false)
          if (isLang(parts[0])) {
            const ok = writeLangPref(parts[0])
            setLang(parts[0])
            channel.notify(
              ok ? t('lang-switched', { lang: parts[0] }) : t('lang-switch-failed', { lang: parts[0] }),
              { color: ok ? 'success' : 'error' },
            )
          } else {
            channel.notify(t('lang-unknown', { lang: parts[0] }), { color: 'error' })
          }
          return true
        }
        setHelpOpen(false)
        channel.pushLocal('/lang', [
          t('lang-current', { lang: getLang() }),
          t('lang-switch-hint'),
          t('lang-persist-hint'),
        ])
        return true
      }
      case 'theme': {
        // Bare `/theme` opens the interactive color picker (`auto` + built-in
        // palettes + user themes from ~/.dsh-tui/themes); `/theme <name>`
        // switches directly; `/theme status` shows the current choice.
        // `auto` follows the terminal background (OSC 11). Selection
        // persists to ~/.dsh-tui/theme.json and hot swaps via the
        // ThemeProvider setter (DSH_TUI_THEME still wins on next launch).
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (parts[0] === 'status') {
          setHelpOpen(false)
          channel.pushLocal('/theme', [
            t('theme-current', { name: themeName }),
            // `auto` resolves through terminal-background detection; show
            // which palette it currently maps to.
            ...(themeName === AUTO_THEME_NAME
              ? [t('theme-auto-resolved', { name: getAutoThemeBase() })]
              : []),
            t('theme-switch-hint'),
            t('theme-persist-hint'),
            t('theme-custom-hint'),
          ])
          return true
        }
        if (parts.length > 0) {
          setHelpOpen(false)
          const ok = setTheme(parts[0])
          channel.notify(
            ok ? t('theme-switched-saved', { name: parts[0] }) : t('theme-unknown', { name: parts[0] }),
            { color: ok ? 'success' : 'error' },
          )
          return true
        }
        setHelpOpen(false)
        setThemeIndex(Math.max(0, getThemeOptions().findIndex(option => option.value === themeName)))
        setThemePickerOpen(true)
        return true
      }
      case 'new': {
        // One-shot `/new` (issue #25): the old session stays persisted and
        // is recoverable via /resume, so discarding the live view is
        // non-destructive — no CC-style "press /new again" confirmation.
        setHelpOpen(false)
        void channel.newSession().then((ok) => {
          if (ok) channel.notify('New session started')
        })
        return true
      }
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
      case 'trace':
        // Open the trajectory view (issue #80): the timeline reads the live
        // session event log via channel.traceEvents() and follows new events
        // in real time (every session event bumps the channel version, which
        // re-renders this screen). Opens pinned to the newest entry.
        setHelpOpen(false)
        traceFollowRef.current = true
        setTraceFilter('all')
        setTraceCursor(0)
        setTraceOpen(true)
        return true
      case 'help':
        setHelpOpen(true)
        return true
      case 'model':
        setHelpOpen(false)
        setModelPickerOpen(true)
        void channel.listModels().then((list) => {
          setModels(list)
          const index = list.findIndex(
            model => model.provider === channel.provider && model.id === channel.model,
          )
          setModelIndex(index >= 0 ? index : 0)
        })
        return true
      case 'provider': {
        // Interactive add-provider wizard (/provider): drives the shared
        // question panel, persists profile + key via the channel's settings/
        // credentials seams. No picker state — AskUserQuestionPanel renders it.
        setHelpOpen(false)
        const host = channel.providerSetup()
        if (!host) {
          channel.notify(t('provider-unavailable'), { color: 'warning', timeoutMs: 8000 })
          return true
        }
        void runProviderWizard({
          host,
          ask: (request, options) => questionStore.ask(request, options),
          notify: (text, options) => channel.notify(text, options),
          pushLocal: (title, lines) => channel.pushLocal(title, lines),
          working: () => channel.working,
          switchModel: (provider, model) => channel.switchModel(provider, model),
        }).catch(() => {
          // The wizard notifies on every handled failure; this only swallows
          // an unexpected reject so it never surfaces as an unhandled promise.
        })
        return true
      }
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
          // The current session cannot be resumed into itself (agents.resume
          // rejects a live session), so it is excluded from the picker —
          // otherwise the fresh empty session of this launch always tops the
          // list as an unopenable row.
          const pickable = sessions.filter(session => session.id !== channel.agentId)
          setResumeSessions(pickable)
          if (pickable.length === 0) {
            channel.notify(t('resume-none-in-cwd'))
            return
          }
          setResumeMode('list')
          setResumePickerOpen(true)
          setResumeIndex(0)
        })()
        return true
      }
      case 'workspace': {
        setHelpOpen(false)
        const trimmed = rawInput.trim()
        const separator = trimmed.search(/\s/u)
        const subcommand = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase()
        const input = separator < 0 ? '' : trimmed.slice(separator).trim()
        if (subcommand === '') {
          const extensions = channel.workspaceCommands()
            .map(command => ` | ${command.name}`)
            .join('')
          channel.pushLocal('/workspace', [t('workspace-command-usage', { commands: extensions })])
        } else if (subcommand === 'resume') {
          openWorkspaceResume()
        } else if (subcommand === 'rename') {
          if (input.length === 0) channel.notify(t('workspace-rename-usage'))
          else void channel.renameWorkspace(input)
        } else if (subcommand === 'open') {
          if (input.length === 0) channel.notify(t('workspace-open-usage'))
          else openWorkspaceTarget(input)
        } else if (channel.workspaceCommands().some(command =>
          command.name.toLowerCase() === subcommand
          || command.aliases?.some(alias => alias.toLowerCase() === subcommand))) {
          void channel.runWorkspaceCommand(subcommand, input).then((result) => {
            if (result !== undefined) handleWorkspaceResult(result)
          }).catch((error: unknown) => {
            channel.notify(
              t('workspace-command-failed', { err: error instanceof Error ? error.message : String(error) }),
              { color: 'error', timeoutMs: 8000 },
            )
          })
        } else {
          channel.notify(t('workspace-command-unknown', { command: subcommand }), { color: 'error' })
        }
        return true
      }
      case 'rename': {
        setHelpOpen(false)
        const title = rawInput.trim()
        if (title.length === 0) {
          channel.pushLocal('/rename', [
            t('rename-current', { title: channel.sessionTitle || '—' }),
            t('rename-usage'),
          ])
          return true
        }
        channel.renameSession(title)
        channel.notify(t('rename-done', { title }))
        return true
      }
      case 'rewind':
        // Same picker as PromptInput's double-Esc on an empty input (CC
        // rewind); `openRewind` notifies when there is nothing to rewind.
        setHelpOpen(false)
        openRewind()
        return true
      case 'exit':
      case 'quit':
      case 'q':
        onExit()
        return true
      case 'status': {
        const usage = channel.lastUsage
        const pct =
          channel.contextWindow === undefined
            ? undefined
            : Math.max(0, Math.min(100, Math.round((channel.tokens.input / channel.contextWindow) * 100)))
        const lines: string[] = [
          `${t('status-model', { model: channel.model })}${channel.reasoningEffort ? ` · ${capitalize(channel.reasoningEffort)} effort` : ''}`,
          `${t('status-state', { state: channel.working ? t('status-working') : t('status-idle') })}`,
          `${t('status-session', { id: channel.agentId })}`,
          `${t('status-dir', { cwd: channel.displayCwd })}${channel.gitBranch ? ` · ${channel.gitBranch}` : ''}`,
          `Tokens ${formatTokens(channel.tokens.input)} in → ${formatTokens(channel.tokens.output)} out`,
        ]
        if (usage !== undefined) {
          const total = usage.input + usage.cacheRead + usage.cacheWrite
          const rate = total > 0 ? ((usage.cacheRead / total) * 100).toFixed(1) : '0.0'
          lines.push(t('cost-cache-rate', { rate, read: formatTokens(usage.cacheRead), write: formatTokens(usage.cacheWrite) }))
        }
        if (pct !== undefined) lines.push(t('cost-context', { pct }))
        if (channel.sessionTitle) lines.push(t('status-title', { title: channel.sessionTitle }))
        setHelpOpen(false)
        channel.pushLocal('/status', lines)
        return true
      }
      case 'cost': {
        const usage = channel.lastUsage
        const lines = [
          `Tokens ${formatTokens(channel.tokens.input)} in → ${formatTokens(channel.tokens.output)} out`,
        ]
        if (usage !== undefined) {
          const total = usage.input + usage.cacheRead + usage.cacheWrite
          const rate = total > 0 ? ((usage.cacheRead / total) * 100).toFixed(1) : '0.0'
          lines.push(t('cost-cache-hit-rate', { rate, read: formatTokens(usage.cacheRead), write: formatTokens(usage.cacheWrite) }))
        }
        lines.push(t('cost-note'))
        setHelpOpen(false)
        channel.pushLocal('/cost', lines)
        return true
      }
      case 'config': {
        const userHome = process.env.USERPROFILE ?? ''
        const lines = [
          t('doctor-example-config', { path: 'dsh --profile dsh-tui' }),
          t('doctor-user-config', { path: `${userHome}/.dsh/profiles/dsh-tui/cordis.patch.yml` }),
          '',
          t('doctor-launch-hint'),
          t('doctor-route-hint'),
        ]
        setHelpOpen(false)
        channel.pushLocal('/config', lines)
        return true
      }
      case 'doctor':
        setHelpOpen(false)
        channel.pushLocal('/doctor', channel.doctorInfo())
        return true
      case 'export': {
        const target = channel.exportSession()
        channel.notify(
          target === null
            ? t('export-failed')
            : t('export-saved', { target }),
          target === null ? { color: 'error', timeoutMs: 8000 } : { timeoutMs: 8000 },
        )
        return true
      }
      case 'init': {
        const result = channel.initWorkspace()
        if (result === null) channel.notify(t('agentsmd-create-failed'), { color: 'error' })
        else if (result === 'exists') channel.notify(t('agentsmd-exists'))
        else channel.notify(t('agentsmd-created', { result }))
        return true
      }
      case 'agents':
        setHelpOpen(false)
        void channel.listSubagents().then((lines) => {
          channel.pushLocal('/agents', lines)
        })
        return true
      case 'login': {
        const key = process.env.DEEPSEEK_API_KEY
        const lines = [
          `${t('login-api-key', { key: key ? key.slice(0, 6) + '…' + key.slice(-4) : t('login-key-missing') })}`,
          `${t('login-base-url', { url: process.env.DEEPSEEK_BASE_URL ?? t('login-official-endpoint') })}`,
          t('login-source-hint'),
        ]
        setHelpOpen(false)
        channel.pushLocal('/login', lines)
        return true
      }
      case 'logout':
        channel.notify(t('login-logout-hint'))
        return true
      case 'permissions':
        setHelpOpen(false)
        channel.pushLocal('/permissions', [
          t('permissions-policy-hint'),
          t('permissions-approval-hint'),
          // /permission comes from the dsh-base permission-presets row via the
          // commands registry; only advertise it when this composition
          // actually mounted it (the bare cordis.yml leaf has no
          // permission-presets, so the command does not exist there).
          ...(channel.commandList.some(command => command.name === 'permission')
            ? [t('permissions-preset-hint')]
            : []),
        ])
        return true
      case 'add-dir':
        setHelpOpen(false)
        channel.pushLocal('/add-dir', [
          t('permissions-root-hint', { cwd: channel.cwd }),
          t('permissions-path-hint'),
        ])
        return true
      case 'hooks':
        setHelpOpen(false)
        channel.pushLocal('/hooks', [
          t('hooks-not-mounted'),
          t('hooks-mount-hint'),
        ])
        return true
      case 'mcp':
        setHelpOpen(false)
        channel.pushLocal('/mcp', channel.mcpStatus())
        return true
      case 'memory':
        setHelpOpen(false)
        channel.pushLocal('/memory', [
          t('memory-none'),
          t('memory-hint'),
        ])
        return true
      case 'update':
        setHelpOpen(false)
        if (onUpdate === undefined) {
          channel.notify(t('update-unavailable'), { color: 'warning' })
        } else if (channel.working) {
          channel.notify(t('update-working'), { color: 'warning' })
        } else {
          channel.notify(t('update-starting'))
          onUpdate()
        }
        return true
      case 'vim':
        channel.notify(t('vim-not-implemented'))
        return true
      case 'terminal-setup':
        setHelpOpen(false)
        channel.pushLocal('/terminal-setup', [
          t('terminal-setup-hint'),
          t('terminal-paste-hint', { mod: modLabel }),
        ])
        return true
      case 'btw': {
        // CC /btw：单轮无工具侧问，overlay 态纯 UI，不打断主回合、不写
        // 会话历史。空参数只提示用法。
        setHelpOpen(false)
        const question = rawInput.trim()
        if (!question) {
          channel.notify(t('btw-usage'), { timeoutMs: 3000 })
          return true
        }
        btwAbortRef.current?.abort()
        const controller = new AbortController()
        btwAbortRef.current = controller
        setBtw({ question, answer: '', done: false })
        void channel.sideQuestion(question, {
          signal: controller.signal,
          onText: delta => setBtw(prev => (prev ? { ...prev, answer: prev.answer + delta } : prev)),
        }).then(result => {
          if (controller.signal.aborted) return
          setBtw(prev => (prev ? { ...prev, answer: result.answer ?? prev.answer, error: result.error, done: true } : prev))
        })
        return true
      }
      case 'connect':
        setHelpOpen(false)
        channel.pushLocal('/connect', [t('connect-none')])
        return true
      case 'audit':
      case 'bug':
      case 'practice':
      case 'review':
      case 'pr_comments':
      case 'release-notes':
      case 'vuln-check': {
        // CC's skill commands: drive the DSH skill system by sending the
        // activation prompt to the model (it loads the skill via its skill
        // catalog/load tools when the SKILL.md ships in ~/.dsh/skills).
        const key = SKILL_PROMPTS[name]
        if (key) channel.submit(t(key))
        return true
      }
      default: {
        // Plugin-registered command (DSH command registry): dispatch through
        // the channel, whose execution logs command/run + command/done (the
        // plan-mode projection folds those records, so /plan state stays
        // consistent). Unknown names fall through to the model.
        const external = channel.commandList.find(
          command => command.external && command.name === name,
        )
        if (external) {
          setHelpOpen(false)
          void channel.runExternalCommand(name, rawInput).then((text) => {
            if (text !== undefined && text !== '') {
              channel.notify(text)
            } else if (text === undefined) {
              channel.notify(`/${name}: no such command`, { color: 'error' })
            }
          })
          return true
        }
        return false
      }
    }
  }

  // === Message-selection mode (CC's Shift+↑ message actions) ===
  // NOTE: rows is a live in-place array on the channel (no new reference per
  // update), so derived lists must be computed per render — a useMemo keyed
  // on `channel.rows` would freeze at the first empty snapshot forever.
  // Both lists only feed their respective modes; computing them
  // unconditionally cost an O(rows) scan + array allocation per render
  // (every streamed chunk), so they are gated on the consuming mode.
  const selectableRows = selectionActive
    ? channel.rows.filter(row => SELECTABLE_KINDS.has(row.kind))
    : NO_ROWS

  // ctrl+r history search: substring match on the query, newest first.
  const historyMatches = React.useMemo(() => {
    const q = historyQuery.trim().toLowerCase()
    return q ? historyEntries.filter(e => e.text.toLowerCase().includes(q)) : historyEntries
  }, [historyEntries, historyQuery])

  // Double-Esc rewind: the user's own messages, newest first (CC lists the
  // selectable user turns; steering side-questions are excluded). Computed
  // per render while the picker is open — `channel.rows` is a live in-place
  // array (see selectableRows).
  const rewindRows = rewindOpen
    ? channel.rows
      .filter(row => row.kind === 'user' && row.label === undefined)
      .reverse()
    : NO_ROWS
  /** Open the rewind picker (from PromptInput's double-Esc on an empty input). */
  const openRewind = () => {
    // rewindOpen is still false this render, so rewindRows is empty — scan
    // directly instead of reading the gated list.
    const candidates = channel.rows
      .filter(row => row.kind === 'user' && row.label === undefined)
      .reverse()
    if (candidates.length === 0) {
      channel.notify(t('rewind-none'))
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
      channel.notify(t('rewind-done'))
    }
  }

  // `/trace` timeline: extend the incremental build with the session's
  // current event snapshot, then apply the /thinking gate and the type
  // filter. Computed per render while open (channel events bump `version`);
  // extendTrace only consumes the appended tail, so a long session costs
  // O(new events), never O(log), per frame.
  if (traceOpen) {
    traceBuildRef.current = extendTrace(traceBuildRef.current, channel.traceEvents())
  }
  const traceEntries: readonly TraceEntry[] = traceOpen && traceBuildRef.current !== null
    ? filterTraceEntries(
      thinkingVisible
        ? traceBuildRef.current.entries
        : traceBuildRef.current.entries.filter(entry => entry.kind !== 'thinking'),
      traceFilter,
    )
    : NO_TRACE_ENTRIES
  /** Effective cursor: pinned to the newest entry while following, clamped
   *  against the (possibly filtered) list otherwise. */
  const traceCursorClamped = traceEntries.length === 0
    ? 0
    : traceFollowRef.current
      ? traceEntries.length - 1
      : Math.min(traceCursor, traceEntries.length - 1)

  // Row seeking under layout virtualization: a mounted row seeks directly;
  // an unmounted one is force-mounted first, then sought by the completion
  // effect below once its ref lands.
  const [forceMountRowId, setForceMountRowId] = React.useState<number | null>(null)
  const seekRow = (rowId: number): void => {
    const el = rowRefsRef.current.get(rowId)
    if (el) {
      handle?.scrollToElement(el)
      return
    }
    setForceMountRowId(rowId)
  }
  React.useLayoutEffect(() => {
    if (forceMountRowId === null) return
    const el = rowRefsRef.current.get(forceMountRowId)
    if (el) {
      handle?.scrollToElement(el)
      setForceMountRowId(null)
    }
  })

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
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty/filtered list
    if (target) {
      seekRow(target.row.id)
    }
  }, [searchQuery, searchOpen])

  // n/N navigation: move the current match into view.
  React.useEffect(() => {
    if (!searchOpen) return
    const target = searchMatches[searchCurrent]
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty/filtered list
    if (target) {
      seekRow(target.row.id)
    }
  }, [searchCurrent])

  const enterSelection = () => {
    setSelectionActive(true)
    const last = selectableRows[selectableRows.length - 1]
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: empty selectable list
    setSelectedId(last ? last.id : null)
  }
  const moveSelection = (delta: 1 | -1) => {
    if (selectedId === null) return
    const index = selectableRows.findIndex(row => row.id === selectedId)
    if (index < 0) return
    const next = selectableRows[index + delta]
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index
    if (next) setSelectedId(next.id)
  }
  // useCallback: these feed MessageList → MemoRow's shallow compare; fresh
  // closures each render would defeat every row's memo.
  const toggleRowExpanded = React.useCallback((rowId: number) => {
    setExpandedRows((previous) => {
      const next = new Set(previous)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }, [])
  const registerRowRef = React.useCallback((rowId: number, el: DOMElement | null) => {
    if (el) rowRefsRef.current.set(rowId, el)
    else rowRefsRef.current.delete(rowId)
  }, [])
  /** Deduplicate terminals that report one Enter as parsed Return then raw CR/LF. */
  const lastModalEnterAtRef = React.useRef(0)

  useInput((input, key, event) => {
    // The /btw panel owns the keyboard while open (its own useInput handles
    // Esc/Enter/Space close, ↑/↓ scroll, c copy; everything else is
    // swallowed there). Chat registered first, so an early return here does
    // not block the event from reaching the panel.
    if (btw !== null) return
    // The questionnaire / approval panel owns the keyboard while one is
    // pending (the panel's own useInput handles ↑/↓/Space/Tab/Enter/Esc;
    // the prompt input is unmounted, so nothing else should see these keys).
    if (questionSnapshot !== null || approvalSnapshot !== null) return
    const returnCandidate = isPlainReturnInput(input, key)
    const returnNow = Date.now()
    const plainReturn = returnCandidate && returnNow - lastModalEnterAtRef.current >= 80
    if (plainReturn) lastModalEnterAtRef.current = returnNow
    // Mouse wheel scrolls the transcript — in fullscreen there is no
    // terminal scrollback (alt-screen), so this is the only way back.
    // Imperative scrollBy: no React re-render per notch (CC semantics).
    // Events only arrive with mouse tracking on; inline mode never sees
    // them, so this is a no-op there.
    if (key.wheelUp || key.wheelDown) {
      handle?.scrollBy(key.wheelUp ? -3 : 3)
      event.stopImmediatePropagation()
      return
    }
    // Esc clears a settled mouse selection first (CC precedence), ahead of
    // every other Esc meaning below (close pickers, interrupt the turn).
    // hasSelection() is an imperative read — no subscription needed.
    if (key.escape && hasMouseSelection()) {
      clearMouseSelection()
      event.stopImmediatePropagation()
      return
    }
    if (searchOpen) {
      // Transcript search bar (less-style): edit the query, Enter commits
      // (query persists for n/N), Esc/ctrl+c cancels back to the anchor.
      if (key.escape || (key.ctrl && input === 'c')) {
        setSearchOpen(false)
        setHighlight('')
        handle?.scrollTo(searchAnchorRef.current)
      } else if (plainReturn) {
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
      } else if (!key.ctrl && !key.meta && !key.super && input) {
        const next = searchQuery.slice(0, searchCursor) + input + searchQuery.slice(searchCursor)
        setSearchQuery(next)
        setSearchCursor(searchCursor + input.length)
      }
      event.stopImmediatePropagation()
      return
    }
    // After Enter closed the search bar, n/N keep walking the matches
    // (CC: "Query persists across bar open/close so n/N keep working").
    // Transcript mode only — in prompt mode n/N are ordinary input chars.
    if (expanded && input === 'n' && searchQuery && searchCount > 0 && !key.ctrl && !key.meta && !key.super) {
      setSearchCurrent(i => (i >= searchCount - 1 ? 0 : i + 1))
      event.stopImmediatePropagation()
      return
    }
    if (expanded && input === 'N' && searchQuery && searchCount > 0 && !key.ctrl && !key.meta && !key.super) {
      setSearchCurrent(i => (i <= 0 ? searchCount - 1 : i - 1))
      event.stopImmediatePropagation()
      return
    }
    if (thinkingOpen) {
      if (thinkingConfirm !== null) {
        // Confirmation state: Enter applies, Esc backs out to the select.
        if (plainReturn) {
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
      } else if (plainReturn) {
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
    if (workspaceFlow !== null) {
      if (key.escape) {
        if (workspaceFlowInput !== null && !workspaceFlowBusy) {
          setWorkspaceFlowInput(null)
          return
        }
        workspaceFlowAbortRef.current?.abort()
        workspaceFlowAbortRef.current = null
        workspaceFlowRequestRef.current += 1
        setWorkspaceFlowBusy(false)
        setWorkspaceFlow(null)
        return
      }
      if (workspaceFlowBusy) return
      if (workspaceFlowInput !== null) {
        const choice = workspaceFlow.choices.find(candidate => candidate.id === workspaceFlowInput.choiceId)
        const editor = choice?.input
        if (plainReturn) {
          const value = workspaceFlowInput.value.trim()
          if (value.length === 0) {
            channel.notify(t('workspace-flow-input-empty'), { color: 'warning' })
          } else if (editor !== undefined) {
            runWorkspaceFlowAction(signal => editor.submit(value, signal))
          }
        } else if (key.backspace && workspaceFlowInput.cursor > 0) {
          setWorkspaceFlowInput(current => current === null ? null : {
            ...current,
            value: current.value.slice(0, current.cursor - 1) + current.value.slice(current.cursor),
            cursor: current.cursor - 1,
          })
        } else if (key.delete && workspaceFlowInput.cursor < workspaceFlowInput.value.length) {
          setWorkspaceFlowInput(current => current === null ? null : {
            ...current,
            value: current.value.slice(0, current.cursor) + current.value.slice(current.cursor + 1),
          })
        } else if (key.leftArrow) {
          setWorkspaceFlowInput(current => current === null ? null : {
            ...current,
            cursor: Math.max(0, current.cursor - 1),
          })
        } else if (key.rightArrow) {
          setWorkspaceFlowInput(current => current === null ? null : {
            ...current,
            cursor: Math.min(current.value.length, current.cursor + 1),
          })
        } else if (input.length > 0 && !key.ctrl && !key.meta && !key.super && !key.tab) {
          setWorkspaceFlowInput(current => current === null ? null : {
            ...current,
            value: current.value.slice(0, current.cursor) + input + current.value.slice(current.cursor),
            cursor: current.cursor + input.length,
          })
        }
        return
      }
      if (key.upArrow) {
        setWorkspaceFlowIndex(index => (index <= 0 ? workspaceFlow.choices.length - 1 : index - 1))
      } else if (key.downArrow) {
        setWorkspaceFlowIndex(index => (index >= workspaceFlow.choices.length - 1 ? 0 : index + 1))
      } else if (key.tab && !key.shift) {
        const choice = workspaceFlow.choices[workspaceFlowIndex]
        if (choice?.input !== undefined) {
          const value = choice.input.initialValue ?? ''
          setWorkspaceFlowInput({
            choiceId: choice.id,
            value,
            cursor: value.length,
            ...(choice.input.placeholder === undefined ? {} : { placeholder: choice.input.placeholder }),
          })
        }
      } else if (plainReturn) {
        const choice = workspaceFlow.choices[workspaceFlowIndex]
        if (choice !== undefined) {
          runWorkspaceFlowAction(signal => choice.choose(signal))
        }
      }
      return
    }
    if (workspacePickerOpen) {
      if (key.upArrow) {
        setWorkspaceIndex(index => (index <= 0 ? workspaceTargets.length - 1 : index - 1))
      } else if (key.downArrow) {
        setWorkspaceIndex(index => (index >= workspaceTargets.length - 1 ? 0 : index + 1))
      } else if (plainReturn) {
        const target = workspaceTargets[workspaceIndex]
        setWorkspacePickerOpen(false)
        if (target !== undefined) void channel.switchWorkspace(target)
      } else if (key.escape) {
        setWorkspacePickerOpen(false)
      }
      return
    }
    if (resumePickerOpen) {
      const resumeSession = resumeSessions[resumeIndex]
      // Session management modes (issue #112): the list keys stay untouched
      // until ctrl+d/ctrl+r switch into a sub-mode, each with Enter/Esc.
      if (resumeMode === 'confirm-delete') {
        if (plainReturn) {
          setResumeMode('list')
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
          if (resumeSession) {
            const target = resumeSession
            void (async () => {
              const ok = await channel.deleteSession(target.id)
              if (!ok) {
                channel.notify(t('resume-delete-failed', { name: target.title || target.id }), { color: 'error' })
                return
              }
              channel.notify(t('resume-deleted', { name: target.title || target.id }))
              // Refresh right away so the row disappears in place; closing
              // the picker when nothing resumable remains.
              const sessions = await channel.listSessions()
              const pickable = sessions.filter(session => session.id !== channel.agentId)
              setResumeSessions(pickable)
              if (pickable.length === 0) {
                setResumePickerOpen(false)
              } else {
                setResumeIndex(index => Math.min(index, pickable.length - 1))
              }
            })()
          }
        } else if (key.escape) {
          setResumeMode('list')
        }
        return
      }
      if (resumeMode === 'rename') {
        if (plainReturn) {
          setResumeMode('list')
          const title = resumeRenameText.trim()
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
          if (resumeSession && title.length > 0) {
            const target = resumeSession
            void (async () => {
              const ok = await channel.renameSessionTo(target.id, title)
              if (!ok) {
                channel.notify(t('resume-rename-failed', { name: target.title || target.id }), { color: 'error' })
                return
              }
              channel.notify(t('rename-done', { title }))
              // Re-list so the row reflects the persisted state, but patch
              // the renamed row's title explicitly: listSessions resolves
              // persisted titles only within the MRU top SESSION_TITLE_DEPTH
              // window, and a freshly renamed row must never snap back to
              // the basename fallback in between.
              const sessions = await channel.listSessions()
              const next = sessions
                .filter(session => session.id !== channel.agentId)
                .map(session => (session.id === target.id ? { ...session, title } : session))
              setResumeSessions(next)
              // Re-anchor focus on the renamed row: renameSessionTo touches
              // MRU, so the re-listed order shifts — a kept index would
              // silently point at a DIFFERENT session, and a following
              // Enter/ctrl+d would act on the wrong one (review leftover).
              const anchored = next.findIndex(session => session.id === target.id)
              if (anchored >= 0) setResumeIndex(anchored)
            })()
          }
        } else if (key.escape) {
          setResumeMode('list')
        } else if (key.backspace) {
          setResumeRenameText(text => text.slice(0, -1))
        } else if (!key.ctrl && !key.meta && !key.super && input) {
          // Single-line title: pasted newlines collapse to spaces.
          setResumeRenameText(text => text + input.replace(/[\r\n]+/g, ' '))
        }
        return
      }
      if (key.upArrow) {
        setResumeIndex(index => (index <= 0 ? resumeSessions.length - 1 : index - 1))
      } else if (key.downArrow) {
        setResumeIndex(index => (index >= resumeSessions.length - 1 ? 0 : index + 1))
      } else if (plainReturn) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
        if (resumeSession) {
          // Enter switches the live agent to the persisted session right
          // away (the history replays into the transcript); the resume.txt
          // launcher marker is refreshed by resumeTo so `--resume` on the
          // next launch opens the same session.
          setResumePickerOpen(false)
          void channel.resumeTo(resumeSession.id).then((ok) => {
            if (ok) channel.notify(t('resume-resumed'))
          })
        } else {
          setResumePickerOpen(false)
        }
      } else if (key.escape) {
        setResumePickerOpen(false)
      } else if (isMod(key) && input === 'd' && resumeSession) {
        setResumeMode('confirm-delete')
      } else if (isMod(key) && input === 'r' && resumeSession) {
        setResumeRenameText(resumeSession.title || '')
        setResumeMode('rename')
      }
      return
    }
    if (modelPickerOpen) {
      if (key.upArrow) {
        setModelIndex(index => (index <= 0 ? models.length - 1 : index - 1))
      } else if (key.downArrow) {
        setModelIndex(index => (index >= models.length - 1 ? 0 : index + 1))
      } else if (plainReturn) {
        const model = models[modelIndex]
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
        if (model) {
          // Enter switches the live model right away: the conversation is
          // forked at its end and continued with an agent routed to the new
          // model (history replays unchanged).
          setModelPickerOpen(false)
          channel.notify(t('model-switching', { name: model.name }))
          void channel.switchModel(model.provider, model.id).then((ok) => {
            if (ok) channel.notify(t('model-switched', { name: model.name }))
          })
        } else {
          setModelPickerOpen(false)
        }
      } else if (key.escape) {
        setModelPickerOpen(false)
      }
      return
    }
    if (activityPickerOpen) {
      if (key.upArrow) {
        setActivityIndex(index => (index <= 0 ? PRESET_NAMES.length - 1 : index - 1))
      } else if (key.downArrow) {
        setActivityIndex(index => (index >= PRESET_NAMES.length - 1 ? 0 : index + 1))
      } else if (plainReturn) {
        const name = PRESET_NAMES[activityIndex]
        setActivityPickerOpen(false)
        if (name) channel.setActivityFrames(name)
      } else if (key.escape) {
        setActivityPickerOpen(false)
      }
      return
    }
    if (effortSliderOpen) {
      if (key.leftArrow || key.rightArrow) {
        const delta = key.leftArrow ? -1 : 1
        const next = (effortIndex + delta + effortOptions.length) % effortOptions.length
        setEffortIndex(next)
        const option = effortOptions[next]
        // Live-apply: the slider IS the control; Esc does not revert.
        if (option) void channel.setEffort(option.id)
      } else if (plainReturn || key.escape) {
        setEffortSliderOpen(false)
      }
      return
    }
    if (presetPickerOpen) {
      if (key.upArrow) {
        setPresetIndex(index => (index <= 0 ? presetOptions.length - 1 : index - 1))
      } else if (key.downArrow) {
        setPresetIndex(index => (index >= presetOptions.length - 1 ? 0 : index + 1))
      } else if (plainReturn) {
        const option = presetOptions[presetIndex]
        setPresetPickerOpen(false)
        if (option) void channel.switchPreset(option.id)
      } else if (key.escape) {
        setPresetPickerOpen(false)
      }
      return
    }
    if (themePickerOpen) {
      const options = getThemeOptions()
      if (key.upArrow) {
        setThemeIndex(index => (index <= 0 ? options.length - 1 : index - 1))
      } else if (key.downArrow) {
        setThemeIndex(index => (index >= options.length - 1 ? 0 : index + 1))
      } else if (plainReturn) {
        setThemePickerOpen(false)
        const name = options[themeIndex]?.value
        if (name !== undefined) {
          const ok = setTheme(name)
          channel.notify(
            ok ? t('theme-switched-saved', { name }) : t('theme-switch-failed', { name }),
            { color: ok ? 'success' : 'error' },
          )
        }
      } else if (key.escape) {
        setThemePickerOpen(false)
      }
      return
    }
    if (historyOpen) {
      if (key.escape) {
        setHistoryOpen(false)
      } else if (key.ctrl && (input === 'c' || input === 'd')) {
        // CC's history search cancels on ctrl+c/ctrl+d too.
        setHistoryOpen(false)
      } else if (plainReturn) {
        const entry = historyMatches[historyFocus]
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty match list
        if (entry) {
          setHistoryFill(entry.text)
          setHistoryOpen(false)
        }
      } else if (key.upArrow) {
        setHistoryFocus(index =>
          historyMatches.length === 0 ? 0 : (index <= 0 ? historyMatches.length - 1 : index - 1),
        )
      } else if (key.downArrow || (isMod(key) && input === 'r')) {
        // CC's historySearch:next — ↓ and repeat ctrl+r walk to the next match.
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
      } else if (!key.ctrl && !key.meta && !key.super && input) {
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
        if (plainReturn) {
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
      } else if (plainReturn) {
        const row = rewindRows[rewindIndex]
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
        if (row) setRewindConfirm(row)
      } else if (key.escape) {
        setRewindOpen(false)
        setRewindConfirm(null)
      }
      return
    }
    if (traceOpen) {
      // Trajectory view (issue #80): read-only timeline navigation. ↑/↓ and
      // PgUp/PgDn move the cursor (any upward move unpins tail-following,
      // landing back on the newest entry re-pins it); g/G jump top/bottom;
      // `f` cycles the type filter (all → tool → thinking → message →
      // progress); Esc/q closes back to the conversation.
      const last = traceEntries.length - 1
      const letter = input !== '' && !key.ctrl && !key.meta
      if (key.escape || (letter && input === 'q')) {
        setTraceOpen(false)
      } else if (key.upArrow) {
        traceFollowRef.current = false
        setTraceCursor(Math.max(0, traceCursorClamped - 1))
      } else if (key.downArrow) {
        const next = Math.min(last, traceCursorClamped + 1)
        setTraceCursor(next)
        traceFollowRef.current = next >= last
      } else if (key.pageUp) {
        traceFollowRef.current = false
        setTraceCursor(Math.max(0, traceCursorClamped - TRACE_WINDOW))
      } else if (key.pageDown) {
        const next = Math.min(last, traceCursorClamped + TRACE_WINDOW)
        setTraceCursor(next)
        traceFollowRef.current = next >= last
      } else if (key.home || (letter && input === 'g')) {
        traceFollowRef.current = false
        setTraceCursor(0)
      } else if (key.end || (letter && input === 'G')) {
        traceFollowRef.current = true
        setTraceCursor(Math.max(0, last))
      } else if (letter && input === 'f') {
        const index = TRACE_FILTERS.indexOf(traceFilter)
        setTraceFilter(TRACE_FILTERS[(index + 1) % TRACE_FILTERS.length] ?? 'all')
        // The filtered list re-anchors to the newest entry.
        traceFollowRef.current = true
        setTraceCursor(0)
      }
      return
    }
    if (isMod(key) && input === 't') {
      // Toggle the startup loaded-context panel (keyboard only — the
      // ported ink core handles no mouse clicks).
      setLoadedContextOpen(previous => !previous)
    }
    if (isMod(key) && input === 'r' && !helpOpen) {
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
      } else if (plainReturn && selectedId !== null) {
        toggleRowExpanded(selectedId)
      } else if (key.escape) {
        setSelectionActive(false)
        setSelectedId(null)
      }
    } else if (key.escape && channel.working) {
      // CC's chat:cancel — esc interrupts a running turn (the prompt input
      // only sees esc when idle, where it has the double-tap-clear meaning).
      // With messages queued for delivery, interrupt-and-deliver them right
      // away (Codex behavior); otherwise a plain interrupt parks the queue.
      if (channel.pending.length > 0) {
        const count = channel.interruptAndDeliver(channel.pending.map(item => item.text))
        if (count > 0) {
          channel.notify(t('interrupt-delivered', { n: count }), { timeoutMs: 2500 })
        }
      } else {
        channel.cancel()
      }
      event.stopImmediatePropagation()
    } else if (isMod(key) && input === 'o') {
      // Leaving transcript mode (Ctrl+O) — search was already handled above.
      setExpanded(previous => !previous)
    } else if (input === '/' && !key.ctrl && !key.meta && !key.super) {
      // `/` in transcript mode (Ctrl+O expanded, CC's REPL semantics:
      // search is active on the transcript screen where `/` isn't a command).
      if (expanded) {
        searchAnchorRef.current = handle?.getScrollTop() ?? 0
        setSearchQuery('')
        setSearchCursor(0)
        setSearchCurrent(0)
        setSearchCount(0)
        setSearchOpen(true)
        event.stopImmediatePropagation()
      }
    } else if (key.ctrl && (input === 'c' || input === 'd')) {
      // CC's app:exit — ctrl+c interrupts a running turn; idle ctrl+c
      // CLEARS a non-empty prompt (single press) and only arms the
      // double-press exit when the input is empty; ctrl+d keeps the
      // time-based double-press exit regardless.
      if (channel.working) {
        channel.cancel()
      } else if (input === 'c' && promptControllerRef.current?.hasText()) {
        promptControllerRef.current.clear()
        // A pending exit arm no longer makes sense once the user is editing.
        exitPendingRef.current = false
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
      } else {
        requestExit()
      }
    } else if (isMod(key) && input === 'l') {
      // CC's app:redraw — clear the physical terminal and repaint.
      instances.get(process.stdout)?.forceRedraw()
    } else if (isMod(key) && input === 'e') {
      setShowAllMessages(previous => !previous)
    } else if (plainReturn && showPill) {
      handle?.scrollToBottom()
    }
  })

  // Working-activity line (spinner slot): context-pressure prefix shares the
  // StatusLine thresholds (amber ≥ 80, red ≥ 95).
  const activityWarnPct = contextPressurePct(channel.lastUsage, channel.contextWindow)
  /** Prompt input is inert while a modal dialog owns the keyboard. */
  const promptSelectionActive =
    selectionActive || modelPickerOpen || resumePickerOpen || workspacePickerOpen || workspaceFlow !== null || activityPickerOpen ||
    effortSliderOpen || presetPickerOpen || themePickerOpen || thinkingOpen || historyOpen || rewindOpen || searchOpen ||
    btw !== null ||
    traceOpen

  return (
    <Box flexDirection="column" flexGrow={1} width="100%">
      {!isSticky && channel.lastUserText && (
        <StickyPromptHeader
          text={channel.lastUserText}
          onClick={() => {
            // Click jumps back to the pinned prompt (CC's StickyPromptHeader).
            const lastUser = [...channel.rows].reverse().find(row => row.kind === 'user')
            if (lastUser) seekRow(lastUser.id)
            else handle?.scrollToBottom()
          }}
        />
      )}
      <ScrollBox ref={setHandle} flexDirection="column" flexGrow={1} flexShrink={1} stickyScroll>
        <LogoHeader
          model={channel.model}
          effort={channel.reasoningEffort}
          cwd={channel.displayCwd}
        />
        {/* The startup loaded-context panel: before the first message the
            transcript is empty, so the collapsed summary of what this
            conversation will load (system prompt, workspace instructions,
            skills, tools) sits at the top; the first rows take over. */}
        {channel.rows.length === 0 && channel.loadedContext !== undefined && (
          <LoadedContextPanel
            context={channel.loadedContext}
            open={loadedContextOpen}
            onToggle={() => { setLoadedContextOpen(previous => !previous) }}
          />
        )}
        <MessageList
          rows={channel.rows}
          expanded={expanded}
          expandedRows={expandedRows}
          selectedId={selectionActive ? selectedId : null}
          onToggleRow={toggleRowExpanded}
          model={channel.model}
          showAll={showAllMessages}
          thinkingVisible={thinkingVisible}
          onToggleAll={() =>{  setShowAllMessages(previous => !previous) }}
          onLoadOlder={() => channel.loadOlder()}
          registerRowRef={registerRowRef}
          scrollHandle={handle}
          forceMountRowId={forceMountRowId}
          newSinceRowId={isSticky ? null : lastSeenRowIdRef.current}
          onUnseenCount={setUnseenCount}
        />
      </ScrollBox>
      {/* Bottom chrome (pill, spinners, dialogs, prompt, statusline): never
          let flex shrink squeeze these fixed-height rows — the ScrollBox
          above absorbs all overflow (it is the scroll container). */}
      <Box flexDirection="column" flexShrink={0}>
        {showPill && (
          <NewMessagesPill
            count={unseenCount}
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
            // `activity: false`, the classic spinner still renders. The line
            // hugs the left edge (no padding) so the self-narration reads as
            // part of the transcript, aligned with the `❯` prompt below.
              <Box marginTop={1}>
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
        {workspacePickerOpen && workspaceTargets.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <WorkspacePicker
              targets={workspaceTargets}
              focusIndex={workspaceIndex}
              currentCwd={channel.cwd}
            />
          </Box>
        )}
        {workspaceFlow !== null && (
          <Box flexDirection="column" marginTop={1}>
            <WorkspaceFlowPicker
              title={workspaceFlow.title}
              choices={workspaceFlow.choices}
              focusIndex={workspaceFlowIndex}
              busy={workspaceFlowBusy}
              input={workspaceFlowInput}
            />
          </Box>
        )}
        {resumePickerOpen && resumeSessions.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <ResumePicker
              sessions={resumeSessions}
              focusIndex={resumeIndex}
              currentSessionId={channel.agentId}
              mode={resumeMode}
              renameText={resumeRenameText}
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
                currentModel={`${channel.provider}/${channel.model}`}
              />
            )}
          </Box>
        )}
        {activityPickerOpen && (
          <Box flexDirection="column" marginTop={1}>
            <ActivityPicker
              focusIndex={activityIndex}
              currentPreset={channel.activityFrames}
            />
          </Box>
        )}
        {effortSliderOpen && effortOptions.length > 1 && (
          <Box flexDirection="column" marginTop={1}>
            <EffortSlider
              options={effortOptions}
              focusIndex={effortIndex}
              currentId={channel.reasoningEffort}
            />
          </Box>
        )}
        {presetPickerOpen && presetOptions.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <PresetPicker
              presets={presetOptions}
              focusIndex={presetIndex}
              currentPreset={channel.agentPreset}
            />
          </Box>
        )}
        {themePickerOpen && (
          <Box flexDirection="column" marginTop={1}>
            <ThemePicker focusIndex={themeIndex} currentTheme={themeName} />
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
        {traceOpen && (
          <Box flexDirection="column" marginTop={1}>
            <TraceView
              entries={traceEntries}
              cursor={traceCursorClamped}
              filter={traceFilter}
            />
          </Box>
        )}
        {searchOpen && <TranscriptSearchBar query={searchQuery} cursorOffset={searchCursor} count={searchCount} current={searchCurrent} />}
        <GoalTodoPanel channel={channel} />
        {approvalSnapshot !== null ? (
          <ApprovalPanel
            key={approvalSnapshot.key}
            approval={approvalSnapshot}
            onDecide={outcome => approvals.decide(outcome)}
          />
        ) : btw !== null ? (
          <Box flexDirection="column" marginTop={1}>
            <BtwPanel
              question={btw.question}
              answer={btw.answer}
              error={btw.error}
              streaming={!btw.done}
              onClose={closeBtw}
              onCopy={() => {
                void setClipboard(btw.answer ?? '').then(raw => { if (raw) process.stdout.write(raw) })
                channel.notify(t('copied-chars', { n: (btw.answer ?? '').length }), { timeoutMs: 1500 })
              }}
            />
          </Box>
        ) : questionSnapshot !== null ? (
          <AskUserQuestionPanel
            key={questionSnapshot.key}
            question={questionSnapshot.question}
            position={questionSnapshot.position}
            total={questionSnapshot.total}
            answered={questionSnapshot.answered}
            onAnswer={selection => questionStore.answerCurrent(selection)}
            onCancel={() => questionStore.cancelCurrent()}
          />
        ) : (
          <PromptInput
            channel={channel}
            helpOpen={helpOpen}
            onToggleHelp={() =>{  setHelpOpen(previous => !previous) }}
            onRunCommand={runCommand}
            selectionActive={promptSelectionActive}
            fillText={historyFill}
            onFillConsumed={() =>{  setHistoryFill(null) }}
            onRewindRequest={openRewind}
            controllerRef={promptControllerRef}
          />
        )}
        <StatusLine
          channel={channel}
          selectionActive={selectionActive}
          helpOpen={helpOpen}
        />
      </Box>
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
  onClick: () => void
}): React.ReactNode {
  const [hover, setHover] = React.useState(false)
  return (
    <Box
      flexShrink={0}
      width="100%"
      height={1}
      paddingRight={1}
      backgroundColor={hover ? 'userMessageBackgroundHover' : 'userMessageBackground'}
      onMouseEnter={() =>{  setHover(true) }}
      onMouseLeave={() =>{  setHover(false) }}
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
        onMouseEnter={() =>{  setHover(true) }}
        onMouseLeave={() =>{  setHover(false) }}
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
          {t('picker-title-model')}
        </Text>
        <LoadingState
          message={t('model-loading')}
          bold
          subtitle={t('model-loading-subtitle')}
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
        <Text color="error">{t('search-no-matches')} </Text>
      ) : count > 0 ? (
        <Text dimColor>
          {Math.min(current + 1, count)}/{count}{'  '}
        </Text>
      ) : null}
    </NoSelect>
  )
}
