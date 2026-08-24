import {
  Key,
  LAYOUT_NODE,
  matchesKey,
  HStack,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  VStack,
  type Component,
  type LayoutComponent,
  type LayoutNode,
  type OverlayHandle,
  type PointerEvent,
  type StackChild,
  type TUI,
} from '../public.js'
import type { TuiCommands } from '../commands.js'
import type { TuiController } from '../controller.js'
import type {
  TuiSceneContext,
  TuiSceneHost,
  TuiSceneOverlayDescriptor,
  TuiSceneRootDescriptor,
} from '../../dsh-adapter/scenes.js'
import type {
  ChatViewModel,
  GoalTodoProjection,
  HeaderProjection,
  OverlayProjection,
  ProjectionMeta,
  PromptProjection,
  SessionsProjection,
  SpinnerProjection,
  StatusLineProjection,
  SubagentsProjection,
  TrajectoryProjection,
} from '../view-model.js'
import { TranscriptView } from '../components/transcript.js'
import { ChatTimeline, type TimelineState } from '../timeline.js'
import {
  RAIL_MIN_TERMINAL_WIDTH,
  RAIL_WIDTH,
  jumpTargetForTurn,
  railEligible,
  wrapPreviewLines,
  type TimelineTurn,
} from '../timeline-model.js'
import {
  ScrollbarGutterView,
  TimelineRailView,
  createTurnPreviewCard,
  type TimelineHoverCard,
  type TimelineViewInputs,
} from '../components/timeline-rail.js'
import { StickyPromptHeaderView } from '../components/sticky-prompt-header.js'
import { BackToBottomPillView } from '../components/back-to-bottom-pill.js'
import { PromptEditor } from '../components/prompt-editor.js'
import { NotificationsView } from '../components/notifications.js'
import { HeaderView } from '../components/header.js'
import { WorkingIndicator } from '../components/working-indicator.js'
import { GoalTodoView } from '../components/goal-todo.js'
import { StatusLineView } from '../components/status-line.js'
import { ApprovalPanelView } from '../components/overlays/approval-panel.js'
import { ExtensionDialogView } from '../components/overlays/extension-dialog.js'
import { QuestionPanelView } from '../components/overlays/question-panel.js'
import { SessionBrowserScreen } from './session-browser.js'
import { SessionTreeScreen } from './session-tree.js'
import { SettingsPanel } from '../components/settings-panel.js'
import { TrajectoryScene } from './trajectory-scene.js'
import {
  SubagentDashboardScreen,
  SubagentDetailScreen,
} from './subagent-scenes.js'
import {
  PickerView,
  createActivityPicker,
  createBtwPanel,
  createEffortSlider,
  createHistorySearch,
  createModelPicker,
  createPermissionPicker,
  createPresetPicker,
  createSkillsPicker,
  createThemePicker,
  createThinkingToggle,
  createTipsPanel,
  createWorkspacePicker,
  type BtwPanel,
} from '../components/pickers.js'
import { getLang, isLang, t, type I18nKey } from '../../i18n.js'
import { LOCAL_COMMANDS, localizedDescription } from '../../commands.js'
import { modeDescription, modeDisplayName } from '../../sessionModes.js'
import { FRAME_PRESETS, PRESET_NAMES } from '../../components/activityFrames.js'
import { formatTokens } from '../../cc/format.js'
import { isMac, modLabel } from '../../utils/modifiers.js'
import { loadHistory } from '../../history.js'
import { formatLoadedContextReport } from '../../utils/loaded-context.js'
import { runProviderWizard } from '../../dsh-adapter/providerWizard.js'
import { AUTO_THEME_NAME, getAutoThemeBase } from '../../theme.js'
import type {
  TuiWorkspaceChoice,
  TuiWorkspaceCommandResult,
} from '../../dsh-adapter/workspaces.js'

/** `max` → `Max` (effort levels arrive lower-case from the adapter). */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1)
}

/**
 * CC's built-in skill commands, driven through the DSH skill system: each
 * submits an activation prompt the model resolves via its skill catalog/load
 * tools (the corresponding SKILL.md ships under ~/.dsh/skills with dsh-tui).
 * i18n keys, not resolved strings: module scope evaluates before the boot
 * language settles, so t() must run at the call site to follow the active
 * language. Registry-discovered skill names are NOT here — those stay
 * completion-only and fall through the dispatcher's default to the model
 * verbatim (src/commands.ts contract, issue #86).
 */
const SKILL_PROMPTS: Readonly<Record<string, I18nKey>> = {
  audit: 'skill-audit-prompt',
  bug: 'skill-bug-prompt',
  practice: 'skill-practice-prompt',
  review: 'skill-review-prompt',
  pr_comments: 'skill-pr-comments-prompt',
  'release-notes': 'skill-release-notes-prompt',
  'vuln-check': 'skill-vuln-check-prompt',
}

/** The host-only scene controls consumed by the single chat root. */
export type ChatSceneHost = Pick<TuiSceneHost, 'active' | 'close' | 'create'>

/** Options for the single imperative chat root. */
export interface ChatScreenOptions {
  readonly ui: TUI
  readonly commands: TuiCommands
  readonly controller: TuiController
  readonly onExit: () => void
  readonly onUpdate?: () => void
  readonly onReload?: () => void
  readonly onOpenExternalEditor?: (draft: string, apply: (text: string) => void) => void
  /** Optional host bridge; absent hosts keep the no-plugin-scene behavior. */
  readonly sceneHost?: ChatSceneHost
  readonly fullscreen?: boolean
  readonly home?: string
  readonly sameProject?: (a: string, b: string) => boolean
}

const EMPTY_META: ProjectionMeta = {
  revision: 0,
  sessionEpoch: 0,
  generation: 0,
}

const EMPTY_MODE: PromptProjection['mode'] = { id: 'default', plan: false }
const EMPTY_STATUS_BAR = {} as StatusLineProjection['statusBar']

const EMPTY_PROMPT: PromptProjection = {
  meta: EMPTY_META,
  pending: [],
  notifications: [],
  commandList: [],
  reasoningEffort: undefined,
  effortLevels: undefined,
  working: false,
  mode: EMPTY_MODE,
}

const EMPTY_HEADER: HeaderProjection = {
  meta: EMPTY_META,
  whale: false,
  model: '',
  reasoningEffort: undefined,
  displayCwd: '',
  loadedContext: undefined,
}

const EMPTY_SPINNER: SpinnerProjection = {
  meta: EMPTY_META,
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  turnStart: 0,
  activeToolCount: 0,
  workingActivity: undefined,
  activityFrames: undefined,
  activityEnabled: false,
  minimal: false,
  lastUsage: undefined,
}

const EMPTY_STATUS: StatusLineProjection = {
  meta: EMPTY_META,
  minimal: false,
  statusBar: EMPTY_STATUS_BAR,
  lastUsage: undefined,
  reasoningEffort: undefined,
  mode: EMPTY_MODE,
  modeIndex: 0,
  contextWindow: undefined,
  tps: undefined,
  tpsSamples: [],
  model: '',
  tokens: { input: 0, output: 0 },
  gitBranch: undefined,
  displayCwd: '',
  sessionTitle: '',
  agentId: '',
  working: false,
  workingActivity: undefined,
  activityFrames: undefined,
  contextBarEnabled: false,
  contextSegments: {
    system: 0,
    prompt: 0,
    assistant: 0,
    thinking: 0,
    tools: 0,
  },
}

const EMPTY_SUBAGENTS: SubagentsProjection = {
  meta: EMPTY_META,
  items: [],
}

const EMPTY_GOAL_TODO: GoalTodoProjection = {
  meta: EMPTY_META,
  goal: undefined,
  todos: [],
  working: false,
}

/** A tiny imperative component for plugin status contributions. */
class StatusEntriesView implements Component {
  private entries: OverlayProjection['statusEntries'] = []

  update(entries: OverlayProjection['statusEntries']): void {
    this.entries = entries
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0 || this.entries.length === 0) return []
    return [truncateToWidth(this.entries.map((entry) => entry.text).join(' · '), width, '')]
  }
}

type PluginSceneComponent = Component & {
  readonly update?: (context: TuiSceneContext) => void
  readonly dispose?: () => void
}

type TransientKind =
  | 'session-browser'
  | 'session-tree'
  | 'trajectory'
  | 'subagent-dashboard'
  | 'subagent-detail'
  | 'plugin-scene'
  /** A picker-family panel mounted as a FULL transient replacement (only the
   *  /tips panel and the /btw side-question panel still do this): modal,
   *  keyboard-owning, closed via closeTransientScreen(). Selection pickers
   *  mount in the editor slot instead — see pickerPanel. */
  | 'picker'

/**
 * The only Chat root for the imperative pi-tui path.
 *
 * This class deliberately composes existing Components by their public
 * `render`/`handleInput` contracts. It owns no renderer, layout engine, input
 * parser, Channel or store; the controller pushes bounded projections and the
 * command sink is the only outbound side-effect path.
 */
export class ChatScreen implements Component {
  private readonly ui: TUI
  private readonly commands: TuiCommands
  private readonly controller: TuiController
  private readonly onExit: () => void
  private readonly onUpdate: (() => void) | undefined
  private readonly onReload: (() => void) | undefined
  private readonly onOpenExternalEditor:
    | ((draft: string, apply: (text: string) => void) => void)
    | undefined
  private readonly home: string
  private readonly sameProject: (a: string, b: string) => boolean
  private readonly sceneHost: ChatSceneHost | undefined
  private readonly sceneRootDescriptor: TuiSceneRootDescriptor
  private readonly sceneOverlayDescriptor: TuiSceneOverlayDescriptor

  private readonly transcript: TranscriptView
  private readonly promptEditor: PromptEditor
  private readonly header: HeaderView
  private readonly working: WorkingIndicator
  private readonly goalTodo: GoalTodoView
  private readonly status: StatusLineView
  private readonly statusEntries: StatusEntriesView
  private readonly notifications: NotificationsView
  private readonly approval: ApprovalPanelView
  private readonly dialog: ExtensionDialogView
  private readonly question: QuestionPanelView
  private readonly root: VStack
  private readonly fullscreen: boolean
  /** The fullscreen conversation ScrollView (header + transcript). Created
   *  only in fullscreen — inline mode has no scroll container. Promoted to a
   *  field (research §1.2) so M2.4 keyboard paths (Enter back-to-bottom,
   *  scroll-top loadOlder) and later timeline/pill work can query and steer
   *  it. */
  private readonly conversationScroll?: ScrollView
  /** Timeline data layer (research §3.4.4): derives the rail/header/pill
   *  snapshot + unseen state from the transcript's row geometry and the
   *  ScrollView's metrics. Ticked from update(); its published state is
   *  signature-gated and identity-stable while nothing consumed changed. */
  private readonly timeline = new ChatTimeline()
  /** Header-height memo for the timeline's content coordinate system: the
   *  header renders inside the scroll content, so its height is the
   *  transcript's offset. Keyed on the header projection identity (the
   *  controller shares it while whale/model/effort/cwd/loadedContext are
   *  unchanged) plus width; the opening animation and theme/lang changes
   *  never alter the line count. */
  private headerHeightCache:
    | { width: number; vm: HeaderProjection | undefined; height: number }
    | undefined

  /** M4b timeline chrome (research §3.3–§3.5): the rail/scrollbar gutter
   *  views, the sticky prompt header, and the back-to-bottom pill. Created
   *  unconditionally; MOUNTED only in fullscreen — the inline root keeps the
   *  §3.4.8 three-no rule (no rail, no sticky header, no pill). */
  private readonly railView: TimelineRailView
  private readonly scrollbarGutter: ScrollbarGutterView
  private readonly stickyHeaderView: StickyPromptHeaderView
  private readonly pillView: BackToBottomPillView
  /** Stable HStack child delegating to the active gutter view (rail or
   *  scrollbar, per `dsh-tui.scrollGutter`). Never unmounted itself — the
   *  `visible` predicate drops the slot when the mode is `hidden` or the
   *  current mode's eligibility fails. */
  private readonly gutterSlot: Component
  /** Terminal width seen by the last layout-predicate pass. In fullscreen
   *  the root entries' `visible` predicates receive the full root viewport
   *  every frame, so this is fresh by the time any chrome view renders. */
  private terminalWidthSeen = 0
  /** The transcript width the last timeline tick measured with — a change
   *  marks a (re)wrap frame and schedules the converging follow-up frame
   *  (see {@link tickTimeline}). */
  private lastTickWidth = 0
  /** Rail hover preview card (research §3.4.3): a non-capturing pi overlay
   *  popped by the rail's dwell timer. The screen owns the lifecycle —
   *  torn down on leave/click/state change (rail-side), modal open
   *  (update/handleInput), and dispose. */
  private previewOverlay: OverlayHandle | undefined
  private previewOverlayTurn: number | null = null

  private vm: ChatViewModel | undefined
  private subagents: SubagentsProjection = EMPTY_SUBAGENTS
  private transientScreen: Component | undefined
  private transientKind: TransientKind | undefined
  /** The `/settings` panel, mounted in the editor slot while open (pi-style
   *  editor replacement: the conversation stays visible above it and Esc
   *  restores the prompt editor). */
  private settingsPanel: SettingsPanel | undefined
  /** Stable VStack child that delegates to the open settings panel. */
  private readonly settingsSlot: Component
  /** The picker-family panel holding the editor slot (same pi-style editor
   *  replacement as the settings panel; mutually exclusive with it). */
  private pickerPanel: Component | undefined
  /** Stable VStack child that delegates to the open slot picker. */
  private readonly pickerSlot: Component
  private pluginSceneId: string | undefined
  private pluginSceneAbortController: AbortController | undefined
  private subagentDetailId: string | undefined
  /** `/deepseek` easter egg: each dispatch replays the header's opening. */
  private logoNonce = 0
  /** In-flight `/btw` side question; aborted when the panel closes. */
  private btwAbort: AbortController | undefined
  /** Ctrl+C-on-empty double-press exit: first press arms the window and shows
   *  the hint, a second press within 3s exits. */
  private exitPending = false
  private exitTimer: ReturnType<typeof setTimeout> | null = null
  /** Fold state for the goal/todo panel todo section — the one UI-local state
   *  the Ctrl/Cmd+Q hotkey and the panel's fold-header toggle share. */
  private todoCollapsed = false
  /** Ctrl/Cmd+O verbose expansion (UI-local toggle mirrored into the
   *  transcript's shared RowContext). */
  private transcriptExpanded = false
  /** Scroll-top auto-loadOlder (M2.4): armed once the user has scrolled away
   *  from the top at least once; consumed by each trigger, so a viewport
   *  parked at the top never drains the log in a loop. */
  private loadOlderArmed = false
  /** One loadOlder in flight at a time; the trigger never doubles up. */
  private loadOlderInFlight = false
  private disposed = false
  private readonly unsubscribeController: () => void

  constructor(options: ChatScreenOptions) {
    this.ui = options.ui
    this.commands = options.commands
    this.controller = options.controller
    this.onExit = options.onExit
    this.onUpdate = options.onUpdate
    this.onReload = options.onReload
    this.onOpenExternalEditor = options.onOpenExternalEditor
    this.home = options.home ?? ''
    this.sameProject = options.sameProject ?? ((a, b) => a === b)
    this.sceneHost = options.sceneHost
    this.fullscreen = options.fullscreen === true
    this.sceneRootDescriptor = Object.freeze({
      kind: 'root' as const,
      id: 'chat',
      mode: options.fullscreen === true ? 'fullscreen' as const : 'inline' as const,
    })
    this.sceneOverlayDescriptor = Object.freeze({
      kind: 'overlay' as const,
      id: 'none',
      visible: false,
    })

    this.transcript = new TranscriptView(this.ui)
    // Transcript pointer seams (research §4.3):
    // - the subagent card click opens the detail scene directly (the
    //   dashboard's Enter path targets the same screen);
    // - the load-earlier divider click shares the scroll-top trigger's
    //   fenced command-sink path, viewport anchor included;
    // - the §1.3 ownership gate is mirrored INTO the transcript: the root
    //   backstop below only sees events that bubble past every deeper
    //   component, so a transcript with its own handler must gate itself —
    //   while a modal/panel owns the keyboard it consumes without acting.
    this.transcript.onOpenSubagent = (agentId) => this.openSubagentDetail(agentId)
    this.transcript.onLoadOlder = () => this.triggerLoadOlder()
    this.transcript.isPointerBlocked = () =>
      this.transientScreen !== undefined ||
      this.settingsPanel !== undefined ||
      this.pickerPanel !== undefined ||
      this.activeOverlayKind() !== undefined

    // M4b timeline chrome wiring (research §3.3–§3.5): pure pull-model
    // views — the screen feeds ticked inputs, resolves navigation/reveal,
    // owns the hover card overlay, and mirrors the §1.3 ownership gate one
    // level down (the same condition the transcript gates itself with).
    this.railView = new TimelineRailView(this.ui)
    this.scrollbarGutter = new ScrollbarGutterView()
    this.stickyHeaderView = new StickyPromptHeaderView()
    this.pillView = new BackToBottomPillView(this.ui)
    const timelineSource = (): TimelineViewInputs | undefined => this.currentTimelineInputs()
    this.railView.source = timelineSource
    this.scrollbarGutter.source = timelineSource
    this.stickyHeaderView.source = timelineSource
    this.pillView.source = timelineSource
    this.railView.onJumpToTurn = (turn) => this.jumpToTurn(turn)
    this.stickyHeaderView.onJumpToTurn = (turn) => this.jumpToTurn(turn)
    this.railView.onHoverCard = (card) => this.showTurnPreview(card)
    this.scrollbarGutter.onScrollTo = (top) => {
      this.conversationScroll?.scrollTo(top)
      this.ui.requestRender()
    }
    this.pillView.onJumpToBottom = () => {
      this.conversationScroll?.scrollToEnd()
      this.ui.requestRender()
    }
    const chromeBlocked = (): boolean => this.chromePointerBlocked()
    this.railView.isPointerBlocked = chromeBlocked
    this.scrollbarGutter.isPointerBlocked = chromeBlocked
    this.stickyHeaderView.isPointerBlocked = chromeBlocked
    this.pillView.isPointerBlocked = chromeBlocked
    this.gutterSlot = {
      render: (width) => this.activeGutterView().render(width),
      invalidate: () => {
        this.railView.invalidate()
        this.scrollbarGutter.invalidate()
      },
      // The slot is the layout child, so pointer events on the gutter rect
      // arrive here; the active view owns them (same delegation pattern as
      // the settings/picker slots above).
      handlePointer: (event: PointerEvent): boolean | void =>
        this.activeGutterView().handlePointer?.(event),
    }
    this.header = new HeaderView(this.ui, EMPTY_HEADER)
    this.working = new WorkingIndicator(this.ui, EMPTY_SPINNER)
    this.goalTodo = new GoalTodoView(this.ui, EMPTY_GOAL_TODO)
    this.status = new StatusLineView(this.ui, EMPTY_STATUS)
    this.statusEntries = new StatusEntriesView()
    this.notifications = new NotificationsView()
    this.approval = new ApprovalPanelView(this.commands, this.ui)
    this.dialog = new ExtensionDialogView(this.commands, this.ui)
    this.question = new QuestionPanelView(this.commands, this.ui)
    this.promptEditor = new PromptEditor(this.ui, this.commands, EMPTY_PROMPT)

    this.promptEditor.onSubmitPrompt = (text) => this.submitPrompt(text)
    this.promptEditor.onSteer = (text) => this.commands.input.steer(text)
    this.promptEditor.onQueue = (text) => this.commands.input.submit(text)
    this.promptEditor.onInterruptAndDeliver = (text) => {
      this.commands.input.interruptAndDeliver([text])
    }
    this.promptEditor.onCancel = () => this.commands.input.cancel()
    this.promptEditor.onPullBack = () => this.pullBackPending()
    this.promptEditor.onExitRequest = () => {
      if (this.exitPending) {
        if (this.exitTimer !== null) {
          clearTimeout(this.exitTimer)
          this.exitTimer = null
        }
        this.exitPending = false
        this.onExit()
        return
      }
      this.exitPending = true
      this.commands.info.notify(t('exit-press-again'), { color: 'warning', timeoutMs: 3000 })
      this.exitTimer = setTimeout(() => {
        this.exitTimer = null
        this.exitPending = false
      }, 3000)
    }
    this.promptEditor.onOpenExternalEditor = (draft) => {
      if (this.onOpenExternalEditor === undefined) {
        this.commands.info.notify('External editor is not wired into this root yet.', { color: 'warning' })
      } else {
        this.onOpenExternalEditor(draft, text => this.promptEditor.setText(text))
      }
    }
    this.promptEditor.onClearOrExit = () => this.promptEditor.setText('')
    this.promptEditor.onRewindRequest = () => {
      this.openSessionTree('rewind')
    }
    this.promptEditor.focused = true

    this.settingsSlot = {
      render: (width) => this.settingsPanel?.render(width) ?? [],
      invalidate: () => this.settingsPanel?.invalidate(),
      // The slot is the layout child, so pointer events on the panel's rect
      // arrive here; the open panel owns them (modal ownership, §1.3 pointer
      // mirror). Everything the panel's own handler does not act on is still
      // consumed — never bubbled to the transcript behind it.
      handlePointer: (event: PointerEvent): boolean | void => {
        const panel = this.settingsPanel
        if (panel === undefined) return undefined
        if (panel.handlePointer !== undefined) return panel.handlePointer(event)
        return true
      },
    }
    this.pickerSlot = {
      render: (width) => this.pickerPanel?.render(width) ?? [],
      invalidate: () => this.pickerPanel?.invalidate(),
      handlePointer: (event: PointerEvent): boolean | void => {
        const panel = this.pickerPanel
        if (panel === undefined) return undefined
        if (panel.handlePointer !== undefined) return panel.handlePointer(event)
        return true
      },
    }

    // VStack owns the vertical component composition. Visibility predicates are
    // layout predicates only; every component still receives its own bounded
    // projection through update(). The settings panel and the selection
    // pickers swap into the prompt editor's slot while open (pi-style editor
    // replacement); the notification toast stack sits under the slot.
    const headerEntry: StackChild = { component: this.header, visible: () => this.shouldShowHeader() }
    const dockEntries: StackChild[] = [
      { component: this.working, visible: () => this.vm?.spinner.working === true },
      // Goal/todo docks directly under the working row, above overlays and
      // the editor slot — the position the React Chat gave GoalTodoPanel.
      { component: this.goalTodo, visible: () => this.goalTodo.visible },
      { component: this.approval, visible: () => this.activeOverlayKind() === 'approval' },
      { component: this.dialog, visible: () => this.activeOverlayKind() === 'dialog' },
      { component: this.question, visible: () => this.activeOverlayKind() === 'question' },
      { component: this.statusEntries, visible: () => this.hasStatusEntries() },
      { component: this.promptEditor, visible: () => this.settingsPanel === undefined && this.pickerPanel === undefined },
      { component: this.settingsSlot, visible: () => this.settingsPanel !== undefined },
      { component: this.pickerSlot, visible: () => this.pickerPanel !== undefined },
      { component: this.notifications, visible: () => this.hasNotifications() },
      this.status,
    ]
    if (this.fullscreen) {
      // Fullscreen (alt-screen) layout, mirroring pi's interactive-mode
      // fullscreenLayoutRoot: the conversation — banner included, so it
      // scrolls away with the history (see shouldShowHeader) — lives in the
      // primary ScrollView that TuiAltScreen routes wheel/PageUp/PageDown to;
      // the working/overlay/editor/notification/status chrome docks below at
      // its natural height and is never clipped by the viewport.
      //
      // M4b additions (research §3.3–§3.5): the sticky prompt header pins
      // above the conversation while scrolled up; the ScrollView shares an
      // HStack with the 2-column timeline gutter (rail or scrollbar per
      // `dsh-tui.scrollGutter`, dropped entirely by the `hidden` mode or a
      // failed eligibility check); the back-to-bottom pill docks at the
      // dock's top. The inline root below is untouched (§3.4.8).
      const conversation = new VStack([headerEntry, this.transcript])
      const scrollView = new ScrollView(conversation, {
        follow: 'end',
        primary: true,
        overscroll: 'chain',
        scrollbar: 'auto',
      })
      this.conversationScroll = scrollView
      const conversationRow = new HStack([
        { component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        {
          component: this.gutterSlot,
          basis: RAIL_WIDTH,
          grow: 0,
          shrink: 0,
          visible: (viewport) => {
            this.terminalWidthSeen = viewport.width
            return this.gutterVisible(viewport.width)
          },
        },
      ])
      const dock = new VStack([
        {
          component: this.pillView,
          visible: (viewport) => {
            this.terminalWidthSeen = viewport.width
            return this.pillVisible()
          },
        },
        ...dockEntries,
      ])
      this.root = new VStack([
        {
          component: this.stickyHeaderView,
          visible: (viewport) => {
            this.terminalWidthSeen = viewport.width
            return this.stickyHeaderVisible()
          },
        },
        { component: conversationRow, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
      ])
    } else {
      this.root = new VStack([headerEntry, this.transcript, ...dockEntries])
    }

    this.unsubscribeController = this.controller.subscribe('chat', () => {
      if (!this.disposed) this.update(this.controller.getChat())
    })

    // The controller subscription is not an immediate subscription contract;
    // seed the root from the current projection so the first frame is live.
    this.update(this.controller.getChat())
  }

  /** Push the latest Chat projection and refresh any open transient scene. */
  update(vm: ChatViewModel): void {
    if (this.disposed) return
    this.vm = vm
    this.transcript.update(vm.transcript)
    this.header.update(vm.header)
    this.working.update(vm.spinner)
    this.status.update(vm.statusLine)
    this.statusEntries.update(vm.overlays.statusEntries ?? [])
    this.notifications.update(vm.prompt.notifications)
    this.promptEditor.update(vm.prompt)
    this.approval.update(vm.overlays.approval)
    this.dialog.update(vm.overlays.dialog)
    this.question.update(vm.overlays.question)
    this.subagents = this.controller.getSubagents?.() ?? EMPTY_SUBAGENTS
    // Standalone getter like subagents: the panel slice is pulled, not
    // embedded in ChatViewModel, so older fakes without it still work.
    this.goalTodo.update(this.controller.getGoalTodo?.() ?? EMPTY_GOAL_TODO)
    this.updatePluginScene()
    this.updateTransient()
    this.syncPromptFocus()
    this.pollLoadOlder()
    this.tickTimeline()
    this.syncScrollGutter()
    // A modal/panel opening must drop a popped hover card even before the
    // pointer moves again (the rail's own clear only fires on rail events).
    if (this.chromePointerBlocked()) this.hideTurnPreview()
    this.ui.requestRender()
  }

  /** Route transient screens first, then the active inline modal, then prompt. */
  handleInput(data: string): void {
    if (this.disposed) return
    // Keyboard-driven modal opens don't come with a controller emit; drop a
    // popped hover card as soon as ownership moves away from the transcript.
    if (this.chromePointerBlocked()) this.hideTurnPreview()

    // A plugin scene owns the whole root even when it has no input handler;
    // otherwise its Escape/letters would leak into the chat editor.
    if (this.transientKind === 'plugin-scene') {
      this.transientScreen?.handleInput?.(data)
      this.ui.requestRender()
      return
    }

    if (this.transientScreen?.handleInput !== undefined) {
      this.transientScreen.handleInput(data)
      this.ui.requestRender()
      return
    }

    // The settings panel owns the keyboard while it holds the editor slot.
    if (this.settingsPanel !== undefined) {
      this.settingsPanel.handleInput(data)
      this.ui.requestRender()
      return
    }

    // So does a slot-mounted picker (the two never hold the slot together).
    if (this.pickerPanel?.handleInput !== undefined) {
      this.pickerPanel.handleInput(data)
      this.ui.requestRender()
      return
    }

    const overlay = this.activeOverlay()
    if (overlay !== undefined) {
      overlay.handleInput(data)
      this.ui.requestRender()
      return
    }

    // These global root bindings match the old Chat scene shortcuts. They are
    // checked before the editor so Ctrl+A is not mistaken for line-start.
    if (matchesKey(data, Key.ctrl('t'))) {
      this.openTrajectory(this.controller.getTrajectory())
      return
    }
    if (matchesKey(data, Key.ctrl('a'))) {
      this.openSubagentDashboard(this.subagents)
      return
    }

    // Ctrl/Cmd+Q folds the goal/todo panel's todo section (mod = ctrl, or
    // super on macOS — the isMod contract). Global like Ctrl+T/Ctrl+A: it
    // works mid-turn and never reaches the editor; the fold-header toggle
    // shares the same UI-local state.
    if (matchesKey(data, Key.ctrl('q')) || (isMac && matchesKey(data, Key.super('q')))) {
      this.todoCollapsed = !this.todoCollapsed
      this.goalTodo.setCollapsed(this.todoCollapsed)
      this.ui.requestRender()
      return
    }

    // Ctrl/Cmd+E lifts/re-applies the transcript's MAX_RENDERED_ROWS fold
    // (the divider advertises the key). Global like Ctrl+T/Ctrl+A.
    if (matchesKey(data, Key.ctrl('e')) || (isMac && matchesKey(data, Key.super('e')))) {
      if (this.transcript.isShowingAll) this.transcript.collapse()
      else this.transcript.showAll()
      this.ui.requestRender()
      return
    }

    // Ctrl/Cmd+O toggles verbose expansion (full reasoning, full tool
    // args/results). pi's exact layout re-measures on the next frame, so no
    // source-style reanchorViewport is needed here.
    if (matchesKey(data, Key.ctrl('o')) || (isMac && matchesKey(data, Key.super('o')))) {
      this.transcriptExpanded = !this.transcriptExpanded
      this.transcript.setExpanded(this.transcriptExpanded)
      this.ui.requestRender()
      return
    }

    // Ctrl/Cmd+R mounts the persisted-input history search in the editor
    // slot (pi-style editor replacement, same as the other slot pickers).
    if (matchesKey(data, Key.ctrl('r')) || (isMac && matchesKey(data, Key.super('r')))) {
      this.openHistorySearch()
      return
    }

    // Shift+Tab cycles the session permission mode. The open completion menu
    // keeps the key (the same isShowingAutocomplete guard the editor's Tab
    // routing uses); transient screens, the settings panel and overlays own
    // the keyboard above and never reach this check.
    if (matchesKey(data, Key.shift('tab')) && !this.promptEditor.isShowingAutocomplete()) {
      this.commands.session.cycleMode()
      return
    }

    // Back-to-bottom (research §3.5): a plain Enter while the conversation is
    // scrolled away from the end returns to the bottom and is CONSUMED — the
    // send does not happen this time, even with a non-empty prompt. That is
    // the manual's semantics and a deliberate deviation from source main,
    // which still sends a non-empty prompt on this Enter. The completion
    // menu keeps Enter for its own selection. Inline mode has no scroll
    // container, so the key always falls through to the editor there.
    if (
      this.conversationScroll !== undefined
      && !this.conversationScroll.isFollowingEnd
      && !this.promptEditor.isShowingAutocomplete()
      && matchesKey(data, Key.enter)
    ) {
      this.conversationScroll.scrollToEnd()
      this.ui.requestRender()
      return
    }

    this.promptEditor.handleInput(data)
    this.ui.requestRender()
  }

  /**
   * Pointer gate (research §1.3, §4.2 contract 2): whoever owns the keyboard
   * owns the pointer too.
   *
   * A transient screen with a pointer handler (session browser, session tree)
   * owns the whole root: events reach it through this root backstop, because
   * a mounted transient collapses the layout to the chat leaf.
   *
   * While an approval/dialog/question panel, the settings panel, or a slot
   * picker owns the keyboard, this root-level backstop reproduces
   * capturing-modal semantics (those panels are DOCK components, not pi
   * overlays, so they are not capturing regions). ChatScreen is the layout
   * root, hence the LAST box in every hit chain — events on a panel's own
   * rect are consumed deeper by the slot's forwarding handler or the panel's
   * handlePointer and never reach here; everything that bubbles this far
   * (transcript, dock chrome) is swallowed: press consumed → no selection
   * candidate, click consumed → no transcript business action, wheel consumed
   * → pi skips ScrollView routing. The transcript now has its own
   * handlePointer (research §4.4 stage 6), so it mirrors this gate one level
   * down via its `isPointerBlocked` seam — a transcript click under an open
   * modal is consumed there without acting, exactly as if it had bubbled
   * here. With no panel open, nothing is consumed and the default
   * wheel/selection behavior is untouched.
   *
   * Trade-off vs source main: drag-selection is suspended while a blocking
   * panel is open (source's screen-buffer selection stays live there). The
   * strict modal reading was chosen so transcript click handlers can never
   * leak under an open modal.
   */
  handlePointer(event: PointerEvent): boolean | void {
    if (this.disposed) return
    if (this.transientScreen?.handlePointer !== undefined) {
      return this.transientScreen.handlePointer(event)
    }
    if (this.settingsPanel !== undefined || this.pickerPanel !== undefined) return true
    if (this.activeOverlayKind() !== undefined) return true
    return undefined
  }

  /**
   * Windows right-click paste (the TuiAltScreen `onRightClickPaste` hook):
   * paste into the prompt only when the editor would own keyboard input —
   * the same ownership order handleInput enforces (research §1.3). With a
   * transient screen, settings panel, slot picker or blocking overlay open,
   * the paste target is not the prompt and the event is ignored.
   */
  pasteIntoPrompt(): void {
    if (this.disposed) return
    if (this.transientScreen !== undefined) return
    if (this.settingsPanel !== undefined || this.pickerPanel !== undefined) return
    if (this.activeOverlayKind() !== undefined) return
    this.promptEditor.requestClipboardPaste()
  }

  /** Render the transient replacement or the main VStack, clipping every row. */
  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width))
    if (safeWidth === 0) return []

    if (this.transientScreen !== undefined) {
      this.updateTransientViewport()
      return fitLines(this.transientScreen.render(safeWidth), safeWidth)
    }

    this.syncPromptFocus()
    return fitLines(this.root.render(safeWidth), safeWidth)
  }

  /**
   * The editor emits the hardware cursor marker only while focused; it yields
   * focus to an active overlay, the settings panel, or a slot picker (a
   * transient screen returns from render() before this runs, hence the same
   * guard here). Called from both update() and render(): fullscreen layout
   * frames bypass render() entirely — the alt-screen engine draws the layout
   * entries directly — so update() is the only place the flag tracks overlay
   * state in fullscreen.
   */
  private syncPromptFocus(): void {
    if (this.transientScreen !== undefined) return
    this.promptEditor.focused =
      this.activeOverlayKind() === undefined && this.settingsPanel === undefined && this.pickerPanel === undefined
  }

  /**
   * Expose the root's layout node to pi-tui's alt-screen engine: in
   * fullscreen this hands renderLayoutFrame the ScrollView+dock tree (scroll
   * routing, bottom-docked chrome). A mounted transient screen keeps the leaf
   * behavior — the engine renders this component's render() output directly.
   * Inline mode never consults layout nodes.
   */
  [LAYOUT_NODE](): LayoutNode | undefined {
    if (this.transientScreen !== undefined) return undefined
    return (this.root as unknown as LayoutComponent)[LAYOUT_NODE]()
  }

  invalidate(): void {
    this.root.invalidate()
    this.transientScreen?.invalidate()
    this.settingsPanel?.invalidate()
    this.pickerPanel?.invalidate()
  }

  /** Components replayed by fullscreen finalStop on the same terminal. */
  getTranscriptComponentsForExit(): readonly Component[] {
    // The live TranscriptView folds long sessions behind MAX_RENDERED_ROWS;
    // the exit replay must land the COMPLETE transcript in scrollback
    // (plan §1.2), so it mounts an uncapped render facade over the same row
    // cache instead of the capped live view.
    const transcript = this.transcript
    const fullTranscript: Component = {
      render: (width) => transcript.renderFullTranscript(width),
      invalidate: () => transcript.invalidate(),
    }
    return [this.header, fullTranscript, this.working, this.statusEntries, this.promptEditor, this.status]
  }

  /** Stop controller delivery and every child/scene timer. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeController()
    this.hideTurnPreview()
    this.railView.dispose()
    this.btwAbort?.abort()
    this.btwAbort = undefined
    if (this.exitTimer !== null) {
      clearTimeout(this.exitTimer)
      this.exitTimer = null
    }
    this.exitPending = false
    this.settingsPanel?.dispose()
    this.settingsPanel = undefined
    this.disposeComponent(this.pickerPanel)
    this.pickerPanel = undefined
    if (this.transientKind === 'plugin-scene') {
      this.closePluginScene(false)
    } else {
      this.disposeComponent(this.transientScreen)
      this.transientScreen = undefined
      this.transientKind = undefined
    }
    this.subagentDetailId = undefined
    this.promptEditor.dispose()
    this.header.dispose()
    this.working.dispose()
    this.goalTodo.dispose()
  }

  /** Replace the conversation with the session browser, without another TUI. */
  openSessionBrowser(vm: SessionsProjection): void {
    const screen = new SessionBrowserScreen({
      commands: this.commands,
      home: this.home,
      sameProject: this.sameProject,
      onClose: () => this.closeTransientScreen(),
    })
    screen.onChange = () => {
      if (this.transientScreen === screen) this.ui.requestRender()
    }
    screen.update(vm)
    this.replaceTransient(screen, 'session-browser')

    // The browser opens immediately and refreshes through the controller fence.
    // Keep the explicit projection passed by the caller until the refresh lands.
    const refreshSessions = this.controller.refreshSessions
    if (typeof refreshSessions !== 'function') return
    void refreshSessions.call(this.controller).then(() => {
      if (this.transientScreen !== screen) return
      screen.update(this.controller.getSessions())
      this.ui.requestRender()
    }).catch(() => {
      if (this.transientScreen === screen) this.ui.requestRender()
    })
  }

  /**
   * Double-Esc / `/tree`: replace the conversation with the session family
   * tree (pi's Session Tree). The family loads asynchronously through the
   * fenced sink — the panel opens in its loading seat, and a tree that
   * settles null/undefined closes itself (the channel already toasted the
   * reason, or a session swap made the build stale). The panel opens in
   * rewind intent; ctrl+f toggles the fork intent inside it.
   */
  openSessionTree(mode: 'rewind' | 'fork'): void {
    const screen = new SessionTreeScreen({
      commands: this.commands,
      mode,
      currentSessionId: this.vm?.agentId ?? '',
      onClose: () => this.closeTransientScreen(),
      onRestoreText: (text) => this.promptEditor.setText(text),
    })
    screen.onChange = () => {
      if (this.transientScreen === screen) this.ui.requestRender()
    }
    this.replaceTransient(screen, 'session-tree')
    screen.load()
  }

  /**
   * `/rewind`: immediately rewind the LAST user turn (kimi-code's `/undo 1`)
   * — no picker. The channel forks to just before that turn, swaps in the
   * fork, and returns the prompt text, which goes back into the editor for
   * re-editing. Refusals (running-turn settle timeout, first message) are
   * toasted by the channel; an empty transcript gets its own note here.
   */
  private rewindLastTurn(): void {
    const rows = this.vm?.transcript.rows ?? []
    let target
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!
      if (row.kind === 'user' && row.seq !== undefined) {
        target = row
        break
      }
    }
    if (target === undefined) {
      this.commands.info.notify(t('rewind-none'), { color: 'warning' })
      return
    }
    void this.commands.session.rewindTo(target).then((text) => {
      if (text === null) return
      if (text !== '') this.promptEditor.setText(text)
      this.commands.info.notify(t('rewind-done'))
      this.ui.requestRender()
    })
  }

  /**
   * `/settings`: mount the settings panel in the prompt editor's slot
   * (pi-style editor replacement — the transcript and status chrome stay
   * visible; Esc closes the panel and restores the editor). Reopening while
   * open is a no-op; writes land immediately through the settings host.
   */
  openSettings(): void {
    if (this.disposed || this.settingsPanel !== undefined || this.pickerPanel !== undefined) return
    this.settingsPanel = new SettingsPanel({
      commands: this.commands,
      onClose: () => this.closeSettings(),
    })
    this.hideTurnPreview()
    this.promptEditor.focused = false
    this.ui.requestRender()
  }

  /** Close the settings panel and hand the keyboard back to the editor. */
  private closeSettings(): void {
    if (this.settingsPanel === undefined) return
    this.settingsPanel.dispose()
    this.settingsPanel = undefined
    this.promptEditor.focused = true
    this.ui.requestRender()
  }

  /** Replace the conversation with the trajectory scene. */
  openTrajectory(vm: TrajectoryProjection): void {
    const scene = new TrajectoryScene({
      commands: this.commands,
      onClose: () => this.closeTransientScreen(),
      requestRender: () => this.ui.requestRender(),
      title: this.vm?.statusLine.sessionTitle || this.vm?.statusLine.displayCwd,
      viewportHeight: this.terminalRows(),
    })
    scene.update(vm)
    this.replaceTransient(scene, 'trajectory')
  }

  /** Open the subagent dashboard; its Enter path opens the detail screen. */
  openSubagentDashboard(vm: SubagentsProjection): void {
    this.subagents = vm
    const dashboard = new SubagentDashboardScreen(this.commands, {
      onClose: () => this.closeTransientScreen(),
      onSelect: (agentId) => this.openSubagentDetail(agentId),
    })
    dashboard.update(vm)
    this.subagentDetailId = undefined
    this.replaceTransient(dashboard, 'subagent-dashboard')
  }

  /** Close and dispose the current replacement screen, if any. */
  closeTransientScreen(): void {
    if (this.transientKind === 'plugin-scene') {
      this.closePluginScene()
      return
    }
    if (this.transientScreen === undefined) return
    this.disposeComponent(this.transientScreen)
    this.transientScreen = undefined
    this.transientKind = undefined
    this.subagentDetailId = undefined
    this.promptEditor.focused = true
    this.ui.requestRender()
  }

  /** Project and mount the host-owned plugin scene in this root only. */
  private updatePluginScene(): void {
    const active = this.vm?.pluginScene.active
    const host = this.sceneHost
    if (active === undefined || host === undefined) {
      if (this.transientKind === 'plugin-scene') this.closePluginScene(false)
      return
    }

    // The channel mirror and the host accessor should move together. If they
    // briefly disagree, do not create a component for the wrong descriptor.
    if (host.active === undefined || host.active.id !== active.id) {
      if (this.transientKind === 'plugin-scene') this.disposePluginScene()
      return
    }

    if (this.transientKind === 'plugin-scene' && this.pluginSceneId === active.id) {
      const component = this.transientScreen as PluginSceneComponent | undefined
      const signal = this.pluginSceneAbortController?.signal
      if (component?.update !== undefined && signal !== undefined) {
        component.update(this.createPluginSceneContext(signal))
      }
      return
    }

    if (this.transientKind === 'plugin-scene') {
      // The runtime has already selected the replacement id, so closing the
      // host here would close the new scene. Abort/dispose only, then create it.
      this.disposePluginScene()
    } else if (this.transientScreen !== undefined) {
      // A plugin scene has priority over an existing built-in transient screen.
      this.disposeComponent(this.transientScreen)
      this.transientScreen = undefined
      this.transientKind = undefined
      this.subagentDetailId = undefined
    }

    const abortController = new AbortController()
    const context = this.createPluginSceneContext(abortController.signal)
    let component: Component | undefined
    try {
      component = host.create(context)
    } catch {
      // The real runtime catches factory failures. Keep a structural host fake
      // or a skewed runtime from taking down the single TUI as well.
      component = undefined
    }

    if (!this.isPluginSceneComponent(component)) {
      // TuiSceneHost.create() normally owns factory validation/failure
      // closure. If a structural/skewed host leaves the same scene active,
      // close it here too; never install an absent component into the root.
      abortController.abort()
      if (host.active?.id === active.id) this.closeSceneHost(host)
      return
    }

    // A factory may synchronously close or replace itself through the command
    // sink. Never let a stale component escape into the newly active root.
    if (
      this.disposed
      || this.vm?.pluginScene.active?.id !== active.id
      || host.active?.id !== active.id
      || abortController.signal.aborted
    ) {
      abortController.abort()
      this.disposeComponent(component)
      return
    }

    this.pluginSceneId = active.id
    this.pluginSceneAbortController = abortController
    this.transientScreen = component
    this.transientKind = 'plugin-scene'
    this.updateTransientViewport()
    this.promptEditor.focused = false
  }

  private createPluginSceneContext(signal: AbortSignal): TuiSceneContext {
    const viewModel = this.vm
    if (viewModel === undefined) throw new Error('plugin scene context requested before ChatViewModel')
    return Object.freeze({
      viewModel,
      commands: this.commands,
      root: this.sceneRootDescriptor,
      overlay: this.sceneOverlayDescriptor,
      signal,
    })
  }

  private isPluginSceneComponent(component: Component | undefined): component is PluginSceneComponent {
    return component !== undefined
      && typeof component.render === 'function'
      && typeof component.invalidate === 'function'
  }

  /** Close the active host scene and restore the conversation root. */
  private closePluginScene(requestRender = true): void {
    if (this.transientKind !== 'plugin-scene') return
    const sceneId = this.pluginSceneId
    const host = this.sceneHost
    this.disposePluginScene()
    if (host !== undefined && sceneId !== undefined) {
      const hostActive = host.active
      if (hostActive === undefined || hostActive.id === sceneId) this.closeSceneHost(host)
    }
    this.promptEditor.focused = true
    if (requestRender && !this.disposed) this.ui.requestRender()
  }

  private disposePluginScene(): void {
    const component = this.transientScreen
    const abortController = this.pluginSceneAbortController
    this.transientScreen = undefined
    this.transientKind = undefined
    this.pluginSceneId = undefined
    this.pluginSceneAbortController = undefined
    abortController?.abort()
    this.disposeComponent(component)
  }

  private closeSceneHost(host: ChatSceneHost): void {
    try {
      host.close()
    } catch {
      // Host close is intentionally best effort; the runtime close path is
      // synchronous and idempotent, while a skewed host must fail closed.
    }
  }

  private submitPrompt(text: string): void {
    if (this.vm?.prompt.working === true) {
      this.commands.input.steer(text)
      return
    }

    const command = /^\/([^\s]+)(?:\s([\s\S]*))?$/.exec(text)
    if (command === null) {
      this.commands.input.submit(text)
      return
    }
    this.dispatchSlashCommand(command[1]!, command[2] ?? '', text)
  }

  /**
   * Local slash-command dispatcher (ported from the old React Chat scene's
   * runCommand switch). Every LOCAL_COMMANDS/HIDDEN_COMMANDS entry lands on
   * a case below with a visible effect — an interactive picker/panel mounted
   * as the transient screen, a transcript-local report, a notification, or a
   * prompt submitted to the model. The default branch handles only names the
   * merged command list marks `external` (plugin-registered DSH commands);
   * anything else — unknown names and registry-discovered skill entries,
   * which are completion-only by design (src/commands.ts) — falls back to
   * sending the line to the model verbatim, so a hand-typed `/foo` never
   * silently disappears.
   */
  private dispatchSlashCommand(name: string, rawInput: string, original: string): void {
    const command = name.toLowerCase()
    switch (command) {
      case 'resume':
        this.openSessionBrowser(this.controller.getSessions())
        return
      case 'settings':
        this.openSettings()
        return
      case 'trace':
      case 'trajectory':
        this.openTrajectory(this.controller.getTrajectory())
        return
      case 'agents':
      case 'subagents':
        this.openSubagentDashboard(this.subagents)
        return
      case 'clear':
        this.commands.session.clear()
        return
      case 'compact':
        this.commands.session.compact()
        return
      case 'new':
        void this.commands.session.newSession()
        return
      case 'rewind':
        this.rewindLastTurn()
        return
      case 'tree':
        this.openSessionTree('rewind')
        return
      case 'fork':
        void this.commands.session.forkSession()
        return
      case 'update':
        if (this.onUpdate === undefined) {
          this.commands.info.notify('Update is not available in this host.', { color: 'warning' })
        } else {
          this.onUpdate()
        }
        return
      case 'reload':
        if (this.onReload === undefined) {
          this.commands.info.notify('Reload is not available in this host.', { color: 'warning' })
        } else {
          this.onReload()
        }
        return
      case 'exit':
      case 'quit':
      case 'q':
        this.onExit()
        return
      case 'model':
        this.runModelCommand(rawInput)
        return
      case 'effort':
        this.runEffortCommand(rawInput)
        return
      case 'preset':
        this.runPresetCommand(rawInput)
        return
      case 'theme':
        this.runThemeCommand(rawInput)
        return
      case 'lang':
        this.runLangCommand(rawInput)
        return
      case 'activity':
        this.runActivityCommand(rawInput)
        return
      case 'thinking':
        this.openThinkingToggle()
        return
      case 'skills':
        this.openSkillsPicker()
        return
      case 'workspace':
        this.runWorkspaceCommand(rawInput)
        return
      case 'provider':
        this.openProviderWizard()
        return
      case 'btw':
        this.openBtwPanel(rawInput)
        return
      case 'tips':
        // Static reference panel: stays a full transient screen, not the
        // editor-slot replacement the selection pickers use.
        this.replaceTransient(createTipsPanel({ onClose: () => this.closeTransientScreen() }), 'picker')
        return
      case 'help':
        this.pushHelp()
        return
      case 'context': {
        const context = this.vm?.header.loadedContext
        if (context === undefined) {
          this.commands.info.notify(t('context-unavailable'), { color: 'warning' })
          return
        }
        this.commands.info.pushLocal('/context', formatLoadedContextReport(context))
        return
      }
      case 'status':
        this.pushStatus()
        return
      case 'cost': {
        const status = this.vm?.statusLine
        const usage = status?.lastUsage
        const lines = [
          `Tokens ${formatTokens(status?.tokens.input ?? 0)} in → ${formatTokens(status?.tokens.output ?? 0)} out`,
        ]
        if (usage !== undefined) {
          const total = usage.input + usage.cacheRead + usage.cacheWrite
          const rate = total > 0 ? ((usage.cacheRead / total) * 100).toFixed(1) : '0.0'
          lines.push(t('cost-cache-hit-rate', { rate, read: formatTokens(usage.cacheRead), write: formatTokens(usage.cacheWrite) }))
        }
        lines.push(t('cost-note'))
        this.commands.info.pushLocal('/cost', lines)
        return
      }
      case 'tokens': {
        const status = this.vm?.statusLine
        const usage = t('tokens-usage', {
          in: formatTokens(status?.tokens.input ?? 0),
          out: formatTokens(status?.tokens.output ?? 0),
        })
        if (status?.contextWindow === undefined) {
          this.commands.info.notify(usage)
        } else {
          const percent = Math.max(
            0,
            Math.min(100, Math.round((status.tokens.input / status.contextWindow) * 100)),
          )
          this.commands.info.notify(t('tokens-usage-context', { usage, percent }))
        }
        return
      }
      case 'config': {
        const userHome = process.env.USERPROFILE ?? ''
        this.commands.info.pushLocal('/config', [
          t('doctor-example-config', { path: 'dsh --profile dsh-tui' }),
          t('doctor-user-config', { path: `${userHome}/.dsh/profiles/dsh-tui/cordis.patch.yml` }),
          '',
          t('doctor-launch-hint'),
          t('doctor-route-hint'),
        ])
        return
      }
      case 'doctor':
        this.commands.info.pushLocal('/doctor', this.commands.info.doctorInfo())
        return
      case 'plugins':
        // Plugin diagnostics (C-070): trust banner first, then descriptor /
        // grant matrix / ledger tail — or validate+negotiate for
        // `/plugins check <path>` (rawInput carries the subcommand).
        this.commands.info.pushLocal('/plugins', this.commands.info.pluginsInfo(rawInput))
        return
      case 'export': {
        const target = this.commands.info.exportSession()
        this.commands.info.notify(
          target === null
            ? t('export-failed')
            : t('export-saved', { target }),
          target === null ? { color: 'error', timeoutMs: 8000 } : { timeoutMs: 8000 },
        )
        return
      }
      case 'init': {
        const result = this.commands.info.initWorkspace()
        if (result === null) this.commands.info.notify(t('agentsmd-create-failed'), { color: 'error' })
        else if (result === 'exists') this.commands.info.notify(t('agentsmd-exists'))
        else this.commands.info.notify(t('agentsmd-created', { result }))
        return
      }
      case 'login':
        void this.commands.info.describeCredential('DEEPSEEK_API_KEY')
          .catch(() => undefined)
          .then(status => {
            if (this.disposed) return
            const keyStatus = status === undefined
              ? t('login-credentials-unavailable')
              : status.configured
                ? t('login-key-configured', { ref: 'DEEPSEEK_API_KEY' })
                : t('login-key-missing')
            this.commands.info.pushLocal('/login', [
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
            ])
          })
        return
      case 'logout':
        this.commands.info.notify(t('login-logout-hint'))
        return
      case 'permission':
        this.runPermissionCommand(rawInput)
        return
      case 'add-dir':
        this.commands.info.pushLocal('/add-dir', [
          t('permissions-root-hint', { cwd: this.vm?.cwd ?? '' }),
          t('permissions-path-hint'),
        ])
        return
      case 'hooks':
        this.commands.info.pushLocal('/hooks', [
          t('hooks-not-mounted'),
          t('hooks-mount-hint'),
        ])
        return
      case 'mcp':
        this.commands.info.pushLocal('/mcp', this.commands.info.mcpStatus())
        return
      case 'vim':
        this.commands.info.notify(t('vim-not-implemented'))
        return
      case 'terminal-setup':
        this.commands.info.pushLocal('/terminal-setup', [
          t('terminal-setup-hint'),
          t('terminal-paste-hint', { mod: modLabel }),
        ])
        return
      case 'rename': {
        const title = rawInput.trim()
        if (title.length === 0) {
          this.commands.info.pushLocal('/rename', [
            t('rename-current', { title: this.vm?.statusLine.sessionTitle || '—' }),
            t('rename-usage'),
          ])
          return
        }
        this.commands.session.renameSession(title)
        this.commands.info.notify(t('rename-done', { title }))
        return
      }
      case 'connect':
        this.commands.info.pushLocal('/connect', [t('connect-none')])
        return
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
        const key = SKILL_PROMPTS[command]
        if (key !== undefined) this.commands.input.submit(t(key))
        return
      }
      case 'deepseek':
        // Hidden easter egg: replay the logo header's whale spout + text
        // shimmer. Intentionally absent from the suggestion/help catalogs.
        this.logoNonce += 1
        this.header.setLogoNonce(this.logoNonce)
        return
      default: {
        // Plugin-registered command (DSH command registry): dispatch through
        // the channel, whose execution logs command/run + command/done (the
        // plan-mode projection folds those records, so /plan state stays
        // consistent). Only names the merged command list marks external go
        // to the registry; unknown names fall through to the model.
        const external = this.vm?.prompt.commandList.find(
          entry => entry.external === true && entry.name === command,
        )
        if (external === undefined) {
          this.commands.input.submit(original)
          return
        }
        void this.commands.input.runExternalCommand(command, rawInput).then((result) => {
          if (result === undefined) {
            // The registry lost the name between projection and dispatch:
            // same model fallback as an unknown name — never swallow the line.
            this.commands.input.submit(original)
          } else if (result !== '') {
            this.commands.info.notify(result)
          }
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          this.commands.info.notify(`Command failed: ${message}`, { color: 'error' })
        })
      }
    }
  }

  /**
   * Mount a picker-family panel in the prompt editor's slot (pi-style editor
   * replacement — the transcript and status chrome stay visible, Esc closes
   * the picker and restores the editor). Picker payloads load asynchronously,
   * so the mount happens after the await — when the user already opened
   * another panel in between, the stale picker stays closed instead of
   * clobbering the newer one.
   */
  private mountPicker(picker: Component): void {
    if (
      this.disposed
      || this.transientScreen !== undefined
      || this.settingsPanel !== undefined
      || this.pickerPanel !== undefined
    ) {
      return
    }
    this.pickerPanel = picker
    this.hideTurnPreview()
    this.promptEditor.focused = false
    this.ui.requestRender()
  }

  /** Close the slot-mounted picker and hand the keyboard back to the editor. */
  private closePicker(): void {
    if (this.pickerPanel === undefined) return
    this.disposeComponent(this.pickerPanel)
    this.pickerPanel = undefined
    this.promptEditor.focused = true
    this.ui.requestRender()
  }

  /**
   * Ctrl/Cmd+R: search the persisted input history (newest first) in the
   * editor slot. The payload is a synchronous local file read, so the picker
   * mounts immediately — mountPicker's stale guard still applies (it refuses
   * the mount while a transient screen, the settings panel or another picker
   * holds the slot; the input routing above already keeps those cases from
   * reaching this binding). An empty history mounts the picker's empty state
   * (createHistorySearch's existing behavior). Enter fills the editor with
   * the picked text and closes; Esc just closes.
   */
  private openHistorySearch(): void {
    const entries = loadHistory()
    this.mountPicker(createHistorySearch({
      entries,
      onSelect: (text) => {
        this.promptEditor.setText(text)
        this.closePicker()
      },
      onClose: () => this.closePicker(),
    }))
  }

  /**
   * Scroll-top auto-loadOlder (M2.4, product decision): when the fullscreen
   * conversation is parked at the very top and the session log still holds
   * folded rows, restore them once through the fenced command sink. Polled
   * from update() — there is no scroll-state subscription, and at the 16ms
   * coalesced frame cadence the poll cost is negligible.
   *
   * Guards: the trigger is armed only after the user has left the top
   * (scrollTop > 0) and consumed by each fire, so a viewport parked at the
   * top never auto-drains the log. The restore itself (in-flight guard,
   * viewport anchor) lives in {@link triggerLoadOlder}.
   */
  private pollLoadOlder(): void {
    const scroll = this.conversationScroll
    if (scroll === undefined) return // inline mode: no scroll container
    if (this.transientScreen !== undefined) return
    if (scroll.scrollTop > 0) {
      this.loadOlderArmed = true
      return
    }
    if (!this.loadOlderArmed) return
    this.triggerLoadOlder()
  }

  /**
   * One loadOlder restore through the fenced sink, shared by the scroll-top
   * trigger and the load-earlier divider click. Guards: one in flight at a
   * time, and only while the session log still holds folded rows. Viewport
   * anchor: the restored rows land ABOVE the reading position, so the grown
   * transcript height delta is compensated with one scrollBy (fullscreen
   * only — inline has no scroll container to steer).
   */
  private triggerLoadOlder(): void {
    const sink = this.commands.transcript
    if (sink === undefined || this.loadOlderInFlight) return
    if (this.vm?.transcript.rows.some(row => row.folded) !== true) return
    const scroll = this.conversationScroll
    this.loadOlderArmed = false
    this.loadOlderInFlight = true
    const width = this.transcript.renderWidth
    const heightBefore = this.transcript.renderedHeight
    void sink.loadOlder().then((restored) => {
      this.loadOlderInFlight = false
      if (restored === undefined || restored === 0 || this.disposed) return
      if (scroll === undefined || width <= 0 || this.conversationScroll !== scroll) return
      const delta = this.transcript.render(width).length - heightBefore
      if (delta !== 0) scroll.scrollBy(delta)
    })
  }

  /** @internal The fullscreen conversation ScrollView, exposed for tests and
   *  the upcoming timeline/pill wiring (research §1.2); undefined inline. */
  get conversationScrollView(): ScrollView | undefined {
    return this.conversationScroll
  }

  /** @internal The fullscreen timeline state (research §3.4.4) — the
   *  rail/header/pill data layer; undefined inline (no scroll container, no
   *  snapshot, §3.4.8). Identity-stable while the consumed content is
   *  unchanged. */
  get timelineState(): TimelineState | undefined {
    return this.conversationScroll === undefined ? undefined : this.timeline.state
  }

  /**
   * Timeline tick (research §3.4.4), polled from update() like
   * {@link pollLoadOlder} — there is no scroll-state subscription, and the
   * signature gate inside ChatTimeline keeps an unchanged tick
   * allocation-free. The transcript is re-rendered at its last width first
   * when the projection dropped its cache, so the row geometry reflects
   * THIS tick's rows (a cache hit costs nothing).
   *
   * Frame convergence: the tick's inputs can change as a RESULT of the
   * layout pass itself — the first frame (no transcript render yet) and any
   * (re)wrap frame (gutter mount/unmount, terminal resize) leave the
   * entries laid out before the conversation one frame stale. Both cases
   * schedule exactly one follow-up frame; a stable width schedules nothing,
   * so neither can loop.
   */
  private tickTimeline(): void {
    const scroll = this.conversationScroll
    if (scroll === undefined) return // inline mode: no scroll container
    const width = this.transcript.renderWidth
    if (width <= 0) {
      this.ui.requestRender() // first frame: the transcript renders later in this pass
      return
    }
    if (width !== this.lastTickWidth) {
      this.lastTickWidth = width
      this.ui.requestRender()
    }
    this.transcript.render(width)
    this.timeline.update({
      sessionEpoch: this.vm?.transcript.meta.sessionEpoch ?? 0,
      geometry: this.transcript.rowGeometry,
      headerHeight: this.measureHeaderHeight(width),
      scrollTop: scroll.scrollTop,
      viewportHeight: scroll.viewportHeight,
      contentHeight: scroll.contentHeight,
      atBottom: scroll.isFollowingEnd,
    })
  }

  /**
   * The transcript's offset inside the ScrollView content (research §3.4.3):
   * the fullscreen conversation is VStack(header, transcript) with no gap,
   * so the header's rendered height is exactly the transcript's content-space
   * base. 0 while the header is hidden (minimal mode).
   */
  private measureHeaderHeight(width: number): number {
    if (!this.shouldShowHeader()) return 0
    const vm = this.vm?.header
    const cache = this.headerHeightCache
    if (cache !== undefined && cache.width === width && cache.vm === vm) return cache.height
    const height = this.header.render(width).length
    this.headerHeightCache = { width, vm, height }
    return height
  }

  /**
   * Per-frame input pull for the M4b timeline chrome views (research §3.4.4
   * "per-frame view pull"): fullscreen layout frames bypass
   * ChatScreen.render() entirely — the alt-screen engine draws the layout
   * entries directly — so the freshness point moves onto the predicates and
   * view renders, all of which pull through here. tickTimeline is
   * signature-gated, so the N pulls a frame costs one effective tick.
   */
  private currentTimelineInputs(): TimelineViewInputs | undefined {
    const scroll = this.conversationScroll
    if (scroll === undefined) return undefined // inline: no scroll container
    this.tickTimeline()
    return {
      state: this.timeline.state,
      terminalWidth: this.terminalWidthSeen,
      viewportRows: scroll.viewportHeight,
      scrollTop: scroll.scrollTop,
      maxScrollTop: scroll.maxScrollTop,
    }
  }

  /** Sticky header layout predicate (research §3.4.6): pinned while scrolled
   *  up with an identifiable active turn; gone at the bottom so the
   *  ScrollView never shifts under the reader. */
  private stickyHeaderVisible(): boolean {
    const inputs = this.currentTimelineInputs()
    if (inputs === undefined) return false
    const { state } = inputs
    if (state.atBottom || state.snapshot.activeId === null) return false
    const turn = state.snapshot.turns.find(candidate => candidate.id === state.snapshot.activeId)
    return turn !== undefined && turn.preview.length > 0
  }

  /** Pill layout predicate (research §3.5): shown whenever the conversation
   *  is scrolled away from the end — with or without unseen rows. */
  private pillVisible(): boolean {
    const inputs = this.currentTimelineInputs()
    return inputs !== undefined && !inputs.state.atBottom
  }

  /**
   * Gutter layout predicate (research §3.3): the `hidden` mode never mounts
   * the slot; `timeline`/`scrollbar` each apply their own eligibility. The
   * slot width is RAIL_WIDTH in both mounted modes, so switching modes never
   * rewraps the transcript; an eligibility flip (resize, content fitting the
   * viewport) rewraps once, as in the source.
   */
  private gutterVisible(terminalWidth: number): boolean {
    const mode = this.vm?.scrollGutter ?? 'timeline'
    if (mode === 'hidden') return false
    const inputs = this.currentTimelineInputs()
    if (inputs === undefined) return false
    const { state } = inputs
    const viewportRows = this.conversationScroll?.viewportHeight ?? 0
    if (mode === 'scrollbar') {
      return viewportRows >= 2 && state.scrollable && terminalWidth >= RAIL_MIN_TERMINAL_WIDTH
    }
    return railEligible({
      turnCount: state.snapshot.turns.length,
      terminalWidth,
      viewportRows,
      scrollable: state.scrollable,
    })
  }

  /** The gutter view for the current `dsh-tui.scrollGutter` mode. Only
   *  called while the slot is mounted, so the `hidden` mode never reaches
   *  here; `timeline` is the fallback for a missing/legacy vm. */
  private activeGutterView(): Component {
    return (this.vm?.scrollGutter ?? 'timeline') === 'scrollbar' ? this.scrollbarGutter : this.railView
  }

  /**
   * Gutter preference → ScrollView scrollbar policy: the rail/scrollbar
   * gutter REPLACES pi's built-in scrollbar while mounted; only the
   * `hidden` mode keeps the transient auto-scrollbar. `auto` never changes
   * the content width (only `always` reserves a column), so this stays
   * width-stable across mode switches. setScrollbar is same-value guarded,
   * making the per-update call free.
   */
  private syncScrollGutter(): void {
    const scroll = this.conversationScroll
    if (scroll === undefined) return
    scroll.setScrollbar((this.vm?.scrollGutter ?? 'timeline') === 'hidden' ? 'auto' : 'hidden')
  }

  /** The §1.3 ownership gate shared by the timeline chrome views — the same
   *  condition the transcript's isPointerBlocked seam mirrors. */
  private chromePointerBlocked(): boolean {
    return (
      this.transientScreen !== undefined ||
      this.settingsPanel !== undefined ||
      this.pickerPanel !== undefined ||
      this.activeOverlayKind() !== undefined
    )
  }

  /**
   * Turn navigation shared by the rail ticks/chevrons and the sticky prompt
   * header (research §3.4.7): measured turns jump by content coordinate;
   * folded turns go through the reveal path (never scrollTo(−1)).
   */
  private jumpToTurn(turn: TimelineTurn): void {
    const scroll = this.conversationScroll
    if (scroll === undefined || this.disposed || this.transientScreen !== undefined) return
    const target = jumpTargetForTurn(turn)
    if (target.kind === 'scroll') {
      if (target.top < 0) return
      scroll.scrollTo(target.top)
      this.ui.requestRender()
      return
    }
    void this.revealAndSeekTurn(target.id)
  }

  /**
   * Reveal-then-seek for folded turns (research §3.4.7): restore the folded
   * history through the fenced sink when the CHANNEL folded the row away,
   * lift the render-window cap when the row is merely window-excluded, then
   * re-measure synchronously and pin the prompt text to the viewport top —
   * no Ink-style setTimeout race. Any step that cannot resolve the turn
   * abandons the jump (the tick stays clickable for a later attempt).
   */
  private async revealAndSeekTurn(id: number): Promise<void> {
    const scroll = this.conversationScroll
    if (scroll === undefined || this.disposed) return
    const row = this.vm?.transcript.rows.find(candidate => candidate.id === id)
    if (row?.folded === true) {
      const sink = this.commands.transcript
      // One restore at a time globally (shared with the M2.4 scroll-top
      // trigger); a concurrent trigger — or a host without the sink — just
      // abandons this jump.
      if (sink === undefined || this.loadOlderInFlight) return
      this.loadOlderInFlight = true
      try {
        await sink.loadOlder()
      } catch {
        // A fenced-sink failure just never reveals — fall through to the
        // seek, which resolves whatever geometry exists now.
      } finally {
        this.loadOlderInFlight = false
      }
      if (this.disposed || this.conversationScroll !== scroll) return
    }
    const width = this.transcript.renderWidth
    if (width <= 0) return
    // Re-measure THIS tick's rows before reading geometry (cache-hit cheap;
    // required after a restore, which invalidated the render cache).
    this.transcript.render(width)
    let geometry = this.transcript.rowGeometry.find(
      candidate => candidate.rowId === id && candidate.kind === 'user',
    )
    if ((geometry === undefined || geometry.folded) && !this.transcript.isShowingAll) {
      this.transcript.showAll()
      this.transcript.render(width) // synchronous re-measure at the live width
      geometry = this.transcript.rowGeometry.find(
        candidate => candidate.rowId === id && candidate.kind === 'user',
      )
    }
    if (geometry === undefined || geometry.folded || geometry.startRow < 0) return
    // The restore grew the content ABOVE the reading position; the fresh
    // geometry already reflects the shift, so an absolute scrollTo lands
    // exactly (no delta compensation like the M2.4 trigger needs).
    scroll.scrollTo(this.measureHeaderHeight(width) + geometry.startRow)
    this.ui.requestRender()
  }

  /**
   * Rail hover preview card (research §3.4.3): a non-capturing pi overlay
   * popped by the rail's dwell timer, positioned beside the hovered tick
   * and vertically clamped into the conversation region. The rail reports
   * intent; the screen owns the overlay lifecycle.
   */
  private showTurnPreview(card: TimelineHoverCard | null): void {
    if (card === null) {
      this.hideTurnPreview()
      return
    }
    if (this.disposed || this.transientScreen !== undefined) return
    // Minimal fake TUIs in tests have no overlay stack — skip silently.
    if (typeof this.ui.showOverlay !== 'function') return
    if (this.previewOverlay !== undefined && this.previewOverlayTurn === card.turn.id) return
    this.hideTurnPreview()
    const inputs = this.currentTimelineInputs()
    if (inputs === undefined) return
    const { terminalWidth, viewportRows } = inputs
    if (terminalWidth <= 0 || viewportRows <= 0) return
    // Width budget (source): half the transcript width, clamped to [16, 32]
    // content columns; +4 for the border and 1-cell padding per side.
    const budget = Math.min(32, Math.max(16, Math.floor((terminalWidth - RAIL_WIDTH) / 2)))
    const lines = wrapPreviewLines(card.turn.preview, budget)
    const cardW = Math.max(...lines.map(line => visibleWidth(line))) + 4
    if (cardW + RAIL_WIDTH + 1 >= terminalWidth) return // no room beside the rail
    const cardH = Math.min(viewportRows, lines.length + 2)
    const top = Math.max(0, Math.min(card.row - Math.floor(cardH / 2), viewportRows - cardH))
    // The card's absolute row: the conversation row sits under the sticky
    // header when that is pinned.
    const row = (this.stickyHeaderVisible() ? 1 : 0) + top
    const col = terminalWidth - RAIL_WIDTH - 1 - cardW
    this.previewOverlay = this.ui.showOverlay(createTurnPreviewCard(lines, cardW), {
      row,
      col,
      width: cardW,
      nonCapturing: true,
    })
    this.previewOverlayTurn = card.turn.id
  }

  private hideTurnPreview(): void {
    const overlay = this.previewOverlay
    this.previewOverlay = undefined
    this.previewOverlayTurn = null
    overlay?.hide()
  }

  /**
   * `/model <provider/model>` switches directly (same live-fork path as the
   * picker's Enter, source main 41300b04 semantics): the spec is validated
   * against the catalog before the fork; bare `/model` opens the picker.
   * Both hops go through the fenced sink — a stale listModels or a failed
   * switchModel just never narrates.
   */
  private runModelCommand(rawInput: string): void {
    const parts = rawInput.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) {
      this.openModelPicker()
      return
    }
    const spec = parts[0]!
    const slash = spec.indexOf('/')
    const provider = slash >= 0 ? spec.slice(0, slash) : undefined
    const id = slash >= 0 ? spec.slice(slash + 1) : spec
    if (provider === undefined || id.length === 0 || provider.length === 0) {
      this.commands.info.notify(t('model-usage'), { color: 'warning' })
      return
    }
    void this.commands.model.listModels().then((list) => {
      if (list === undefined || this.disposed) return
      const model = list.find(m => m.provider === provider && m.id === id)
      if (model === undefined) {
        this.commands.info.notify(t('model-unknown', { spec }), { color: 'error', timeoutMs: 8000 })
        return
      }
      this.commands.info.notify(t('model-switching', { name: model.name }))
      void this.commands.model.switchModel(provider, id).then((ok) => {
        if (ok) this.commands.info.notify(t('model-switched', { name: model.name }))
      })
    })
  }

  /** `/model` — the forked listModels/listEfforts payloads arrive async, then
   *  the picker mounts in the editor slot; Enter switches the live route (the
   *  conversation forks onto a new agent; the sink fences a stale completion)
   *  and, when the Thinking draft differs from the live effort, applies it
   *  after the switch succeeds. */
  private openModelPicker(): void {
    void Promise.all([this.commands.model.listModels(), this.commands.model.listEfforts()]).then(
      ([models, effortsResult]) => {
        if (models === undefined || this.disposed) return
        const efforts = effortsResult?.efforts
        const currentEffort = this.vm?.statusLine.reasoningEffort ?? effortsResult?.defaultEffort
        this.mountPicker(createModelPicker({
          models: models.map(model => ({
            provider: model.provider,
            id: model.id,
            name: model.name,
            description: model.description,
          })),
          current: { provider: this.vm?.provider ?? '', model: this.vm?.statusLine.model ?? '' },
          ...(efforts !== undefined && efforts.length > 1
            ? {
                efforts: efforts.map(effort => ({
                  id: effort.id,
                  name: effort.name,
                  description: effort.description,
                })),
                currentEffort,
              }
            : {}),
          onSelect: (provider, id, effort) => {
            this.closePicker()
            const label = models.find(model => model.provider === provider && model.id === id)?.name ?? id
            this.commands.info.notify(t('model-switching', { name: label }))
            void this.commands.model.switchModel(provider, id).then((ok) => {
              if (!ok) return
              this.commands.info.notify(t('model-switched', { name: label }))
              if (effort !== undefined && effort !== currentEffort) void this.commands.model.setEffort(effort)
            })
          },
          onClose: () => this.closePicker(),
        }))
      },
    )
  }

  /**
   * `/effort` — bare opens the segmented picker over the live route's
   * adapter levels (←/→ moves the focus, Enter commits); `/effort <id>`
   * sets directly (validated by the channel); `/effort status` prints the
   * current level. The choice persists to ~/.dsh-tui/effort.json.
   */
  private runEffortCommand(rawInput: string): void {
    const parts = rawInput.trim().split(/\s+/).filter(Boolean)
    if (parts[0] === 'status') {
      this.commands.info.pushLocal('/effort', [
        t('effort-current', { name: this.vm?.statusLine.reasoningEffort ?? '—' }),
        t('effort-usage'),
      ])
      return
    }
    if (parts.length > 0) {
      void this.commands.model.setEffort(parts[0]!)
      return
    }
    void this.commands.model.listEfforts().then((result) => {
      if (result === undefined || this.disposed) return
      const { efforts, defaultEffort } = result
      // 0/1-tier routes were already notified by listEfforts.
      if (efforts.length <= 1) return
      this.mountPicker(createEffortSlider({
        levels: efforts.map(effort => ({
          id: effort.id,
          name: effort.name,
          description: effort.description,
        })),
        current: this.vm?.statusLine.reasoningEffort ?? defaultEffort,
        onSelect: (id) => {
          this.closePicker()
          void this.commands.model.setEffort(id)
        },
        onClose: () => this.closePicker(),
      }))
    })
  }

  /**
   * `/permission` — bare opens the session permission-mode picker (a choice
   * list over the configured Shift+Tab modes, current one marked ✓);
   * `/permission <id>` applies the mode directly. The channel narrates the
   * switch (mode-switched notify) like the Shift+Tab cycle does.
   */
  private runPermissionCommand(rawInput: string): void {
    const id = rawInput.trim().split(/\s+/).filter(Boolean)[0]
    if (id !== undefined) {
      void this.commands.session.setMode(id).then((ok) => {
        if (this.disposed || ok) return
        this.commands.info.notify(t('permission-unknown-mode', { id }), { color: 'warning' })
      })
      return
    }
    this.mountPicker(createPermissionPicker({
      modes: this.commands.session.listModes().map(spec => ({
        id: spec.id,
        label: modeDisplayName(spec),
        description: modeDescription(spec),
      })),
      activeId: this.vm?.statusLine.mode.id,
      onSelect: (modeId) => {
        this.closePicker()
        void this.commands.session.setMode(modeId)
      },
      onClose: () => this.closePicker(),
    }))
  }

  /**
   * `/preset` (issue #8) — bare opens the roster picker; `/preset <id>`
   * switches directly; `/preset status` shows the current choice. A blank
   * session swaps composition in place (official blank-only rule); a started
   * session is locked and the choice persists as the default for future
   * sessions (~/.dsh-tui/agent-preset.json).
   */
  private runPresetCommand(rawInput: string): void {
    const parts = rawInput.trim().split(/\s+/).filter(Boolean)
    if (parts[0] === 'status') {
      this.commands.info.pushLocal('/preset', [
        t('preset-current', { name: this.commands.model.currentPreset() ?? t('preset-roster-missing') }),
        t('preset-switch-hint'),
        t('preset-persist-hint'),
        t('preset-lock-hint'),
      ])
      return
    }
    if (parts.length > 0) {
      void this.commands.model.switchPreset(parts[0]!)
      return
    }
    void this.commands.model.listPresets().then((list) => {
      if (list === undefined || this.disposed) return
      if (list.length === 0) {
        this.commands.info.notify(t('preset-roster-unmounted'), { color: 'warning' })
        return
      }
      this.mountPicker(createPresetPicker({
        presets: list.map(preset => ({
          id: preset.id,
          name: preset.name,
          description: preset.description,
          isDefault: preset.isDefault,
          broken: preset.broken,
        })),
        activeId: this.commands.model.currentPreset(),
        onSelect: (id) => {
          this.closePicker()
          void this.commands.model.switchPreset(id)
        },
        onClose: () => this.closePicker(),
      }))
    })
  }

  /**
   * `/theme` — bare opens the interactive color picker (`auto` + built-in
   * palettes + user themes from ~/.dsh-tui/themes); `/theme <name>` switches
   * directly; `/theme status` shows the current choice. `auto` follows the
   * terminal background detected at boot (OSC 11). Selection persists to
   * ~/.dsh-tui/theme.json (DSH_TUI_THEME still wins on next launch).
   */
  private runThemeCommand(rawInput: string): void {
    const parts = rawInput.trim().split(/\s+/).filter(Boolean)
    if (parts[0] === 'status') {
      const name = this.commands.display.currentTheme()
      this.commands.info.pushLocal('/theme', [
        t('theme-current', { name }),
        // `auto` resolves through terminal-background detection; show which
        // palette it currently maps to.
        ...(name === AUTO_THEME_NAME ? [t('theme-auto-resolved', { name: getAutoThemeBase() })] : []),
        t('theme-switch-hint'),
        t('theme-persist-hint'),
        t('theme-custom-hint'),
      ])
      return
    }
    if (parts.length > 0) {
      this.applyTheme(parts[0]!, 'theme-unknown')
      return
    }
    this.mountPicker(createThemePicker({
      themes: this.commands.display.listThemes(),
      activeId: this.commands.display.currentTheme(),
      onSelect: (name) => {
        this.closePicker()
        this.applyTheme(name, 'theme-switch-failed')
      },
      onClose: () => this.closePicker(),
    }))
  }

  /** Validate + persist + hot-swap a theme through the display sink. */
  private applyTheme(name: string, failureKey: 'theme-unknown' | 'theme-switch-failed'): void {
    const ok = this.commands.display.setTheme(name)
    this.commands.info.notify(
      ok ? t('theme-switched-saved', { name }) : t(failureKey, { name }),
      { color: ok ? 'success' : 'error' },
    )
  }

  /**
   * `/lang` shows the current UI language, `/lang en|zh` switches (hot-swap,
   * persisted to ~/.dsh-tui/lang.json and mirrored into the settings
   * namespace by the sink). Precedence on next launch: DSH_TUI_LANG >
   * settings.yaml `dsh-tui.lang` > cordis.yml `lang` > the persisted choice.
   */
  private runLangCommand(rawInput: string): void {
    const parts = rawInput.trim().split(/\s+/).filter(Boolean)
    if (parts.length > 0 && parts[0] !== 'status') {
      const value = parts[0]!
      if (!isLang(value)) {
        this.commands.info.notify(t('lang-unknown', { lang: value }), { color: 'error' })
        return
      }
      const ok = this.commands.display.setLang(value)
      // The notify follows the switch, so it renders in the NEW language.
      this.commands.info.notify(
        ok ? t('lang-switched', { lang: value }) : t('lang-switch-failed', { lang: value }),
        { color: ok ? 'success' : 'error' },
      )
      return
    }
    this.commands.info.pushLocal('/lang', [
      t('lang-current', { lang: getLang() }),
      t('lang-switch-hint'),
      t('lang-persist-hint'),
    ])
  }

  /**
   * `/activity` (ported from the pi working-activity extension) — bare opens
   * the interactive indicator picker; `/activity frames <name>` switches
   * directly; `/activity frames` lists presets; `/activity status` shows the
   * current choice. The choice persists to ~/.dsh-tui/working-activity.json
   * and survives restarts.
   */
  private runActivityCommand(rawInput: string): void {
    const parts = rawInput.trim().split(/\s+/).filter(Boolean)
    const current = this.vm?.statusLine.activityFrames
    const preview = (name: string): string =>
      name === 'random' ? t('activity-random-each') : FRAME_PRESETS[name].frames.slice(0, 5).join(' ')
    if (parts[0] === 'status') {
      this.commands.info.pushLocal('/activity', [
        t('activity-current-preset', { name: current ?? 'claude' }),
        t('activity-switch-hint'),
        t('activity-persist-hint'),
      ])
      return
    }
    if (parts[0] === 'frames') {
      if (parts[1] !== undefined) {
        this.commands.model.setActivityFrames(parts[1].toLowerCase())
        return
      }
      this.commands.info.pushLocal('/activity', [
        t('activity-current-direct', { name: current ?? 'claude' }),
        ...PRESET_NAMES.map(name =>
          `${name.padEnd(10)} ${preview(name)}${name === current ? t('activity-current-marker') : ''}`),
      ])
      return
    }
    if (parts.length > 0) {
      this.commands.info.notify(t('activity-usage'), { color: 'warning' })
      return
    }
    this.mountPicker(createActivityPicker({
      presets: PRESET_NAMES.map(name => ({ name, description: preview(name) })),
      activeName: current ?? 'random',
      onSelect: (name) => {
        this.closePicker()
        this.commands.model.setActivityFrames(name)
      },
      onClose: () => this.closePicker(),
    }))
  }

  /** `/thinking` display dialog: Shown/Hidden; Enter applies and closes. */
  private openThinkingToggle(): void {
    this.mountPicker(createThinkingToggle({
      visible: this.transcript.thinkingShown,
      onToggle: (visible) => {
        this.transcript.setThinkingVisible(visible)
        this.commands.info.notify(t('thinking-toggled', { state: visible ? t('thinking-on') : t('thinking-off') }))
      },
      onClose: () => this.closePicker(),
    }))
  }

  /**
   * `/skills` (issue #204): the live agent's full skill catalog (name +
   * source + summary); Enter fills a user-invocable skill back into the
   * input as `/name ` — the same completion-only dispatch path as picking it
   * from the `/` menu (model-only skills just close the picker).
   */
  private openSkillsPicker(): void {
    void this.commands.query.listSkills().then((list) => {
      if (list === undefined) {
        if (!this.disposed) this.commands.info.notify(t('skills-load-failed'), { color: 'error' })
        return
      }
      this.mountPicker(createSkillsPicker({
        skills: list.map(skill => ({
          name: skill.name,
          description: skill.description,
          source: skill.source,
          userInvocable: skill.userInvocable,
        })),
        onSelect: (name) => {
          this.closePicker()
          this.promptEditor.setText(`/${name} `)
        },
        onClose: () => this.closePicker(),
      }))
    })
  }

  /**
   * `/workspace` — bare prints usage (including provider extension commands);
   * `resume` opens the target picker; `rename <title>` renames the durable
   * workspace; `open <uri|path>` resolves and switches; provider-registered
   * extension subcommands run through the workspace runtime, their `choices`
   * results driving a follow-up picker until a target (or an empty choice
   * list) settles the flow.
   */
  private runWorkspaceCommand(rawInput: string): void {
    const trimmed = rawInput.trim()
    const separator = trimmed.search(/\s/u)
    const subcommand = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase()
    const input = separator < 0 ? '' : trimmed.slice(separator).trim()
    if (subcommand === '') {
      const extensions = this.commands.workspace.workspaceCommands()
        .map(command => ` | ${command.name}`)
        .join('')
      this.commands.info.pushLocal('/workspace', [t('workspace-command-usage', { commands: extensions })])
      return
    }
    if (subcommand === 'resume') {
      this.openWorkspaceResume()
      return
    }
    if (subcommand === 'rename') {
      if (input.length === 0) this.commands.info.notify(t('workspace-rename-usage'))
      else void this.commands.workspace.renameWorkspace(input)
      return
    }
    if (subcommand === 'open') {
      if (input.length === 0) {
        this.commands.info.notify(t('workspace-open-usage'))
        return
      }
      void this.commands.workspace.resolveWorkspace(input).then((target) => {
        if (this.disposed) return
        if (target === undefined) {
          this.commands.info.notify(t('workspace-uri-invalid', { uri: input }), { color: 'error', timeoutMs: 8000 })
          return
        }
        void this.commands.workspace.switchWorkspace(target)
      }).catch((error: unknown) => {
        this.commands.info.notify(
          t('workspace-uri-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
      })
      return
    }
    if (this.commands.workspace.workspaceCommands().some(command =>
      command.name.toLowerCase() === subcommand
      || command.aliases?.some(alias => alias.toLowerCase() === subcommand) === true)) {
      void this.commands.workspace.runWorkspaceCommand(subcommand, input).then((result) => {
        if (result !== undefined && !this.disposed) this.handleWorkspaceResult(result)
      }).catch((error: unknown) => {
        this.commands.info.notify(
          t('workspace-command-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
      })
      return
    }
    this.commands.info.notify(t('workspace-command-unknown', { command: subcommand }), { color: 'error' })
  }

  /** `/workspace resume`: list the targets, then mount the picker. */
  private openWorkspaceResume(): void {
    void this.commands.workspace.listWorkspaces().then((targets) => {
      if (targets === undefined || this.disposed) return
      if (targets.length === 0) {
        this.commands.info.notify(t('workspace-none'))
        return
      }
      this.mountPicker(createWorkspacePicker({
        workspaces: targets,
        cwd: this.vm?.cwd ?? '',
        onSelect: (picked) => {
          this.closePicker()
          const target = targets.find(candidate => candidate.uri === picked.uri)
          if (target !== undefined) void this.commands.workspace.switchWorkspace(target)
        },
        onClose: () => this.closePicker(),
      }))
    }).catch((error: unknown) => {
      if (this.disposed) return
      this.commands.info.notify(
        t('workspace-list-failed', { err: error instanceof Error ? error.message : String(error) }),
        { color: 'error' },
      )
    })
  }

  /**
   * One step of a provider workspace flow: a `target` settles the flow with
   * a session switch; `choices` replace the open step's picker with the next
   * one (while the flow owns the editor slot no other panel can open, so an
   * open picker here is always the previous step of this flow). Choice-level
   * inline inputs (Tab) from the old WorkspaceFlowPicker have no pi-tui
   * equivalent yet — Enter runs the choice's `choose` directly.
   */
  private handleWorkspaceResult(result: TuiWorkspaceCommandResult): void {
    if (this.pickerPanel !== undefined) this.closePicker()
    if (result.kind === 'target') {
      void this.commands.workspace.switchWorkspace(result.target)
      return
    }
    if (result.choices.length === 0) {
      this.commands.info.notify(t('workspace-command-empty'))
      return
    }
    this.mountPicker(new PickerView<TuiWorkspaceChoice>({
      title: result.title,
      items: result.choices,
      toItem: (choice) => ({
        label: choice.badge !== undefined ? `${choice.badge} · ${choice.label}` : choice.label,
        ...(choice.description === undefined ? {} : { description: choice.description }),
      }),
      footerHint: t('hint-confirm-exit'),
      onSelect: (choice) => {
        void Promise.resolve(choice.choose()).then((next) => {
          if (!this.disposed) this.handleWorkspaceResult(next)
        }).catch((error: unknown) => {
          if (this.disposed) return
          this.commands.info.notify(
            t('workspace-command-failed', { err: error instanceof Error ? error.message : String(error) }),
            { color: 'error', timeoutMs: 8000 },
          )
        })
      },
      onClose: () => this.closePicker(),
    }))
  }

  /**
   * `/provider` add-provider wizard: drives the shared question panel through
   * the overlay sink, persists profile + key via the channel's settings/
   * credentials seams. No picker of its own — the question overlay renders it.
   */
  private openProviderWizard(): void {
    const host = this.commands.info.providerSetup()
    if (host === undefined) {
      this.commands.info.notify(t('provider-unavailable'), { color: 'warning', timeoutMs: 8000 })
      return
    }
    void runProviderWizard({
      host,
      ask: (request, options) => this.commands.overlays.askQuestion(request, options),
      notify: (text, options) => {
        this.commands.info.notify(text, options)
      },
      pushLocal: (title, lines) => this.commands.info.pushLocal(title, lines),
      working: () => this.vm?.prompt.working === true,
      switchModel: (provider, model) => this.commands.model.switchModel(provider, model),
    }).catch(() => {
      // The wizard notifies on every handled failure; this only swallows an
      // unexpected reject so it never surfaces as an unhandled promise.
    })
  }

  /**
   * `/btw` (CC): a single-turn tool-free side question; the panel streams the
   * answer without interrupting the main turn or writing session history.
   * Enter on a non-empty input asks a follow-up into the same panel; Enter on
   * an empty input and Esc close. Empty arguments only show the usage hint.
   */
  private openBtwPanel(rawInput: string): void {
    const question = rawInput.trim()
    if (question === '') {
      this.commands.info.notify(t('btw-usage'), { timeoutMs: 3000 })
      return
    }
    this.btwAbort?.abort()
    const controller = new AbortController()
    this.btwAbort = controller
    const panel = createBtwPanel({
      question,
      onText: (text) => this.runSideQuestion(panel, text, controller),
      onClose: () => {
        controller.abort()
        this.closeTransientScreen()
      },
    })
    this.replaceTransient(panel, 'picker')
    this.runSideQuestion(panel, question, controller)
  }

  /** Stream one side question into the open /btw panel (stale-safe: a panel
   *  that was replaced or a fenced-away session drop never gets written). */
  private runSideQuestion(panel: BtwPanel, question: string, controller: AbortController): void {
    if (this.transientScreen !== panel) return
    panel.setQuestion(question)
    panel.setAnswer('')
    panel.setError(undefined)
    panel.setStreaming(true)
    this.ui.requestRender()
    void this.commands.info.sideQuestion(question, {
      signal: controller.signal,
      onText: (delta) => {
        if (this.transientScreen !== panel) return
        panel.appendAnswer(delta)
        this.ui.requestRender()
      },
    }).then((result) => {
      if (result === undefined || controller.signal.aborted || this.transientScreen !== panel) return
      if (result.answer !== null) panel.setAnswer(result.answer)
      panel.setError(result.error)
      panel.setStreaming(false)
      this.ui.requestRender()
    })
  }

  /**
   * `/help`: the shortcut reference plus the merged slash-command surface
   * (built-in + plugin-registered; skill entries stay hidden — a skills
   * directory can hold dozens of entries and the menu is for chrome
   * commands), printed as a transcript-local report.
   */
  private pushHelp(): void {
    const listed = this.vm?.prompt.commandList
    const chrome = (listed !== undefined && listed.length > 0 ? listed : LOCAL_COMMANDS)
      .filter(entry => entry.skill !== true)
    this.commands.info.pushLocal('/help', [
      t('help-for-commands'),
      t('help-this-help'),
      t('help-verbose-output', { mod: modLabel }),
      t('help-open-trajectory', { mod: modLabel }),
      t('help-search-history', { mod: modLabel }),
      t('help-interrupt'),
      t('help-exit'),
      t('help-redraw', { mod: modLabel }),
      t('help-clear-input'),
      t('help-history-nav'),
      t('help-move-cursor'),
      t('help-word-jumps', { mod: modLabel }),
      t('help-complete-command'),
      t('help-cycle-mode'),
      t('help-open-editor'),
      '',
      t('help-commands-title'),
      ...chrome.map(entry => `/${entry.name} — ${localizedDescription(entry)}`),
    ])
  }

  /** `/status`: model/effort, turn state, session id, cwd/branch, tokens,
   *  cache rate, context pressure and title as a transcript-local report. */
  private pushStatus(): void {
    const vm = this.vm
    if (vm === undefined) return
    const status = vm.statusLine
    const usage = status.lastUsage
    const pct =
      status.contextWindow === undefined
        ? undefined
        : Math.max(0, Math.min(100, Math.round((status.tokens.input / status.contextWindow) * 100)))
    const lines: string[] = [
      `${t('status-model', { model: status.model })}${status.reasoningEffort ? ` · ${capitalize(status.reasoningEffort)} effort` : ''}`,
      `${t('status-state', { state: status.working ? t('status-working') : t('status-idle') })}`,
      `${t('status-session', { id: vm.agentId })}`,
      `${t('status-dir', { cwd: status.displayCwd })}${status.gitBranch ? ` · ${status.gitBranch}` : ''}`,
      `Tokens ${formatTokens(status.tokens.input)} in → ${formatTokens(status.tokens.output)} out`,
    ]
    if (usage !== undefined) {
      const total = usage.input + usage.cacheRead + usage.cacheWrite
      const rate = total > 0 ? ((usage.cacheRead / total) * 100).toFixed(1) : '0.0'
      lines.push(t('cost-cache-rate', { rate, read: formatTokens(usage.cacheRead), write: formatTokens(usage.cacheWrite) }))
    }
    if (pct !== undefined) lines.push(t('cost-context', { pct }))
    if (status.sessionTitle) lines.push(t('status-title', { title: status.sessionTitle }))
    this.commands.info.pushLocal('/status', lines)
  }

  private pullBackPending(): void {
    const pending = this.vm?.prompt.pending ?? []
    const last = pending[pending.length - 1]
    if (last !== undefined && this.commands.input.removePending(last.id)) {
      this.promptEditor.setText(last.text)
    }
  }

  private activeOverlayKind(): 'approval' | 'dialog' | 'question' | undefined {
    const overlays = this.vm?.overlays
    if (overlays?.approval !== null && overlays?.approval !== undefined) return 'approval'
    if (overlays?.dialog !== null && overlays?.dialog !== undefined) return 'dialog'
    if (overlays?.question !== null && overlays?.question !== undefined) return 'question'
    return undefined
  }

  private activeOverlay(): Component & { handleInput(data: string): void } | undefined {
    switch (this.activeOverlayKind()) {
      case 'approval':
        return this.approval
      case 'dialog':
        return this.dialog
      case 'question':
        return this.question
      default:
        return undefined
    }
  }

  private shouldShowHeader(): boolean {
    // The banner stays mounted as the transcript's top block and scrolls away
    // with the conversation (inline: native scrollback; fullscreen: the
    // alt-screen ScrollView) — the React LogoHeader behaved the same. Minimal
    // mode drops the splash entirely (the old isMinimalMode() guard).
    return this.vm === undefined || this.vm.statusLine.minimal !== true
  }

  private hasStatusEntries(): boolean {
    return (this.vm?.overlays.statusEntries.length ?? 0) > 0
  }

  private hasNotifications(): boolean {
    return (this.vm?.prompt.notifications.length ?? 0) > 0
  }

  private updateTransient(): void {
    switch (this.transientKind) {
      case 'trajectory':
        if (this.transientScreen instanceof TrajectoryScene) {
          this.transientScreen.update(this.controller.getTrajectory())
        }
        break
      case 'subagent-dashboard':
        if (this.transientScreen instanceof SubagentDashboardScreen) {
          this.transientScreen.update(this.subagents)
        }
        break
      case 'subagent-detail': {
        const subagent = this.subagents.items.find((item) => item.agentId === this.subagentDetailId)
        if (subagent === undefined) {
          this.openSubagentDashboard(this.subagents)
        } else if (this.transientScreen instanceof SubagentDetailScreen) {
          this.transientScreen.update(subagent)
        }
        break
      }
      default:
        break
    }
  }

  private openSubagentDetail(agentId: string): void {
    const subagent = this.subagents.items.find((item) => item.agentId === agentId)
    if (subagent === undefined) return
    this.subagentDetailId = agentId
    const detail = new SubagentDetailScreen(this.commands, {
      onBack: () => this.openSubagentDashboard(this.subagents),
    }, subagent)
    this.replaceTransient(detail, 'subagent-detail')
  }

  private replaceTransient(screen: Component, kind: TransientKind): void {
    this.disposeComponent(this.transientScreen)
    this.transientScreen = screen
    this.transientKind = kind
    this.hideTurnPreview()
    this.updateTransientViewport()
    this.promptEditor.focused = false
    this.ui.requestRender()
  }

  private updateTransientViewport(): void {
    const screen = this.transientScreen
    if (screen === undefined) return
    const setViewportHeight = (screen as Component & { setViewportHeight?: (rows: number) => void }).setViewportHeight
    if (setViewportHeight !== undefined) setViewportHeight.call(screen, this.terminalRows())
  }

  private terminalRows(): number {
    const rows = this.ui.terminal?.rows
    return typeof rows === 'number' && Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24
  }

  private disposeComponent(component: Component | undefined): void {
    const dispose = (component as (Component & { dispose?: () => void }) | undefined)?.dispose
    dispose?.call(component)
  }

}

function fitLines(lines: readonly string[], width: number): string[] {
  return lines.map((line) => truncateToWidth(line, width, ''))
}
