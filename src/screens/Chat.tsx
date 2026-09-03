import React from 'react'
import { t, getLang, setLang, isLang, writeLangPref, readLangPref, subscribeLang, LANGS, type Lang } from '../i18n.js'
import { readThemePref } from '../themePrefs.js'
import { readPresetPref } from '../presetPrefs.js'
import { readModelPref } from '../modelPrefs.js'
import { readActivityFrames } from '../activityPrefs.js'
import { envThemeOverride } from '../components/design-system/ThemeProvider.js'
import { hasPath } from '../dsh-adapter/settingsEditor.js'
import { planReload, type ReloadKind } from '../reload.js'
import { AlternateScreen, Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTheme, useTerminalSize } from '../ui.js'
import * as tuiKit from '../ui.js'
import { usePageInset } from '../components/PageMargin.js'
import { POINTER } from '../cc/figures.js'
import { isPlainReturnInput, modLabel } from '../utils/modifiers.js'
import { actionMatches } from '../utils/keymap.js'
import { formatTokens } from '../cc/format.js'
import { homeDir } from '../utils/paths.js'
import type { LlmModelInfo, LlmProviderInfo } from '../dsh-adapter/types.js'
import { cleanRenderText, cleanScalarText } from '../dsh-adapter/sanitize.js'
import {
  deriveModelGroups,
  modelPickerLanding,
  recentCatalogModels,
  RECENTS_GROUP_PROVIDER,
} from '../modelGroups.js'
import { readModelRecents, recordModelUse, type ModelRecentsRef } from '../modelRecents.js'
import { sessionCwdMatches, type Channel, type ChatRow, type EffortOption, type PermissionPresetSnapshot, type PresetOption, type SkillInfo } from '../dsh-adapter/channel.js'
import type { QuestionStore } from '../dsh-adapter/questions.js'
import { TuiDialogStore } from '../dsh-adapter/dialogs.js'
import { TuiStatusStore } from '../dsh-adapter/status.js'
import type { TuiShortcutHost } from '../dsh-adapter/shortcuts.js'
import type { TuiThemeHost } from '../dsh-adapter/themes.js'
import type { TuiRewindMode } from '../dsh-adapter/extension-events.js'
import { runProviderWizard } from '../dsh-adapter/providerWizard.js'
import { ApprovalStore } from '../dsh-adapter/approvals.js'
import { AskUserQuestionPanel } from '../components/questions/AskUserQuestionPanel.js'
import { ApprovalPanel } from '../components/approvals/ApprovalPanel.js'
import { ExtensionDialog } from '../components/ExtensionDialog.js'
import type { DOMElement } from '../ink/dom.js'
import { useSearchHighlight } from '../ink/hooks/use-search-highlight.js'
import { useTerminalTitle } from '../ink/hooks/use-terminal-title.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { useCopyOnSelect } from '../ink/hooks/use-copy-on-select.js'
import { useSelection } from '../ink/hooks/use-selection.js'
import { NoSelect } from '../ink/components/NoSelect.js'
import { LogoHeader, MessageList } from '../components/MessageList.js'
import { TimelineRail } from '../components/TimelineRail.js'
import { ScrollbarGutter } from '../components/ScrollbarGutter.js'
import type { TimelineSnapshot } from '../ink/timeline-rail.js'
import { normalizeScrollGutter } from '../tuiDisplayPrefs.js'
import { OverlayAbove } from '../components/OverlayAbove.js'
import { TooltipLayer } from '../components/Tooltip.js'
import { PromptInput, type PromptController } from '../components/PromptInput.js'
import type { InjectController } from '../dsh-adapter/inject-channel.js'
import { PromptEditorLayer } from '../components/PromptEditor.js'
import { GoalTodoPanel } from '../components/GoalTodoPanel.js'
import { AutoRecapRow } from '../components/AutoRecapRow.js'
import { BalanceReportRow } from '../components/BalanceReportRow.js'
import type { BalanceResult } from '../deepseekBalance.js'
import { LoadedContextPanel } from '../components/LoadedContextPanel.js'
import { StatusLine } from './StatusLine.js'
import { WorkingSpinner, useThinkingStatus } from '../components/WorkingSpinner.js'
import { ActivityLine, contextPressurePct } from '../components/ActivityLine.js'
import { ModelPicker } from '../components/ModelPicker.js'
import { PluginSceneBoundary } from '../components/PluginSceneBoundary.js'
import { SkillsPicker, SkillsPickerLoading } from '../components/SkillsPicker.js'
import { SessionBrowser } from './SessionBrowser.js'
import { SessionTree } from './SessionTree.js'
import { Settings } from './Settings.js'
import { WorkspacePicker } from '../components/WorkspacePicker.js'
import { WorkspaceMenuPicker } from '../components/WorkspaceMenuPicker.js'
import { WorkspaceFlowPicker } from '../components/WorkspaceFlowPicker.js'
import type { TuiWorkspaceCommandResult, TuiWorkspaceTarget } from '../workspaces.js'
import { ActivityPicker } from '../components/ActivityPicker.js'
import { ColorPicker } from '../components/ColorPicker.js'
import { EffortSlider } from '../components/EffortSlider.js'
import { PresetPicker } from '../components/PresetPicker.js'
import { PermissionsPicker } from '../components/PermissionsPicker.js'
import { PlanPicker } from '../components/PlanPicker.js'
import { LangPicker } from '../components/LangPicker.js'
import { ThemePicker, getThemeOptions } from '../components/ThemePicker.js'
import { AUTO_THEME_NAME, getAutoThemeBase } from '../theme.js'
import { FRAME_PRESETS, PRESET_NAMES } from '../components/activityFrames.js'
import { ThinkingToggle } from '../components/ThinkingToggle.js'
import { HistorySearchDialog } from '../components/HistorySearchDialog.js'
import { RewindPicker } from '../components/RewindPicker.js'
import { BtwPanel } from '../components/BtwPanel.js'
import { RecapPanel } from '../components/RecapPanel.js'
import { isValidSessionColor, SESSION_COLOR_NAMES } from '../cc/sessionColors.js'
import { TipsPanel } from '../components/TipsPanel.js'
import { SubagentDashboard } from '../components/SubagentDashboard.js'
import { JobsPanel } from '../components/JobsPanel.js'
import { SubagentDetailScene } from '../components/SubagentDetailScene.js'
import { FileActionsPanel, FILE_ACTION_COUNT } from '../components/FileActionsPanel.js'
import { openExternal, openFile, revealInFileManager } from '../utils/openExternal.js'
import { resolveTargetPath } from '../utils/fileTarget.js'
import { classifyOpenTarget } from '../utils/urlGuard.js'
import { statSync } from 'node:fs'
import { setClipboard } from '../ink/termio/osc.js'
import { TerminalWriteContext } from '../ink/useTerminalNotification.js'
import instances from '../ink/instances.js'
import { useAnimationFrame } from '../ink/hooks/use-animation-frame.js'
import { useExternalVersion } from '../hooks/useExternalVersion.js'
import { TrajectoryScene } from './TrajectoryScene.js'
import { AgentView } from './AgentView.js'
import { extendTrajectory, projectWave, type TrajBuild } from '../dsh-adapter/trajectory/index.js'
import { miniWakeWidth } from '../components/trajectory/MiniWake.js'
import { readTrajectorySeen, writeTrajectorySeen } from '../trajectoryPrefs.js'
import type { SessionEvent } from '../dsh-adapter/types.js'
import { LoadingState } from '../components/design-system/LoadingState.js'
import { Pane } from '../components/design-system/Pane.js'
import { loadHistory, type HistoryEntry } from '../history.js'
import { formatLoadedContextReport } from '../utils/loaded-context.js'
import {
  NO_OVERLAY,
  chatOverlayReducer,
  dialogOverlayVisible,
  wrapIndex,
  type WorkspaceFlowInput,
} from './chatOverlay.js'

/** Shared empty snapshot for hosts whose channel has no event log. */
const NO_EVENTS: readonly SessionEvent[] = []

const PERMISSION_RESULT_CELLS = 200

function cleanPermissionError(error: unknown): string {
  try {
    if (error instanceof Error) {
      return typeof error.message === 'string'
        ? cleanRenderText(error.message, PERMISSION_RESULT_CELLS)
        : ''
    }
    return cleanScalarText(error, PERMISSION_RESULT_CELLS)
  } catch {
    return ''
  }
}

function clonePermissionPresetSnapshot(snapshot: PermissionPresetSnapshot): PermissionPresetSnapshot {
  return {
    availability: snapshot.availability,
    options: snapshot.options.map(option => ({ ...option })),
    ...(snapshot.current === undefined ? {} : { current: { ...snapshot.current } }),
  }
}

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

/** `max` → `Max` (effort levels arrive lower-case from the adapter). */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
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
 * (with the user message the viewport is showing pinned above the transcript
 * while scrolled up, and a 1-column minimap scrollbar with one node per
 * user message — the current message's node is highlighted, clicking a node
 * jumps to it), transient notifications, the working spinner, the bordered
 * prompt
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

/**
 * Shared inert extension stores for hosts that render Chat without the
 * dsh-tui-extensions row (headless verify scripts, bare embeds). Never
 * written, so the dialog panel and the plugin status line never mount and
 * no shortcut ever matches.
 */
let fallbackDialogStore: TuiDialogStore | undefined
let fallbackStatusStore: TuiStatusStore | undefined

export function Chat({
  channel,
  questionStore,
  approvalStore,
  extensionDialogs,
  extensionStatus,
  extensionShortcuts,
  themeHost,
  onExit,
  onUpdate,
  onRestart,
  fullscreen = false,
  trajectorySeen: trajectorySeenProp,
  injectControllerRef,
}: {
  channel: Channel
  questionStore: QuestionStore
  /**
   * The approval seam's UI store. Optional: hosts without an approval
   * channel (headless scripts, older embeds) render Chat without it and
   * simply never see an approval panel — the question panel keeps its seat.
   */
  approvalStore?: ApprovalStore
  /**
   * The managed plugin dialog queue (tuiDialogs service's store). Optional
   * for the same hosts as approvalStore; absent, plugin dialog requests
   * park unanswered (their `timeoutMs` is the plugin's guard).
   */
  extensionDialogs?: TuiDialogStore
  /** Plugin status-line contributions (tuiStatus service's store). */
  extensionStatus?: TuiStatusStore
  /** Host-only keyboard shortcut dispatch path. */
  extensionShortcuts?: TuiShortcutHost
  /** Optional runtime theme host; static JSON themes work without it. */
  themeHost?: TuiThemeHost
  onExit: () => void
  /** Update the installed package and restart the current TUI process. */
  onUpdate?: () => void
  /** Restart the current TUI process and resume this session (no update). */
  onRestart?: () => void
  /**
   * True when the host already wrapped this tree in `<AlternateScreen>`
   * (`fullscreen: true`). Both full-screen surfaces need this — the trajectory
   * scene and the session browser: entering the alt
   * screen a second time is harmless, but the inner unmount's DEC 1049 exit
   * would drop the whole app back to the main screen.
   */
  fullscreen?: boolean
  /**
   * Whether the trajectory has been opened before on this machine.
   *
   * A prop rather than a filesystem read inside the component: a render
   * initializer touching disk is the wrong layer, and hosts that already know
   * (or tests that need determinism) can simply say. Falls back to the
   * persisted flag when the host does not supply one.
   */
  trajectorySeen?: boolean
  /**
   * External injection controller (dsh-adapter/inject-channel.ts). When the
   * host runs the injection socket, Chat publishes `{ append, submit }` into
   * this ref every render so the adapter-owned socket drives the prompt input
   * without reaching into React state directly. Absent for hosts that do not
   * open the channel (headless scripts, bare embeds).
   */
  injectControllerRef?: React.RefObject<InjectController | null>
}) {
  const writeRaw = React.useContext(TerminalWriteContext)
  // Re-render whenever the channel mutates; rows/status are read fresh below.
  // DEFAULT lane on purpose (useExternalVersion): the channel version bumps
  // at streaming cadence (every ~16ms via emitStream), and a useSyncExternalStore
  // wakeup would force a SyncLane render per bump — each such sync commit
  // preempting the in-flight Default render and ending with Default work
  // still pending feeds React's nested-update counter until error #185 kills
  // the process (beta.3; the reveal-store half was PR #680, this is the
  // channel half — the surviving source on Windows timer granularity).
  useExternalVersion(channel.subscribe, () => channel.version)
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
  // The pending managed plugin dialog (tuiDialogs seam): a plugin's
  // select/confirm/input request parks here until the panel settles it.
  // Priority sits right below the approval panel (a gated tool outranks a
  // plugin's question) and above the questionnaire. Hosts without the
  // extensions row share one inert store that never holds a dialog.
  const dialogs = extensionDialogs ?? (fallbackDialogStore ??= new TuiDialogStore())
  const dialogSnapshot = React.useSyncExternalStore(
    listener => dialogs.subscribe(listener),
    () => dialogs.getSnapshot(),
  )
  // Plugin status-line contributions (tuiStatus seam): keyed texts joined
  // into one line above the prompt.
  const statusContributions = extensionStatus ?? (fallbackStatusStore ??= new TuiStatusStore())
  const statusEntries = React.useSyncExternalStore(
    listener => statusContributions.subscribe(listener),
    () => statusContributions.getSnapshot(),
  )
  // Shortcut handler failures surface as toasts (the registry also logs
  // them); the hook is re-pointed on every mount so a stale closure never
  // outlives its channel.
  React.useEffect(() => {
    if (extensionShortcuts === undefined) return
    return extensionShortcuts.setErrorHandler(combo => {
      channel.notify(t('ext-shortcut-failed', { combo }), { color: 'error', timeoutMs: 4000 })
    })
  }, [extensionShortcuts, channel])
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
  /**
   * Conversation timeline snapshot (reported by MessageList): one entry
   * per user turn plus the viewport-derived navigation targets. The
   * ACTIVE turn — the one whose content owns the viewport top row — pins
   * the sticky prompt header AND highlights the transcript rail's tick,
   * from one report so the two can never disagree; upId/downId drive the
   * rail's ▲/▼. Null activeId while pinned to the bottom only when there
   * are no turns (header hidden there anyway).
   */
  const [timeline, setTimeline] = React.useState<TimelineSnapshot>({
    turns: [],
    activeId: null,
    upId: null,
    downId: null,
  })
  const [selectionActive, setSelectionActive] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<number | null>(null)
  const [expandedRows, setExpandedRows] = React.useState<ReadonlySet<number>>(
    () => new Set(),
  )
  /** 流式 reasoning 行相对 thinkingFold 默认值的用户切换。与
   *  expandedRows 分开：preview 默认三行、full 默认全文，点击在两者间
   *  翻转；落定后自动回到普通行的折叠语义。 */
  const [streamViewToggledRows, setStreamViewToggledRows] = React.useState<ReadonlySet<number>>(
    () => new Set(),
  )
  /**
   * The transient-dialog layer (every picker/dialog `<OverlayAbove>` hosts,
   * plus /tips) as ONE value: mutual exclusion between the panels is
   * structural instead of emerging from "an open picker makes the prompt
   * inert". Transitions live in the pure reducer (chatOverlay.ts), which
   * scripts/verify-chat-overlay.ts pins without a renderer. Async data the
   * pickers show (model list, preset roster, …) stays in the caches below —
   * it persists across open/close so a reopened picker paints the previous
   * list while the fresh one loads, exactly as the boolean era did.
   */
  const [overlay, dispatchOverlay] = React.useReducer(chatOverlayReducer, NO_OVERLAY)
  // Chat and PromptInput both receive one parsed stdin batch. Keep the
  // permission focus synchronous so arrow+Enter in the same batch uses the
  // post-arrow row rather than the previous render's index.
  const permissionOverlayFocusRef = React.useRef<{ overlay: unknown; index: number } | null>(null)
  React.useEffect(() => {
    if (overlay.kind === 'permission') {
      // Seed each concrete picker instance after commit. Keyboard handlers
      // update this ref synchronously; render must remain side-effect free.
      if (permissionOverlayFocusRef.current?.overlay !== overlay) {
        permissionOverlayFocusRef.current = { overlay, index: overlay.index }
      }
    } else {
      permissionOverlayFocusRef.current = null
    }
  }, [overlay])
  const [models, setModels] = React.useState<readonly LlmModelInfo[]>([])
  /** Provider display identities for the /model group level; refreshed alongside `models`. */
  const [providerInfos, setProviderInfos] = React.useState<readonly LlmProviderInfo[]>([])
  /** /model 最近使用分组：成功切换即记录（去重置顶，上限 10），重启保留。 */
  const [modelRecents, setModelRecents] = React.useState<readonly ModelRecentsRef[]>(() => readModelRecents())
  /** Two-level /model: the drilled-in provider route; undefined = group level.
   *  Reset on open; stale ids resolve back to the group level via `activeModelGroup`. */
  const [modelGroup, setModelGroup] = React.useState<string | undefined>(undefined)
  /** True while the picker sits in the single-provider fast path (drilled in
   *  at open, the group level never shown): Esc closes directly and no back
   *  hint renders — a pinned recents pseudo-group must not fake a two-level
   *  walk the user never saw (issue #527 regression: repro-picker-windowing). */
  const [modelPickerDirect, setModelPickerDirect] = React.useState(false)
  /** Group rows over the current catalog, first-appearance (registry) order,
   *  with the pinned recents pseudo-group first when any entry is catalogued. */
  const modelGroups = React.useMemo(
    () => deriveModelGroups(models, providerInfos, modelRecents),
    [models, providerInfos, modelRecents],
  )
  /** The drilled-in group, but only while it still exists in the catalog. */
  const activeModelGroup = modelGroup !== undefined && modelGroups.some(group => group.provider === modelGroup)
    ? modelGroup
    : undefined
  const groupModels = React.useMemo(() => {
    if (activeModelGroup === undefined) return []
    if (activeModelGroup === RECENTS_GROUP_PROVIDER) return recentCatalogModels(modelRecents, models)
    return models.filter(model => model.provider === activeModelGroup)
  }, [models, modelRecents, activeModelGroup])
  /** Switch + record: every successful switch feeds the /model recents group
   *  (picker Enter/click, `/model provider/id`, the wizard's live switch,
   *  and /reload's applied model all ride this one path). */
  const switchModelRecorded = (provider: string, id: string, name?: string): Promise<boolean> => {
    if (name !== undefined) channel.notify(t('model-switching', { name }))
    return channel.switchModel(provider, id).then((ok) => {
      if (!ok) return ok
      if (name !== undefined) channel.notify(t('model-switched', { name }))
      setModelRecents(recordModelUse({ provider, id }))
      return ok
    })
  }
  /** `/skills` 技能目录（issue #204）：null = 注册表快照在途。 */
  const [skillsList, setSkillsList] = React.useState<readonly SkillInfo[] | null>(null)
  /** `/resume` opens the session browser, a screen rather than a panel. It
   *  owns its own selection, filters and keyboard — Chat only opens it. */
  const [browserOpen, setBrowserOpen] = React.useState(false)
  /** `/tree` opens the session family tree (pi's Session Tree): every rewind
   *  fork stitched back onto the message it diverged from, hover previews,
   *  and per-node rewind/fork/adopt actions. Like the browser, a screen. */
  const [treeOpen, setTreeOpen] = React.useState(false)
  /** `/agentview` and `/bg` open the agent view — a screen like the browser:
   *  it owns selection, the dispatch input and every key while up. */
  const [agentViewOpen, setAgentViewOpen] = React.useState(false)
  /** The session backgrounded when the view opened via ←/`/bg` (CC's "Esc
   *  returns to that conversation" return target), cleared on close. */
  const [agentViewReturnId, setAgentViewReturnId] = React.useState<string | undefined>(undefined)
  /** Live agent-view rows: the prompt footer's "← N agents" hint reads the
   *  needs-input count from here (cached snapshot in the channel). The
   *  `?.()` fallbacks keep pre-agent-view test stubs (channel facades in
   *  scripts/*) rendering — the real channel always provides the seams. */
  const EMPTY_AGENT_VIEW_ROWS: readonly never[] = []
  const agentViewRows = React.useSyncExternalStore(
    listener => channel.subscribeAgentView?.(listener) ?? (() => {}),
    () => channel.agentViewRows?.() ?? EMPTY_AGENT_VIEW_ROWS,
  )
  const backgroundAgentsNeedingInput = agentViewRows.filter(
    row => row.status === 'needs-input' && !row.current,
  ).length
  /** CC parity: background the attached session and open the agent view
   *  (`/bg`, `/background`, and ← on an empty prompt all land here). The
   *  backgrounded session becomes the view's return target (final Esc
   *  attaches back to it). */
  const backgroundToAgentView = React.useCallback((): void => {
    void channel.backgroundCurrent().then((result) => {
      if (result.ok) {
        setAgentViewReturnId(result.backgroundedSessionId)
        agentViewOpenSessionRef.current = channel.agentId
        setAgentViewOpen(true)
      }
    })
  }, [channel])
  /** `/settings` opens the plugin settings screen (issue #165) — like the
   *  browser, a screen rather than a panel: it owns its own focus, staged
   *  drafts and keyboard; Chat only opens it. */
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [workspaceTargets, setWorkspaceTargets] = React.useState<readonly TuiWorkspaceTarget[]>([])
  const workspaceFlowRequestRef = React.useRef(0)
  const workspaceFlowAbortRef = React.useRef<AbortController | null>(null)
  /** `/preset` agent-preset roster (issue #8): loads async, persists. */
  const [presetOptions, setPresetOptions] = React.useState<readonly PresetOption[]>([])
  /** `/effort` adapter levels: load async before the slider opens. */
  const [effortOptions, setEffortOptions] = React.useState<readonly EffortOption[]>([])
  const [themeName, setTheme] = useTheme()
  const { rows: terminalRows } = useTerminalSize()
  const [showAllMessages, setShowAllMessages] = React.useState(false)
  /** Fold state for the GoalTodoPanel todo section (ctrl/cmd+q or click). */
  const [todoCollapsed, setTodoCollapsed] = React.useState(false)
  const [thinkingVisible, setThinkingVisible] = React.useState(true)
  /** ctrl+r history-search entries (loaded on open, persists). */
  const [historyEntries, setHistoryEntries] = React.useState<readonly HistoryEntry[]>([])
  const [historyFill, setHistoryFill] = React.useState<string | null>(null)
  /** Monotonic token: only the latest rewind decision may land (a slow
   *  plugin answering after the user moved on must not open a confirm for
   *  a row they are no longer looking at). */
  const rewindRequestRef = React.useRef(0)
  /** /btw side-question overlay (CC): pure UI state — the answer never
   *  enters the transcript or the session log. */
  const [btw, setBtw] = React.useState<{ question: string; answer: string; error?: string; done: boolean } | null>(null)
  const btwAbortRef = React.useRef<AbortController | null>(null)
  const closeBtw = () => {
    btwAbortRef.current?.abort()
    btwAbortRef.current = null
    setBtw(null)
  }
  /** /recap overlay (pi-recap semantics): pure UI state like /btw — the
   *  summary never enters the transcript or session log; applying the
   *  proposed title goes through the normal /rename path. `auto` marks the
   *  recapOnOpen-triggered run (rendered as the dim AutoRecapRow until
   *  expanded); `expanded` lifts an auto recap into the full RecapPanel;
   *  `rowsAtTrigger` is the last user-row id when the auto run started —
   *  a newer user row (the user starts a new message) retires the recap. */
  const [recap, setRecap] = React.useState<{
    raw: string
    summary: string
    title?: string
    error?: string
    done: boolean
    titleApplied: boolean
    auto?: boolean
    expanded?: boolean
    rowsAtTrigger?: number
  } | null>(null)
  const recapAbortRef = React.useRef<AbortController | null>(null)
  const closeRecap = () => {
    recapAbortRef.current?.abort()
    recapAbortRef.current = null
    setRecap(null)
  }
  /** /balance report (`BalanceReportRow`): pure UI state like /recap — the
   *  result never enters the transcript or session log. Clicking the row
   *  re-queries (refreshing keeps the stale summary visible); a session
   *  switch retires the report. */
  const [balance, setBalance] = React.useState<{
    result: BalanceResult | null
    refreshing: boolean
  } | null>(null)
  const balanceSeqRef = React.useRef(0)
  const runBalance = React.useCallback(() => {
    const seq = ++balanceSeqRef.current
    setBalance(prev => ({ result: prev?.result ?? null, refreshing: true }))
    void channel.balanceInfo().then(result => {
      if (balanceSeqRef.current !== seq) return
      setBalance({ result, refreshing: false })
    })
  }, [channel])
  const balanceSessionId = channel.agentId
  React.useEffect(() => {
    setBalance(null)
  }, [balanceSessionId])
  // Auto-recap (`dsh-tui.recapOnOpen`): every time the session switches
  // (mount = open/resume, rewind/fork included), summarize its tail into
  // the dim AutoRecapRow. Failures stay silent in auto mode — `/recap`
  // surfaces them; the summary never enters the transcript or session log.
  const autoRecapSessionId = channel.agentId
  React.useEffect(() => {
    // A session switch retires the previous recap outright — an old
    // session's 回顾 has no place above a new conversation.
    setRecap(null)
    if (!channel.autoRecapOnOpen) return
    // No conversation yet (/new): nothing to recap, don't even fire.
    if (!channel.rows.some(row => row.kind === 'user' || row.kind === 'assistant')) return
    recapAbortRef.current?.abort()
    const controller = new AbortController()
    recapAbortRef.current = controller
    const lastUserId = channel.rows.filter(row => row.kind === 'user').at(-1)?.id ?? -1
    setRecap({ raw: '', summary: '', error: undefined, done: false, titleApplied: false, auto: true, expanded: false, rowsAtTrigger: lastUserId })
    void channel.recapRecent({
      signal: controller.signal,
      onText: delta => setRecap(prev => (prev ? { ...prev, raw: prev.raw + delta } : prev)),
    }).then(result => {
      if (controller.signal.aborted) return
      setRecap(prev => {
        if (prev === null || !prev.auto) return prev
        // Auto mode stays quiet on failure (no activity / llm missing / error).
        if (result.summary === null) return null
        return { ...prev, summary: result.summary, title: result.title, error: result.error, done: true }
      })
    })
    return () => controller.abort()
  }, [autoRecapSessionId])
  // The user starts a new message → the auto recap has served its purpose
  // (catching them up) and bows out. A newer user row is the signal; the
  // assistant's own streamed rows don't count.
  const lastUserRowId = channel.rows.filter(row => row.kind === 'user').at(-1)?.id ?? -1
  React.useEffect(() => {
    if (
      recap !== null &&
      recap.auto &&
      recap.rowsAtTrigger !== undefined &&
      lastUserRowId > recap.rowsAtTrigger
    ) {
      closeRecap()
    }
  }, [lastUserRowId, recap])
  /**
   * Session switches that do not go through `/new` (agent-view attach,
   * backgrounding, `/resume`) remount the transcript tree without resetting
   * view-local state. Row-id-based UI would keep pointing at rows of the
   * PREVIOUS session (ids restart at 0 after an adopt), so the new session
   * renders with stale folds/expansion/selection — the "entered a freshly
   * dispatched session and it renders wrong" bug. Reset the same set `/new`
   * resets, plus the search overlay and the side question, and repaint the
   * transcript from the top.
   */
  const repaintTranscript = (): void => {
    const ink = instances.get(process.stdout) ?? instances.values().next().value
    // Wait one task so React commits the new session's tree before the
    // scrollback clear repaints (same pattern as `/new`).
    setTimeout(() => {
      handle?.scrollTo(0)
      ink?.clearScrollbackAndRedraw()
    }, 0)
  }
  const lastAgentIdRef = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    const id = channel.agentId
    if (lastAgentIdRef.current === undefined) {
      lastAgentIdRef.current = id
      return
    }
    if (lastAgentIdRef.current === id) return
    lastAgentIdRef.current = id
    setExpanded(false)
    setExpandedRows(new Set())
    setSelectedId(null)
    setSelectionActive(false)
    setShowAllMessages(false)
    setLoadedContextOpen(false)
    setSearchQuery('')
    setSearchCursor(0)
    setSearchCount(0)
    setSearchCurrent(0)
    closeBtw()
    repaintTranscript()
  }, [channel.agentId]) // eslint-disable-line react-hooks/exhaustive-deps
  /** The session attached when the agent view opened; a close on a
   *  DIFFERENT session means a switch happened inside the view, and the
   *  transcript repaint cannot be skipped. */
  const agentViewOpenSessionRef = React.useRef<string | undefined>(undefined)
  /**
   * Leaving a whole screen (agent view, browser) remounts the transcript
   * tree, which would replay the ~3.4s whale opening animation on every
   * close — competing with resumed or streaming rows for frame budget.
   * Suppress the intro on those remounts; `/deepseek` re-enables it.
   */
  const suppressLogoIntroRef = React.useRef(false)
  /** Subagent dashboard (Ctrl+A): displays active/completed subagents. */
  const [subagentDashboardOpen, setSubagentDashboardOpen] = React.useState(false)
  const [jobsPanelOpen, setJobsPanelOpen] = React.useState(false)
  /** Detail view for a specific subagent (opened from dashboard). */
  const [subagentDetailId, setSubagentDetailId] = React.useState<string | null>(null)
  /**
   * Hidden `/deepseek` easter egg: each invocation bumps this key so the
   * logo header remounts and replays the whale spout + text shimmer.
   */
  const [logoNonce, setLogoNonce] = React.useState(0)
  React.useEffect(() => () => btwAbortRef.current?.abort(), [])
  React.useEffect(() => () => recapAbortRef.current?.abort(), [])
  /**
   * The trajectory scene (issue #80 evolution). Unlike every other overlay
   * here it is not a panel but a whole screen: while open, Chat renders the
   * scene INSTEAD of the conversation (see the early return below) and hands
   * it the keyboard. Chat itself stays mounted, so scroll position, pickers
   * and in-flight turn state survive the round trip untouched.
   */
  const [sceneOpen, setSceneOpen] = React.useState(false)
  /**
   * Close the scene.
   *
   * Leaving the alternate screen makes the terminal restore the main buffer;
   * Ink restores the matching saved frame and diffs any conversation changes
   * that happened while the scene was open.
   */
  const closeScene = React.useCallback(() => {
    setSceneOpen(false)
  }, [])

  /** Open the scene, mark failures seen, and retire the key hint for good. */
  const openScene = React.useCallback(() => {
    seenFailuresRef.current = trajectoryRef.current?.counts.errors ?? 0
    setTrajectorySeen(previous => {
      if (!previous) writeTrajectorySeen()
      return true
    })
    setSceneOpen(true)
  }, [])
  /** The startup summary gives way to transcript rows after the first local command or message. */
  const loadedContextVisible = channel.rows.length === 0 && channel.loadedContext !== undefined
  /** Startup context panel: collapsed by default, toggled with Ctrl+P. */
  const [loadedContextOpen, setLoadedContextOpen] = React.useState(false)
  /**
   * The context panel changes the height of the main-screen transcript by a
   * large amount. In inline mode that invalidates the renderer's previous
   * scrollback/layout correspondence; asking it to repaint from the physical
   * viewport prevents the collapsed frame from reusing stale blank cells.
   */
  const toggleLoadedContext = React.useCallback(() => {
    setLoadedContextOpen(previous => !previous)
    const ink = instances.get(process.stdout) ?? instances.values().next().value
    ink?.invalidatePrevFrame()
    ink?.reanchorViewport()
  }, [])

  /**
   * Click-to-act targets: the Ink instance's hyperlink-open callback (wired
   * in the effect below) resolves every clickable target the transcript
   * renders — http(s) links open the browser, `dsh-file:`/`file://` paths
   * open the file-action menu. `dsh-file:` payloads are RAW display paths
   * (possibly relative), so they resolve against the CURRENT channel cwd
   * at click time (read through a ref so this callback keeps a stable
   * identity — it is threaded into memoized row components).
   */
  const cwdRef = React.useRef(channel.cwd)
  React.useEffect(() => {
    cwdRef.current = channel.cwd
  }, [channel.cwd])
  const openFileActions = React.useCallback((rawPath: string): void => {
    const resolved = resolveTargetPath(rawPath, cwdRef.current)
    // Whether the target is a directory decides the first menu row's label
    // ("open file" vs "open folder"). Missing paths count as files.
    let isDir = false
    try {
      isDir = statSync(resolved).isDirectory()
    } catch {
      isDir = false
    }
    dispatchOverlay({ type: 'open', overlay: { kind: 'file-actions', path: resolved, index: 0, isDir } })
  }, [])

  /** Run one file-action menu row: 0 = open file, 1 = reveal in file
   *  manager, 2 = copy absolute path. */
  const runFileAction = React.useCallback((index: number, path: string): void => {
    if (index === 0) openFile(path)
    else if (index === 1) revealInFileManager(path)
    else void setClipboard(path)
  }, [])

  const handleOpenTarget = React.useCallback((url: string): void => {
    const classification = classifyOpenTarget(url)
    if (classification.kind === 'file-actions') {
      openFileActions(classification.path)
      return
    }
    if (classification.kind === 'external') {
      openExternal(url)
      return
    }
    // Non-http(s) schemes from model/plugin-shaped links are not handed to
    // the OS handler — see urlGuard.ts. Silently ignored: a toast needs
    // channel state the Ink click path does not carry.
  }, [openFileActions])

  // Wire the click-to-open callback into the Ink instance (the field is
  // otherwise never set — clicking links was a no-op). Re-wired whenever
  // the handler changes (cwd moves), cleared on unmount.
  React.useEffect(() => {
    const ink = instances.get(process.stdout) ?? instances.values().next().value
    if (ink) ink.onHyperlinkClick = handleOpenTarget
    return () => {
      const current = instances.get(process.stdout) ?? instances.values().next().value
      if (current) current.onHyperlinkClick = undefined
    }
  }, [handleOpenTarget])
  /** `/` transcript search (less-style incsearch, ported from CC's REPL).
   *  Only the bar's open/closed mode lives in `overlay`; the query and match
   *  counters persist past the bar closing so n/N keep walking the matches. */
  const searchActive = overlay.kind === 'search'
  const [searchQuery, setSearchQuery] = React.useState('')
  const [searchCursor, setSearchCursor] = React.useState(0)
  const [searchCount, setSearchCount] = React.useState(0)
  const [searchCurrent, setSearchCurrent] = React.useState(0)
  const searchAnchorRef = React.useRef(0)
  const rowRefsRef = React.useRef(new Map<number, DOMElement>())
  const { setQuery: setHighlight } = useSearchHighlight()

  // Sticky (pinned-to-bottom) scroll state, subscribed imperatively so
  // wheel events don't re-render React — only the header/pill flip.
  // Deliberately KEPT on useSyncExternalStore despite the SyncLane wakeup
  // cost: the renderer's at-bottom re-pin flips sticky WITHOUT firing the
  // scroll subscribers (see ScrollBox's subscribe doc), so only uSES's
  // every-render getSnapshot check picks that flip up — a pure
  // notification-driven subscription misses it and the new-message pill
  // stops reflecting reality (repro-pill). Wheel cadence is an
  // interaction-rate source (not streaming-rate), the streaming-side
  // #185 sources are all Default-lane now, and the overflow guard
  // backstops the residue.
  const isSticky = React.useSyncExternalStore(
    cb => (handle ? handle.subscribe(cb) : () => {}),
    () => (handle ? handle.isSticky() : true),
  )
  const subscribeTooltipInvalidation = React.useCallback(
    (listener: () => void) => (handle ? handle.subscribe(listener) : () => {}),
    [handle],
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
  // The pill shows whenever the view is off the bottom (one-click return
  // home): with unseen rows it counts them, otherwise it is the plain
  // "return to bottom" affordance (Enter/End/click all land it).
  const showPill = !isSticky

  // Idle Ctrl+C: first press arms an exit, second press exits (CC's
  // double-press semantics, simplified). Under Windows ConPTY the key
  // arrives as stdin data (key.ctrl && input === 'c') — the useInput
  // branch below is the only path; SIGINT is not emitted.
  const exitPendingRef = React.useRef(false)
  const exitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // Live view into the prompt's text for the Ctrl+C rule (clears text when
  // non-empty; the double-press exit only arms on an empty input).
  const promptControllerRef = React.useRef<PromptController | null>(null)
  // Publish the external-injection controller (dsh.nvim etc.) every render so
  // the adapter-owned socket can append to the prompt and submit. `submit`
  // mirrors an Enter press: `channel.submit` routes through the DSH inbox
  // (queued after the current turn while working), then the input is cleared.
  React.useEffect(() => {
    if (!injectControllerRef) return
    injectControllerRef.current = {
      append: (text: string) => {
        promptControllerRef.current?.append(text)
      },
      submit: () => {
        const controller = promptControllerRef.current
        if (!controller) return
        const text = controller.append('').trim()
        if (text === '') return
        channel.submit(text)
        controller.clear()
        channel.notify(
          channel.working ? t('input-sent-after-turn') : t('input-injected'),
          { timeoutMs: 2500 },
        )
      },
    }
    return () => {
      injectControllerRef.current = null
    }
  })
  const requestExit = () => {
    if (exitPendingRef.current) {
      onExit()
    } else {
      exitPendingRef.current = true
      channel.notify(t('exit-press-again'))
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
  const uploadTokensRef = React.useRef(0)
  const loadingStartTimeRef = React.useRef(0)
  const totalPausedMsRef = React.useRef(0)
  const pauseStartTimeRef = React.useRef<number | null>(null)
  responseLengthRef.current = channel.responseChars
  // Most recent request's real upload (input + cache read/write occupy the
  // wire exactly like the context window); 0 until the first usage event.
  const lastUploadTokens = channel.lastUsage === undefined
    ? 0
    : channel.lastUsage.input + channel.lastUsage.cacheRead + channel.lastUsage.cacheWrite
  uploadTokensRef.current = lastUploadTokens
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
    if (result.kind === 'target') {
      dispatchOverlay({ type: 'close-if', kind: 'workspace-flow' })
      void channel.switchWorkspace(result.target)
      return
    }
    if (result.choices.length === 0) {
      dispatchOverlay({ type: 'close-if', kind: 'workspace-flow' })
      channel.notify(t('workspace-command-empty'))
      return
    }
    // open-if: 'workspace-flow' stays allowed so an in-flow action can
    // transition to its next stage; a picker the user opened after leaving
    // the menu wins over a late command result.
    dispatchOverlay({
      type: 'open-if',
      overlay: { kind: 'workspace-flow', flow: result, index: 0, busy: false, input: null },
      when: ['none', 'workspace-flow'],
    })
  }

  const runWorkspaceFlowAction = (
    action: (signal: AbortSignal) => Promise<TuiWorkspaceCommandResult> | TuiWorkspaceCommandResult,
  ): void => {
    const request = ++workspaceFlowRequestRef.current
    const controller = new AbortController()
    workspaceFlowAbortRef.current = controller
    dispatchOverlay({ type: 'flow-busy', busy: true })
    void Promise.resolve()
      .then(() => action(controller.signal))
      .then((result) => {
        if (request === workspaceFlowRequestRef.current) handleWorkspaceResult(result)
      })
      .catch((error: unknown) => {
        if (request !== workspaceFlowRequestRef.current) return
        workspaceFlowAbortRef.current = null
        dispatchOverlay({ type: 'flow-busy', busy: false })
        channel.notify(
          t('workspace-command-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
      })
  }

  /** Bare `/workspace` menu rows: built-in subcommands first, then the
   *  dynamically registered extensions (same reserved-name filter the Tab
   *  completion applies). Recomputed per render — the extension list is
   *  live. */
  const workspaceMenuOptions: ReadonlyArray<{ id: string; label: string; description: string }> = [
    { id: 'resume', label: 'resume', description: t('workspace-menu-resume-desc') },
    { id: 'rename', label: 'rename', description: t('workspace-menu-rename-desc') },
    { id: 'open', label: 'open', description: t('workspace-menu-open-desc') },
    // Optional call: verify/repro scripts and embedders stub the channel
    // without the workspace-commands API — render must not throw for them
    // (a thrown render unmounts the whole Ink root).
    ...(channel.workspaceCommands?.() ?? [])
      .filter(command => !['resume', 'rename', 'open'].includes(command.name.toLowerCase()))
      .map(command => ({ id: command.name, label: command.name, description: command.description })),
  ]

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
      // open-if: the listing is async — whatever the user opened meanwhile wins.
      dispatchOverlay({
        type: 'open-if',
        overlay: {
          kind: 'workspace-picker',
          index: Math.max(0, targets.findIndex(target => target.cwd === channel.cwd)),
        },
        when: ['none'],
      })
    }).catch((error: unknown) => {
      channel.notify(
        t('workspace-list-failed', { err: error instanceof Error ? error.message : String(error) }),
        { color: 'error' },
      )
    })
  }

  /**
   * Run one /workspace menu row (Enter path, shared with the mouse click):
   * built-ins dispatch locally, extension commands go through the channel.
   */
  const runWorkspaceMenuOption = (option: { id: string } | undefined): void => {
    dispatchOverlay({ type: 'close-if', kind: 'workspace-menu' })
    if (option === undefined) return
    if (option.id === 'resume') {
      openWorkspaceResume()
    } else if (option.id === 'rename') {
      channel.notify(t('workspace-rename-usage'))
    } else if (option.id === 'open') {
      channel.notify(t('workspace-open-usage'))
    } else {
      void channel.runWorkspaceCommand(option.id, '').then((result) => {
        if (result !== undefined) handleWorkspaceResult(result)
      }).catch((error: unknown) => {
        channel.notify(
          t('workspace-command-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
      })
    }
  }

  /**
   * Dispatch a slash command; false lets the input flow to the model.
   * Built-in names run the local switch; anything registered by a DSH
   * plugin (plan/goal/…) dispatches through the command registry, whose
   * result text lands as a notification. `rawInput` carries the text after
   * the command name (`/plan off` → ` off`).
   */
  /** Route every permission switch through the official command path. */
  const runPermissionCommand = (rawInput: string): void => {
    const originAgentBinding = channel.agentBindingGeneration
    void channel.runExternalCommand('permission', rawInput).then((text) => {
      if (channel.agentBindingGeneration !== originAgentBinding) return
      if (text === undefined) {
        channel.notify(t('command-not-found', { name: 'permission' }), { color: 'error' })
        return
      }
      const cleaned = typeof text === 'string' ? cleanRenderText(text, PERMISSION_RESULT_CELLS) : ''
      if (cleaned !== '') channel.notify(cleaned)
    }).catch((error: unknown) => {
      if (channel.agentBindingGeneration !== originAgentBinding) return
      const detail = cleanPermissionError(error)
      if (detail !== '') channel.notify(detail, { color: 'error' })
    })
  }

  /** Hot-swap the UI language (`/lang <id>` and the LangPicker both land
   *  here): persist to ~/.dsh-tui/lang.json and mirror into the dsh-tui
   *  settings namespace when it is served (best effort). */
  const applyLang = (lang: Lang): void => {
    const ok = writeLangPref(lang)
    setLang(lang)
    const settingsHost = channel.settingsHost()
    const tuiView = settingsHost?.listNamespaces().find(entry => entry.ns === 'dsh-tui')
    if (settingsHost !== undefined && tuiView !== undefined) {
      void settingsHost
        .write('dsh-tui', [{ op: 'set', path: ['lang'], value: lang }], tuiView.revision)
        .catch(() => {})
    }
    channel.notify(
      ok ? t('lang-switched', { lang }) : t('lang-switch-failed', { lang }),
      { color: ok ? 'success' : 'error' },
    )
  }

  /** Localized label of one /reload surface, for the change report. */
  const reloadKindLabel = (kind: ReloadKind): string => {
    switch (kind) {
      case 'theme': return t('reload-kind-theme')
      case 'lang': return t('reload-kind-lang')
      case 'preset': return t('reload-kind-preset')
      case 'model': return t('reload-kind-model')
      case 'activity': return t('reload-kind-activity')
    }
  }

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
        dispatchOverlay({
          type: 'open',
          overlay: {
            kind: 'activity',
            index: Math.max(0, PRESET_NAMES.indexOf(channel.activityFrames ?? 'random')),
          },
        })
        return true
      }
      case 'preset': {
        // issue #8: bare `/preset` opens the roster picker (standard/ptc/
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
        // The picker opens immediately over the cached roster (no loading
        // pane — deliberate contrast with /model); the fresh list lands with
        // the authoritative focus. Both loader writes are kind-guarded, so a
        // picker the user already left is not resurrected or re-focused.
        dispatchOverlay({
          type: 'open',
          overlay: {
            kind: 'preset',
            index: Math.max(0, presetOptions.findIndex(preset => preset.id === channel.agentPreset)),
          },
        })
        void channel.listPresets().then((list) => {
          if (list.length === 0) {
            dispatchOverlay({ type: 'close-if', kind: 'preset' })
            channel.notify(t('preset-roster-unmounted'), { color: 'warning' })
            return
          }
          setPresetOptions(list)
          const index = list.findIndex(preset => preset.id === channel.agentPreset)
          dispatchOverlay({ type: 'set-index', kind: 'preset', index: index >= 0 ? index : 0 })
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
          // open-if: a picker the user opened during the round trip wins
          // over this late-arriving slider.
          dispatchOverlay({
            type: 'open-if',
            overlay: { kind: 'effort', index: index >= 0 ? index : 0 },
            when: ['none'],
          })
        })
        return true
      }
      case 'lang': {
        // `/lang` shows the current UI language, `/lang en|zh` switches
        // (hot-swap, persisted to ~/.dsh-tui/lang.json), bare `/lang` opens
        // the en/zh picker. Precedence on next launch: DSH_TUI_LANG >
        // settings.yaml `dsh-tui.lang` > cordis.yml `lang` > the persisted
        // choice.
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
            applyLang(parts[0])
          } else {
            channel.notify(t('lang-unknown', { lang: parts[0] }), { color: 'error' })
          }
          return true
        }
        setHelpOpen(false)
        dispatchOverlay({
          type: 'open',
          overlay: { kind: 'lang', index: getLang() === 'zh' ? 0 : 1 },
        })
        return true
      }
      case 'theme': {
        // Bare `/theme` opens the interactive color picker (`auto` + built-in
        // palettes + static/runtime themes); `/theme <name>`
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
          // setTheme rejects unknown names via isThemeAvailable, so pass the
          // raw argument instead of resolving it against the catalog first.
          const ok = setTheme(parts[0])
          channel.notify(
            ok ? t('theme-switched-saved', { name: parts[0] }) : t('theme-unknown', { name: parts[0] }),
            { color: ok ? 'success' : 'error' },
          )
          return true
        }
        setHelpOpen(false)
        dispatchOverlay({
          type: 'open',
          overlay: {
            kind: 'theme',
            index: Math.max(0, getThemeOptions(themeHost).findIndex(option => option.value === themeName)),
          },
        })
        return true
      }
      case 'color': {
        // `/color`（CC accent，按会话持久化）：无参打开调色板选择器，
        // `/color <name>` 直接设置，`/color status` 显示当前，`/color
        // reset` 清除回主题默认。颜色经 `session/color` 事件按会话保存
        // ——resume/rewind 后仍是这个会话自己的颜色（见 channel.ts）。
        setHelpOpen(false)
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (parts.length === 0) {
          dispatchOverlay({
            type: 'open',
            overlay: {
              kind: 'color',
              index: Math.max(0, SESSION_COLOR_NAMES.indexOf(channel.sessionColor)),
            },
          })
          return true
        }
        if (parts[0] === 'status') {
          channel.pushLocal('/color', [
            channel.sessionColor === ''
              ? t('color-current-none')
              : t('color-current', { name: channel.sessionColor }),
            t('color-usage', { list: SESSION_COLOR_NAMES.join('/') }),
          ])
          return true
        }
        if (parts[0] === 'reset') {
          channel.setSessionColor('')
          channel.notify(t('color-reset'))
          return true
        }
        const colorName = parts[0]!.toLowerCase()
        if (!isValidSessionColor(colorName)) {
          channel.notify(
            t('color-unknown', { name: colorName, list: SESSION_COLOR_NAMES.join(' · ') }),
            { color: 'error' },
          )
          return true
        }
        channel.setSessionColor(colorName)
        channel.notify(t('color-set', { name: colorName }), { color: 'success' })
        return true
      }
      case 'new': {
        // One-shot `/new` (issue #25): the old session stays persisted and
        // is recoverable via /resume, so discarding the live view is
        // non-destructive — no CC-style "press /new again" confirmation.
        setHelpOpen(false)
        void channel.newSession().then((ok) => {
          if (!ok) return
          // A new session is a fresh terminal page, not merely an emptied
          // transcript. Reset view-local state, return the ScrollBox to the
          // top, then clear native scrollback and repaint the whale homepage.
          setExpanded(false)
          setExpandedRows(new Set())
          setStreamViewToggledRows(new Set())
          setSelectedId(null)
          setSelectionActive(false)
          setShowAllMessages(false)
          setLoadedContextOpen(false)
          handle?.scrollTo(0)
          channel.notify(t('new-session-started'))
          const ink = instances.get(process.stdout) ?? instances.values().next().value
          // Wait one task so React commits the empty transcript/homepage tree;
          // clearing before that would immediately repaint the old session.
          setTimeout(() => {
            handle?.scrollTo(0)
            ink?.clearScrollbackAndRedraw()
          }, 0)
        })
        return true
      }
      case 'clear':
        channel.clear()
        // channel.clear() resets row ids to 0; stale expanded/selection
        // state would mis-highlight fresh rows (known-limitation fix).
        setExpandedRows(new Set())
        setStreamViewToggledRows(new Set())
        setSelectedId(null)
        setSelectionActive(false)
        return true
      case 'compact':
        channel.compact()
        return true
      case 'trace':
        // `/trace` is kept as the discoverable spelling of Ctrl+T: the
        // command menu is where a user finds out the trajectory exists.
        setHelpOpen(false)
        openScene()
        return true
      case 'context': {
        setHelpOpen(false)
        const context = channel.loadedContext
        if (context === undefined) {
          channel.notify(t('context-unavailable'), { color: 'warning' })
          return true
        }
        channel.pushLocal('/context', formatLoadedContextReport(context))
        return true
      }
      case 'help':
        setHelpOpen(true)
        return true
      case 'model': {
        // `/model <provider/model>` switches directly (same live-fork path
        // as the picker's Enter), bare `/model` opens the picker.
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (parts.length > 0) {
          setHelpOpen(false)
          const spec = parts[0]!
          const slash = spec.indexOf('/')
          const provider = slash >= 0 ? spec.slice(0, slash) : undefined
          const id = slash >= 0 ? spec.slice(slash + 1) : spec
          if (provider === undefined || id.length === 0 || provider.length === 0) {
            channel.notify(t('model-usage'), { color: 'warning' })
            return true
          }
          void channel.listModels().then((list) => {
            const model = list.find(m => m.provider === provider && m.id === id)
            if (model === undefined) {
              channel.notify(t('model-unknown', { spec }), { color: 'error', timeoutMs: 8000 })
              return
            }
            void switchModelRecorded(provider, id, model.name)
          })
          return true
        }
        setHelpOpen(false)
        // Opens over the cached catalog (empty cache shows the loading
        // pane); the fresh list lands with the authoritative focus, and the
        // kind-guarded set-index cannot re-focus a picker the user left.
        // Seed-on-open: the model in use IS a use — recording it here means
        // the recents group exists before the first post-update switch, and
        // switching A→B keeps A in the list (the file records what was
        // used, not only switches made after the file appeared).
        let recentsNow = modelRecents
        if (channel.provider !== '' && channel.model !== ''
          && !recentsNow.some(ref => ref.provider === channel.provider && ref.id === channel.model)) {
          recentsNow = recordModelUse({ provider: channel.provider, id: channel.model })
          setModelRecents(recentsNow)
        }
        // Two-level landing: recents (when catalogued) focus their pinned
        // row; else multi-provider catalogs focus the current provider's
        // group row; a single-provider catalog without a meaningful recents
        // list drills straight into its model list (pre-grouping UX).
        {
          const landing = modelPickerLanding(models, channel.provider, channel.model, recentsNow)
          setModelGroup(landing.group)
          setModelPickerDirect(landing.group !== undefined)
          dispatchOverlay({ type: 'open', overlay: { kind: 'model', index: landing.index } })
        }
        void channel.listModels().then((list) => {
          setModels(list)
          const landing = modelPickerLanding(list, channel.provider, channel.model, recentsNow)
          setModelGroup(landing.group)
          setModelPickerDirect(landing.group !== undefined)
          dispatchOverlay({ type: 'set-index', kind: 'model', index: landing.index })
        })
        void channel.listProviders().then(setProviderInfos).catch(() => setProviderInfos([]))
        return true
      }
      case 'skills': {
        // issue #204: 列出当前 agent 的完整技能目录（名称 + 来源 + 简述），
        // Enter 把可直调技能以 `/name ` 填回输入行（completion-only 分发的
        // 同一路径）。注册表读取走 channel（快照 scoped 到 live agent）。
        // `/skills <name>` 直达同一个填回动作，跳过选择器。
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (parts.length > 0) {
          setHelpOpen(false)
          void channel.listSkills().then((list) => {
            if (list === undefined) {
              channel.notify(t('skills-load-failed'), { color: 'error' })
              return
            }
            const skill = list.find(s => s.name === parts[0])
            if (skill === undefined) {
              channel.notify(t('skills-unknown', { name: parts[0] }), { color: 'error' })
              return
            }
            if (skill.userInvocable) setHistoryFill(`/${skill.name} `)
            else channel.notify(t('skills-not-invocable', { name: parts[0] }), { color: 'warning' })
          })
          return true
        }
        setHelpOpen(false)
        setSkillsList(null)
        dispatchOverlay({ type: 'open', overlay: { kind: 'skills', index: 0 } })
        void channel.listSkills().then((list) => {
          if (list === undefined) {
            dispatchOverlay({ type: 'close-if', kind: 'skills' })
            channel.notify(t('skills-load-failed'), { color: 'error' })
            return
          }
          setSkillsList(list)
        })
        return true
      }
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
          switchModel: (provider, model) => switchModelRecorded(provider, model),
        }).then((outcome) => {
          // A catalog-changing outcome invalidates every cached model surface
          // so `/model` (picker + completion) reflects it immediately — the
          // same consistency the picker's per-open refetch provides, minus
          // the stale flash on the next open. The wizard's live-switch branch
          // already dropped the completion cache via switchModelRecorded;
          // this covers keep-current, add, edit, delete and OAuth login/logout.
          if (outcome === 'added' || outcome === 'updated'
            || outcome === 'deleted' || outcome === 'signed-out') {
            channel.invalidateModelCompletion()
            void channel.listModels().then(setModels)
            void channel.listProviders().then(setProviderInfos).catch(() => setProviderInfos([]))
          }
        }).catch(() => {
          // The wizard notifies on every handled failure; this only swallows
          // an unexpected reject so it never surfaces as an unhandled promise.
        })
        return true
      }
      case 'thinking':
        setHelpOpen(false)
        dispatchOverlay({
          type: 'open',
          overlay: { kind: 'thinking', focus: thinkingVisible ? 0 : 1 },
        })
        return true
      case 'tokens': {
        const usage = t('tokens-usage', { in: formatTokens(channel.tokens.input), out: formatTokens(channel.tokens.output) })
        if (channel.contextWindow === undefined) {
          channel.notify(usage)
        } else {
          const percent = Math.max(
            0,
            Math.min(100, Math.round((channel.tokens.input / channel.contextWindow) * 100)),
          )
          channel.notify(t('tokens-usage-context', { usage, percent }))
        }
        return true
      }
      case 'resume': {
        setHelpOpen(false)
        // The browser opens immediately and loads its own list. Waiting for
        // the listing here would make `/resume` feel slower the more history
        // a project has, which is exactly backwards.
        setBrowserOpen(true)
        return true
      }
      case 'agentview': {
        // CC's `claude agents`: one screen for every session. Opens
        // immediately; the view reads its own rows (live + persisted).
        setHelpOpen(false)
        agentViewOpenSessionRef.current = channel.agentId
        setAgentViewOpen(true)
        return true
      }
      case 'bg':
      case 'background': {
        // CC's `/background`: the attached session moves to the background
        // (it keeps running in this process), the terminal lands on a fresh
        // session, and the agent view opens on top.
        setHelpOpen(false)
        backgroundToAgentView()
        return true
      }
      case 'workspace': {
        setHelpOpen(false)
        const trimmed = rawInput.trim()
        const separator = trimmed.search(/\s/u)
        const subcommand = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase()
        const input = separator < 0 ? '' : trimmed.slice(separator).trim()
        if (subcommand === '') {
          // Bare `/workspace` opens the action menu (resume / rename / open
          // plus any registered extensions) instead of a text usage line.
          dispatchOverlay({ type: 'open', overlay: { kind: 'workspace-menu', index: 0 } })
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
      case 'tree': {
        // The session family tree (pi's Session Tree): every fork branch
        // stitched back, hover previews, per-node rewind/fork/adopt.
        setHelpOpen(false)
        setTreeOpen(true)
        return true
      }
      case 'fork': {
        // Tip fork (kimi-code semantics): a persisted copy of the whole
        // conversation the user enters via /resume — the live session and
        // its running turn stay untouched.
        setHelpOpen(false)
        void channel.forkSession()
        return true
      }
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
      case 'balance': {
        // DeepSeek official account balance (free read-only endpoint): the
        // channel resolves DEEPSEEK_API_KEY through the credentials seam and
        // queries api.deepseek.com/user/balance. The result renders as the
        // interactive BalanceReportRow (hover for details, click to refresh).
        setHelpOpen(false)
        runBalance()
        return true
      }
      case 'settings': {
        // Plugin settings screen (issue #165): opens immediately; the screen
        // reads sections + namespaces from the channel itself.
        setHelpOpen(false)
        setSettingsOpen(true)
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
      case 'plugins':
        // Plugin diagnostics (C-070): trust banner first, then descriptor /
        // grant matrix / ledger tail — or validate+negotiate for
        // `/plugins check <path>` (rawInput carries the subcommand).
        setHelpOpen(false)
        channel.pushLocal('/plugins', channel.pluginsInfo(rawInput))
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
      case 'jobs':
        setHelpOpen(false)
        setJobsPanelOpen(true)
        return true
      case 'agents':
        setHelpOpen(false)
        void channel.listSubagents().then((lines) => {
          channel.pushLocal('/agents', lines)
        })
        return true
      case 'login': {
        setHelpOpen(false)
        void channel.describeCredential('DEEPSEEK_API_KEY')
          .catch(() => undefined)
          .then(async status => {
            const keyStatus = status === undefined
              ? t('login-credentials-unavailable')
              : status.configured
                ? t('login-key-configured', { ref: 'DEEPSEEK_API_KEY' })
                : t('login-key-missing')
            // OAuth account states ride along only while a dsh-auth-style
            // plugin is mounted; absent it the lines below are exactly the
            // pre-plugin set.
            const oauth = await channel.oauthProviderStatuses().catch(() => undefined)
            channel.pushLocal('/login', [
              t('login-api-key', { status: keyStatus }),
              ...(status === undefined
                ? []
                : [
                    t('login-credential-source', { source: status.source ?? t('login-source-none') }),
                    t('login-credential-storage', {
                      mode: t(status.writable ? 'login-storage-writable' : 'login-storage-read-only'),
                    }),
                  ]),
              t('login-base-url', { url: process.env.DEEPSEEK_BASE_URL ?? t('login-official-endpoint') }),
              ...(oauth === undefined
                ? []
                : [
                    t('login-oauth-heading'),
                    ...oauth.map(row => t('login-oauth-row', {
                      provider: row.provider,
                      state: row.signedIn
                        ? t('login-oauth-in', { time: new Date(row.expiresAt ?? 0).toISOString() })
                        : row.expired
                          ? t('login-oauth-expired')
                          : t('login-oauth-signed-out'),
                    })),
                    t('login-oauth-hint'),
                  ]),
            ])
          })
        return true
      }
      case 'logout':
        channel.notify(t('login-logout-hint'))
        return true
      case 'permission': {
        // The command itself is registered by dsh-sandbox-policy (dsh-base
        // permission-presets row): bare `/permission` opens the preset
        // picker and
        // Enter dispatches `/permission <preset>` through the same
        // external-command path a hand-typed argument takes. `/permission
        // status` prints the policy explainer; other arguments pass through
        // verbatim.
        // When the row is not mounted the default external path (or the
        // model, when nothing is registered) wins.
        const mounted = channel.commandList.some(command => command.external && command.name === 'permission')
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (mounted && parts[0] === 'status') {
          setHelpOpen(false)
          const snapshot = channel.permissionPresets()
          if (snapshot.options.some(option => option.value === 'status')) {
            runPermissionCommand(rawInput)
            return true
          }
          const currentName = snapshot.availability === 'unavailable'
            ? t('permission-roster-unavailable')
            : snapshot.current?.name ?? '—'
          channel.pushLocal('/permission', [
            t('permission-current', { name: currentName }),
            t('permission-policy-hint'),
            t('permission-approval-hint'),
            t('permission-root-hint', { cwd: channel.cwd }),
            t('permission-path-hint'),
          ])
          return true
        }
        if (mounted && parts.length === 0) {
          setHelpOpen(false)
          const snapshot = channel.permissionPresets()
          if (snapshot.availability === 'unavailable' || snapshot.options.length === 0) {
            runPermissionCommand(rawInput)
            return true
          }
          const currentValue = snapshot.current?.kind === 'preset' ? snapshot.current.value : undefined
          const currentIndex = currentValue === undefined
            ? -1
            : snapshot.options.findIndex(option => option.value === currentValue)
          const index = currentIndex >= 0
            ? currentIndex
            : Math.min(1, snapshot.options.length - 1)
          dispatchOverlay({
            type: 'open',
            overlay: {
              kind: 'permission',
              index,
              snapshot: clonePermissionPresetSnapshot(snapshot),
            },
          })
          return true
        }
        if (mounted) {
          setHelpOpen(false)
          runPermissionCommand(rawInput)
          return true
        }
        return false
      }
      case 'plan': {
        // Registered by dsh-plan-mode: bare `/plan` opens an on/off picker
        // marked with the current state instead of toggling blindly; Enter
        // dispatches `/plan` or `/plan off`. Arguments pass through verbatim
        // (`/plan off`), and an unmounted row falls back to the default
        // external path.
        const mounted = channel.commandList.some(command => command.external && command.name === 'plan')
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (mounted && parts.length === 0) {
          setHelpOpen(false)
          dispatchOverlay({
            type: 'open',
            overlay: { kind: 'plan', index: channel.mode.plan === true ? 0 : 1 },
          })
          return true
        }
        if (mounted) {
          setHelpOpen(false)
          void channel.runExternalCommand('plan', rawInput).then((text) => {
            if (text !== undefined && text !== '') {
              channel.notify(text)
            } else if (text === undefined) {
              channel.notify(t('command-not-found', { name: 'plan' }), { color: 'error' })
            }
          })
          return true
        }
        return false
      }
      case 'add-dir':
        setHelpOpen(false)
        channel.pushLocal('/add-dir', [
          t('permission-root-hint', { cwd: channel.cwd }),
          t('permission-path-hint'),
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
      case 'reload': {
        // pi-style soft reload: re-read the persisted preference files
        // (~/.dsh-tui/{theme,lang,agent-preset,model,working-activity}.json)
        // and re-apply live, honoring the boot-time precedence (env >
        // cordis.yml > settings user layer > pref). The dsh-tui settings
        // namespace is NOT re-read here — its watch applies edits live and
        // the platform watcher hot-reloads settings.yaml itself. What no
        // reload can re-read (cordis.yml root config, frozen fullscreen,
        // newly built code) is listed in the footer and served by /restart.
        setHelpOpen(false)
        const tuiNamespace = channel.settingsHost()
          ?.listNamespaces()
          .find(entry => entry.ns === 'dsh-tui')
        const plan = planReload({
          envTheme: envThemeOverride(),
          envLang: isLang(process.env.DSH_TUI_LANG) ? process.env.DSH_TUI_LANG : undefined,
          themePref: readThemePref(),
          currentTheme: themeName,
          langPref: readLangPref(),
          currentLang: getLang(),
          langOverriddenBySettings: tuiNamespace !== undefined && hasPath(tuiNamespace.user, ['lang']),
          configuredLang: channel.configuredLang,
          configuredPreset: channel.configuredPreset,
          presetPref: readPresetPref(),
          currentPreset: channel.agentPreset,
          configuredModel: {
            provider: channel.configuredProvider,
            model: channel.configuredModel,
          },
          modelPref: readModelPref(),
          currentModel: { provider: channel.provider, model: channel.model },
          configuredActivity: channel.configuredActivityFrames,
          activityPref: readActivityFrames(),
          currentActivity: channel.activityFrames,
        })
        for (const item of plan.apply) {
          switch (item.kind) {
            case 'theme':
              setTheme(item.to)
              break
            case 'lang':
              applyLang(item.to as Lang)
              break
            case 'preset':
              void channel.switchPreset(item.to)
              break
            case 'model':
              if (item.route !== undefined) {
                void switchModelRecorded(item.route.provider, item.route.model)
              }
              break
            case 'activity':
              channel.setActivityFrames(item.to)
              break
          }
        }
        const lines = [t('reload-header')]
        for (const item of plan.apply) {
          lines.push(t('reload-applied', {
            kind: reloadKindLabel(item.kind),
            from: item.from,
            to: item.to,
          }))
        }
        for (const kind of plan.unchanged) {
          lines.push(t('reload-unchanged', { kind: reloadKindLabel(kind) }))
        }
        for (const skip of plan.skipped) {
          const key = skip.reason === 'env-wins'
            ? 'reload-skipped-env'
            : skip.reason === 'config-wins' ? 'reload-skipped-config' : 'reload-skipped-invalid'
          lines.push(t(key, { kind: reloadKindLabel(skip.kind) }))
        }
        lines.push(t('reload-footer'))
        channel.pushLocal('/reload', lines)
        return true
      }
      case 'restart':
        // pi-style reload tail: /reload cannot re-read boot-time-only state
        // (cordis.yml root config, frozen fullscreen layout, newly built
        // code), so /restart respawns the process with the original argv and
        // resumes this session — the /update handoff minus the pnpm step.
        setHelpOpen(false)
        if (onRestart === undefined) {
          channel.notify(t('restart-unavailable'), { color: 'warning' })
        } else if (channel.working) {
          channel.notify(t('update-working'), { color: 'warning' })
        } else {
          channel.notify(t('restart-starting'))
          onRestart()
        }
        return true
      case 'vim': {
        // `/vim`（CC vim 编辑模式）：切换输入框的 vim 编辑开关。状态在
        // PromptInput 内部（controllerRef.toggleVim），每次切换落回 insert
        // 子模式；Esc 进 normal、i/a/o 回 insert。会话级、不持久化。
        setHelpOpen(false)
        const on = promptControllerRef.current?.toggleVim() ?? false
        channel.notify(t(on ? 'vim-on' : 'vim-off'))
        return true
      }
      case 'terminal-setup':
        setHelpOpen(false)
        channel.pushLocal('/terminal-setup', [
          t('terminal-setup-hint'),
          t('terminal-paste-hint', { mod: modLabel }),
        ])
        return true
      case 'recap': {
        // `/recap`（pi-recap 语义）：对会话最近活动做一次无工具单轮
        // 调用，生成一行摘要 + 建议标题。摘要是纯 UI 状态（不进 transcript
        // 也不进 session log）；建议标题经「应用」按钮走 /rename 路径。
        setHelpOpen(false)
        recapAbortRef.current?.abort()
        const controller = new AbortController()
        recapAbortRef.current = controller
        setRecap({ raw: '', summary: '', error: undefined, done: false, titleApplied: false, auto: false, expanded: true })
        void channel.recapRecent({
          signal: controller.signal,
          onText: delta => setRecap(prev => (prev ? { ...prev, raw: prev.raw + delta } : prev)),
        }).then(result => {
          if (controller.signal.aborted) return
          setRecap(prev => (prev
            ? {
                ...prev,
                summary: result.summary ?? prev.raw,
                title: result.title,
                error: result.error,
                done: true,
              }
            : prev))
        })
        return true
      }
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
      case 'deepseek': {
        // Hidden easter egg: replay the logo header's whale spout + text
        // shimmer. The command is intentionally not in the suggestion/help
        // catalogs; PromptInput recognizes it through HIDDEN_COMMAND_NAMES.
        setHelpOpen(false)
        suppressLogoIntroRef.current = false
        setLogoNonce(n => n + 1)
        // Bring the logo back into view if the transcript has scrolled.
        setTimeout(() => {
          handle?.scrollTo(0)
        }, 0)
        return true
      }
      case 'tips':
        setHelpOpen(false)
        dispatchOverlay({ type: 'open', overlay: { kind: 'tips' } })
        return true
      case 'connect':
        setHelpOpen(false)
        channel.pushLocal('/connect', [t('connect-none')])
        return true
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
              channel.notify(t('command-not-found', { name }), { color: 'error' })
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
  // The draft lives in the overlay variant; the derived '' while closed
  // keeps the memo inputs stable (nothing renders the matches then).
  const historyQuery = overlay.kind === 'history' ? overlay.query : ''
  const historyMatches = React.useMemo(() => {
    const q = historyQuery.trim().toLowerCase()
    return q ? historyEntries.filter(e => e.text.toLowerCase().includes(q)) : historyEntries
  }, [historyEntries, historyQuery])

  // Double-Esc rewind: the user's own messages, newest first (CC lists the
  // selectable user turns; steering side-questions are excluded). Computed
  // per render while the picker is open — `channel.rows` is a live in-place
  // array (see selectableRows).
  const rewindRows = overlay.kind === 'rewind'
    ? channel.rows
      .filter(row => row.kind === 'user' && row.label === undefined)
      .reverse()
    : NO_ROWS
  /** Open the rewind picker (from PromptInput's double-Esc on an empty input). */
  const openRewind = () => {
    // The overlay is not 'rewind' yet this render, so rewindRows is empty —
    // scan directly instead of reading the gated list.
    const candidates = channel.rows
      .filter(row => row.kind === 'user' && row.label === undefined)
      .reverse()
    if (candidates.length === 0) {
      channel.notify(t('rewind-none'))
      return
    }
    rewindRequestRef.current += 1
    dispatchOverlay({
      type: 'open',
      overlay: { kind: 'rewind', index: 0, confirm: null, modes: null, modeIndex: 0, busy: false },
    })
  }
  /**
   * Enter on a rewind candidate: ask the plugins first (tui/rewind-prompt).
   * A veto keeps the list open; offered modes turn the confirm pane into a
   * choice list; "no opinion" lands on the plain confirm as before.
   */
  const requestRewindConfirm = async (row: ChatRow) => {
    const token = ++rewindRequestRef.current
    dispatchOverlay({ type: 'rewind-busy', busy: true })
    const decision = await channel.promptRewind(row)
    if (token !== rewindRequestRef.current) return
    if (decision === 'cancel') {
      dispatchOverlay({ type: 'rewind-busy', busy: false })
      return
    }
    dispatchOverlay({ type: 'rewind-decision', confirm: row, modes: decision?.modes ?? null })
  }
  /** Execute the confirmed rewind; the message comes back into the input. */
  const performRewind = async (row: ChatRow, mode: string | null = null) => {
    const text = await channel.rewindTo(row, mode)
    if (text !== null) {
      // CC puts the restored message back in the prompt for re-editing.
      setHistoryFill(text)
      channel.notify(t('rewind-done'))
    }
  }

  /**
   * The session's trajectory projection, folded here rather than inside the
   * scene.
   *
   * Two things fall out of owning it at this level: the status-line chip can
   * show live counters without a second fold, and opening the scene is
   * instant because the build is already warm. The fold is incremental — it
   * consumes only events appended since the last render — so an idle
   * conversation pays nothing for it.
   */
  const trajectoryRef = React.useRef<TrajBuild | null>(null)
  trajectoryRef.current = extendTrajectory(
    trajectoryRef.current,
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: headless hosts render Chat with a partial channel
    channel.traceEvents?.() ?? NO_EVENTS,
  )
  const trajectory = trajectoryRef.current

  /**
   * The status-line wake.
   *
   * Projected onto a dozen-odd columns and memoized against the ledger's row
   * count, so it recomputes when the session actually grows rather than on
   * every animation tick. The tick only re-colours the cells it already has.
   */
  const { columns: terminalColumns } = useTerminalSize()
  const pageInsetX = usePageInset().x
  const wakeWidth = miniWakeWidth(terminalColumns)
  const wakeBand = React.useMemo(
        () =>
      wakeWidth === 0
        ? undefined
        // `sequence`, not the scene's `compressed`: at sixteen columns an idle
        // gap cannot express how long it was, so it only reads as a broken
        // strip. Equal-width columns give a continuous silhouette, which is
        // the only thing this size can actually say.
        // Width is also clamped to the row count: with fewer rows than
        // columns the strip would be mostly gaps, which reads as broken
        // rather than as short. It simply grows as the session does.
        : projectWave(trajectory.nodes, Math.min(wakeWidth, trajectory.nodes.length), 'sequence'),
    // The node array is mutated in place by the incremental fold, so its
    // length is the honest dependency; its identity never changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [trajectory.nodes, trajectory.counts.rows, wakeWidth],
  )
  const [wakeTickRef, wakeTime] = useAnimationFrame(channel.working ? 120 : null)
  /**
   * The key hint beside the strip retires itself once the trajectory has been
   * opened — teaching belongs in the first minute, not on every frame forever.
   */
  const [trajectorySeen, setTrajectorySeen] = React.useState(() => trajectorySeenProp ?? readTrajectorySeen())

  /**
   * The one failure worth pointing at.
   *
   * Only the LATEST failed tool row carries the footnote, and only while its
   * failures are unseen. Repeating it under every historical failure would be
   * exactly the clutter the whole entry design is trying to avoid — one
   * pointer, at the newest problem, is enough to find the rest.
   */
  const seenFailuresRef = React.useRef(0)
  const unreadFailures = Math.max(0, trajectory.counts.errors - seenFailuresRef.current)
  const failureHintRowId = React.useMemo(() => {
    if (unreadFailures === 0) return null
    for (let index = channel.rows.length - 1; index >= 0; index--) {
      const row = channel.rows[index]
      if (row?.kind === 'tool' && row.tool?.status === 'error') return row.id
    }
    return null
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.rows, channel.version, unreadFailures])

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
  /**
   * Reveal-and-seek for a row folded behind the recent-rows window (the
   * rail's tick for an old turn, the doc's revealAndSeekRow): expand the
   * fold first, then the ordinary seek takes over — the completion effect
   * below force-mounts the row and scrollToElement lands it once its ref
   * (and Yoga top) exist. The fold toggle is idempotent, so calling this
   * for an already-revealed row is harmless.
   */
  const revealAndSeekRow = (rowId: number): void => {
    if (!showAllMessages) setShowAllMessages(true)
    seekRow(rowId)
  }
  React.useLayoutEffect(() => {
    if (forceMountRowId === null) return
    const el = rowRefsRef.current.get(forceMountRowId)
    if (el) {
      handle?.scrollToElement(el)
      // Clear deferred to a macrotask: clearing here would let React's
      // synchronous re-render narrow the virtualization window and unmount
      // the row BEFORE the renderer's deferred pass reads its Yoga top
      // (scrollAnchor processing runs in a microtask) — the seek would
      // silently no-op (detached anchor element).
      setTimeout(() => setForceMountRowId(null), 0)
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
    if (!searchActive) return
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
  }, [searchQuery, searchActive])

  // n/N navigation: move the current match into view.
  React.useEffect(() => {
    if (!searchActive) return
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
  const toggleStreamView = React.useCallback((rowId: number) => {
    setStreamViewToggledRows((previous) => {
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
    // Same for the session browser: it renders instead of the conversation,
    // so every key belongs to it — including the plain letters that drive its
    // search box, which Chat would otherwise route into the prompt.
    if (browserOpen) return
    // Same for the session tree: plain letters drive its search, clicks and
    // Enter drive its action menu.
    if (treeOpen) return
    // The agent view (CC `claude agents`) is another whole-screen surface:
    // its dispatch input owns every printable key.
    if (agentViewOpen) return
    // Same for the settings screen: plain letters (s save / d discard) and
    // the field draft editor belong to it alone.
    if (settingsOpen) return
    // Subagent dashboard or detail scene: it owns the keyboard while open.
    if (subagentDashboardOpen || subagentDetailId !== null) return
    // A plugin scene (dsh-tui-scenes) or the trajectory scene owns the whole
    // screen while open: every key belongs to it. Unguarded, an Esc meant to
    // CLOSE the scene also reached the chat:cancel branch below whenever a
    // turn was in flight — closing the view and killing the turn in one key.
    if (sceneOpen || channel.pluginScene !== undefined) return
    // Mouse wheel scrolls the transcript even while a question/approval/
    // dialog panel is open — those panels own arrow/Enter/Esc keys, but the
    // transcript above them should still be scrollable in fullscreen mode.
    //
    // Wheel routing is position-first: events landing over a ScrollBox
    // (transcript, help, subagent panels…) are consumed by that box in
    // App's input batch (onWheelAt) and never reach this branch. What
    // arrives here is the fallback: wheel over non-scroll areas (prompt,
    // status bar) or over floating overlays.
    //   - Help stays yielded: PromptInput's help ScrollBox handles the
    //     remaining global wheel while help is open (both covered layers
    //     must not move).
    //   - Pickers/dialogs are modal: wheel that fell through over them
    //     must NOT scroll the transcript behind (the audit's
    //     pass-through gap), so yield like the keyboard guards above.
    // Events only arrive with mouse tracking on; inline mode never sees
    // them, so this is a no-op there.
    if (key.wheelUp || key.wheelDown) {
      if (helpOpen) return
      // Any open transient dialog is modal to the wheel; the one exception
      // mirrors the render gate — a workspace picker whose target list has
      // not landed paints nothing, so wheel-through keeps scrolling.
      const overlayModal =
        overlay.kind !== 'none' &&
        (overlay.kind !== 'workspace-picker' || workspaceTargets.length > 0)
      if (overlayModal) return
      handle?.scrollBy(key.wheelUp ? -3 : 3)
      event.stopImmediatePropagation()
      return
    }
    // Help is modal over Chat. Chat's listener registers before PromptInput's,
    // so yield every remaining key before any global/custom shortcut, search,
    // selection, or working-turn cancellation branch can mutate hidden state.
    // PromptInput then owns Esc, navigation, Tab guards, and ordinary typing.
    if (helpOpen) return
    // The questionnaire / approval panel / managed plugin dialog owns the
    // keyboard while one is pending (the panel's own useInput handles
    // ↑/↓/Space/Tab/Enter/Esc; the prompt input is unmounted, so nothing
    // else should see these keys).
    if (questionSnapshot !== null || approvalSnapshot !== null || dialogSnapshot !== null) return
    const returnCandidate = isPlainReturnInput(input, key)
    const returnNow = Date.now()
    const plainReturn = returnCandidate && returnNow - lastModalEnterAtRef.current >= 80
    if (plainReturn) lastModalEnterAtRef.current = returnNow
    // Esc clears a settled mouse selection first (CC precedence), ahead of
    // every other Esc meaning below (close pickers, interrupt the turn).
    // hasSelection() is an imperative read — no subscription needed.
    if (key.escape && hasMouseSelection()) {
      clearMouseSelection()
      event.stopImmediatePropagation()
      return
    }
    if (overlay.kind === 'search') {
      // Transcript search bar (less-style): edit the query, Enter commits
      // (query persists for n/N), Esc/ctrl+c cancels back to the anchor.
      if (key.escape || (key.ctrl && input === 'c')) {
        dispatchOverlay({ type: 'close' })
        setHighlight('')
        handle?.scrollTo(searchAnchorRef.current)
      } else if (plainReturn) {
        // Enter commits; 0-match junk queries don't persist (CC behavior).
        if (searchCount === 0) setSearchQuery('')
        dispatchOverlay({ type: 'close' })
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
    if (overlay.kind === 'thinking') {
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: 2 })
      } else if (plainReturn) {
        const visible = overlay.focus === 0
        setThinkingVisible(visible)
        dispatchOverlay({ type: 'close' })
        channel.notify(t('thinking-toggled', { state: visible ? t('thinking-on') : t('thinking-off') }))
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'workspace-flow') {
      const { flow, busy, input: flowInput } = overlay
      if (key.escape) {
        if (flowInput !== null && !busy) {
          dispatchOverlay({ type: 'flow-input', input: null })
          return
        }
        workspaceFlowAbortRef.current?.abort()
        workspaceFlowAbortRef.current = null
        workspaceFlowRequestRef.current += 1
        dispatchOverlay({ type: 'close' })
        return
      }
      if (busy) return
      if (flowInput !== null) {
        const choice = flow.choices.find(candidate => candidate.id === flowInput.choiceId)
        const editor = choice?.input
        if (plainReturn) {
          const value = flowInput.value.trim()
          if (value.length === 0) {
            channel.notify(t('workspace-flow-input-empty'), { color: 'warning' })
          } else if (editor !== undefined) {
            runWorkspaceFlowAction(signal => editor.submit(value, signal))
          }
        } else if (key.backspace && flowInput.cursor > 0) {
          dispatchOverlay({
            type: 'flow-input-edit',
            value: flowInput.value.slice(0, flowInput.cursor - 1) + flowInput.value.slice(flowInput.cursor),
            cursor: flowInput.cursor - 1,
          })
        } else if (key.delete && flowInput.cursor < flowInput.value.length) {
          dispatchOverlay({
            type: 'flow-input-edit',
            value: flowInput.value.slice(0, flowInput.cursor) + flowInput.value.slice(flowInput.cursor + 1),
            cursor: flowInput.cursor,
          })
        } else if (key.leftArrow) {
          dispatchOverlay({
            type: 'flow-input-edit',
            value: flowInput.value,
            cursor: Math.max(0, flowInput.cursor - 1),
          })
        } else if (key.rightArrow) {
          dispatchOverlay({
            type: 'flow-input-edit',
            value: flowInput.value,
            cursor: Math.min(flowInput.value.length, flowInput.cursor + 1),
          })
        } else if (input.length > 0 && !key.ctrl && !key.meta && !key.super && !key.tab) {
          dispatchOverlay({
            type: 'flow-input-edit',
            value: flowInput.value.slice(0, flowInput.cursor) + input + flowInput.value.slice(flowInput.cursor),
            cursor: flowInput.cursor + input.length,
          })
        }
        return
      }
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: flow.choices.length })
      } else if (key.tab && !key.shift) {
        const choice = flow.choices[overlay.index]
        if (choice?.input !== undefined) {
          const value = choice.input.initialValue ?? ''
          const flowInputNext: WorkspaceFlowInput = {
            choiceId: choice.id,
            value,
            cursor: value.length,
            ...(choice.input.placeholder === undefined ? {} : { placeholder: choice.input.placeholder }),
          }
          dispatchOverlay({ type: 'flow-input', input: flowInputNext })
        }
      } else if (plainReturn) {
        const choice = flow.choices[overlay.index]
        if (choice !== undefined) {
          runWorkspaceFlowAction(signal => choice.choose(signal))
        }
      }
      return
    }
    if (overlay.kind === 'workspace-picker') {
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: workspaceTargets.length })
      } else if (plainReturn) {
        const target = workspaceTargets[overlay.index]
        dispatchOverlay({ type: 'close' })
        if (target !== undefined) void channel.switchWorkspace(target)
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'workspace-menu') {
      const menu = workspaceMenuOptions
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: menu.length })
      } else if (plainReturn) {
        const option = menu[overlay.index]
        runWorkspaceMenuOption(option)
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'model') {
      // Two-level picker: group rows at the top (Enter drills in), one
      // provider's models below (Enter switches, the same live-fork path as
      // the flat picker always had). Esc/⌫ climbs one level and only closes
      // at the top; a single-group catalog never shows the group level, so
      // Esc there closes directly.
      const rowCount = activeModelGroup === undefined ? modelGroups.length : groupModels.length
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: rowCount })
      } else if (plainReturn) {
        if (activeModelGroup === undefined) {
          const group = modelGroups[overlay.index]
          if (!group) {
            dispatchOverlay({ type: 'close' })
            return
          }
          setModelGroup(group.provider)
          // The recents group opens on its most-recent entry; a provider
          // group on its current model when it owns one, else its first row.
          if (group.provider === RECENTS_GROUP_PROVIDER) {
            dispatchOverlay({ type: 'set-index', kind: 'model', index: 0 })
            return
          }
          const landing = modelPickerLanding(
            models.filter(model => model.provider === group.provider),
            channel.provider,
            channel.model,
          )
          dispatchOverlay({ type: 'set-index', kind: 'model', index: landing.index })
          return
        }
        const model = groupModels[overlay.index]
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
        if (model) {
          // Enter switches the live model right away: the conversation is
          // forked at its end and continued with an agent routed to the new
          // model (history replays unchanged) — and feeds the recents group.
          dispatchOverlay({ type: 'close' })
          void switchModelRecorded(model.provider, model.id, model.name)
        } else {
          dispatchOverlay({ type: 'close' })
        }
      } else if (key.escape || key.backspace) {
        if (activeModelGroup !== undefined && modelGroups.length > 1 && !modelPickerDirect) {
          setModelGroup(undefined)
          const groupIndex = Math.max(0, modelGroups.findIndex(group => group.provider === activeModelGroup))
          dispatchOverlay({ type: 'set-index', kind: 'model', index: groupIndex })
        } else {
          dispatchOverlay({ type: 'close' })
        }
      }
      return
    }
    if (overlay.kind === 'skills') {
      const list = skillsList ?? []
      if (key.upArrow || key.downArrow) {
        // count 0 (snapshot still loading) is a no-op inside the reducer.
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: list.length })
      } else if (plainReturn) {
        const skill = list[overlay.index]
        dispatchOverlay({ type: 'close' })
        // 可直调技能 Enter 填入 `/name `——与 / 菜单选中技能同一条
        // completion-only 分发路径；模型专用技能（userInvocable=false）只关闭。
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
        if (skill?.userInvocable) setHistoryFill(`/${skill.name} `)
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'activity') {
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: PRESET_NAMES.length })
      } else if (plainReturn) {
        const name = PRESET_NAMES[overlay.index]
        dispatchOverlay({ type: 'close' })
        if (name) channel.setActivityFrames(name)
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'color') {
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: SESSION_COLOR_NAMES.length })
      } else if (plainReturn) {
        const name = SESSION_COLOR_NAMES[overlay.index]
        dispatchOverlay({ type: 'close' })
        if (name) {
          channel.setSessionColor(name)
          channel.notify(t('color-set', { name }), { color: 'success' })
        }
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'effort') {
      if (key.leftArrow || key.rightArrow) {
        const delta = key.leftArrow ? -1 : 1
        // The same wrap rule the reducer applies — computed here too so the
        // newly focused level is applied in this very keystroke.
        const next = wrapIndex(overlay.index, delta, effortOptions.length)
        dispatchOverlay({ type: 'move', delta, count: effortOptions.length })
        const option = effortOptions[next]
        // Live-apply: the slider IS the control; Esc does not revert.
        if (option) void channel.setEffort(option.id)
      } else if (plainReturn || key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'preset') {
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: presetOptions.length })
      } else if (plainReturn) {
        const option = presetOptions[overlay.index]
        dispatchOverlay({ type: 'close' })
        if (option) void channel.switchPreset(option.id)
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'permission') {
      if (key.upArrow || key.downArrow) {
        const currentIndex = permissionOverlayFocusRef.current?.overlay === overlay
          ? permissionOverlayFocusRef.current.index
          : overlay.index
        const nextIndex = wrapIndex(currentIndex, key.upArrow ? -1 : 1, overlay.snapshot.options.length)
        permissionOverlayFocusRef.current = { overlay, index: nextIndex }
        dispatchOverlay({ type: 'set-index', kind: 'permission', index: nextIndex })
      } else if (plainReturn) {
        const currentIndex = permissionOverlayFocusRef.current?.overlay === overlay
          ? permissionOverlayFocusRef.current.index
          : overlay.index
        const option = overlay.snapshot.options[currentIndex]
        permissionOverlayFocusRef.current = null
        dispatchOverlay({ type: 'close' })
        if (option !== undefined) runPermissionCommand(` ${option.value}`)
      } else if (key.escape) {
        permissionOverlayFocusRef.current = null
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'plan') {
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: 2 })
      } else if (plainReturn) {
        const on = overlay.index === 0
        dispatchOverlay({ type: 'close' })
        void channel.runExternalCommand('plan', on ? '' : ' off').then((text) => {
          if (text !== undefined && text !== '') channel.notify(text)
        })
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'lang') {
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: 2 })
      } else if (plainReturn) {
        const lang = LANGS[overlay.index]
        dispatchOverlay({ type: 'close' })
        if (lang !== undefined) applyLang(lang)
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'theme') {
      const options = getThemeOptions(themeHost)
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: options.length })
      } else if (plainReturn) {
        dispatchOverlay({ type: 'close' })
        const name = options[overlay.index]?.value
        if (name !== undefined) {
          const ok = setTheme(name)
          channel.notify(
            ok ? t('theme-switched-saved', { name }) : t('theme-switch-failed', { name }),
            { color: ok ? 'success' : 'error' },
          )
        }
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'history') {
      const { query, cursor, focus } = overlay
      if (key.escape) {
        dispatchOverlay({ type: 'close' })
      } else if (key.ctrl && (input === 'c' || input === 'd')) {
        // CC's history search cancels on ctrl+c/ctrl+d too.
        dispatchOverlay({ type: 'close' })
      } else if (plainReturn) {
        const entry = historyMatches[focus]
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty match list
        if (entry) {
          setHistoryFill(entry.text)
          dispatchOverlay({ type: 'close' })
        }
      } else if (key.upArrow) {
        if (historyMatches.length > 0) {
          dispatchOverlay({ type: 'move', delta: -1, count: historyMatches.length })
        }
      } else if (key.downArrow || actionMatches('history', input, key)) {
        // CC's historySearch:next — ↓ and the history key (default Ctrl+R)
        // walk to the next match.
        if (historyMatches.length > 0) {
          dispatchOverlay({ type: 'move', delta: 1, count: historyMatches.length })
        }
      } else if (key.backspace) {
        if (cursor > 0) {
          dispatchOverlay({
            type: 'history-edit',
            query: query.slice(0, cursor - 1) + query.slice(cursor),
            cursor: cursor - 1,
            focus: 0,
          })
        }
      } else if (key.delete) {
        if (cursor < query.length) {
          dispatchOverlay({
            type: 'history-edit',
            query: query.slice(0, cursor) + query.slice(cursor + 1),
            focus: 0,
          })
        }
      } else if (key.leftArrow) {
        // Step by code point, not UTF-16 unit: an emoji is two units, and
        // a mid-pair caret offset would split it in the SearchBox render.
        if (cursor > 0) {
          const ch = [...query.slice(0, cursor)].pop()!
          dispatchOverlay({ type: 'history-edit', cursor: cursor - ch.length })
        }
      } else if (key.rightArrow) {
        if (cursor < query.length) {
          const ch = [...query.slice(cursor)][0]!
          dispatchOverlay({ type: 'history-edit', cursor: cursor + ch.length })
        }
      } else if (key.home) {
        dispatchOverlay({ type: 'history-edit', cursor: 0 })
      } else if (key.end) {
        dispatchOverlay({ type: 'history-edit', cursor: query.length })
      } else if (!key.ctrl && !key.meta && !key.super && input) {
        dispatchOverlay({
          type: 'history-edit',
          query: query.slice(0, cursor) + input + query.slice(cursor),
          cursor: cursor + input.length,
          focus: 0,
        })
      }
      return
    }
    if (overlay.kind === 'rewind') {
      // While the plugin decision is in flight the picker is read-only;
      // Esc abandons the wait (the stale answer is dropped by the token).
      if (overlay.busy) {
        if (key.escape) {
          rewindRequestRef.current += 1
          dispatchOverlay({ type: 'rewind-busy', busy: false })
        }
        return
      }
      if (overlay.confirm !== null) {
        const row = overlay.confirm
        if (overlay.modes !== null) {
          // Plugin offered modes: the confirm pane is a choice list —
          // option 0 is always the built-in conversation-only rewind.
          const optionCount = overlay.modes.length + 1
          if (key.upArrow || key.downArrow) {
            dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: optionCount })
          } else if (plainReturn) {
            const mode = overlay.modeIndex === 0 ? null : (overlay.modes[overlay.modeIndex - 1]?.id ?? null)
            dispatchOverlay({ type: 'close' })
            void performRewind(row, mode)
          } else if (key.escape) {
            dispatchOverlay({ type: 'rewind-back' })
          }
          return
        }
        // Confirmation state: Enter rewinds, Esc backs out to the list.
        if (plainReturn) {
          dispatchOverlay({ type: 'close' })
          void performRewind(row)
        } else if (key.escape) {
          dispatchOverlay({ type: 'rewind-back' })
        }
      } else if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: rewindRows.length })
      } else if (plainReturn) {
        const row = rewindRows[overlay.index]
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
        if (row) void requestRewindConfirm(row)
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'file-actions') {
      // Click-to-act file menu: ↑/↓ move, Enter runs the focused action,
      // Esc closes.
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: FILE_ACTION_COUNT })
      } else if (plainReturn) {
        const path = overlay.path
        dispatchOverlay({ type: 'close' })
        runFileAction(overlay.index, path)
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (actionMatches('trajectory', input, key)) {
      // The trajectory scene key (default Ctrl+T) opens it at any point in
      // the session.
      openScene()
      return
    }
    if (actionMatches('dashboard', input, key)) {
      // The subagent dashboard key (default Ctrl+A) opens the dashboard.
      // Consume the key: without the stop the prompt editor's readline
      // binding ALSO fires (Ctrl+A moves the caret to line start), so one
      // press both opens the overlay and jumps the cursor.
      setSubagentDashboardOpen(true)
      event.stopImmediatePropagation()
      return
    }
    if (actionMatches('contextPanel', input, key) && loadedContextVisible) {
      // The loaded-context panel key (default Ctrl+P) toggles the startup
      // panel while it is on screen (transcript still empty); once rows take
      // over and the panel disappears the key has nothing left to do.
      toggleLoadedContext()
      return
    }
    if (actionMatches('history', input, key) && !helpOpen) {
      setHistoryEntries(loadHistory())
      dispatchOverlay({
        type: 'open',
        overlay: { kind: 'history', query: '', cursor: 0, focus: 0 },
      })
      return
    }
    if (key.shift && key.upArrow && !selectionActive && !helpOpen) {
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
    } else if (key.escape && channel.working && !helpOpen && !promptControllerRef.current?.vimActive()) {
      // CC's chat:cancel — esc interrupts a running turn (the prompt input
      // only sees esc when idle, where it has the double-tap-clear meaning).
      // With messages queued for delivery, interrupt-and-deliver them right
      // away (Codex behavior); otherwise a plain interrupt parks the queue.
      // vim mode (either submode) yields: there Esc is a MODE key (INSERT→
      // NORMAL, NORMAL = no-op/cancel pending d) and the prompt owns it;
      // interrupting still works via Ctrl+C / Ctrl+Enter.
      if (channel.pending.length > 0) {
        const count = channel.interruptAndDeliver(channel.pending.map(item => item.text))
        if (count > 0) {
          channel.notify(t('interrupt-delivered', { n: count }), { timeoutMs: 2500 })
        }
      } else {
        channel.cancel()
      }
      event.stopImmediatePropagation()
    } else if (actionMatches('transcript', input, key) && !helpOpen) {
      // Leaving transcript mode (default Ctrl+O) — search was already
      // handled above. Help is modal: toggling this state behind the
      // overlay is invisible, then the next `/` unexpectedly opens
      // transcript search instead of slash-command completion after Help
      // closes.
      setExpanded(previous => !previous)
      // The toggle rewrites every thinking row's layout at once. The
      // ordinary scroll-based diff pushes rows into terminal scrollback on
      // each expand and nothing removes them on collapse — rapid toggling
      // drifts the virtual↔scrollback mapping until writes misland
      // (garbled transcript, duplicated rows). Re-anchor the next frame:
      // in-place viewport repaint, nothing added to scrollback. Lookup
      // falls back to the only live instance for embedders whose stdout
      // isn't process.stdout (test harnesses).
      const ink = instances.get(process.stdout) ?? instances.values().next().value
      ink?.reanchorViewport()
    } else if (input === '/' && !key.ctrl && !key.meta && !key.super && !helpOpen) {
      // `/` in transcript mode (Ctrl+O expanded, CC's REPL semantics:
      // search is active on the transcript screen where `/` isn't a command).
      if (expanded) {
        searchAnchorRef.current = handle?.getScrollTop() ?? 0
        setSearchQuery('')
        setSearchCursor(0)
        setSearchCurrent(0)
        setSearchCount(0)
        dispatchOverlay({ type: 'open', overlay: { kind: 'search' } })
        event.stopImmediatePropagation()
      }
    } else if (key.ctrl && (input === 'c' || input === 'd')) {
      // CC's app:exit — ctrl+c interrupts a running turn; idle ctrl+c
      // CLEARS a non-empty prompt (single press) and only arms the
      // double-press exit when the input is empty; ctrl+d keeps the
      // time-based double-press exit regardless.
      if (channel.working) {
        // First press while working only interrupts. If that abort is still
        // converging (cancelPending) the next press is the user insisting on
        // leaving: go straight to the exit funnel. Without this, a stuck turn
        // (long tool call that never settles, silent stream) swallows every
        // Ctrl+C forever — raw mode keeps the launcher's SIGINT escape
        // unreachable until the TUI exits.
        if (channel.cancelPending) {
          onExit()
        } else {
          channel.cancel()
          // Interrupt replaces any previously armed exit: the next press
          // must re-confirm instead of exiting out from under the turn.
          exitPendingRef.current = false
          if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
        }
      } else if (input === 'c' && promptControllerRef.current?.consumeSelectionCopy()) {
        // A mouse selection is active: Ctrl+C copies it to the clipboard
        // (via the prompt controller — Chat's listener registers first) and
        // KEEPS the selection for further editing. The key is consumed.
        exitPendingRef.current = false
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
      } else if (input === 'c' && promptControllerRef.current?.hasText()) {
        promptControllerRef.current.clear()
        // A pending exit arm no longer makes sense once the user is editing.
        exitPendingRef.current = false
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
      } else {
        requestExit()
      }
    } else if (actionMatches('redraw', input, key)) {
      // CC's app:redraw (default Ctrl+L) — clear the physical terminal and
      // repaint.
      instances.get(process.stdout)?.forceRedraw()
      // Consume: same readline-shadowing rule as dashboard/showAll below.
      event.stopImmediatePropagation()
    } else if (actionMatches('showAll', input, key)) {
      setShowAllMessages(previous => !previous)
      // Ctrl+E is also the editor's line-end binding — stop the press from
      // additionally moving the caret (one press, one meaning).
      event.stopImmediatePropagation()
    } else if (actionMatches('todoFold', input, key)) {
      // Fold/unfold the GoalTodoPanel todo section (default Ctrl+Q) — works
      // mid-turn too: the collapsed line keeps the done/total count and the
      // live task preview, so long todo lists stop crowding the prompt.
      setTodoCollapsed(previous => !previous)
      // Consume: same readline-shadowing rule as dashboard/showAll above.
      event.stopImmediatePropagation()
    } else if (plainReturn && !isSticky) {
      // Enter while scrolled up returns to the bottom (CC's pill: the
      // affordance now exists whenever the view is off the bottom, not
      // only with unseen rows).
      handle?.scrollToBottom()
    } else if (key.end && !isSticky) {
      // End = jump to bottom, less/vim semantics. Global on the chat
      // screen (search/history overlays consume their own End first —
      // cursor-to-line-end there). At the bottom already: no-op, so the
      // key stays harmless in muscle memory.
      handle?.scrollToBottom()
      event.stopImmediatePropagation()
    } else if (extensionShortcuts !== undefined && extensionShortcuts.dispatch(input, key)) {
      // Plugin shortcut (tuiShortcuts seam): matched only after every
      // built-in global binding above declined — locals always win, and the
      // registry additionally refuses the prompt editor's own combos at
      // registration, so a plugin can never shadow anything. The handler
      // runs fire-and-forget; its errors arrive via the onError hook
      // (wired to the toast below).
      event.stopImmediatePropagation()
    }
  })

  // Working-activity line (spinner slot): context-pressure prefix shares the
  // StatusLine thresholds (amber ≥ 80, red ≥ 95).
  const activityWarnPct = contextPressurePct(channel.lastUsage, channel.contextWindow)

  // ── Interrupt lane ─────────────────────────────────────────────────────
  // The approval and ask_user_question panels park the agent until the user
  // answers, but they render inside the conversation layout — every screen
  // early-return below (plugin scene, browser, settings, subagent, trace)
  // used to win over them, leaving the session stuck with no visible cause.
  // While one is pending and a screen is up, the panel takes the whole
  // terminal INSTEAD of the screen. The screen's open flag survives, so the
  // decision lands back on the screen (remounted fresh — the same lifecycle
  // as closing and reopening it); keyboard exclusivity holds because the
  // covered screen is unmounted, exactly like the chat-state prompt slot.
  // The panel elements are shared with the prompt-slot chain below so the
  // two mount sites cannot drift.
  const approvalPanelNode = approvalSnapshot !== null ? (
    <ApprovalPanel
      key={approvalSnapshot.key}
      approval={approvalSnapshot}
      background={approvalSnapshot.agentId !== channel.agentId}
      onDecide={outcome => approvals.decide(outcome)}
    />
  ) : null
  const questionPanelNode = questionSnapshot !== null ? (
    <AskUserQuestionPanel
      key={questionSnapshot.key}
      question={questionSnapshot.question}
      position={questionSnapshot.position}
      total={questionSnapshot.total}
      answered={questionSnapshot.answered}
      initialDraft={questionSnapshot.draft}
      onAnswer={selection => questionStore.answerCurrent(selection)}
      onCancel={() => questionStore.cancelCurrent()}
      onBack={questionSnapshot.canGoBack
        ? draft => questionStore.backCurrent(draft)
        : undefined}
    />
  ) : null
  const interruptPanel = approvalPanelNode ?? questionPanelNode
  const screenOpen = channel.pluginScene !== undefined || browserOpen || settingsOpen
    || subagentDetailId !== null || subagentDashboardOpen || sceneOpen
  if (interruptPanel !== null && screenOpen) {
    const node = (
      <Box flexDirection="column" width="100%" paddingX={1}>
        {interruptPanel}
      </Box>
    )
    return fullscreen ? node : <AlternateScreen>{node}</AlternateScreen>
  }

  // A plugin scene (dsh-tui-scenes) takes the whole terminal the same way
  // the trajectory scene does, and sits at the TOP of this return chain:
  // an open() landing while the session browser or the trajectory scene is
  // up must still take the screen (and the keyboard, via the useInput guard
  // above), not queue silently behind them. Closing the plugin scene lands
  // back on whatever screen was up before, so these early returns read as a
  // stack. The component comes from the registry, so its identity is stable
  // across renders and its hook state survives re-renders; it receives the
  // TUI's own React + ui kit because a plugin importing its own React copy
  // would die on the first hook call under this reconciler.
  // The scene is third-party code, so it renders inside a boundary: a render
  // crash reports to the transcript and closes the scene instead of taking
  // the whole TUI down through ink's app-level boundary.
  const pluginScene = channel.pluginScene
  if (pluginScene !== undefined) {
    const node = (
      <PluginSceneBoundary
        id={pluginScene.id}
        onError={(id, error) => {
          channel.notify(t('plugin-scene-crashed', { id, err: error.message }), { color: 'error' })
          channel.closePluginScene()
        }}
      >
        {React.createElement(pluginScene.component, {
          React,
          ui: tuiKit,
          channel,
          close: () => channel.closePluginScene(),
        })}
      </PluginSceneBoundary>
    )
    return fullscreen ? node : <AlternateScreen>{node}</AlternateScreen>
  }

  // The agent view is a screen like the browser: it REPLACES the
  // conversation. Every session keeps running behind it — including the
  // attached one mid-turn.
  if (agentViewOpen) {
    const view = (
      <AgentView
        channel={channel}
        home={homeDir()}
        approval={approvalSnapshot}
        onApprove={outcome => approvals.decide(outcome)}
        returnSessionId={agentViewReturnId}
        onClose={() => {
          // The transcript tree remounts on close: never replay the whale
          // intro there, and when the session changed INSIDE the view
          // (attach / backgrounded dispatch), repaint the fresh transcript
          // from the top like `/new` does.
          suppressLogoIntroRef.current = true
          const switched =
            agentViewOpenSessionRef.current !== undefined &&
            agentViewOpenSessionRef.current !== channel.agentId
          if (switched) repaintTranscript()
          setAgentViewReturnId(undefined)
          setAgentViewOpen(false)
        }}
      />
    )
    return fullscreen ? view : <AlternateScreen>{view}</AlternateScreen>
  }

  // The browser is a screen, not an overlay: it REPLACES the conversation
  // rather than floating above it. Rendering it as an early return (after
  // every hook above has run) is what makes that literal — there is no
  // transcript underneath to be repainted, scrolled, or bled through.
  if (browserOpen) {
    const browser = (
      <SessionBrowser
        channel={channel}
        home={homeDir()}
        sameProject={sessionCwdMatches}
        onClose={() => {
          suppressLogoIntroRef.current = true
          setBrowserOpen(false)
        }}
      />
    )
    // Inline hosts enter the alternate screen for the duration; full-screen
    // hosts are already in it and must not nest a second one.
    return fullscreen ? browser : <AlternateScreen>{browser}</AlternateScreen>
  }

  // The session tree follows the browser's rule exactly: it REPLACES the
  // conversation (an early return after every hook above has run), so there
  // is no transcript underneath to be repainted or bled through. The dropped
  // turn's prompt returns through the same fill path a rewind picker uses.
  if (treeOpen) {
    const tree = (
      <SessionTree
        channel={channel}
        currentSessionId={channel.agentId}
        onClose={() => setTreeOpen(false)}
        onRestoreText={(text) => {
          setHistoryFill(text)
        }}
      />
    )
    return fullscreen ? tree : <AlternateScreen>{tree}</AlternateScreen>
  }

  // The settings screen follows the browser's rule exactly: it REPLACES the
  // conversation (an early return after every hook above has run), so there
  // is no transcript underneath to be repainted or bled through.
  if (settingsOpen) {
    const screen = <Settings channel={channel} onClose={() => setSettingsOpen(false)} />
    return fullscreen ? screen : <AlternateScreen>{screen}</AlternateScreen>
  }

  // Subagent detail scene: displays detailed view of a specific subagent.
  // Like the browser and settings, it replaces the conversation entirely.
  if (subagentDetailId !== null) {
    const subagent = channel.subagents.find(s => s.agentId === subagentDetailId)
    if (!subagent) {
      // Agent not found, go back to dashboard
      setSubagentDetailId(null)
      setSubagentDashboardOpen(true)
      return null
    }
    const scene = (
      <SubagentDetailScene
        subagent={subagent}
        onInterrupt={(id) => channel.subagentControl.interrupt(id)}
        onBack={() => {
          setSubagentDetailId(null)
          setSubagentDashboardOpen(true)
        }}
      />
    )
    return fullscreen ? scene : <AlternateScreen>{scene}</AlternateScreen>
  }

  // Jobs panel: background jobs (running/killed) with kill/inspect actions.
  // Like the browser and settings, it replaces the conversation entirely.
  if (jobsPanelOpen) {
    const panel = (
      <JobsPanel
        jobs={channel.backgroundJobs ?? []}
        onClose={() => setJobsPanelOpen(false)}
        onKill={(id) => {
          // Stub channels (verify harnesses) have no jobControl — surface
          // the same failure toast as a refused kill instead of throwing.
          if (channel.jobControl?.kill(id) !== true) {
            channel.notify(t('jobs-kill-failed', { id }), { color: 'error' })
          }
        }}
      />
    )
    return fullscreen ? panel : <AlternateScreen>{panel}</AlternateScreen>
  }

  // Subagent dashboard: displays all active and completed subagents.
  // Like the browser and settings, it replaces the conversation entirely.
  if (subagentDashboardOpen) {
    const dashboard = (
      <SubagentDashboard
        subagents={[...channel.subagents]}
        onSelect={(id) => {
          setSubagentDashboardOpen(false)
          setSubagentDetailId(id)
        }}
        onClose={() => setSubagentDashboardOpen(false)}
      />
    )
    return fullscreen ? dashboard : <AlternateScreen>{dashboard}</AlternateScreen>
  }

  /** Prompt input is inert while a modal dialog owns the keyboard. The
   *  overlay union covers every picker/dialog and /tips in one check;
   *  message-selection mode and the /btw panel live outside it. */
  const promptSelectionActive =
    selectionActive || overlay.kind !== 'none' || btw !== null

  // The trajectory scene replaces the conversation for as long as it is open.
  // Rendering it INSTEAD of (not above) the transcript is what makes it a
  // screen rather than an overlay: it owns the full viewport, and the
  // conversation's own frame is never resized while it is up. Chat stays
  // mounted, so every hook above has already run and no state is lost.
  // `<AlternateScreen>` is skipped when the app is already fullscreen —
  // nesting it would emit a second DEC 1049, and its unmount would drop the
  // whole app back to the main screen.
  if (sceneOpen) {
    const scene = <TrajectoryScene channel={channel} build={trajectory} onClose={closeScene} />
    return fullscreen ? scene : <AlternateScreen>{scene}</AlternateScreen>
  }

  // 浮层整体挂载条件：与内部各面板的可见条件同值（数据门在
  // dialogOverlayVisible 里逐面板镜像）。关闭时把整个 absolute 浮层从树里
  // 移除——渲染器的"移除 absolute 节点"检测只看被移除子树自身的
  // style.position（dom.ts collectRemovedRects），若浮层常驻、只移除其
  // 普通子节点，blit 解毒不触发，被覆盖的转录行会在 blit-skip 后留空
  // （Esc 关 picker 一片空白的根因）。
  const dialogOverlayOpen = dialogOverlayVisible(overlay, {
    workspaceTargetCount: workspaceTargets.length,
    effortOptionCount: effortOptions.length,
    presetOptionCount: presetOptions.length,
  }) && !(overlay.kind === 'permission'
    && (approvalSnapshot !== null || questionSnapshot !== null || dialogSnapshot !== null))

  // The sticky header pins the turn owning the viewport top row
  // (timeline.activeId, reported by MessageList) — scrolled up to an old
  // turn, it carries THAT turn's prompt, not the latest one.
  // channel.rows is a live in-place array, so the lookup is per-render.
  const anchorUserRowId = timeline.activeId
  const anchorUserText =
    anchorUserRowId === null
      ? null
      : channel.rows.find(row => row.id === anchorUserRowId)?.text ?? null

  return (
    <Box ref={wakeTickRef} flexDirection="column" flexGrow={1} width="100%">
      {!isSticky && anchorUserText && (
        <StickyPromptHeader
          text={anchorUserText}
          onClick={() => {
            // Click snaps the pinned prompt to the viewport top (CC's
            // StickyPromptHeader). Jump by the SAME content coordinate the
            // rail's tick uses (timeline turn top = the prompt TEXT top):
            // the element-based seek lands the row wrapper's margin at the
            // top instead — one row shy of the text top the anchor rule
            // compares against — and the header would flip to the previous
            // turn immediately after the click.
            const turn = timeline.turns.find(t => t.id === anchorUserRowId)
            if (turn) handle?.scrollTo(turn.top)
            else if (anchorUserRowId !== null) seekRow(anchorUserRowId)
            else handle?.scrollToBottom()
          }}
        />
      )}
      {/* Transcript row. Under PageMargin the negative right margin makes
          the row stretch past the content column to the terminal edge —
          the gutter (timeline rail / scrollbar) thus lands at the very
          edge while the transcript TEXT stays inside the page margin
          (structural chrome convention: dividers and the rail bleed, text
          and cards keep the content column). No explicit width: cross-axis
          stretch with the margin yields exactly content+margin. */}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} marginRight={-pageInsetX}>
        <ScrollBox ref={setHandle} flexDirection="column" flexGrow={1} flexShrink={1} stickyScroll>
        <LogoHeader
          key={logoNonce}
          model={channel.model}
          effort={channel.reasoningEffort}
          cwd={channel.displayCwd}
          whale={channel.whale}
          whaleIdle={channel.whaleIdle}
          working={channel.working}
          // Resuming a long session skips the ~3.4s opening animation: it
          // keeps firing low-frequency React commits that compete with the
          // transcript mount batches (and the first wheel events) for the
          // frame budget right when the user wants to read history. Fresh
          // sessions keep the full intro; restored ones settle instantly.
          // A remount after a whole screen closed also settles instantly
          // (see suppressLogoIntroRef).
          skipIntro={suppressLogoIntroRef.current || channel.rows.length > 30}
        />
        {/* The startup loaded-context panel: before the first message the
            transcript is empty, so the inventory of what this conversation
            will load (system prompt, workspace instructions, skills, tools)
            sits at the top, collapsed to a summary line and expandable with
            Ctrl+P; the first rows take over. */}
        {loadedContextVisible && (
          <LoadedContextPanel
            context={channel.loadedContext}
            open={loadedContextOpen}
            onToggle={toggleLoadedContext}
          />
        )}
        <MessageList
          rows={channel.rows}
          failureHintRowId={failureHintRowId}
          failureHint={t('traj-hint-failure', { key: `${modLabel}t` })}
          expanded={expanded}
          expandedRows={expandedRows}
          selectedId={selectionActive ? selectedId : null}
          onToggleRow={toggleRowExpanded}
          streamViewToggledRows={streamViewToggledRows}
          onToggleStreamView={toggleStreamView}
          model={channel.model}
          diffLayout={channel.diffLayout}
          thinkingFold={channel.thinkingFold}
          toolBackground={channel.toolBackground}
          foldTerminalCommand={channel.foldTerminalCommand}
          smoothStreaming={channel.smoothStreaming}
          activityFrames={channel.activityFrames}
          showAll={showAllMessages}
          thinkingVisible={thinkingVisible}
          historyPaintEnabled={!fullscreen}
          onToggleAll={() =>{  setShowAllMessages(previous => !previous) }}
          onLoadOlder={() => channel.loadOlder()}
          registerRowRef={registerRowRef}
          scrollHandle={handle}
          forceMountRowId={forceMountRowId}
          newSinceRowId={isSticky ? null : lastSeenRowIdRef.current}
          onUnseenCount={setUnseenCount}
          onTimeline={setTimeline}
          onOpenSubagent={(agentId) => setSubagentDetailId(agentId)}
          onOpenJobs={() => setJobsPanelOpen(true)}
          onOpenFile={openFileActions}
        />
        </ScrollBox>
        {(() => {
          // Gutter mode (settings `dsh-tui.scrollGutter`): the timeline
          // rail (default), the proportional scrollbar, or nothing. The
          // slot keeps its 2 columns in both rendered modes (Qwen's
          // permanent-gutter rule — an appearing/disappearing gutter
          // changes the transcript width and rewraps everything).
          const gutter = normalizeScrollGutter(channel.scrollGutter)
          if (gutter === 'hidden') return null
          if (gutter === 'scrollbar') {
            return <ScrollbarGutter handle={handle} terminalWidth={terminalColumns} />
          }
          return (
            <TimelineRail
              handle={handle}
              turns={timeline.turns}
              activeId={timeline.activeId}
              upId={timeline.upId}
              downId={timeline.downId}
              terminalWidth={terminalColumns}
              hoverEnabled={!promptSelectionActive}
              onRevealTurn={revealAndSeekRow}
            />
          )
        })()}
      </Box>
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
          !channel.minimal &&
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
                  // Upload = real tokens of the last request; download =
                  // the animated chars/4 estimate, matching the classic
                  // spinner's counter (the suffix used raw chars before,
                  // inflating the reading next to a real upload number).
                  suffix={`${lastUploadTokens > 0 ? ` · ↑ ${formatTokens(lastUploadTokens)}` : ''} · ↓ ${formatTokens(Math.round(channel.responseChars / 4))} tokens`}
                />
              </Box>
            ) : (
              <WorkingSpinner
                mode={channel.spinnerMode}
                hasActiveTools={channel.activeToolCount > 0}
                responseLengthRef={responseLengthRef}
                uploadTokensRef={uploadTokensRef}
                loadingStartTimeRef={loadingStartTimeRef}
                totalPausedMsRef={totalPausedMsRef}
                pauseStartTimeRef={pauseStartTimeRef}
                thinkingStatus={thinkingStatus}
              />
            ))}
        <GoalTodoPanel
          channel={channel}
          collapsed={todoCollapsed}
          onToggle={() => setTodoCollapsed(previous => !previous)}
        />
        {recap !== null && recap.auto && !recap.expanded && (
          <AutoRecapRow
            summary={recap.summary}
            streaming={!recap.done}
            onExpand={() => setRecap(prev => (prev ? { ...prev, expanded: true } : prev))}
            onDismiss={() => closeRecap()}
          />
        )}
        {balance !== null && (
          <BalanceReportRow
            result={balance.result}
            refreshing={balance.refreshing}
            tokens={channel.tokens}
            model={channel.model}
            onRefresh={runBalance}
            onDismiss={() => setBalance(null)}
          />
        )}
        {statusEntries.length > 0 && (
          // Plugin status contributions (tuiStatus seam): one joined line,
          // truncated by the Text wrap contract — the host owns the layout,
          // plugins own only their text.
          <Text dimColor wrap="truncate">
            {statusEntries.map(entry => entry.text).join(' · ')}
          </Text>
        )}
        {approvalPanelNode !== null ? (
          approvalPanelNode
        ) : dialogSnapshot !== null ? (
          <ExtensionDialog
            key={dialogSnapshot.key}
            dialog={dialogSnapshot}
            onDecide={value => dialogs.decide(dialogSnapshot.key, value)}
            onCancel={() => dialogs.cancel(dialogSnapshot.key)}
          />
        ) : overlay.kind === 'tips' ? (
          <Box flexDirection="column" marginTop={1}>
            <TipsPanel onClose={() => dispatchOverlay({ type: 'close-if', kind: 'tips' })} />
          </Box>
        ) : recap !== null && (!recap.auto || recap.expanded) ? (
          <Box flexDirection="column" marginTop={1}>
            <RecapPanel
              summary={recap.summary}
              title={recap.title}
              error={recap.error}
              streaming={!recap.done}
              titleApplied={recap.titleApplied}
              onClose={() => {
                // An expanded auto recap collapses back to its dim row;
                // a manual /recap closes outright.
                if (recap.auto) {
                  setRecap(prev => (prev ? { ...prev, expanded: false } : prev))
                } else {
                  closeRecap()
                }
              }}
              onCopy={() => {
                void setClipboard(recap.summary ?? '').then(raw => { if (raw) writeRaw?.(raw) })
                channel.notify(t('copied-chars', { n: (recap.summary ?? '').length }), { timeoutMs: 1500 })
              }}
              onApplyTitle={() => {
                if (recap.title === undefined || recap.titleApplied) return
                channel.renameSession(recap.title)
                setRecap(prev => (prev ? { ...prev, titleApplied: true } : prev))
                channel.notify(t('recap-title-applied-notify', { title: recap.title }), { color: 'success' })
              }}
            />
          </Box>
        ) : btw !== null ? (
          <Box flexDirection="column" marginTop={1}>
            <BtwPanel
              question={btw.question}
              answer={btw.answer}
              error={btw.error}
              streaming={!btw.done}
              onClose={closeBtw}
              onCopy={() => {
                void setClipboard(btw.answer ?? '').then(raw => { if (raw) writeRaw?.(raw) })
                channel.notify(t('copied-chars', { n: (btw.answer ?? '').length }), { timeoutMs: 1500 })
              }}
            />
          </Box>
        ) : questionPanelNode !== null ? (
          questionPanelNode
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
            onBackgroundRequest={backgroundToAgentView}
            backgroundAgentsNeedingInput={
              // Only the real channel supplies the seam; pre-agent-view test
              // stubs must not grow the footer row (layout-dependent
              // regressions pin the visible row count). The footer only
              // renders while some session actually waits (N > 0): a
              // permanent idle row would steal a transcript row on every
              // real channel — one row is enough to scroll the startup
              // header fully off a short terminal, pausing its viewport
              // clock and shifting every row-count layout invariant.
              channel.agentViewRows !== undefined && backgroundAgentsNeedingInput > 0
                ? backgroundAgentsNeedingInput
                : undefined
            }
            controllerRef={promptControllerRef}
          />
        )}
        <StatusLine
          channel={channel}
          selectionActive={selectionActive}
          helpOpen={helpOpen}
          wake={
            wakeBand === undefined
              ? undefined
              : {
                  band: wakeBand,
                  hint: trajectorySeen ? undefined : `${modLabel}t`,
                  tick: Math.floor(wakeTime / 120),
                }
          }
        />
        {/* 瞬态面板浮层：absolute + bottom:'100%' 钉在本 chrome Box 顶边，向上
            覆盖转录尾部行，自身零布局高度。in-flow 挂载会让帧高随面板开关涨落，
            把帧顶行滚进 scrollback 并在关闭重绘时二次写入（每切一次 /model 多
            一份启动画的根因）。maxHeight 预留 prompt/statusline 行，防短会话
            高列表探出帧顶。整体条件挂载：见 dialogOverlayOpen 注释。 */}
        {dialogOverlayOpen && (
        <OverlayAbove maxHeight={Math.max(terminalRows - 8, 1)}>
          {overlay.kind === 'thinking' && (
            <ThinkingToggle
              currentValue={thinkingVisible}
              focusIndex={overlay.focus}
              onPick={(index) => {
                // 点击行 = 设焦点 + 应用（与 Enter 同一条路径）
                const visible = index === 0
                setThinkingVisible(visible)
                dispatchOverlay({ type: 'close' })
                channel.notify(t('thinking-toggled', { state: visible ? t('thinking-on') : t('thinking-off') }))
              }}
            />
          )}
          {overlay.kind === 'workspace-picker' && workspaceTargets.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <WorkspacePicker
                targets={workspaceTargets}
                focusIndex={overlay.index}
                currentCwd={channel.cwd}
                onPick={(index) => {
                  // 点击行 = 切换该行目标（与 Enter 同一条路径）
                  const target = workspaceTargets[index]
                  dispatchOverlay({ type: 'close' })
                  if (target !== undefined) void channel.switchWorkspace(target)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'workspace-menu' && (
            <Box flexDirection="column" marginTop={1}>
              <WorkspaceMenuPicker
                options={workspaceMenuOptions}
                focusIndex={overlay.index}
                onPick={(index) => {
                  // 点击行 = 执行该行（与 Enter 同一条路径）
                  runWorkspaceMenuOption(workspaceMenuOptions[index])
                }}
              />
            </Box>
          )}
          {overlay.kind === 'workspace-flow' && (
            <Box flexDirection="column" marginTop={1}>
              <WorkspaceFlowPicker
                title={overlay.flow.title}
                choices={overlay.flow.choices}
                focusIndex={overlay.index}
                busy={overlay.busy}
                input={overlay.input}
                onPick={(index) => {
                  // 点击行 = 设焦点 + 执行分支（与 Enter 同一条路径）；
                  // busy/输入态在组件侧禁点
                  const choice = overlay.flow.choices[index]
                  if (choice === undefined) return
                  dispatchOverlay({ type: 'set-index', kind: 'workspace-flow', index })
                  runWorkspaceFlowAction(signal => choice.choose(signal))
                }}
              />
            </Box>
          )}
          {overlay.kind === 'model' && (
            <Box flexDirection="column" marginTop={1}>
              {models.length === 0 ? (
                <ModelPickerLoading />
              ) : activeModelGroup === undefined ? (
                <ModelPicker
                  groups={modelGroups}
                  focusIndex={overlay.index}
                  currentProvider={channel.provider}
                  onPick={(index) => {
                    // 点击分组行 = 进入该组（与 Enter 同一条路径）
                    const group = modelGroups[index]
                    if (!group) return
                    setModelGroup(group.provider)
                    if (group.provider === RECENTS_GROUP_PROVIDER) {
                      dispatchOverlay({ type: 'set-index', kind: 'model', index: 0 })
                      return
                    }
                    const landing = modelPickerLanding(
                      models.filter(model => model.provider === group.provider),
                      channel.provider,
                      channel.model,
                    )
                    dispatchOverlay({ type: 'set-index', kind: 'model', index: landing.index })
                  }}
                />
              ) : (
                <ModelPicker
                  models={groupModels}
                  groupLabel={activeModelGroup === RECENTS_GROUP_PROVIDER
                    ? t('picker-group-recent')
                    : modelGroups.find(group => group.provider === activeModelGroup)?.label}
                  showBack={modelGroups.length > 1 && !modelPickerDirect}
                  showProviderPrefix={activeModelGroup === RECENTS_GROUP_PROVIDER}
                  focusIndex={overlay.index}
                  currentModel={`${channel.provider}/${channel.model}`}
                  onPick={(index) => {
                    // 点击行 = 应用该行模型（与 Enter 同一条路径）
                    const model = groupModels[index]
                    if (!model) return
                    dispatchOverlay({ type: 'close' })
                    void switchModelRecorded(model.provider, model.id, model.name)
                  }}
                />
              )}
            </Box>
          )}
          {overlay.kind === 'skills' && (
            <Box flexDirection="column" marginTop={1}>
              {skillsList === null ? (
                <SkillsPickerLoading />
              ) : (
                <SkillsPicker
                  skills={skillsList}
                  focusIndex={overlay.index}
                  onPick={(index) => {
                    const skill = skillsList[index]
                    if (!skill) return
                    dispatchOverlay({ type: 'close' })
                    if (skill.userInvocable) setHistoryFill(`/${skill.name} `)
                  }}
                />
              )}
            </Box>
          )}
          {overlay.kind === 'activity' && (
            <Box flexDirection="column" marginTop={1}>
              <ActivityPicker
                focusIndex={overlay.index}
                currentPreset={channel.activityFrames}
                onPick={(index) => {
                  dispatchOverlay({ type: 'close' })
                  const name = PRESET_NAMES[index]
                  if (name) channel.setActivityFrames(name)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'color' && (
            <Box flexDirection="column" marginTop={1}>
              <ColorPicker
                focusIndex={overlay.index}
                currentColor={channel.sessionColor}
                onPick={(index) => {
                  dispatchOverlay({ type: 'close' })
                  const name = SESSION_COLOR_NAMES[index]
                  if (name) {
                    channel.setSessionColor(name)
                    channel.notify(t('color-set', { name }), { color: 'success' })
                  }
                }}
              />
            </Box>
          )}
          {overlay.kind === 'effort' && effortOptions.length > 1 && (
            <Box flexDirection="column" marginTop={1}>
              <EffortSlider
                options={effortOptions}
                focusIndex={overlay.index}
                currentId={channel.reasoningEffort}
                // 点击档位 = 移到该档并即时应用（与 ←/→ 同语义）
                onPick={(index) => {
                  dispatchOverlay({ type: 'set-index', kind: 'effort', index })
                  const option = effortOptions[index]
                  if (option) void channel.setEffort(option.id)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'preset' && presetOptions.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <PresetPicker
                presets={presetOptions}
                focusIndex={overlay.index}
                currentPreset={channel.agentPreset}
                onPick={(index) => {
                  dispatchOverlay({ type: 'close' })
                  const option = presetOptions[index]
                  if (option) void channel.switchPreset(option.id)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'permission' && overlay.snapshot.options.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <PermissionsPicker
                options={overlay.snapshot.options}
                focusIndex={overlay.index}
                currentValue={overlay.snapshot.current?.value}
                cwd={channel.cwd}
                onPick={(index) => {
                  if (approvalSnapshot !== null || questionSnapshot !== null || dialogSnapshot !== null) return
                  const option = overlay.snapshot.options[index]
                  dispatchOverlay({ type: 'close' })
                  if (option !== undefined) runPermissionCommand(` ${option.value}`)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'plan' && (
            <Box flexDirection="column" marginTop={1}>
              <PlanPicker
                focusIndex={overlay.index}
                currentOn={channel.mode.plan === true}
                onPick={(index) => {
                  dispatchOverlay({ type: 'close' })
                  const on = index === 0
                  void channel.runExternalCommand('plan', on ? '' : ' off').then((text) => {
                    if (text !== undefined && text !== '') channel.notify(text)
                  })
                }}
              />
            </Box>
          )}
          {overlay.kind === 'lang' && (
            <Box flexDirection="column" marginTop={1}>
              <LangPicker
                focusIndex={overlay.index}
                currentLang={getLang()}
                onPick={(index) => {
                  const lang = LANGS[index]
                  if (lang === undefined) return
                  dispatchOverlay({ type: 'close' })
                  applyLang(lang)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'theme' && (
            <Box flexDirection="column" marginTop={1}>
              <ThemePicker
                focusIndex={overlay.index}
                currentTheme={themeName}
                themeHost={themeHost}
                onPick={(index) => {
                  dispatchOverlay({ type: 'close' })
                  const name = getThemeOptions(themeHost)[index]?.value
                  if (name !== undefined) {
                    const ok = setTheme(name)
                    channel.notify(
                      ok ? t('theme-switched-saved', { name }) : t('theme-switch-failed', { name }),
                      { color: ok ? 'success' : 'error' },
                    )
                  }
                }}
              />
            </Box>
          )}
          {overlay.kind === 'history' && (
            <Box flexDirection="column" marginTop={1}>
              <HistorySearchDialog
                query={overlay.query}
                cursorOffset={overlay.cursor}
                matches={historyMatches}
                focusIndex={overlay.focus}
                onPick={(index) => {
                  // 点击行 = 填入该历史命令（与 Enter 同路径）
                  const entry = historyMatches[index]
                  if (entry) {
                    setHistoryFill(entry.text)
                    dispatchOverlay({ type: 'close' })
                  }
                }}
              />
            </Box>
          )}
          {overlay.kind === 'rewind' && (
            <Box flexDirection="column" marginTop={1}>
              <RewindPicker
                rows={rewindRows}
                focusIndex={overlay.index}
                confirmRow={overlay.confirm}
                modes={overlay.modes}
                modeIndex={overlay.modeIndex}
                busy={overlay.busy}
                onPickRow={(index) => {
                  // 列表页点击只选中：进入确认态保留键盘 Enter 显式触发
                  dispatchOverlay({ type: 'set-index', kind: 'rewind', index })
                }}
                onConfirm={() => {
                  // 确认页即显式确认层，点击直接执行（与 Enter 同路径）
                  const row = overlay.confirm
                  if (row === null) return
                  dispatchOverlay({ type: 'close' })
                  void performRewind(row)
                }}
                onPickMode={(index) => {
                  // 模式列表点击直接执行该模式（与 Enter 同路径）
                  const row = overlay.confirm
                  if (row === null) return
                  // 模式页仅当 modes 非空才渲染，这里空安全取值
                  const mode = index === 0 ? null : (overlay.modes?.[index - 1]?.id ?? null)
                  dispatchOverlay({ type: 'close' })
                  void performRewind(row, mode)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'file-actions' && (
            <Box flexDirection="column" marginTop={1}>
              <FileActionsPanel
                path={overlay.path}
                isDir={overlay.isDir}
                focusIndex={overlay.index}
                onPick={(index) => {
                  // 点击行直接执行该动作（与 Enter 同路径）
                  const path = overlay.path
                  dispatchOverlay({ type: 'close' })
                  runFileAction(index, path)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'search' && <TranscriptSearchBar query={searchQuery} cursorOffset={searchCursor} count={searchCount} current={searchCurrent} />}
        </OverlayAbove>
        )}
      </Box>
      {/* Tooltip 悬停浮层：absolute 零布局高度，挂在根 Box 最后确保盖在
          其余内容之上（yoga 的 absolute 相对父级，根 Box 原点即屏原点，
          指针 anchor 的屏幕坐标可直接使用）。订阅模块级 store，锚点/
          内容由各处的 useTooltip hover props 写入；resize 时自行隐藏
          （几何失效）。 */}
      <TooltipLayer
        invalidationKey={`${overlay.kind}:${dialogOverlayOpen}:${btw !== null}`}
        subscribeInvalidation={subscribeTooltipInvalidation}
      />
      {/* 全屏草稿编辑浮层：必须挂在 TooltipLayer 之后（树序最后），
          才能盖住包括状态栏在内的全部后绘兄弟。内容由 PromptInput
          经 module store 发布（见 PromptEditor.tsx）。 */}
      <PromptEditorLayer />
    </Box>
  )
}

/**
 * The pinned prompt header shown above the ScrollBox while the user has
 * scrolled up (mirroring Claude Code's FullscreenLayout.StickyPromptHeader).
 * Pins the user message the transcript viewport is currently showing — the
 * topmost visible user message, or the nearest one above when only assistant
 * content fills the view — so it tracks which turn the user is reading
 * instead of always carrying the latest prompt. Fixed at 1 row so the
 * ScrollBox never shifts when the text changes.
 */
function StickyPromptHeader({
  text,
  onClick,
}: {
  text: string
  onClick: () => void
}): React.ReactNode {
  return (
    <Box
      flexShrink={0}
      width="100%"
      height={1}
      paddingRight={1}
      onClick={onClick}
    >
      <Text color="briefLabelYou" bold wrap="truncate-end">
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
    // noSelect: the pill is chrome (a button), not transcript. Without this,
    // its text row is ordinary selectable cells — a selection anchored at
    // the screen bottom (or extended across it) captures
    // "↓ 回到底部（Enter/End）" into the copy on release. noSelect keeps the
    // click/hover wiring (dispatchClick ignores noSelect) and only removes
    // the cells from the highlight and getSelectedText.
    <NoSelect paddingX={2} paddingTop={1}>
      <Box
        backgroundColor={hover ? 'userMessageBackgroundHover' : 'background'}
        onClick={onClick}
        onMouseEnter={() =>{  setHover(true) }}
        onMouseLeave={() =>{  setHover(false) }}
      >
        <Text color="inverseText" bold>
          {' '}
          {count > 0
            ? t(count === 1 ? 'new-message' : 'new-messages', { n: count })
            : t('back-to-bottom')}
          {' '}
        </Text>
      </Box>
    </NoSelect>
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
