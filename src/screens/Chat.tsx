import React from 'react'
import { t, getLang, setLang, isLang, writeLangPref, readLangPref, subscribeLang, LANGS, type Lang } from '../i18n.js'
import { checkForTuiUpdate, installedTuiVersion } from '../update.js'
import { installedKernelVersion } from '../dsh-adapter/contract.js'
import { readThemePref } from '../themePrefs.js'
import { readPresetPref } from '../presetPrefs.js'
import { readModelPref } from '../modelPrefs.js'
import { readActivityFrames } from '../activityPrefs.js'
import { envThemeOverride } from '../components/design-system/ThemeProvider.js'
import { resolveBrand, setActiveBrand } from '../branding.js'
import { hasPath } from '../dsh-adapter/settingsEditor.js'
import { planReload, type ReloadKind } from '../reload.js'
import { AlternateScreen, Box, Image, Text, useInput, ScrollBox, type ScrollBoxHandle, useTheme, useTerminalSize } from '../ui.js'
import * as tuiKit from '../ui.js'
import { usePageInset } from '../components/PageMargin.js'
import { POINTER } from '../terminal-utils/figures.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { actionMatches, effectiveComboDisplay, primaryComboString } from '../utils/keymap.js'
import { formatTokens } from '../terminal-utils/format.js'
import { formatClock } from '../trajectory/format.js'
import { homeDir } from '../utils/paths.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import type { LlmModelInfo, LlmProviderInfo } from '../adapter/ports/channel-view.js'
import { cleanRenderText, cleanScalarText } from '../dsh-adapter/sanitize.js'
import {
  deriveModelGroups,
  modelPickerLanding,
  recentCatalogModels,
  RECENTS_GROUP_PROVIDER,
} from '../modelGroups.js'
import { readModelRecents, recordModelUse, type ModelRecentsRef } from '../modelRecents.js'
import type { ChannelUi as Channel } from '../adapter/channel/ui-policy.js'
import { sessionCwdMatches, type ChatRow, type ComposerImageRef, type EffortOption, type ExternalCommandOutcome, type PermissionPresetSnapshot, type PresetOption, type SkillInfo } from '../dsh-adapter/channel.js'
import type { QuestionStore } from '../channel/questions.js'
import { TuiDialogStore } from '../dsh-adapter/dialogs.js'
import { TuiStatusStore, type TuiStatusViewUi } from '../dsh-adapter/status.js'
import { ActivityStore, useActivity } from '../dsh-adapter/activity-store.js'
import type { TranscriptImage } from '../dsh-adapter/transcript-images.js'
import { rasterToPng, setMathPreviewOpener, type MathPreviewRequest } from '../components/mathPreview.js'
import { renderMathRaster, type MathRenderRequest } from '../math/renderer.js'

/** Formula preview rasters are re-typeset at this cell scale (2× the
 *  transcript's) so the card's 100–800% zoom stays sharp instead of upscaling
 *  the inline pixels. Bounded like the other image budgets. */
const MATH_PREVIEW_SCALE = 2
const MATH_PREVIEW_MAX_COLUMNS = 480
const MATH_PREVIEW_MAX_ROWS = 64
import type { TuiShortcutHost } from '../dsh-adapter/shortcuts.js'
import type { TuiThemeHost } from '../dsh-adapter/themes.js'
import type { TuiRewindMode } from '../dsh-adapter/extension-events.js'
import { runOAuthLogin, runProviderWizard } from '../dsh-adapter/providerWizard.js'
import { useKernelPicker } from './chat/useKernelPicker.js'
import { useBackendChannels } from './chat/useBackendChannels.js'
import { backendModeStatus as modeStatus, backendPermissionCommand, parseMcpCommand } from './chat/backendCommands.js'
import { PermissionStore, type PermissionPanelSource } from '../channel/permissions.js'
import { AskUserQuestionPanel } from '../components/questions/AskUserQuestionPanel.js'
import { ApprovalPanel } from '../components/approvals/ApprovalPanel.js'
import { ExtensionDialog } from '../components/ExtensionDialog.js'
import { consumeBoundaryRecoveryRemount } from '../ink/update-overflow-guard.js'
import type { DOMElement } from '../ink/dom.js'
import { useSearchHighlight } from '../ink/hooks/use-search-highlight.js'
import { useTerminalTitle } from '../ink/hooks/use-terminal-title.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { useCopyOnSelect } from '../ink/hooks/use-copy-on-select.js'
import { useSelection } from '../ink/hooks/use-selection.js'
import { NoSelect } from '../ink/components/NoSelect.js'
import { LogoHeader, MessageList } from '../components/MessageList.js'
import { splashFontIdOf } from '../components/splashFonts.js'
import { StarPrompt, WhaleCouponPrompt, type StarAttempt } from '../components/StarPrompt.js'
import type { WhaleCouponStore } from '../dsh-adapter/oauth/bonus.js'
import { dueStarModal, markStarAsked, pendingStarMilestone, readUsage, STAR_MILESTONES } from '../usageStats.js'
import { TimelineRail } from '../components/TimelineRail.js'
import { ScrollbarGutter } from '../components/ScrollbarGutter.js'
import type { TimelineSnapshot } from '../ink/timeline-rail.js'
import { normalizeScrollGutter } from '../tuiDisplayPrefs.js'
import { OverlayAbove } from '../components/OverlayAbove.js'
import { TooltipLayer } from '../components/Tooltip.js'
import { PromptInput, type PromptController } from '../components/PromptInput.js'
import { turnUsageParts } from '../components/TurnUsageRow.js'
import { AgentTranscriptScene } from './AgentTranscriptScene.js'
import { agentViewStore } from '../components/sidePanel/agentViewStore.js'
import { agentComposeTargetOf, type AgentComposeTarget, type AgentMessageView, type AgentViewSource } from '../components/messages/agentTeam.js'
import type { PromptDraftCache } from '../components/promptDraftCache.js'
import type { InjectController } from '../dsh-adapter/inject-channel.js'
import { PromptEditorLayer, usePromptEditorOpen } from '../components/PromptEditor.js'
import { GoalTodoPanel } from '../components/GoalTodoPanel.js'
import { useSidePanel } from '../components/sidePanel/useSidePanel.js'
import { jobsFocusStore } from '../components/sidePanel/jobsFocusStore.js'
import { SidePanelLayout } from '../components/sidePanel/SidePanelLayout.js'
import { SidePanelColumn } from '../components/sidePanel/SidePanelColumn.js'
import { PanelPicker, usePanelPickerRows } from '../components/sidePanel/PanelPicker.js'
import { AutoRecapRow } from '../components/AutoRecapRow.js'
import { CompactionStatusRow } from '../components/CompactionStatusRow.js'
import { BalanceReportRow } from '../components/BalanceReportRow.js'
import type { BalanceResult } from '../deepseekBalance.js'
import { estimateSessionCostSnapshotCny } from '../deepseekPricing.js'
import { LoadedContextPanel } from '../components/LoadedContextPanel.js'
import { formatCostReport, StatusLine } from './StatusLine.js'
import { channelContextOccupancy } from './StatusMetrics.js'
import { WorkingSpinner, useThinkingStatus } from '../components/WorkingSpinner.js'
import { ActivityLine, contextPressurePct } from '../components/ActivityLine.js'
import { ModelPicker } from '../components/ModelPicker.js'
import { HelpMenu } from '../components/HelpMenu.js'
import { PluginSceneBoundary } from '../components/PluginSceneBoundary.js'
import { PluginStatusViewBoundary } from '../components/PluginStatusViewBoundary.js'
import { ImagePreviewOverlay } from '../components/ImagePreviewOverlay.js'
import { SkillsPicker, SkillsPickerLoading } from '../components/SkillsPicker.js'
import { MigrateConfirm, MigratePicker } from '../components/MigratePicker.js'
import { collectMigratePickerRows, MIGRATE_SCAN_SPECS, parseImportSummary, resolveMigrateCommand, type MigratePickerRow } from '../dsh-adapter/migrate/picker.js'
import { collectActivitySamples, recentAgentsFrom, type ActivitySample } from '../dsh-adapter/migrate/recent-agents.js'
import { MIGRATION_ADAPTERS } from '../dsh-adapter/migrate/index.js'
import { SessionSupervisor } from './SessionSupervisor.js'
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
import { ModePicker } from '../components/ModePicker.js'
import { KernelPicker } from '../components/KernelPicker.js'
import { SdkInstallWizard, type SdkInstallPhase } from '../components/SdkInstallWizard.js'
import type { SdkInstaller, SdkInstallTarget } from '../agent/backend.js'
import { ChannelPicker } from '../components/ChannelPicker.js'
import type { KernelStatus } from '../components/kernelCatalog.js'
import type { KernelBackendId } from '../kernelPrefs.js'
import { modeDisplayName } from '../sessionModes.js'
import { PlanPicker } from '../components/PlanPicker.js'
import { LangPicker } from '../components/LangPicker.js'
import { ThemePicker, getThemeOptions } from '../components/ThemePicker.js'
import { AUTO_THEME_NAME, getAutoThemeBase } from '../theme.js'
import { FRAME_PRESETS, PRESET_NAMES } from '../components/activityFrames.js'
import { ThinkingToggle } from '../components/ThinkingToggle.js'
import { HistorySearchDialog } from '../components/HistorySearchDialog.js'
import { RewindPicker } from '../components/RewindPicker.js'
import { BtwPanelFallback } from '../components/BtwPanel.js'
import { btwThreads } from '../components/sidePanel/btw/threads.js'
import { getBtwContextBudget, getBtwContextTurns } from '../tuiDisplayPrefs.js'
import { BtwThreadScene } from '../components/sidePanel/btw/BtwThreadScene.js'
import { RecapPanel } from '../components/RecapPanel.js'
import { isValidSessionColor, SESSION_COLOR_NAMES } from '../terminal-utils/sessionColors.js'
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
import { markHomeSeen } from '../homePrefs.js'
import { markOnboardingDone } from '../onboardingPrefs.js'
import { Launchpad, launchpadVisible, type LaunchpadAction } from './Launchpad.js'
import { resolveLaunchpadActions } from '../components/launchpadActions.js'
import { Onboarding } from './Onboarding.js'
import { appendHistory } from '../history.js'
import { isHiddenCommandName, isLocalCommandName, parseCommandName } from '../commands.js'
import { extendTrajectory, projectWave, type TrajBuild } from '../dsh-adapter/trajectory/index.js'
import { miniWakeWidth } from '../components/trajectory/MiniWake.js'
import { readTrajectorySeen, writeTrajectorySeen } from '../trajectoryPrefs.js'
import type { RawTrajEvent as SessionEvent } from '../adapter/ports/channel-view.js'
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

/** Strip the focus/global-input surface even from untyped plugins. Local
 * click, hover, and captured drag stay inside the view and are kept. */
function StatusViewBox({
  ref: _ref,
  tabIndex: _tabIndex,
  autoFocus: _autoFocus,
  onContextMenu: _onContextMenu,
  onFocus: _onFocus,
  onFocusCapture: _onFocusCapture,
  onBlur: _onBlur,
  onBlurCapture: _onBlurCapture,
  onKeyDown: _onKeyDown,
  onKeyDownCapture: _onKeyDownCapture,
  onWheel: _onWheel,
  ...props
}: React.ComponentProps<typeof Box>): React.ReactNode {
  return <Box {...props} />
}

/** Text refs would expose the host DOM node; status text is presentation. */
function StatusViewText({
  ref: _ref,
  ...props
}: React.ComponentProps<typeof Text>): React.ReactNode {
  return <Text {...props} />
}

/** Rich status views receive pointer-only layout/text primitives, never the
 * input, channel, raw-ANSI, or terminal-write parts of the full UI kit. */
const STATUS_VIEW_UI = Object.freeze({
  Box: StatusViewBox,
  Image,
  Text: StatusViewText,
  useTerminalSize,
}) satisfies TuiStatusViewUi

/** Shared empty snapshot for hosts whose channel has no event log. */
const NO_EVENTS: readonly SessionEvent[] = []

const COMMAND_RESULT_CELLS = 200

/** Ceiling for one `dsh-tui migrate` child run. Discovery parses every source
 *  file, but a healthy import of thousands of conversations finishes well
 *  inside this; without a cap a wedged child would hang the loop forever. */
const MIGRATE_CHILD_TIMEOUT_MS = 30 * 60 * 1000
/**
 * 落地页参数行四段能点开的既有选择器（第五版）：模型 → /model、思考深度 →
 * /effort、模式 → /plan、权限预设 → /permission。盖在落地页之上时键盘归
 * 选择器（见 useInput 的 launchpad 分支注释）；其余 overlay 类型不在此列，
 * 落地页期间照旧整块让位。
 */
const LAUNCHPAD_OVERLAY_KINDS: ReadonlySet<string> = new Set([
  'model', 'effort', 'plan', 'preset', 'permission', 'mode',
  // 第七版：左下角工作目录铭牌点开的工作区菜单（及其二级选择器/流程层）
  // 也是「盖在落地页之上」的姿态——同一套 pickerPanels 挂载，Esc 回落地页。
  'workspace-menu', 'workspace-picker', 'workspace-flow',
  // 第八版：帮助入口也走「盖在落地页之上」的浮层姿态（overlay kind 'help'，
  // HelpMenu 经 pickerPanels 挂进 OverlayAbove）——不再收掉落地页进对话页。
  'help',
  // 内核选择器（/kernel 与启动页「内核」入口）：同一姿态盖在落地页之上，
  // 点选即切换内核并重启（组合根的 onSwitchBackend）。
  'kernel',
  // SDK 安装向导（内核选择器「未安装」行 Enter 进入）：同一姿态，Esc 层级
  // 一样——向导收回，露出落地页。
  'sdk-install',
])

function cleanCommandError(error: unknown): string {
  try {
    if (error instanceof Error) {
      return typeof error.message === 'string'
        ? cleanRenderText(error.message, COMMAND_RESULT_CELLS)
        : ''
    }
    return cleanScalarText(error, COMMAND_RESULT_CELLS)
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

/**
 * The occupancy line `/tokens` and `/status` print.
 *
 * Occupancy has ONE source (see `dsh-adapter/context-occupancy.ts`): this is
 * the same reading the footer's ctx field, the segmented bar and the
 * context-low warning use — never the session's cumulative uncached input,
 * which is a different quantity by orders of magnitude.
 * @param channel - Live channel surface.
 * @returns The localized line, or `undefined` when no window is known.
 */
function contextOccupancyLine(channel: Channel): string | undefined {
  const occupancy = channelContextOccupancy(channel)
  if (occupancy === undefined || occupancy.contextWindow === undefined || occupancy.contextWindow <= 0) return undefined
  const percent = Math.max(0, Math.min(100, Math.round((occupancy.usedTokens / occupancy.contextWindow) * 100)))
  return t('context-occupancy', {
    percent,
    used: formatTokens(occupancy.usedTokens),
    window: formatTokens(occupancy.contextWindow),
  })
}

/** Terminal-title spinner frames. */
const TITLE_SPINNER_FRAMES = ['⠂', '⠐']

/** Searchable transcript text for one row (`/` incsearch):
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
 * Main chat screen: a scrollable transcript
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
let fallbackApprovalStore: PermissionStore | undefined

/**
 * Shared inert extension stores for hosts that render Chat without the
 * dsh-tui-extensions row (headless verify scripts, bare embeds). Never
 * written, so plugin dialogs/status contributions never mount and
 * no shortcut ever matches.
 */
let fallbackDialogStore: TuiDialogStore | undefined
let fallbackStatusStore: TuiStatusStore | undefined
/** Standalone mounts (tests, bare embeds) without the composition root's store. */
let fallbackActivityStore: ActivityStore | undefined
const noCouponSubscription = (): (() => void) => () => undefined
const noCouponSnapshot = (): null => null

/** Identity of one caret-preview dismissal: the token (its title) on the
 *  image, so the same image staged twice is dismissed per token. */
function peekKey(image: TranscriptImage, title: string | undefined): string {
  return `${title ?? ''} ${image.id}`
}

export function Chat({
  channel,
  questionStore,
  approvalStore,
  extensionDialogs,
  bonusNotices,
  extensionStatus,
  activityStore,
  extensionShortcuts,
  themeHost,
  onExit,
  onUpdate,
  onRestart,
  onSwitchBackend,
  onRestartFreshSession,
  onProbeKernels,
  onResolveSdkInstallTarget,
  onStartSdkInstall,
  onCheckPnpm,
  sdkInstallPinned,
  kernelPinned,
  fullscreen = false,
  trajectorySeen: trajectorySeenProp,
  injectControllerRef,
  promptControllerRef: promptControllerRefProp,
  renderScene,
  openHomeOnBoot,
  launchpadOnBoot,
  onboardingOnBoot,
  starPrompt,
}: {
  channel: Channel
  renderScene?: (id: string, channel: Channel) => React.ReactNode
  questionStore: QuestionStore
  /**
   * The approval seam's UI store — the DSH `ApprovalStore` or a backend
   * session's shared `PermissionStore`; both present the same panel shape.
   * Optional: hosts without an approval channel (headless scripts, older
   * embeds) render Chat without it and simply never see an approval panel —
   * the question panel keeps its seat.
   */
  approvalStore?: PermissionPanelSource
  /**
   * The managed plugin dialog queue (tuiDialogs service's store). Optional
   * for the same hosts as approvalStore; absent, plugin dialog requests
   * park unanswered (their `timeoutMs` is the plugin's guard).
   */
  extensionDialogs?: TuiDialogStore
  /** Server-confirmed login bonuses awaiting presentation in the TUI. */
  bonusNotices?: WhaleCouponStore
  /** Plugin text and bounded rich status contributions. */
  extensionStatus?: TuiStatusStore
  /** Session-scoped activity values published by the working-activity plugin. */
  activityStore?: ActivityStore
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
   * 切换内核（组合根实现：写 kernel.json 记忆 → 通知 → 退出 → 以新内核重启，
   * 新内核开新会话）。启动页「内核」入口与 /kernel 都落到这里；缺省 =
   * 当前宿主没有切换能力（选择器只提示，绝不假装）。
   */
  onSwitchBackend?: (backend: KernelBackendId) => void
  /**
   * 以新会话重启（组合根实现：走切换内核的同一条退出路径，不写 resume 目标，
   * 内核不变）。/channel 在激活渠道的连接变了时用它：运行中的 CLI 子进程
   * 换不了 baseUrl/token，只能换会话。
   */
  onRestartFreshSession?: (notice: string) => void
  /**
   * Claude 内核探测（组合根注入；Chat 不 import 任何具体后端）。首次需要时
   * 调一次并缓存结果；探测失败按「未安装」处理。
   */
  onProbeKernels?: () => Promise<Record<string, KernelStatus>>
  /**
   * SDK 安装向导（组合根注入，同上不 import 具体后端）。resolveTarget 同步
   * 快（argv + 文件系统判定）；start 在 profile 目录跑 `pnpm add`，返回可
   * 取消的句柄；checkPnpm 是确认后的预检。与 {@link sdkInstallPinned} 齐
   * 备时向导可用，缺一则「未安装」行保持死路提示。
   */
  onResolveSdkInstallTarget?: () => SdkInstallTarget
  onStartSdkInstall?: (dir: string) => SdkInstaller
  onCheckPnpm?: () => Promise<boolean>
  /** 向导显示与手动兜底命令用的安装目标（`@anthropic-ai/claude-agent-sdk@<pin>`）。
   *  storeDir 是安装时钉住的 store：带上它，用户照着兜底命令手敲的那条才是
   *  向导真正跑的那条，不会按环境另解析出一个 store 来。 */
  sdkInstallPinned?: { readonly specifier: string; readonly version: string; readonly storeDir?: string }
  /** 启动参数（Config 行 / DSH_TUI_BACKEND）压过了记忆：选择器明说。 */
  kernelPinned?: boolean
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
  /**
   * Show the workspace home screen as this session's first frame.
   *
   * A prop rather than a filesystem read inside the component: the host knows
   * whether this launch was an ordinary one (no `--resume`, no workspace
   * target) and whether the home screen has already been shown on this
   * installation, and tests need it deterministic.
   */
  openHomeOnBoot?: boolean
  /**
   * Show the Launchpad as this session's first frame.
   *
   * Same shape of decision as `openHomeOnBoot` and answered by the same
   * ordinary-launch test (no `--resume`, no workspace target, no first
   * prompt) — a resumed conversation belongs to a user who already said
   * where they want to be, and a landing page in front of it would be the
   * TUI second-guessing them. Unlike the workspace home this is NOT one-shot:
   * every ordinary launch lands here, because the page is the place where the
   * first sentence gets typed, not a tutorial that retires itself.
   */
  launchpadOnBoot?: boolean
  /**
   * Offer the first-run guide as this session's first frame.
   *
   * The host owns the decision (it reads `~/.dsh-tui/onboarding.json`); this
   * prop only carries the verdict, exactly like `openHomeOnBoot`. It renders
   * ABOVE the launchpad: the wizard answers "is this thing even wired up",
   * which is upstream of "what do I want to do first".
   */
  onboardingOnBoot?: boolean
  /**
   * Test seam for the startup star modal (usage milestones 99h / 999
   * launches): `null` disables the modal outright; `dir` points the usage
   * ledger at a fixture directory; overriding the actions keeps it fully
   * interactive without spawning `gh` or a browser. Production leaves it
   * undefined.
   */
  starPrompt?: { dir?: string; onStar?: () => StarAttempt | Promise<StarAttempt>; onOpen?: () => void } | null
  /**
   * The composer's live controller, published every render. Exposed as a prop
   * so a regression can read the draft the composer HOLDS — the ownership
   * question (does a screen swap lose it?) is about state, not about pixels.
   */
  promptControllerRef?: React.RefObject<PromptController | null>
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
  const promptEditorOpen = usePromptEditorOpen()
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
  const approvals: PermissionPanelSource = approvalStore ?? (fallbackApprovalStore ??= new PermissionStore())
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
  const coupon = React.useSyncExternalStore(
    bonusNotices?.subscribe ?? noCouponSubscription,
    bonusNotices?.getSnapshot ?? noCouponSnapshot,
  )
  // Plugin status contributions: text keys join into one line; bounded rich
  // views keep their own rows immediately above the prompt.
  const statusContributions = extensionStatus ?? (fallbackStatusStore ??= new TuiStatusStore())
  // The working line: the working-activity plugin's published value for THIS
  // session, read from its session projection. No projection value (plugin
  // absent, or nothing published yet) simply means the classic spinner below.
  const activityValues = activityStore ?? (fallbackActivityStore ??= new ActivityStore())
  const workingActivity = useActivity(activityValues, channel.sessionId)
  const subscribeStatus = React.useCallback(
    (listener: () => void) => statusContributions.subscribe(listener),
    [statusContributions],
  )
  const statusEntries = React.useSyncExternalStore(
    subscribeStatus,
    () => statusContributions.getSnapshot(),
  )
  const statusViews = React.useSyncExternalStore(
    subscribeStatus,
    () => statusContributions.getViewSnapshot(),
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
    pinnedId: null,
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
  // `/migrate` picker rows (null = collecting in the background; the picker
  // shows its empty state until the sub-second scan lands).
  const [migrateRows, setMigrateRows] = React.useState<MigratePickerRow[] | null>(null)
  // Multi-select state (PRD): checked agent ids + the confirmation layer's
  // frozen snapshot of the checked rows.
  const [migrateChecked, setMigrateChecked] = React.useState<ReadonlySet<string>>(new Set())
  const [migratePending, setMigratePending] = React.useState<readonly MigratePickerRow[]>([])
  // Smart-hint arming: while the migration hint notification is up, a bare
  // Enter (empty prompt, no overlay) jumps straight into the picker with
  // that source pre-checked (PRD #4). Any other key disarms.
  const [migrateHintAgent, setMigrateHintAgent] = React.useState<string | null>(null)
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
  // Recents are per backend: a Claude session's picks never evict the DSH list.
  const recentsBackend = channel.backendCapabilities?.backendId
  const [modelRecents, setModelRecents] = React.useState<readonly ModelRecentsRef[]>(() => readModelRecents(undefined, recentsBackend))
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
      setModelRecents(recordModelUse({ provider, id }, undefined, recentsBackend))
      return ok
    })
  }
  /** `/skills` 技能目录（issue #204）：null = 注册表快照在途。 */
  const [skillsList, setSkillsList] = React.useState<readonly SkillInfo[] | null>(null)
  /**
   * The session supervisor — the ONE screen behind `/resume`, `/agentview`,
   * `/home`, `/bg` and the composer's 🏠 button.
   *
   * Those were three screens over one domain (a workspace rail here, a
   * search surface there, a live-status overview somewhere else), which is why
   * each new session feature needed patching into all three and why the
   * three disagreed about what switching a session even does. There is now a
   * single surface and a single runtime behind every entry point: this
   * terminal hosts several sessions, leaving one parks it rather than ending
   * it, and a session another terminal holds is visible but not enterable.
   *
   * Seeded from the host's one-shot landing decision (`openHomeOnBoot`): the
   * first ordinary launch of an installation lands here instead of on a blank
   * conversation, because that is the launch where "which project am I working
   * on" has not been answered yet. Every later launch starts on the chat
   * screen, and the screen stays reachable.
   */
  // 根错误边界恢复后的重挂不是一次启动：启动页、首启引导与会话管理屏都
  // 不再打开，直接回到对话页（一次性标记由错误边界的恢复路径写入，见
  // update-overflow-guard）。首次渲染即消费；若这次渲染被丢弃，最坏只是
  // 多显示一次启动入口。
  const recoveryRemountOnBoot = consumeBoundaryRecoveryRemount()
  // 第七版：启动页在开时**不再**预开会话浏览器。旧姿态是「先收落地页再开
  // 整屏」，浏览器必须提前藏在下面；现在整屏（会话/设置/任务面板）盖在
  // 落地页**之上**、Esc 退回落地页，按需打开即可——boot 时同时为真反而会
  // 让浏览器盖住落地页（渲染顺序见各 early-return）。恢复重挂同样不开它。
  const [supervisorOpen, setSupervisorOpen] = React.useState(
    openHomeOnBoot === true && launchpadOnBoot !== true && !recoveryRemountOnBoot,
  )
  /**
   * The launchpad: the landing page every ordinary launch starts on.
   *
   * Seeded from `launchpadOnBoot`, and the screen that closes it is the one
   * that decides what comes next — a submitted line hands over to the chat
   * screen, an action hands over to whatever surface that action opens.
   */
  const [launchpadOpen, setLaunchpadOpen] = React.useState(launchpadOnBoot === true && !recoveryRemountOnBoot)
  /**
   * The launchpad's draft. It lives HERE, not inside the screen, because the
   * screen unmounts the moment the user submits: a draft owned by an
   * unmounting component would be lost in exactly the transition it exists
   * to carry.
   */
  const [launchpadDraft, setLaunchpadDraft] = React.useState('')
  const [launchpadCaret, setLaunchpadCaret] = React.useState(0)
  const [launchpadFocus, setLaunchpadFocus] = React.useState(-1)
  /**
   * 「整屏盖启动页」的显式授权（第七版防御位，用户实测回归：启动页一闪而过
   * 被顶掉）。整屏分支排在落地页**之前**，任何一处状态在开机后被异步置真
   * （杂散输入/宿主事件/未来新代码）都会把落地页挤掉。授权位只有**从落地页
   * 出发的交互**（入口行/空输入 Esc/目录铭牌/命令面板里的整屏命令、Continue
   * 的兜底浏览器）才置真；覆盖屏全部收起时自动落 false。开机后即便某个整屏
   * 状态被误置真，落地页仍在最上层——「浮层可以盖、整屏必须经授权」。
   */
  const launchpadCoverRef = React.useRef(false)
  /**
   * 这一帧到底出不出落地页：状态开着还不够，minimal 模式（`dsh-tui.minimal`）
   * 下它整块不存在——`minimalMode.ts` 的标志由 channel 在设置落地后写入，
   * 建 state 时读不到，所以判定必须放在**渲染期**读（与其它 minimal 门同一口径）。
   * 键盘守卫、渲染分支与"有没有整屏界面"的判定都认这一个值，三者不会分叉。
   */
  /**
   * 右下角铭牌的版本号：`installedTuiVersion()` 每次都要读一遍 package.json，
   * 而它在一个进程里不会变——mount 时读一次就够。
   */
  const tuiVersion = React.useMemo(() => installedTuiVersion(), [])
  /**
   * 内核（dsh）版本（第七版：落地页右下角双版本铭牌）。真实来源见
   * `contract.installedKernelVersion`（宿主 CLI 的 manifest，回落内核线包）；
   * 两级都读不到 = undefined → 铭牌只画 TUI 段，绝不编造。
   */
  const kernelVersion = React.useMemo(() => installedKernelVersion(), [])

  const launchpadShown = launchpadOpen && launchpadVisible()
  /**
   * 落地页之上是否盖着一个参数选择器（第五版：参数行四段各自可点，点开的
   * 是聊天页同一套 /model · /effort · /plan · /permission overlay）。这时
   * 键盘归选择器（Esc 关它回到落地页），渲染也要把 pickerPanels 带进
   * 落地页分支——不然整屏 early-return 把 overlay 吞了，"点了没反应"。
   */
  const launchpadOverlayUp = launchpadShown && LAUNCHPAD_OVERLAY_KINDS.has(overlay.kind)
  /**
   * 渲染在**覆盖层**（而不是整屏 early-return）的那几个命令。
   *
   * 落地页的快捷入口与向导招式卡的「试一下」都走 `runCommand`，而 supervisor /
   * settings / help 的 early-return 排在两个界面**之后**：不收掉当前界面就是
   * "点了没反应"，状态还滞留着、等界面关掉才突然弹出来。默认收，白名单只留给覆盖层。
   */
  const overlayCommandNames = React.useMemo(
    () => new Set(['model', 'effort', 'plan', 'preset', 'permission', 'kernel']),
    [],
  )
  /**
   * 打开**整屏界面**的命令（第七版）：从落地页触发这些命令时**不收掉落地页**
   * ——整屏盖在落地页之上渲染（它们的 early-return 排在落地页分支之前），
   * Esc 退出整屏回到落地页（草稿/参数/焦点原样保留）。这是「从启动页进入
   * 对话页的唯一路径 = Enter 提交一条非命令消息」的落地：任何返回键都不再
   * 把人甩到对话页。其余命令（star / update / help / 转录输出类）的反馈在
   * 对话页，仍按旧约收掉落地页再执行。
   */
  const launchpadScreenCommands = React.useMemo(
    () => new Set(['home', 'resume', 'agentview', 'settings', 'jobs', 'tree', 'agents', 'setup', 'bg', 'background']),
    [],
  )
  /**
   * 落地页条件位②（有新版本）：`checkForTuiUpdate()`（与 /update 同一条
   * 判定，src/update.ts）在启动页第一次挂起时后台探一次——registry 延迟
   * 不许拖慢第一帧；失败/离线静默为 false（绝不放假按钮）。
   */
  const [launchpadUpdateAvailable, setLaunchpadUpdateAvailable] = React.useState(false)
  const launchpadUpdateProbedRef = React.useRef(false)
  React.useEffect(() => {
    if (!launchpadShown || launchpadUpdateProbedRef.current) return
    launchpadUpdateProbedRef.current = true
    void checkForTuiUpdate().then(update => {
      setLaunchpadUpdateAvailable(update !== undefined)
    }).catch(() => undefined)
  }, [launchpadShown])
  const canInstallSdk = onResolveSdkInstallTarget !== undefined && onStartSdkInstall !== undefined
    && onCheckPnpm !== undefined && sdkInstallPinned !== undefined
  const { currentId: kernelCurrentId, options: kernelOptions, open: openKernelPicker, pick: pickKernel, reprobe: reprobeKernels } = useKernelPicker({
    channel, kernelVersion, launchpadShown, onProbeKernels, onSwitchBackend, canInstallSdk, dispatchOverlay,
  })
  /**
   * SDK 安装向导的步骤态（异步进程状态，按 chatOverlay 的分工留在 Chat，
   * 不进 overlay union）。生命周期约定：向导打开时从 idle 初始化，安装
   * （checking/running）期间面板保持打开——所有异步落地都发生在面板还在
   * 的窗口内；关闭路径（Esc/Enter 离开）一律重置回 idle，下一次打开重新
   * 解析安装目标。
   */
  const [sdkPhase, setSdkPhase] = React.useState<SdkInstallPhase>({ kind: 'idle' })
  const sdkInstallerRef = React.useRef<SdkInstaller | undefined>(undefined)
  // 打开即解析安装目标（同步、只读 argv + 文件系统）：profile → 确认面板；
  // standalone / 无 profile → 直接给手动指引面板。
  React.useEffect(() => {
    if (overlay.kind !== 'sdk-install' || sdkPhase.kind !== 'idle' || onResolveSdkInstallTarget === undefined) return
    const target = onResolveSdkInstallTarget()
    if (target.kind === 'profile' && sdkInstallPinned !== undefined) {
      setSdkPhase({ kind: 'confirm', dir: target.dir, version: sdkInstallPinned.version, specifier: sdkInstallPinned.specifier, storeDir: sdkInstallPinned.storeDir })
    } else {
      setSdkPhase({ kind: 'no-target', reason: target.kind === 'standalone' ? 'standalone' : 'no-profile' })
    }
  }, [overlay.kind, sdkPhase.kind, onResolveSdkInstallTarget, sdkInstallPinned])
  const closeSdkInstallToKernelPicker = (): void => {
    setSdkPhase({ kind: 'idle' })
    dispatchOverlay({ type: 'close' })
    openKernelPicker()
  }
  const closeSdkInstall = (): void => {
    setSdkPhase({ kind: 'idle' })
    dispatchOverlay({ type: 'close' })
  }
  const runSdkInstall = (dir: string): void => {
    if (onStartSdkInstall === undefined || sdkInstallPinned === undefined) return
    const installer = onStartSdkInstall(dir)
    sdkInstallerRef.current = installer
    setSdkPhase({ kind: 'running' })
    void installer.result.then(result => {
      if (result.kind === 'ok') {
        // 装好了：重探内核（灰行变亮，无需重启进程），停在完成面板。
        reprobeKernels()
        setSdkPhase({ kind: 'done' })
      } else if (result.kind === 'failed') {
        setSdkPhase({ kind: 'failed', exitCode: result.exitCode, tail: result.tail, dir, version: sdkInstallPinned.version, specifier: sdkInstallPinned.specifier, storeDir: sdkInstallPinned.storeDir })
      } else if (result.kind === 'store-mismatch') {
        // store 漂移单独说：pnpm 的原文只有「store 对不上」，得告诉用户按哪个
        // store 对齐。用安装器实际用的那个，而不是再解析一次。
        setSdkPhase({ kind: 'store-mismatch', storeDir: result.storeDir, dir, version: sdkInstallPinned.version, specifier: sdkInstallPinned.specifier })
      } else if (result.kind === 'pnpm-missing') {
        setSdkPhase({ kind: 'pnpm-missing', dir, version: sdkInstallPinned.version, specifier: sdkInstallPinned.specifier, storeDir: installer.storeDir })
      } else {
        setSdkPhase({ kind: 'cancelled' })
      }
    })
  }
  const confirmSdkInstall = (dir: string): void => {
    if (onCheckPnpm === undefined) return
    setSdkPhase({ kind: 'checking' })
    void onCheckPnpm().then(ok => {
      if (!ok && sdkInstallPinned !== undefined) {
        setSdkPhase({ kind: 'pnpm-missing', dir, version: sdkInstallPinned.version, specifier: sdkInstallPinned.specifier })
        return
      }
      runSdkInstall(dir)
    })
  }
  const host = channel.backendChannels?.()
  const { rows: channelRows, open: openChannelPicker, pick: pickChannel, setMode: runBackendModeCommand, login: runBackendLogin } = useBackendChannels({
    channel, host, questionStore, dispatchOverlay, onRestartFreshSession, runOAuthLogin,
  })
  /**
   * 落地页条件位③（投喂一颗 Star）：与开屏求 star 弹窗**同一口径**——
   * `usageStats`（~/.dsh-tui/usage.json）里有未报过的已达档里程碑
   * （`pendingStarMilestone`，首档 24h）且本进程尚未 star 成功。star 成功
   * 后（`starred` 翻真）按钮立即消失；记账过的档不再纠缠。
   */

  /**
   * The first-run guide. Renders above the launchpad (see the prop docs): a
   * launch that needs setup has not answered the launchpad's question yet.
   */
  const [onboardingOpen, setOnboardingOpen] = React.useState(onboardingOnBoot === true && !recoveryRemountOnBoot)
  /**
   * 落地页那条"第一次用？跑一遍引导"的横幅认的是**还欠一次引导**，而不是启动快照：
   * 完成（写进 onboarding.json）之后立刻收掉；跳过刻意保留——没记账，下次启动还会问，
   * 横幅说的正是这件事。
   */
  const [onboardingPending, setOnboardingPending] = React.useState(onboardingOnBoot === true && !recoveryRemountOnBoot)
  /**
   * 品牌档（`branding.ts`）：设置项 `dsh-tui.brand`（`auto` = 跟后端）与当前
   * 后端 id（`backendCapabilities.backendId`，boot 时即定）的合成。开屏词、
   * 立绘、大字配色读 prop；主题默认档经 `setActiveBrand` 镜像给
   * ThemeProvider（它挂在 Chat 外层，拿不到 channel）——plugin 已在首帧前
   * 铺过初值，这里负责 `/settings` 切品牌时的实时跟动。
   */
  const brand = resolveBrand(channel.brand, channel.backendCapabilities?.backendId)
  React.useEffect(() => {
    setActiveBrand(brand)
  }, [brand])
  /** `/tree` opens the session family tree (pi's Session Tree): every rewind
   *  fork stitched back onto the message it diverged from, hover previews,
   *  and per-node rewind/fork/adopt actions. Like the supervisor, a screen. */
  const [treeOpen, setTreeOpen] = React.useState(false)
  /**
   * The session backgrounded when the screen opened via ←/`/bg` (the "Esc
   *  returns to that conversation" return target), cleared on close.
   */
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
  /** Background the attached session and open the supervisor
   *  (`/bg`, `/background`, and ← on an empty prompt all land here). The
   *  backgrounded session becomes the screen's return target (final Esc
   *  attaches back to it). */
  const backgroundToAgentView = React.useCallback((): void => {
    void channel.backgroundCurrent().then((result) => {
      if (result.ok) {
        setAgentViewReturnId(result.backgroundedSessionId)
        agentViewOpenSessionRef.current = channel.agentId
        setSupervisorOpen(true)
      }
    })
  }, [channel])
  /** `/settings` opens the plugin settings screen (issue #165) — like the
   *  browser, a screen rather than a panel: it owns its own focus, staged
   *  drafts and keyboard; Chat only opens it. */
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  /** 99h / 999 次的"求 star"开屏弹窗（`usageStats` 记账，一档只弹一次）：
   * 只在启动时判定一次——回合进行中、或已有整屏界面在开（如开机首页），
   * 这一轮不弹也**不记账**，留给下一次启动。`starPrompt` 是测试缝：传
   * `null` 显式关闭，传 actions 覆写两个按钮（不跑真 gh、不开真浏览器）。 */
  /** 本次会话是否已经 star 成功（开屏彩蛋标题切「捡到小星星啦」）。 */
  const [starred, setStarred] = React.useState(false)
  /**
   * 落地页条件位③（投喂一颗 Star）：与开屏求 star 弹窗**同一口径**——
   * `usageStats`（~/.dsh-tui/usage.json）里有未报过的已达档里程碑
   * （`pendingStarMilestone`，首档 24h）且本进程尚未 star 成功。star 成功
   * 后（`starred` 翻真）按钮立即消失；记账过的档不再纠缠。readUsage 是
   * 文件读，只在 starred 翻真或测试缝变化时重算，不逐帧读盘。
   */
  const launchpadStarDue = React.useMemo(
    () => !starred && pendingStarMilestone(readUsage(starPrompt?.dir)) !== null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dir 经测试缝注入
    [starred, starPrompt],
  )
  const [starModal, setStarModal] = React.useState<{ index: number; phase: 'ask' | 'done' } | null>(null)
  // 单发闩：只在第一个"安静的开屏视口"上武装定时器。700ms 窗口内整屏
  // 界面打开 → cleanup 掐掉定时器且**不再重臂**（记账只发生在回调里，
  // 所以这一档完好留给下一次启动）；整屏界面随后关闭也不追到聊天视图
  // 上补弹——开屏求星不追人。
  const starModalArmedRef = React.useRef(false)
  /** 预览缝（`DSH_TUI_STAR_MODAL=1`）：启动即弹一次 99h 档的弹窗，**既不
   * 读账本也不记账**——给作者看效果、给回归夹具用；生产不设这个变量。 */
  const starModalPreview = process.env.DSH_TUI_STAR_MODAL === '1'
  React.useEffect(() => {
    if (starModalArmedRef.current) return
    if (starPrompt === null) return
    if (supervisorOpen || treeOpen || settingsOpen || launchpadShown || onboardingOpen || channel.working) return
    starModalArmedRef.current = true
    // 让开屏先画半秒：弹窗压在介绍动画之上，而不是同抢第一帧。
    const timer = setTimeout(() => {
      // 到点时回合已经开始的仍不弹（channel 是活对象，读到的是当前值）。
      if (channel.working) return
      if (starModalPreview) {
        const preview = STAR_MILESTONES.findIndex(milestone => milestone.hours === 99)
        if (preview >= 0) setStarModal({ index: preview, phase: 'ask' })
        return
      }
      const index = dueStarModal(starPrompt?.dir)
      if (index === null) return
      markStarAsked(index, starPrompt?.dir)
      setStarModal({ index, phase: 'ask' })
    }, 700)
    return () => { clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在整屏界面开合时重判；闩保证只武装一次
  }, [supervisorOpen, treeOpen, settingsOpen, launchpadShown, onboardingOpen])
  /** `/star` 命令、开屏标语的点击/`Alt+S` 共用的一键动作：异步跑 gh，界面
   * 全程不阻塞，结果回来按四类各报一句（成功 / 没装 gh / 没登录 / 失败）。
   * `starPrompt.onStar` 存在时走同一条测试缝（夹具因此不会真的去 star）。 */
  /** 打开仓库页（走 `starPrompt.onOpen` 测试缝——夹具里不会真的拉起浏览器）。 */
  const openStarPage = React.useCallback((): void => {
    const seam = starPrompt?.onOpen
    if (seam !== undefined) { seam(); return }
    void import('../starAction.js').then(({ STAR_REPO }) => {
      openExternal(`https://github.com/${STAR_REPO}`)
    })
  }, [starPrompt])
  const runStarAction = React.useCallback((): void => {
    const seam = starPrompt?.onStar
    void (seam !== undefined
      ? Promise.resolve(seam())
      : import('../starAction.js').then(async ({ starRepo, STAR_REPO }) => {
        const url = `https://github.com/${STAR_REPO}`
        const outcome = await starRepo()
        if (outcome.kind === 'starred') return { kind: 'starred' as const }
        if (outcome.kind === 'no-gh') return { kind: 'no-gh' as const, url }
        if (outcome.kind === 'not-authed') return { kind: 'not-authed' as const, url }
        return { kind: 'failed' as const, detail: outcome.detail, url }
      })).then(attempt => {
      if (attempt.kind === 'starred') {
        setStarred(true)
        // 成功就演一段庆祝（女仆娘接住星星）——`/star`、`Alt+S`、标语点击
        // 都是这一条路。整屏界面开着或回合进行中时弹窗放不下，退回一句
        // 通知，用户至少知道 star 点上了。
        const blocked = channel.working || supervisorOpen || treeOpen || settingsOpen
        const index = STAR_MILESTONES.findIndex(milestone => milestone.hours === 99)
        if (!blocked && index >= 0) {
          setStarModal({ index, phase: 'done' })
          return
        }
        channel.notify(t('star-ok'), { color: 'success' })
        return
      }
      if (attempt.kind === 'no-gh') {
        // 本机没法一键（没装 gh / 没登录）→ **自动**打开仓库页让用户自己点，
        // 通知里说明原因（浏览器没拉起来时 URL 也还在文案里）。
        openStarPage()
        channel.notify(t('star-no-gh', { url: attempt.url }), { color: 'warning' })
        return
      }
      if (attempt.kind === 'not-authed') {
        openStarPage()
        channel.notify(t('star-not-authed', { url: attempt.url }), { color: 'warning' })
        return
      }
      channel.notify(t('star-failed', { detail: attempt.detail, url: attempt.url }), { color: 'error' })
    })
  }, [channel, starPrompt, openStarPage, supervisorOpen, treeOpen, settingsOpen])
  const starModalActions = React.useMemo(() => ({
    // 弹窗自己演结果（成功→庆祝、失败→留在卡里说明原因），所以这里把
    // 结局**回传**给它；`/star` 命令那条路仍走 runStarAction 的 notify。
    onStar: (): StarAttempt | Promise<StarAttempt> => {
      const seam = starPrompt?.onStar
      // 成功把开屏彩蛋切成「捡到星星」版；gh 缺失/未登录**自动**打开仓库页
      // （与一键路径同一套兜底）。注意**不要**给返回值再包一层 `.then()`——
      // 多一个微任务会让弹窗"庆祝那一帧"被紧随其后的 Enter 关窗批掉
      //（夹具 C8/C9 实测）。这里只挂副作用、原样返回。
      const afterAttempt = (attempt: StarAttempt): StarAttempt => {
        if (attempt.kind === 'starred') setStarred(true)
        else if (attempt.kind === 'no-gh' || attempt.kind === 'not-authed') openStarPage()
        return attempt
      }
      if (seam !== undefined) {
        const result = seam()
        if (result instanceof Promise) {
          void result.then(afterAttempt)
          return result
        }
        return afterAttempt(result)
      }
      const run = import('../starAction.js').then(async ({ starRepo, STAR_REPO }) => {
        const url = `https://github.com/${STAR_REPO}`
        const outcome = await starRepo()
        if (outcome.kind === 'starred') return { kind: 'starred' as const }
        if (outcome.kind === 'no-gh') return { kind: 'no-gh' as const, url }
        if (outcome.kind === 'not-authed') return { kind: 'not-authed' as const, url }
        return { kind: 'failed' as const, detail: outcome.detail, url }
      })
      void run.then(afterAttempt)
      return run
    },
    onOpen: () => {
      setStarModal(null)
      openStarPage()
    },
  }), [starPrompt, openStarPage])
  /** 弹窗关闭回调：稳定引用（见渲染处的注释）。 */
  const closeStarModal = React.useCallback((): void => { setStarModal(null) }, [])
  const [workspaceTargets, setWorkspaceTargets] = React.useState<readonly TuiWorkspaceTarget[]>([])
  const workspaceFlowRequestRef = React.useRef(0)
  const workspaceFlowAbortRef = React.useRef<AbortController | null>(null)
  /** `/preset` agent-preset roster (issue #8): loads async, persists. */
  const [presetOptions, setPresetOptions] = React.useState<readonly PresetOption[]>([])
  /**
   * 落地页参数行的模式段（第六版设计 1）显示 preset 的**显示名**
   * （Standard/PTC/极简…），名册是异步的——落地页出来时顺手预热一次
   * （空名册不写；失败静默，段缺省不画）。/preset 自己的加载路径不动。
   */
  React.useEffect(() => {
    if (!launchpadShown || presetOptions.length > 0) return
    let cancelled = false
    channel.listPresets()
      .then(list => { if (!cancelled && list.length > 0) setPresetOptions(list) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [launchpadShown, presetOptions.length, channel])
  /** `/effort` adapter levels: load async before the slider opens. */
  const [effortOptions, setEffortOptions] = React.useState<readonly EffortOption[]>([])
  /** True when those levels are the CLI-standard compatibility ladder (the
   *  model row declares no tiers of its own) — the slider says so. */
  const [effortLevelsFallback, setEffortLevelsFallback] = React.useState(false)
  const [themeName, setTheme] = useTheme()
  const { rows: terminalRows } = useTerminalSize()
  /**
   * 帮助盖屏（第八版，overlay kind 'help'）的滚动视口：HelpMenu 自带
   * ScrollBox，键盘（↑/↓/PgUp/PgDn/Home/End）由 Chat 的 overlay 分支驱动。
   * 视口预算与 PromptInput 的 helpViewportHeight 同式（PR #446 的口径）。
   */
  const helpCoverScrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const helpCoverViewportHeight = Math.max(3, Math.min(terminalRows - 7, 15))
  const [showAllMessages, setShowAllMessages] = React.useState(false)
  /** Scope the fold to this question: an aborted ask can promote its queued
   *  successor without ever publishing an idle (null) snapshot. */
  const [minimizedQuestionKey, setMinimizedQuestionKey] = React.useState<string | null>(null)
  const questionMinimized = questionSnapshot !== null && minimizedQuestionKey === questionSnapshot.key
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
  /** /btw side-question thread: pure UI state in btwThreads — the answers
   *  never enter the transcript or the session log. The floating overlay is
   *  only the FALLBACK surface (btw panel not enabled); with the panel
   *  enabled the same thread routes to the sidebar instead — one answer,
   *  exactly one surface. */
  const [btwOverlayOpen, setBtwOverlayOpen] = React.useState(false)
  /** ⤢ fullscreen thread scene (openPanelFullscreen 'btw' route). */
  const [btwSceneOpen, setBtwSceneOpen] = React.useState(false)
  // Only the fallback overlay reads the thread here. With the overlay closed
  // the snapshot stays undefined, so an answer streaming into the sidebar
  // panel does not re-render the whole Chat on every delta.
  const btwOverlayThread = React.useSyncExternalStore(
    btwThreads.subscribe,
    () => (btwOverlayOpen ? btwThreads.get(String(channel.agentId)) : undefined),
  )
  const closeBtwOverlay = () => {
    // Fallback parity with the pre-thread overlay: closing cancels the
    // in-flight ask (completed turns stay in the thread).
    btwThreads.abortActive(String(channel.agentId))
    setBtwOverlayOpen(false)
  }
  /** 有模态或整屏界面时，/btw 的回答不抢着打开面板，只标未读。 */
  const btwSurfaceFree = () =>
    approvalSnapshot === null && dialogSnapshot === null && questionSnapshot === null
    && overlay.kind === 'none' && !helpOpen && !starModal && !couponVisible
    && !supervisorOpen && !treeOpen && !settingsOpen && !jobsPanelOpen
    && !sceneOpen && channel.pluginScene === undefined
    && !subagentDashboardOpen && subagentDetailId === null
    && !onboardingOpen && !launchpadShown && !btwSceneOpen && !promptEditorOpen
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
    // Retire every in-flight /balance completion from the previous binding;
    // the balance seam has no UI session id in its readonly DTO.
    balanceSeqRef.current += 1
    setBalance(null)
  }, [balanceSessionId])
  // A side question belongs to its captured session just like a recap. The
  // THREAD stays in memory under its own session id (an archived thread may
  // keep streaming); only the FALLBACK overlay is retired on a binding change
  // (see the btwSessionIdRef effect above) so an old conversation never leaks
  // onto the new one's screen.
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
    }).catch(() => {
      if (!controller.signal.aborted) setRecap(null)
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
   * transcript pinned to the bottom so rewinds and model switches can continue.
   */
  const repaintTranscript = (): void => {
    const ink = instances.get(process.stdout) ?? instances.values().next().value
    // Wait one task so React commits the new session's tree before the
    // scrollback clear repaints (same pattern as `/new`).
    setTimeout(() => {
      handle?.scrollToBottom()
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
    setBtwOverlayOpen(false)
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
  /** Job id the panel should focus on open: set by a transcript card click
   *  (open the panel AT that job), cleared on close so the keyboard/command
   *  path reopens at the top. */
  const [jobsPanelFocusId, setJobsPanelFocusId] = React.useState<string | null>(null)
  // Side-panel routing needs the controller, which is created further down;
  // a ref keeps this identity-stable callback fresh anyway.
  const sidePanelRef = React.useRef<{
    split: boolean
    enabledPanelIds: readonly string[]
    openPanel: (id: string, opts?: { focus?: boolean }) => void
    /** 切到整屏前把键盘交还聊天：从整屏返回时不会**落在面板里**吞掉输入。 */
    focusChat: () => void
  } | null>(null)
  // MessageList forwards these open handlers to every memoized row. Their
  // identities must survive token/metrics updates, including for tool rows.
  const openJobsPanel = React.useCallback((focusId?: string) => {
    const sidePanel = sidePanelRef.current
    // Split mode: open the jobs side panel at the requested job (the focus
    // lane carries the id; a fresh nonce refocuses even for the same id).
    if (sidePanel !== null && sidePanel.split && sidePanel.enabledPanelIds.includes('jobs')) {
      if (typeof focusId === 'string' && focusId !== '') jobsFocusStore.request(focusId)
      sidePanel.openPanel('jobs', { focus: true })
      return
    }
    // Narrow / inline fallback: the full-screen overlay (unchanged).
    if (typeof focusId === 'string' && focusId !== '') setJobsPanelFocusId(focusId)
    setJobsPanelOpen(true)
  }, [])
  // A job card / the panel keeps its output tail fresh while on screen, when
  // the backend reads output on demand. The control is re-projected on every
  // read; this handler keeps one identity per channel capability so the
  // memoized rows are not re-rendered by it.
  const jobControlRef = React.useRef(channel.jobControl)
  jobControlRef.current = channel.jobControl
  const jobOutputWatchable = typeof channel.jobControl?.watchOutput === 'function'
  const watchJobOutput = React.useMemo(
    () => jobOutputWatchable ? (id: string) => jobControlRef.current?.watchOutput?.(id) ?? (() => undefined) : undefined,
    [jobOutputWatchable],
  )
  /** Ctrl+A / detail 回退：侧栏分栏且 agents 已启用时打开右栏 Panel（内部
   *  dashboard ↔ detail 二级路由自己管）；窄屏 / inline 保留整屏形态。 */
  const openSubagentDashboard = React.useCallback((): void => {
    const sidePanel = sidePanelRef.current
    if (sidePanel !== null && sidePanel.split && sidePanel.enabledPanelIds.includes('agents')) {
      sidePanel.openPanel('agents', { focus: true })
      return
    }
    setSubagentDashboardOpen(true)
  }, [])
  /** Detail view for a specific subagent (opened from dashboard). */
  const [subagentDetailId, setSubagentDetailId] = React.useState<string | null>(null)
  /**
   * 主屏只读 Agent View：Chat 自己的场景层。父 Chat、Channel 与 PromptInput
   * 保持挂载（草稿经 draftCache 往返），场景只借用屏幕与键盘；Esc 回到打开它
   * 的地方（对话 / 代理面板 / 详情 / 转录卡）。不建第二个 Channel。
   */
  const [agentView, setAgentView] = React.useState<{ agentId: string; source: AgentViewSource } | null>(null)
  const openAgentView = React.useCallback((agentId: string, source: AgentViewSource): void => {
    setAgentView({ agentId, source })
  }, [])
  /** 工作台里切到同级或父代理：原地换被查看的代理，Esc 仍回最初的入口。 */
  const switchViewedAgent = React.useCallback((agentId: string): void => {
    setAgentView(prev => prev === null ? prev : { ...prev, agentId })
  }, [])
  /** 转录卡入口的稳定句柄：MessageList 的 memo 行按 props 身份比较，内联
   *  箭头会让每个流式 tick 重渲染全部落定行（verify-tool-history-window）。 */
  const openSubagentViewFromCard = React.useCallback((agentId: string, rowId: number): void => {
    openAgentView(agentId, { kind: 'transcript-card', rowId })
  }, [openAgentView])
  // 侧栏 agents 面板 / 其 Detail 的主屏查看请求（面板没有 Chat 的场景 state）。
  React.useEffect(() => agentViewStore.subscribe(() => {
    const request = agentViewStore.get()
    if (request === null) return
    const source: AgentViewSource = request.source === 'agents-dashboard'
      ? { kind: 'agents-dashboard', ...(request.panel ? { panel: true as const } : {}) }
      : { kind: 'agent-detail', agentId: request.agentId, ...(request.panel ? { panel: true as const } : {}) }
    setAgentView({ agentId: request.agentId, source })
  }), [])
  /** Esc 的返回路由：面板来源回面板（路由经模块记忆保真），整屏来源回整屏。 */
  const exitAgentView = React.useCallback((source: AgentViewSource): void => {
    setAgentView(null)
    const sidePanel = sidePanelRef.current
    const panelReturn = (sidePanel !== null && sidePanel.split && sidePanel.enabledPanelIds.includes('agents'))
    if (source.kind === 'agents-dashboard') {
      if (source.panel === true && panelReturn) sidePanel.openPanel('agents', { focus: true })
      else setSubagentDashboardOpen(true)
      return
    }
    if (source.kind === 'agent-detail') {
      if (source.panel === true && panelReturn) sidePanel.openPanel('agents', { focus: true })
      else setSubagentDetailId(source.agentId)
    }
  }, [])
  /**
   * Hidden `/deepseek` easter egg: each invocation bumps this key so the
   * logo header remounts and replays the whale spout + text shimmer.
   */
  const [logoNonce, setLogoNonce] = React.useState(0)
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

  /**
   * 整屏分支的「盖启动页」闸门（第七版防御位，用户实测回归：启动页一闪
   * 而过被顶掉）。落地页在屏上时，只有**经 `launchpadCoverRef` 授权**
   * （= 从落地页出发的交互打开）的整屏才盖它；否则该整屏状态被无视
   * （渲染落到落地页），启动页永远不被开机期的杂散状态挤掉。落地页不在
   * 屏上时闸门恒开（普通姿态与从前逐字节一致）。
   *
   * ⚠ 这一段必须排在组件**所有** early-return 之前（hooks 规则）：曾放在
   * onboarding/interrupt 分支之后，向导一开就少跑这个 effect，React 直接
   * 报 hooks 乱序（verify-launchpad-onboarding-chat A2/E5/H2 全红）。
   */
  const launchpadGate = (): boolean => !launchpadShown || launchpadCoverRef.current
  // 覆盖屏全部收起时收回授权：下一次打开必须再经过落地页自己的交互。
  const launchpadCoverScreenUp = supervisorOpen || treeOpen || settingsOpen
    || jobsPanelOpen || subagentDashboardOpen || subagentDetailId !== null || sceneOpen
    || agentView !== null
    || btwSceneOpen
  React.useEffect(() => {
    if (!launchpadCoverScreenUp) launchpadCoverRef.current = false
  }, [launchpadCoverScreenUp])
  /**
   * 从落地页出发的交互要开整屏前先授权（配合 `launchpadGate`）：调用点只在
   * 落地页自己的回调里（onAction / onCommandPick / onEscape 的会话浏览路）。
   * 异步误置真的整屏状态没有这道授权 → 闸门挡下，落地页留在最上层。
   */
  const authorizeLaunchpadCover = (): void => { launchpadCoverRef.current = true }

  /**
   * Open the trajectory, mark failures seen, and retire the key hint for good.
   *
   * Ctrl+T and `/trace` share this one entry point, and it is SPLIT-AWARE the
   * same way `/jobs` and `/agents` already are: while the sidebar is
   * rendering, the trajectory opens as the `trajectory` panel inside it
   * instead of taking the whole screen. `options.fullscreen` is the escape
   * hatch the panel's own ⤢ button uses — without it that button would route
   * straight back into the panel it is trying to leave.
   */
  const openScene = React.useCallback((options?: { readonly fullscreen?: boolean }) => {
    // /trace, Ctrl+T, the sidebar tab and ⤢ all open the trajectory. A
    // kernel without a trajectory source reports 'unsupported' and the
    // scene/panel say so; no entry point refuses on its own, so they can
    // never disagree about the capability.
    seenFailuresRef.current = trajectoryRef.current?.counts.errors ?? 0
    setTrajectorySeen(previous => {
      if (!previous) writeTrajectorySeen()
      return true
    })
    const controller = sidePanelRef.current
    if (
      options?.fullscreen !== true
      && controller !== null
      && controller.split
      && controller.enabledPanelIds.includes('trajectory')
    ) {
      controller.openPanel('trajectory', { focus: true })
      return
    }
    setSceneOpen(true)
  }, [channel])

  /**
   * Leave the session supervisor for the conversation.
   *
   * The one-shot landing preference is written here rather than at boot: a
   * process that dies before the user ever sees the screen (a config error, a
   * crash during the first render) must not burn the installation's only
   * first-launch landing. Writing on the way OUT means "the user has seen it".
   *
   * Leaving also honours `/bg`'s return target. `/background` moved the
   * session the user was in to the background and opened this screen; a plain
   * Esc out of it re-attaches to that session instead of silently leaving them
   * on the fresh one, which is what "go back to what I was doing" means. Any
   * explicit mount inside the screen clears the target first, so this can
   * never undo a choice the user just made.
   */
  const closeHome = React.useCallback(() => {
    suppressLogoIntroRef.current = true
    markHomeSeen()
    const returnTo = agentViewReturnId
    setAgentViewReturnId(undefined)
    setSupervisorOpen(false)
    if (returnTo !== undefined && returnTo !== channel.agentId) {
      void channel.resumeTo(returnTo).then((result) => {
        if (result.ok) repaintTranscript()
      }).catch(() => undefined)
    }
  }, [agentViewReturnId, channel, repaintTranscript])

  /**
   * Leave the first-run guide.
   *
   * `done` writes the one-shot marker; `skipped` deliberately does NOT — the
   * user has not answered, and a later launch is exactly when they might.
   * Both cases land on the launchpad rather than the transcript: the wizard
   * interrupted a launch, so the launch resumes where it left off.
   *
   * The write is best-effort by design (`markOnboardingDone` returns false
   * when the data directory is unwritable); a read-only install gets one more
   * offer next launch, which is the recoverable end of the trade.
   */
  const closeOnboarding = React.useCallback((outcome: 'skipped' | 'done'): void => {
    setOnboardingOpen(false)
    if (outcome === 'done') {
      const written = markOnboardingDone()
      setOnboardingPending(false)
      channel.notify(t(written ? 'onboarding-finished' : 'onboarding-write-failed'), {
        color: written ? 'success' : 'warning',
        timeoutMs: written ? 3000 : 6000,
      })
    } else {
      channel.notify(t('onboarding-skipped'), { timeoutMs: 4000 })
    }
  }, [channel])


  /** The startup summary gives way to transcript rows after the first local command or message. */
  const loadedContextVisible = channel.rows.length === 0 && channel.loadedContext !== undefined
  /** Startup context panel: collapsed by default, toggled with Ctrl+P. */
  const [loadedContextOpen, setLoadedContextOpen] = React.useState(false)
  const toggleLoadedContext = React.useCallback(() => {
    setLoadedContextOpen(previous => !previous)
  }, [])
  const renderedLoadedContextOpen = React.useRef(loadedContextOpen)
  React.useLayoutEffect(() => {
    if (renderedLoadedContextOpen.current === loadedContextOpen) return
    renderedLoadedContextOpen.current = loadedContextOpen
    // Reanchor after the new panel geometry commits. Requesting it in the
    // key handler lets a pending paint consume it on the old tall layout,
    // leaving the collapsed summary stranded outside the physical viewport.
    const ink = instances.get(process.stdout) ?? instances.values().next().value
    ink?.invalidatePrevFrame()
    ink?.reanchorViewport()
  }, [loadedContextOpen])

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

  /** Shared open path for the modal image preview: composer `[Image #N]`
   *  tokens and transcript thumbnails both land here. */
  const openImagePreview = React.useCallback((image: TranscriptImage, title?: string): void => {
    // Snapshot only metadata/facades on an explicit open, not on every streamed
    // token. Unvisited attachments stay lazy and duplicate image occurrences stay distinct.
    const gallery: { image: TranscriptImage; title?: string }[] = channel.rows.flatMap(row => (row.images ?? []).map(image => ({ image })))
    let index = gallery.findIndex(entry => entry.image === image)
    if (index < 0) { index = gallery.length; gallery.push({ image, title }) }
    dispatchOverlay({
      type: 'open',
      overlay: { kind: 'image-preview', image, gallery, index, ...(title === undefined ? {} : { title }) },
    })
  }, [channel])

  /** A clicked formula opens the same card as a transcript image. The raster
   *  is re-typeset at double the cell size, so 100% is a sharper formula
   *  rather than an upscaled one; when that re-render fails (too wide, TeX
   *  rejected) the pixels already on screen stand in. */
  const openMathPreview = React.useCallback((preview: MathPreviewRequest): void => {
    const scaled: MathRenderRequest = {
      ...preview.request,
      cellSize: {
        width: preview.request.cellSize.width * MATH_PREVIEW_SCALE,
        height: preview.request.cellSize.height * MATH_PREVIEW_SCALE,
      },
      maxColumns: Math.min(preview.request.maxColumns * MATH_PREVIEW_SCALE, MATH_PREVIEW_MAX_COLUMNS),
      maxRows: Math.min(preview.request.maxRows * MATH_PREVIEW_SCALE, MATH_PREVIEW_MAX_ROWS),
    }
    const image: TranscriptImage = {
      id: `math:${preview.tex}`,
      width: preview.source.width,
      height: preview.source.height,
      name: preview.tex,
      mediaType: 'image/png',
      read: async () => {
        const rendered = await renderMathRaster(scaled)
        return rasterToPng(rendered.ok ? rendered.raster.source : preview.source)
      },
    }
    openImagePreview(image, preview.tex)
  }, [openImagePreview])

  // The math components live deep inside the transcript, so the opener is
  // published rather than threaded through every message row's props.
  React.useEffect(() => {
    setMathPreviewOpener(openMathPreview)
    return () => setMathPreviewOpener(undefined)
  }, [openMathPreview])
  // Agent-binding generation is monotonic across every agent replacement
  // and bumps before the replacement emit, closing the ABA hole where a
  // resumed session reuses the same id. Partial test/embed channels fall
  // back to staged-image generation.
  const previewBindingGeneration = channel.agentBindingGeneration
    ?? channel.stagedImageGeneration?.()
    ?? 0
  const previewGenerationRef = React.useRef(previewBindingGeneration)
  const imagePreviewOwned = previewGenerationRef.current === previewBindingGeneration
  React.useEffect(() => {
    if (previewGenerationRef.current === previewBindingGeneration) return
    previewGenerationRef.current = previewBindingGeneration
    dispatchOverlay({ type: 'close-if', kind: 'image-preview' })
  }, [previewBindingGeneration])
  // A questionnaire/approval/plugin dialog owns the keyboard while pending
  // (their guard runs BEFORE the overlay key chain), so a preview left open
  // underneath would be visually on top yet key-dead. Close it instead.
  const previewBlocked = questionSnapshot !== null || approvalSnapshot !== null || dialogSnapshot !== null
  React.useEffect(() => {
    if (
      overlay.kind === 'image-preview' &&
      previewBlocked
    ) {
      dispatchOverlay({ type: 'close-if', kind: 'image-preview' })
    }
  }, [overlay.kind, previewBlocked])
  // Caret-driven preview (Grok Build's chip peek): while the composer caret
  // sits on a staged `[Image #N]` — at its start, the token inverted — the
  // same card shows over the transcript, and it goes away when the caret
  // leaves (the cell just after the token is not "on" it). It is
  // derived state, not an overlay: the prompt keeps the keyboard, so ←/→
  // walk from image to image with the card following. Esc (or a click
  // outside the card) dismisses it for THIS token until the caret leaves and
  // comes back; a click on the token always shows it again.
  const [caretPreview, setCaretPreview] = React.useState<
    { image: TranscriptImage; title?: string } | null
  >(null)
  const [peekSuppressed, setPeekSuppressed] = React.useState<string | null>(null)
  const handleCaretImage = React.useCallback((
    image: TranscriptImage | undefined,
    title: string | undefined,
    reason: 'caret' | 'click',
  ): void => {
    if (image === undefined) {
      setCaretPreview(null)
      setPeekSuppressed(null)
      return
    }
    setCaretPreview({ image, ...(title === undefined ? {} : { title }) })
    const key = peekKey(image, title)
    setPeekSuppressed(current => reason === 'click' || current !== key ? null : current)
  }, [])
  const peekPreview =
    !previewBlocked && overlay.kind === 'none' && caretPreview !== null
      && peekSuppressed !== peekKey(caretPreview.image, caretPreview.title)
      ? caretPreview
      : null
  /** Esc / click-outside on the peek: dismissed for this token until the
   *  caret leaves it. PromptInput's Esc arm calls this first — its listener
   *  runs before Chat's and the prompt stays live under a peek. */
  const dismissPeek = (): void => {
    if (peekPreview !== null) setPeekSuppressed(peekKey(peekPreview.image, peekPreview.title))
  }
  /** The card on screen, if any: the modal overlay first, else the peek. */
  const activePreview: { image: TranscriptImage; title?: string; peek: boolean } | null =
    !previewBlocked && overlay.kind === 'image-preview'
      ? { image: overlay.image, ...(overlay.title === undefined ? {} : { title: overlay.title }), peek: false }
      : peekPreview !== null
        ? { ...peekPreview, peek: true }
        : null

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
  /** `/` transcript search (less-style incsearch).
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
  // Whale idle gate: the settled header scrolls away with the transcript,
  // and the idle planner is worth nothing the moment its art leaves the
  // viewport — pause it there (timers cleared, the resting pose's cached
  // rows stay painted so scroll geometry never shifts) and re-arm a fresh
  // cycle when the user scrolls back to the top. Same uSES rationale as
  // isSticky above: the renderer's sticky re-pin doesn't fire scroll
  // subscribers, only the every-render snapshot check picks it up.
  const WHALE_ART_CUTOFF_ROWS = 16 // marginTop + the 13-row whale art
  const whaleArtVisible = React.useSyncExternalStore(
    cb => (handle ? handle.subscribe(cb) : () => {}),
    () => {
      if (!handle) return true
      // A transcript that fits the viewport always shows the header.
      if (handle.getScrollHeight() <= handle.getViewportHeight()) return true
      // Visible while the art block intersects the viewport. A sticky bottom
      // pin with an overflow smaller than the art's height still leaves the
      // art on screen — visibility, not pin state, decides whether the idle
      // planner earns its keep.
      return handle.getScrollTop() < WHALE_ART_CUTOFF_ROWS
    },
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

    // Idle Ctrl+C: first press arms an exit, second press exits. Under
    // Windows ConPTY the key
  // arrives as stdin data (key.ctrl && input === 'c') — the useInput
  // branch below is the only path; SIGINT is not emitted.
  const exitPendingRef = React.useRef(false)
  const exitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // Live view into the prompt's text for the Ctrl+C rule (clears text when
  // non-empty; the double-press exit only arms on an empty input).
  const ownPromptControllerRef = React.useRef<PromptController | null>(null)
  const promptControllerRef = promptControllerRefProp ?? ownPromptControllerRef
  /**
   * Owner of the unsent draft. Every screen this component renders INSTEAD of
   * the conversation (the session screen, the tree, settings, the jobs and
   * subagent panels, the trajectory scene) unmounts the composer, and the
   * composer keeps its text in local state — so without this the half-written
   * prompt died on the way in. The slot lives here, outlives that unmount, and
   * is dropped the moment the attached session changes so no draft can follow
   * the user into a different conversation.
   */
  const promptDraftRef = React.useRef<PromptDraftCache>({ current: null })
  /**
   * Latest channel for the unmount release below: that effect must not re-run
   * on a channel identity change, yet its cleanup must release against the
   * channel of the last render.
   */
  const channelRef = React.useRef(channel)
  channelRef.current = channel
  /**
   * Release the staged images a WAITING snapshot alone owns.
   *
   * While a draft waits in the slot for the composer to remount, the snapshot
   * is the only owner of the capabilities behind its `[Image #N]` tokens. If
   * Chat itself goes away first (leaving an early-return screen by exiting the
   * TUI), nothing would ever restore or discard them — the session's
   * 128-entry FIFO would evict live entries instead. The `hasStagedImage`
   * guard keeps a capability the channel already recycled a no-op; both calls
   * are idempotent.
   *
   * Scope, deliberately narrow (review round 7): a capability a QUEUED message
   * still references (`channel.pending`) is never revoked here. The real
   * double-hold path is paste an image → queue the draft with Tab while the
   * model works → recall that line from input history with ↑ (same stageId
   * rebound to the draft) → park the composer. Delivery resolves its refs from
   * the enqueue-time capture, so a late revoke would only bite a host that
   * re-resolves them afterwards — this keeps the rule identical to
   * `stageIdIsRetained` instead of relying on that.
   *
   * A composer that is still MOUNTED when Chat unmounts is NOT covered: React
   * runs this parent cleanup BEFORE the child's, so the child then writes its
   * draft into the now-dead ref and those ids ride the channel's lifetime out
   * (the #942 review's remaining P2). Neither unmount path loses anything
   * user-visible — the channel dies with them.
   */
  React.useEffect(() => {
    return () => {
      const snapshot = promptDraftRef.current.current
      promptDraftRef.current.current = null
      if (snapshot === null) return
      const queued = new Set<string>()
      for (const item of channelRef.current.pending) {
        // `?? []`: a foreign/embedded host may hand us a pending entry without
        // images, and a throw inside an unmount cleanup escapes into the exit
        // path — every other reader of this field guards it the same way.
        for (const image of item.images ?? []) queued.add(image.stageId)
      }
      for (const [, stageId] of snapshot.images) {
        if (queued.has(stageId)) continue
        if (channelRef.current.hasStagedImage?.(stageId) === true) {
          channelRef.current.discardStagedImage(stageId)
        }
      }
    }
  }, [])
  const draftSessionId = channel.agentId
  /** Session the effect below last reconciled against; a change is a switch. */
  const draftSessionRef = React.useRef(draftSessionId)
  /**
   * The session a fill Chat itself requested belongs to, if one is in flight.
   *
   * A rewind's restored message arrives in the same commit that replaces the
   * session, and it belongs to the NEW binding — the user picked it. The
   * composer cannot tell, so Chat says so here, at the two call sites that ask
   * for a fill.
   *
   * Keyed by the session id rather than a bare flag, so it can only ever excuse
   * the switch it was written for. Do NOT clear it when the composer consumes
   * the fill: a child's layout effects run before the parent's, so the fill is
   * consumed in the very commit this effect judges, and clearing it there would
   * wipe the message the user just got back.
   */
  const pendingFillRef = React.useRef<string | null>(null)
  /**
   * Drop the composer's text when the session underneath it is replaced.
   *
   * A LAYOUT effect, not a passive one: the clear has to land in the commit
   * that swaps the session. A passive effect is flushed later, and anything
   * typed in between (the tree's hand-off, a fast user) would be wiped with the
   * old conversation's text. Which DRAFT the slot keeps is a separate question,
   * answered by the snapshot's owner fields.
   */
  React.useLayoutEffect(() => {
    if (draftSessionRef.current === draftSessionId) return
    draftSessionRef.current = draftSessionId
    // A stored draft can only belong to the conversation being replaced: the
    // composer is the one that writes it, and it writes it on the way out.
    promptDraftRef.current.current = null
    if (pendingFillRef.current === draftSessionId) {
      pendingFillRef.current = null
      return
    }
    promptControllerRef.current?.clear()
  }, [draftSessionId])
  const previewGallery = activePreview === null ? [] : activePreview.peek
    ? promptControllerRef.current?.previewImages?.() ?? [activePreview]
    : overlay.kind === 'image-preview' ? overlay.gallery ?? [activePreview] : []
  // Peek entries are rebuilt from the prompt every render: match by
  // attachment id + token title, not facade identity.
  const previewIndex = activePreview?.peek
    ? previewGallery.findIndex(entry => entry.image.id === activePreview.image.id && entry.title === activePreview.title)
    : overlay.kind === 'image-preview' ? overlay.index ?? 0 : -1
  const stepPreview = (delta: 1 | -1): void => {
    if (!activePreview?.peek) { dispatchOverlay({ type: 'image-step', delta }); return }
    const index = previewIndex + delta
    const entry = previewGallery[index]
    if (!entry) return
    // A gallery click promotes the caret peek to a modal without moving or
    // editing the draft. Suppress the original peek so Esc really closes it.
    setPeekSuppressed(peekKey(activePreview.image, activePreview.title))
    dispatchOverlay({ type: 'open', overlay: { kind: 'image-preview', ...entry, gallery: previewGallery, index } })
  }
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

  // Terminal tab title: the session
  // title when set, else "dsh-TUI"; a `⠂/⠐` spinner prefix while a turn is
  // working (960ms cadence, only while the terminal is focused), a static
  // `✦` otherwise. dsh-TUI brands the idle prefix with the DeepSeek whale.
  const [titleFrame, setTitleFrame] = React.useState(0)
  const terminalFocused = useTerminalFocus()
  // Mouse text selection auto-copy: active only in
  // fullscreen (<AlternateScreen> supplies mouse tracking); a no-op
  // subscription in inline mode, where selection belongs to the terminal.
  // The copy clears the highlight and posts a transient notification.
  // Smart migration hint (product ask): ~12s after mount, one background
  // pass over the foreign-agent stores; when a source was active inside the
  // 20-minute window, surface the user's own wording once per session. The
  // file-level mtime scan is the counter's walk shape (sub-second) and runs
  // off the render path; failures read as "no data" and stay silent.
  const migrateHintShownRef = React.useRef(false)
  React.useEffect(() => {
    if (migrateHintShownRef.current) return
    const timer = setTimeout(() => {
      migrateHintShownRef.current = true
      void (async () => {
        const newest = await new Promise<readonly ActivitySample[]>(resolve => {
          setImmediate(() => resolve(collectActivitySamples(
            MIGRATION_ADAPTERS,
            adapter => MIGRATE_SCAN_SPECS[adapter.id],
          )))
        })
        const top = recentAgentsFrom(newest, Date.now())[0]
        if (top !== undefined) {
          channel.notify(t('migrate-hint-notify', { agent: top.label }), { timeoutMs: 10000 })
          // PRD #4: while the hint is up, a bare Enter (empty prompt, no
          // overlay) jumps into the picker with this source pre-checked;
          // the global key layer below consumes it, anything else disarms.
          setMigrateHintAgent(top.agentId)
          setTimeout(() => setMigrateHintAgent(current => current === top.agentId ? null : current), 10_000)
        }
      })()
    }, 12_000)
    return () => clearTimeout(timer)
  }, [channel])

  useCopyOnSelect(
    text => channel.notify(t('copied-chars', { n: text.length }), { timeoutMs: 1500 }),
    // Stale-selection refusal: the highlighted rows were replaced in place
    // (streaming overwrite), so nothing was copied — say why instead of
    // letting the highlight vanish silently.
    () => channel.notify(t('copy-refused-stale'), { timeoutMs: 2500 }),
  )
  const { clearSelection: clearMouseSelection, hasSelection: hasMouseSelection } =
    useSelection()
  React.useEffect(() => {
    if (!channel.working || !terminalFocused) return
    const interval = setInterval(() => {
      setTitleFrame(f => (f + 1) % TITLE_SPINNER_FRAMES.length)
    }, 960)
    return () =>{  clearInterval(interval) }
  }, [channel.working, terminalFocused])
  const titlePrefix = channel.working
    ? (TITLE_SPINNER_FRAMES[titleFrame] ?? '✦')
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
  const runExternalCommand = (
    name: string,
    rawInput: string,
    images: readonly ComposerImageRef[] = [],
  ): Promise<boolean> => {
    const originAgentBinding = channel.agentBindingGeneration
    return channel.runExternalCommandOutcome(name, rawInput, images).then((outcome) => {
      if (channel.agentBindingGeneration !== originAgentBinding) return false
      if (outcome === undefined) {
        channel.notify(t('command-not-found', { name }), { color: 'error' })
        return false
      }
      const cleaned = cleanRenderText(outcome.text, COMMAND_RESULT_CELLS)
      if (cleaned !== '') {
        channel.notify(cleaned, outcome.kind === 'error' ? { color: 'error' } : undefined)
      }
      return outcome.consumeDraft
    }).catch((error: unknown) => {
      if (channel.agentBindingGeneration !== originAgentBinding) return false
      const detail = cleanCommandError(error)
      if (detail !== '') channel.notify(detail, { color: 'error' })
      return false
    })
  }

  /** Route every permission switch through the official command path when it
   *  is registered; otherwise fall back to the permission-presets service's
   *  own write path (the same handler the command drives) so the picker and
   *  typed `/permission <preset>` keep working on compositions where the
   *  command row never reaches this agent's registry. The fallback carries no
   *  images: it is not a registry command and has no image grammar. */
  const runPermissionCommand = (
    rawInput: string,
    images: readonly ComposerImageRef[] = [],
  ): Promise<boolean> => {
    const originAgentBinding = channel.agentBindingGeneration
    const mounted = channel.commandList.some(command => command.external && command.name === 'permission')
    const run: Promise<ExternalCommandOutcome | undefined> = mounted
      ? channel.runExternalCommandOutcome('permission', rawInput, images)
      : channel.runPermissionPreset(rawInput.trim()).then(ok =>
        ok ? { kind: 'success' as const, text: '', consumeDraft: true as const } : undefined)
    return run.then((outcome) => {
      if (channel.agentBindingGeneration !== originAgentBinding) return false
      if (outcome === undefined) {
        channel.notify(t('command-not-found', { name: 'permission' }), { color: 'error' })
        return false
      }
      const cleaned = cleanRenderText(outcome.text, COMMAND_RESULT_CELLS)
      if (cleaned !== '') {
        channel.notify(cleaned, outcome.kind === 'error' ? { color: 'error' } : undefined)
      }
      return outcome.consumeDraft
    }).catch((error: unknown) => {
      if (channel.agentBindingGeneration !== originAgentBinding) return false
      const detail = cleanCommandError(error)
      if (detail !== '') channel.notify(detail, { color: 'error' })
      return false
    })
  }


  /** Hot-swap the UI language (`/lang <id>` and the LangPicker both land
   *  here): persist to ~/.dsh-tui/lang.json and mirror into the dsh-tui
   *  settings namespace when it is served (best effort). */
  const applyLang = (lang: Lang): void => {
    const ok = writeLangPref(lang)
    setLang(lang)
    const settingsHost = channel.settingsHost()
    // This mount's own namespace (custom Loader ids exist): looking up the
    // literal 'dsh-tui' skipped the mirror entirely on such mounts.
    const tuiView = settingsHost?.listNamespaces().find(entry => entry.ns === channel.settingsNamespace)
    if (settingsHost !== undefined && tuiView !== undefined) {
      void settingsHost
        .write(channel.settingsNamespace, [{ op: 'set', path: ['lang'], value: lang }], tuiView.revision)
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

  /** Collect picker rows off the current turn: the scan is synchronous FS
   *  work (name-only walk + per-file stat), so it is deferred by one macrotask
   *  to let the overlay paint its loading state first. */
  const collectMigrateRows = (): Promise<MigratePickerRow[]> => new Promise(resolve => {
    setImmediate(() => resolve(collectMigratePickerRows(Date.now())))
  })

  /** Run `dsh-tui migrate <args>` in a child process through the package
   *  bin; resolves with the exit code and the combined output. Uses the
   *  shared no-throw runner (bounded capture, timeout, windowsHide): a wedged
   *  child would otherwise hang the sequential per-source loop forever. */
  const runMigrateChild = async (parts: readonly string[]): Promise<{ code: number | null, out: string }> => {
    const { dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { resolveOwnBin } = await import('../dsh-adapter/migrate/bin-path.js')
    // This file sits at a different depth per layout (src/screens vs
    // lib/types/screens), so the bin resolves by upward probe — see
    // bin-path.ts; a fixed dirname count fails on real installs.
    const bin = resolveOwnBin(dirname(fileURLToPath(import.meta.url)))
    if (bin === undefined) {
      channel.notify(t('migrate-spawn-failed'), { color: 'error', timeoutMs: 8000 })
      return { code: -1, out: '' }
    }
    const result = await execFileNoThrow(process.execPath, [bin, 'migrate', ...parts], {
      timeout: MIGRATE_CHILD_TIMEOUT_MS,
    })
    // A killed child reports `code: null` and whatever it managed to print; put
    // the reason on the record so the transcript does not read as a silent
    // failure. Nothing at all (no code, no output) means it never really ran.
    if (result.code === null) {
      return {
        code: null,
        out: `${result.stdout}${result.stderr}${t('migrate-child-timeout', { minutes: MIGRATE_CHILD_TIMEOUT_MS / 60_000 })}\n`,
      }
    }
    if (result.code === 1 && result.stdout === '' && result.stderr === '') {
      channel.notify(t('migrate-spawn-failed'), { color: 'error', timeoutMs: 8000 })
    }
    // stdout carries the per-source report, stderr the usage/error lines;
    // both belong in the /migrate transcript row.
    return { code: result.code, out: `${result.stdout}${result.stderr}` }
  }

  /** Orchestrate the confirmation layer's confirmed rows (PRD #3): one child
   *  per source, sequential; per-source progress notifications (throttled by
   *  the source boundary — no intra-source spam), real per-source counters
   *  parsed from each child's report, and a final summary that NEVER claims
   *  success for a source that did not run (the P2 fix). */
  const spawnMigrateSources = (rows: readonly MigratePickerRow[], dryRun: boolean): void => {
    const allOut: string[] = []
    let failures = 0
    void (async () => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!
        channel.notify(
          t(dryRun ? 'migrate-previewing-source' : 'migrate-importing-source', { label: row.label, i: i + 1, n: rows.length }),
          { timeoutMs: 4000 },
        )
        const { code, out } = await runMigrateChild(dryRun ? [row.agentId, '--dry-run'] : [row.agentId])
        allOut.push(...out.split('\n').map(line => cleanRenderText(line, 400)).filter(Boolean))
        if (code !== 0) failures += 1
        // Per-source real counters straight from the child's report line.
        const summary = parseImportSummary(out).find(entry => entry.agentId === row.agentId)
        if (!dryRun && summary !== undefined) {
          channel.notify(
            t('migrate-source-done', { label: row.label, imported: summary.imported, existing: summary.existing }),
            { timeoutMs: 6000 },
          )
        }
      }
      // The transcript row is this run's record. When a source failed AND no
      // child output was captured at all (killed by the timeout, or never
      // spawned), the success wording would contradict the notification right
      // above it — report the failure here too.
      const fallbackLine = failures > 0
        ? t('migrate-failed', { n: failures })
        : t(dryRun ? 'migrate-all-previewed' : 'migrate-all-done', { n: rows.length })
      channel.pushLocal('/migrate', allOut.length > 0 ? allOut : [fallbackLine])
      channel.notify(
        failures === 0
          ? t(dryRun ? 'migrate-all-previewed' : 'migrate-all-done', { n: rows.length })
          : t('migrate-failed', { n: failures }),
        failures === 0 ? { timeoutMs: 6000 } : { color: 'error', timeoutMs: 10000 },
      )
    })()
  }

  /**
   * Close the launchpad and hand the draft to the chat screen.
   *
   * THREE cases, and they are genuinely different:
   *
   *   - a slash command → `runCommand`, the same dispatch a typed command
   *     takes in the composer. The line is NOT submitted to the model.
   *     Recognition is the composer's OWN rule (第六版 BUG 1 修复): the merged
   *     command list (locals + plugin/registry commands via channel.commandList)
   *     decides whether the line is a command — isLocalCommandName alone missed
   *     registry-only names (e.g. /plan, /goal), which then fell through to
   *     channel.submit and went to the model as a user message.
   *   - ordinary text  → SENT DIRECTLY (fifth revision, user-reported bug:
   *     "按了回车就直接进入流式输出"). The line rides the composer's own
   *     submit path (`channel.submit`, which queues through the DSH inbox
   *     while a turn is running) — no draft is parked anywhere, the composer
   *     mounts EMPTY because the content is already gone as the first turn.
   *   - empty          → nothing to send; just show the conversation.
   *
   * History is appended for the two non-empty cases (matching what PromptInput
   * does on submit) so the launchpad's first line is reachable with ↑ later.
   */
  const closeLaunchpad = React.useCallback((submit: string): void => {
    const text = submit.trim()
    setLaunchpadOpen(false)
    // 首启时 openHomeOnBoot 与落地页同时为真：会话浏览器已经开着、只是被落地页盖住。
    // 提交首句后必须把它收掉，否则用户落到浏览器而不是"草稿就在眼前的对话"，
    // 与本函数 doc 承诺的落点直接矛盾。
    setSupervisorOpen(false)
    setLaunchpadFocus(-1)
    setLaunchpadDraft('')
    setLaunchpadCaret(0)
    if (text === '') return
    void appendHistory(text)
    const parsed = text.startsWith('/') ? parseCommandName(text) : undefined
    // 第八版：/help 在落地页上也是盖屏浮层（补全面板被 Esc 收掉后直接
    // Enter 的那条路）——不收落地页、不进对话页。聊天页里 /help 的行为
    // 不变（那边不走这个回调）。
    if (parsed !== undefined && parsed.name === 'help' && launchpadOpen) {
      dispatchOverlay({ type: 'open', overlay: { kind: 'help' } })
      return
    }
    // 与 composer 的 tryRunCommand 同一条判定：合并命令表（LOCAL_COMMANDS +
    // channel.commandList 的插件/registry 命令）里有名字才是命令；hidden
    // 命令照旧认。判定之外的 / 开头行才走 submit（与聊天页 Enter 行为一致）。
    if (parsed !== undefined && (
      isLocalCommandName(parsed.name)
      || isHiddenCommandName(parsed.name)
      || channel.commandList.some(entry => entry.name === parsed.name)
    )) {
      void runCommand(parsed.name, parsed.rawInput)
      return
    }
    // 直接发送：与 composer 回车同一条提交路径。发出去之后输入框是空的
    // （内容已作为首轮发出，绝不"既发了又留在框里"），也没有交接提示——
    // 没有草稿要交，一句"已放进输入框"的 toast 反而是假的。
    channel.submit(text)
  }, [channel, launchpadOpen])

  /**
   * The screen's command dispatcher. Every entry point reaches this one
   * closure — PromptInput's `onRunCommand`, the completion menu, this screen's
   * own `/` cases, and the launchpad handoff above. There is deliberately no
   * second dispatcher for the landing page.
   */
  const runCommand = (
    name: string,
    rawInput = '',
    images: readonly ComposerImageRef[] = [],
  ): boolean | Promise<boolean> => {
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
            t('activity-current-preset', { name: channel.activityFrames ?? 'moon8' }),
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
            t('activity-current-direct', { name: current ?? 'moon8' }),
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
        void channel.listEfforts().then(({ efforts, defaultEffort, levelsFallback }) => {
          // 0/1-tier routes were already notified by listEfforts.
          if (efforts.length <= 1) return
          setEffortOptions(efforts)
          setEffortLevelsFallback(levelsFallback === true)
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
        // `/color`（按会话持久化的 accent）：无参打开调色板选择器，
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
        // non-destructive — no second confirmation is required.
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
      case 'compact': {
        // The TUI's own transaction is the primary path: it owns the
        // `tui/compact` decision event, the progress row with live token
        // count, Esc cancellation, and the settle before a session switch
        // (issue #1092) — the official `dsh-command-compact` command has none
        // of that. A composition that mounts no compaction service falls back
        // to the registry command; one with neither says WHY up front instead
        // of looking usable and failing on use (channel/capabilities.ts).
        const compact = channel.capabilities().compact
        if (compact.route === 'local') {
          channel.compact()
          return true
        }
        if (compact.route === 'registry') return runExternalCommand('compact', rawInput, images)
        channel.notify(
          t('capability-unavailable', { name: 'compact', reason: t(compact.reasonKey) }),
          { color: 'warning', timeoutMs: 8000 },
        )
        return true
      }
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
          // Backend model routes accept an unqualified model id.
          const singleProvider = (channel.backendCapabilities as Channel['backendCapabilities'] | undefined)?.modelRoutes === 'backend'
          const provider = slash >= 0 ? spec.slice(0, slash) : singleProvider ? channel.provider : undefined
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
          recentsNow = recordModelUse({ provider: channel.provider, id: channel.model }, undefined, recentsBackend)
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
        // Four separately-labelled facts, never two measures side by side:
        // what THIS request uploaded (the provider's mutually-exclusive prompt
        // buckets, with when it was sampled), what the last turn used (its
        // own ledger, never added into the session counters), what the
        // session has accumulated, and how full the window is (the channel's
        // single occupancy reading — the same number the footer and the
        // context-low warning show).
        const usage = channel.lastUsage
        const lines: string[] = []
        if (usage !== undefined) {
          const upload = usage.input + usage.cacheRead + usage.cacheWrite
          const rate = upload > 0 ? ((usage.cacheRead / upload) * 100).toFixed(1) : '0.0'
          lines.push(`${t('tokens-request-upload', {
            upload: formatTokens(upload),
            input: formatTokens(usage.input),
            read: formatTokens(usage.cacheRead),
            write: formatTokens(usage.cacheWrite),
            rate,
          })} · ${t('usage-sampled-at', { time: formatClock(usage.at) })}`)
        }
        const turn = channel.turnUsage
        if (turn !== undefined) lines.push(`${t('usage-turn-summary')} ${turnUsageParts(turn).join(' · ')}`)
        lines.push(t('tokens-session-breakdown', {
          input: formatTokens(channel.tokens.input),
          output: formatTokens(channel.tokens.output),
          read: formatTokens(channel.tokens.cacheRead),
          write: formatTokens(channel.tokens.cacheWrite),
        }))
        const occupancyLine = contextOccupancyLine(channel)
        if (occupancyLine !== undefined) lines.push(occupancyLine)
        channel.notify(lines.join('\n'))
        return true
      }
      case 'resume':
      /**
       * `/resume`, `/home` and `/agentview` are one screen.
       *
       * They were three implementations of one domain and drifted apart: the
       * same session could be listed by all three, each with its own selection
       * model and its own idea of what opening one does. Keeping the three
       * commands is about muscle memory, not about three surfaces — every one
       * of them lands here, on the same runtime.
       */
      case 'home': {
        setHelpOpen(false)
        // Split-aware, like /trace and /jobs: while the sidebar is rendering
        // and the workspace panel is enabled, the workspace view opens THERE.
        // The panel's own ⤢ goes back to the full-screen home. The panel reads
        // the DSH workspace ledger, though: a backend without that capability
        // (capability snapshots absent on test stubs = DSH) would have its
        // /resume swallowed by an unsupported panel and no history anywhere —
        // those keep the full-screen session supervisor.
        const capabilities = channel.backendCapabilities as Channel['backendCapabilities'] | undefined
        const controller = sidePanelRef.current
        if (
          (capabilities === undefined || capabilities.commands.includes('workspace'))
          && controller !== null && controller.split && controller.enabledPanelIds.includes('workspace')
        ) {
          controller.openPanel('workspace', { focus: true })
          return true
        }
        agentViewOpenSessionRef.current = channel.agentId
        setSupervisorOpen(true)
        return true
      }
      case 'agentview': {
        setHelpOpen(false)
        // The screen opens immediately and loads its own list. Waiting for the
        // listing here would make it feel slower the more history a project
        // has, which is exactly backwards.
        agentViewOpenSessionRef.current = channel.agentId
        setSupervisorOpen(true)
        return true
      }
      case 'bg':
      case 'background': {
        // `/background`: the attached session moves to the background
        // (it keeps running in this process), the terminal lands on a fresh
        // session, and the supervisor opens on top.
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
        // Same picker as PromptInput's double-Esc on an empty input;
        // `openRewind` notifies when there is nothing to rewind.
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
        const lines: string[] = [
          `${t('status-model', { model: channel.model })}${channel.reasoningEffort ? ` · ${capitalize(channel.reasoningEffort)} effort` : ''}`,
          `${t('status-state', { state: channel.working ? t('status-working') : t('status-idle') })}`,
          `${t('status-session', { id: channel.agentId })}`,
          `${t('status-dir', { cwd: channel.displayCwd })}${channel.gitBranch ? ` · ${channel.gitBranch}` : ''}`,
          t('tokens-session-total', {
            input: formatTokens(channel.tokens.input),
            output: formatTokens(channel.tokens.output),
          }),
        ]
        if (usage !== undefined) {
          const total = usage.input + usage.cacheRead + usage.cacheWrite
          const rate = total > 0 ? ((usage.cacheRead / total) * 100).toFixed(1) : '0.0'
          lines.push(`${t('cost-cache-rate', { rate, read: formatTokens(usage.cacheRead), write: formatTokens(usage.cacheWrite) })} · ${t('usage-sampled-at', { time: formatClock(usage.at) })}`)
        }
        // The last turn gets its own labelled line so it never reads as part
        // of the session totals.
        const turn = channel.turnUsage
        if (turn !== undefined) lines.push(`${t('usage-turn-summary')} ${turnUsageParts(turn).join(' · ')}`)
        const occupancyLine = contextOccupancyLine(channel)
        if (occupancyLine !== undefined) lines.push(occupancyLine)
        if (channel.sessionTitle) lines.push(t('status-title', { title: channel.sessionTitle }))
        setHelpOpen(false)
        channel.pushLocal('/status', lines)
        return true
      }
      case 'cost': {
        const usage = channel.lastUsage
        const lines = [
          t('tokens-session-total', {
            input: formatTokens(channel.tokens.input),
            output: formatTokens(channel.tokens.output),
          }),
        ]
        if (usage !== undefined) {
          const total = usage.input + usage.cacheRead + usage.cacheWrite
          const rate = total > 0 ? ((usage.cacheRead / total) * 100).toFixed(1) : '0.0'
          lines.push(t('cost-cache-hit-rate', { rate, read: formatTokens(usage.cacheRead), write: formatTokens(usage.cacheWrite) }))
        }
        // A backend that reports its own session cost (Claude) states the
        // bill itself; the DeepSeek estimate below would only be noise.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- partial embedder channels omit the report
        const report = channel.costReport
        if (report !== undefined) {
          lines.push(`${formatCostReport(report)} · ${t(report.source === 'backend' ? 'cost-source-backend' : 'status-cost-note')}`)
          setHelpOpen(false)
          channel.pushLocal('/cost', lines)
          return true
        }
        // 金额与拆解：主会话按模型分桶 + 子代理按各自 (provider, model) 分桶；
        // 全部未计价时只报 token 并标注未计价，不显示 ¥0.00 金额行（DESIGN D4/D6）。
        const estimate = estimateSessionCostSnapshotCny({
          provider: channel.provider,
          main: channel.mainCost,
          subagents: channel.subagentCost,
          fallbackTokens: channel.tokens,
          fallbackModel: channel.model,
        })
        // 金额行与末尾口径共用同一判定：有已计价金额才显示金额行与"估算非账单"
        // 文案；无金额（无用量 / 全部未计价）只解释 token（#1089）。
        const hasAmount = estimate !== undefined && estimate.total > 0
        if (estimate !== undefined) {
          if (hasAmount) {
            lines.push(t('cost-session-estimate', { cost: estimate.total.toFixed(2) }))
            lines.push(`${t('cost-split-main', { cost: estimate.main.toFixed(2) })} · ${t('cost-split-subagent', { cost: estimate.subagent.toFixed(2) })}`)
          }
          if (estimate.unpricedTokens > 0) {
            lines.push(t('cost-unpriced', { tokens: formatTokens(estimate.unpricedTokens) }))
          }
        }
        lines.push(t(hasAmount ? 'cost-note' : 'cost-note-no-amount'))
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
      case 'continue': {
        // 落地页第四版的 Continue（最高频动作）：继续**最近一条可继续会话**。
        // 数据是真的——`agentViewRows`（含持久化名册，listing 落地后含全部历史）
        // 里挑 updatedAt 最新的非当前行；没有可继续的就去会话名册挑，失败也不
        // 静默（notify + 打开 supervisor 让用户自己挑），绝不点了个没反应。
        setHelpOpen(false)
        const candidates = agentViewRows.filter(row =>
          !row.current && row.id !== channel.agentId && row.title.trim() !== '')
        const latest = candidates.reduce<(typeof candidates)[number] | undefined>(
          (acc, row) => (acc === undefined || row.updatedAt > acc.updatedAt ? row : acc), undefined)
        if (latest === undefined) {
          channel.notify(t('launchpad-continue-none'), { color: 'error', timeoutMs: 6000 })
          agentViewOpenSessionRef.current = channel.agentId
          // 第七版：无可继续会话时浏览器盖在落地页之上（不收落地页）——Esc
          // 回启动页，与合并入口「会话与工作区」同一条姿态。
          setSupervisorOpen(true)
          return true
        }
        setLaunchpadOpen(false)
        void channel.resumeTo(latest.id)
          .then((result) => {
            if (!result.ok) {
              channel.notify(t('launchpad-continue-failed'), { color: 'error', timeoutMs: 8000 })
              agentViewOpenSessionRef.current = channel.agentId
              setSupervisorOpen(true)
              return
            }
            channel.notify(t('resume-resumed'))
            suppressLogoIntroRef.current = true
            setAgentViewReturnId(undefined)
            repaintTranscript()
          })
          .catch(() => {
            channel.notify(t('launchpad-continue-failed'), { color: 'error', timeoutMs: 8000 })
          })
        return true
      }
      case 'setup': {
        // `/setup` re-runs the first-run guide. Unlike the boot path this is
        // an EXPLICIT request, so it opens unconditionally — a user who typed
        // it has already decided the wizard is what they want. It reuses the
        // same screen and the same `onClose`, so completing it here also
        // (re)writes the one-shot marker.
        // 第七版：向导的 early-return 在落地页**之前**，天然盖在落地页之上；
        // 不再收掉落地页——Esc/跳过/完成都回到启动页（旧姿态收掉落地页后，
        // 向导关掉就落到对话页，正是用户报的 bug 形态之一）。
        setHelpOpen(false)
        setOnboardingOpen(true)
        return true
      }
      case 'star': {
        // 一键 star：**只有用户主动敲 /star 才会跑**（绝不自动）。动作用
        // runStarAction（与开屏弹窗共用），异步执行、结果用 notify 报。
        setHelpOpen(false)
        runStarAction()
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
      case 'migrate': {
        // Double entry points with the CLI. BARE `/migrate` opens the
        // multi-select picker; `/migrate <agent>` opens the CONFIRMATION
        // layer for that single source (PRD #2 — a bulk import is never one
        // keystroke away). Validity is decided against the adapter REGISTRY,
        // never the picker's row cache: on a fresh mount that cache is empty,
        // and deriving the answer from it made every `/migrate <agent>` report
        // an unknown source until the picker had been opened once.
        setHelpOpen(false)
        const command = resolveMigrateCommand(rawInput, MIGRATION_ADAPTERS.map(adapter => adapter.id))
        if (command.kind === 'unknown') {
          channel.notify(t('migrate-unknown-agent', { agent: command.agentId }), { color: 'error', timeoutMs: 8000 })
          return true
        }
        if (command.kind === 'usage') {
          channel.notify(t('migrate-usage'), { color: 'error', timeoutMs: 8000 })
          return true
        }
        if (command.kind === 'dry-run-needs-source') {
          channel.notify(t('migrate-dry-run-needs-source'), { color: 'error', timeoutMs: 8000 })
          return true
        }
        if (command.kind === 'import') {
          void (async () => {
            // Rows carry the scannable count the confirmation line shows; a
            // warm cache from an earlier picker visit is reused as is.
            const rows = migrateRows ?? await collectMigrateRows()
            const row = rows.find(candidate => candidate.agentId === command.agentId)
            if (row === undefined) {
              channel.notify(t('migrate-unknown-agent', { agent: command.agentId }), { color: 'error', timeoutMs: 8000 })
              return
            }
            if (command.dryRun) {
              spawnMigrateSources([row], true)
              return
            }
            setMigratePending([row])
            // Pin the checked set to the source this confirmation is about:
            // Esc returns to the picker, and a stale set from an earlier visit
            // would there contradict what the confirmation just showed.
            setMigrateChecked(new Set([row.agentId]))
            dispatchOverlay({ type: 'open', overlay: { kind: 'migrate-confirm' } })
          })()
          return true
        }
        // Bare `/migrate` starts a NEW flow: drop the previous run's checks
        // (only Esc-out-of-confirm keeps them) and let the picker show its
        // scanning state until the rows land.
        setMigrateRows(null)
        setMigrateChecked(new Set())
        dispatchOverlay({ type: 'open', overlay: { kind: 'migrate', index: 0 } })
        void collectMigrateRows().then(setMigrateRows)
        return true
      }
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
      case 'jobs': {
        setHelpOpen(false)
        // Split mode routes to the side panel; narrow terminals keep the
        // full-screen overlay.
        if (sidePanel.split && sidePanel.enabledPanelIds.includes('jobs')) {
          sidePanel.openPanel('jobs', { focus: true })
        } else {
          setJobsPanelFocusId(null)
          setJobsPanelOpen(true)
        }
        return true
      }
      case 'panel': {
        setHelpOpen(false)
        // 无参 → 面板选择器（overlay 互斥结构内）；有参 → 侧栏命令分发。
        if (rawInput.trim() === '' && sidePanel.splitAvailable && panelPickerRows.length > 0) {
          const current = panelPickerRows.findIndex(row => row.id === sidePanel.activePanelId)
          dispatchOverlay({ type: 'open', overlay: { kind: 'panel', index: Math.max(0, current) } })
          return true
        }
        if (sidePanel.command(rawInput)) return true
        // 分栏不可用（窄屏 / inline / 编辑器展开 / splitEnabled=false）
        // 或参数未知时的整屏回退与兜底：已知面板走整屏形态，其余消费
        // 掉并提示——绝不原样返回 false，否则 PromptInput 会把
        // "/panel …" 当普通消息发给模型。
        const arg = rawInput.trim().toLowerCase()
        const target = arg === '' || arg === 'focus' || arg === 'toggle' || arg === 'zoom'
          ? sidePanel.activePanelId
          : arg
        if (target === 'jobs') {
          setJobsPanelFocusId(null)
          setJobsPanelOpen(true)
          return true
        }
        if (target === 'agents') {
          setSubagentDashboardOpen(true)
          return true
        }
        if (arg === 'toggle' || arg === 'focus' || arg === 'zoom' || arg === '' || target !== undefined) {
          channel.notify(t('panel-unavailable-hint'))
          return true
        }
        return false
      }
      case 'agents':
        setHelpOpen(false)
        void channel.listSubagents().then((lines) => {
          channel.pushLocal('/agents', lines)
        })
        return true
      case 'login': {
        setHelpOpen(false)
        if (runBackendLogin()) return true
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
                        ? row.expiresAt === undefined
                          ? t('login-oauth-in-no-expiry')
                          : t('login-oauth-in', { time: new Date(row.expiresAt).toISOString() })
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
        // The command itself is registered by the permission-presets row
        // (dsh-base): bare `/permission` opens the preset picker and Enter
        // dispatches `/permission <preset>`; `/permission status` prints the
        // policy explainer; other arguments pass through verbatim.
        // The row may be mounted as a service without its command ever
        // reaching this agent's registry (composition-dependent) — when the
        // service snapshot is usable the TUI still owns the entry and
        // switches through the service write path (never the model).
        const mounted = channel.commandList.some(command => command.external && command.name === 'permission')
        let serviceUsable = false
        try {
          serviceUsable = channel.permissionPresets().availability === 'runtime'
        } catch {
          serviceUsable = false
        }
        const reachable = mounted || serviceUsable
        const parts = rawInput.trim().split(/\s+/).filter(Boolean)
        if (reachable && parts[0] === 'status') {
          setHelpOpen(false)
          const snapshot = channel.permissionPresets()
          if (snapshot.options.some(option => option.value === 'status')) {
            return runPermissionCommand(rawInput, images)
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
        if (reachable && parts.length === 0) {
          setHelpOpen(false)
          const snapshot = channel.permissionPresets()
          if (snapshot.availability === 'unavailable' || snapshot.options.length === 0) {
            return runPermissionCommand(rawInput, images)
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
        if (reachable) {
          setHelpOpen(false)
          return runPermissionCommand(rawInput, images)
        }
        const native = backendPermissionCommand(channel.backendModes?.()?.snapshot(), rawInput, modeDisplayName(channel.mode))
        if (native === undefined) return false
        if (native.kind === 'unknown') {
          channel.notify(t('permission-mode-unknown', { id: native.id }), { color: 'error' })
          return true
        }
        setHelpOpen(false)
        if (native.kind === 'status') channel.pushLocal('/permission', native.lines)
        else if (native.kind === 'picker') dispatchOverlay({ type: 'open', overlay: native.overlay })
        else void runBackendModeCommand(native.mode.id, native.mode.name)
        return true
      }
      case 'plan': {
        // Registered by dsh-plan-mode: bare `/plan` opens an on/off picker
        // marked with the current state instead of toggling blindly; Enter
        // dispatches `/plan` or `/plan off`. Arguments pass through verbatim
        // (`/plan off`). Availability comes from the shared capability facts
        // (the same read Shift+Tab uses), not from a second command-list
        // scan; with no registry command the line falls through to the model,
        // exactly as before.
        const plan = channel.capabilities().plan
        const mounted = plan.route !== 'none'
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
          return runExternalCommand('plan', rawInput, images)
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
      case 'mcp': {
        setHelpOpen(false)
        const control = channel.backendMcp?.()
        const request = parseMcpCommand(rawInput)
        if (control !== undefined && request.kind !== 'status') {
          if (request.kind === 'usage') channel.notify(t('mcp-control-usage'), { color: 'warning' })
          else if (request.kind === 'reconnect') void control.reconnect(request.name)
          else void control.toggle(request.name, request.enabled)
          return true
        }
        channel.pushLocal('/mcp', channel.mcpStatus())
        return true
      }
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
          .find(entry => entry.ns === channel.settingsNamespace)
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
      case 'channel': {
        // 渠道选择器。/channel 只在声明了 channels 能力的内核下进命令表，
        // 能走到这里就说明可用。与 /kernel 一样，再执行一次就收起。
        setHelpOpen(false)
        if (overlay.kind === 'channel') dispatchOverlay({ type: 'close' })
        else openChannelPicker()
        return true
      }
      case 'kernel':
        // 内核选择器，每个内核下都可用（在对话页里切回 DSH 只有这一条路）。
        // 确认后由组合根的 onSwitchBackend 记住选择并以新内核重启。与 /help、
        // 参数行一致：选择器已开着就收起，没开才打开。
        setHelpOpen(false)
        if (overlay.kind === 'kernel') dispatchOverlay({ type: 'close' })
        else openKernelPicker()
        return true
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
        // `/vim`：切换输入框的 vim 编辑开关。状态在
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
          t('terminal-paste-hint', { keys: effectiveComboDisplay('paste') }),
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
        }).catch(error => {
          if (controller.signal.aborted) return
          setRecap(prev => prev ? { ...prev, error: error instanceof Error ? error.message : String(error), done: true } : prev)
        })
        return true
      }
      case 'btw': {
        // `/btw`：单轮无工具侧问，线程只在内存里（btwThreads，按会话
        // 隔离），不打断主回合、不写会话历史。空参数只提示用法。启用了
        // btw 面板就进面板线程（有模态界面时不抢开，只标未读）；没启用
        // 就用浮层。同一个问答只出现在一处。
        setHelpOpen(false)
        const question = rawInput.trim()
        if (!question) {
          channel.notify(t('btw-usage'), { timeoutMs: 3000 })
          return true
        }
        const btwResult = btwThreads.submit(String(channel.agentId), question, (q, options) => channel.sideQuestion(q, options), { recentTurnsLimit: getBtwContextTurns(), contextBudget: getBtwContextBudget() })
        if (!btwResult.ok) {
          channel.notify(t('btw-thread-busy'), { color: 'warning', timeoutMs: 3000 })
          return true
        }
        if (sidePanel.enabledPanelIds.includes('btw')) {
          if (btwSurfaceFree()) sidePanel.openPanel('btw')
        } else {
          setBtwOverlayOpen(true)
        }
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
          return runExternalCommand(name, rawInput, images)
        }
        return false
      }
    }
  }

  // === Message-selection mode (Shift+↑ message actions) ===
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

  // Double-Esc rewind: the user's own messages, newest first (the list shows
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
    if ((channel.backendCapabilities as Channel['backendCapabilities'] | undefined)?.rewind === false) {
      channel.notify(t('capability-unavailable-backend', { name: 'rewind' }), { color: 'warning', timeoutMs: 4000 })
      return
    }
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
      // The restored message belongs to the binding `rewindTo` just created,
      // not to the one it replaced: it is the user's choice, and the switch
      // effect must not treat it as the old conversation's leftovers.
      pendingFillRef.current = String(channel.agentId)
      // Put the restored message back in the prompt for re-editing.
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
  // 侧栏控制器：几何（chatColumns/panelColumns）、焦点与键盘分发都在
  // 这个 hook 里（设计文档 §16.5——Chat 只多一次调用、一处键盘让位、
  // 一条 runCommand case）。编辑器展开时几何强制 collapsed。
  const sidePanel = useSidePanel({
    columns: terminalColumns,
    fullscreen,
    editorOpen: promptEditorOpen,
  })
  /**
   * 「全屏」出口（PanelBar 的 ⤢）：把侧栏里那个面板的内容切到它原本的整屏
   * 形态。只映射**真的有整屏对应物**的面板 id（能力位 capabilities.fullscreen
   * 决定按钮画不画，这里决定点了去哪）；没映射到的 id 静默无操作——按钮与
   * 落地页、键盘入口共用同一个状态位，所以从整屏返回时侧栏还在原处。
   */
  const openPanelFullscreen = React.useCallback((panelId: string): void => {
    if (panelId === 'jobs') {
      sidePanelRef.current?.focusChat()
      setJobsPanelOpen(true)
      return
    }
    if (panelId === 'agents') {
      sidePanelRef.current?.focusChat()
      setSubagentDashboardOpen(true)
      return
    }
    if (panelId === 'trajectory') {
      sidePanelRef.current?.focusChat()
      // 强制整屏：默认的 openScene 在分屏下会路由回面板（见它的注释）。
      openScene({ fullscreen: true })
      return
    }
    if (panelId === 'workspace') {
      sidePanelRef.current?.focusChat()
      setSupervisorOpen(true)
      return
    }
    if (panelId === 'btw') {
      // ⤢ 进整屏线程场景：Esc 返回侧栏，不清 thread/draft（面板
      // mountPolicy=enabled 保挂载，路由/焦点/滚动原样恢复）。
      sidePanelRef.current?.focusChat()
      setBtwSceneOpen(true)
    }
  }, [openScene])
  // openJobsPanel（在上方、identity 稳定）经 ref 读取最新控制器。
  sidePanelRef.current = sidePanel
  /**
   * 宠物「代言」判定：分屏开着且 companion 是活动面板时，新通知由宠物头顶
   * 气泡说出，输入框上方的 toast 不再重复同一条。error 色恒不压制（可能
   * 要行动）。渲染期读控制器状态——与气泡同一提交，无先闪后消的竞态。
   */
  const petSaysNotices = React.useCallback(
    (item: Channel['notifications'][number]): boolean =>
      item.color !== 'error' && sidePanel.split && sidePanel.activePanelId === 'companion',
    [sidePanel.split, sidePanel.activePanelId],
  )
  // 聊天列宽：收起时 = 内容区全宽（与现状逐字节一致），分栏时 = 左栏宽。
  // 所有显式下传的宽度（gutter / 图片预览区 / wake 条）都改用它；转录
  // 子树则经 SidePanelLayout 的 TerminalSizeContext 覆盖自动拿到。
  const chatColumns = sidePanel.chatColumns
  const wakeWidth = miniWakeWidth(chatColumns)
  const panelPickerRows = usePanelPickerRows(sidePanel)
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
  // current match row in view as the query changes.
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
  const couponVisible = coupon !== null && starModal === null
    && approvalSnapshot === null && dialogSnapshot === null && questionSnapshot === null
    && overlay.kind === 'none' && !btwOverlayOpen && recap === null
    && !supervisorOpen && !treeOpen && !settingsOpen && !jobsPanelOpen
    && !sceneOpen && !subagentDashboardOpen && subagentDetailId === null
    && !btwSceneOpen
  const markCouponShown = React.useCallback((orderId: Parameters<WhaleCouponStore['shown']>[0]) => {
    bonusNotices?.shown(orderId)
  }, [bonusNotices])
  const closeCoupon = React.useCallback(() => {
    if (coupon !== null) bonusNotices?.dismiss(coupon.orderId)
  }, [bonusNotices, coupon])

  useInput((input, key, event) => {
    // 开屏"求 star"弹窗开着时键盘全归它（↑/↓/Enter/Esc 由它自己的
    // useInput 处理），滚轮也不许滚动它身后的转录——和下面的整屏界面
    // 同一套让位规则。
    if (starModal !== null || couponVisible) return
    // Prompt-slot panels own the keyboard while visible. Their own useInput
    // handles the relevant keys; Chat registered first, so yielding here
    // still lets the panel receive them. PromptInput now stays mounted but
    // suspended to preserve async command drafts, making this guard also
    // essential for Ctrl+C: it must never clear the hidden composer.
    if (
      btwOverlayOpen
      || overlay.kind === 'tips'
      || (recap !== null && (!recap.auto || recap.expanded))
    ) return
    // The first-run guide owns the whole terminal while it is up: it is a
    // wizard with its own step navigation, its own focus ring inside the
    // pickers it borrows, and no free-text input at all. Registered ABOVE the
    // launchpad because it renders above it.
    if (onboardingOpen) return
    // The launchpad owns the whole terminal while it is up — including the
    // plain letters that would otherwise reach the composer, which is exactly
    // the point: it IS the composer on this screen, and its draft is submitted
    // directly (see closeLaunchpad). ONE exception (fifth revision): a picker
    // opened from the param row renders ABOVE the launchpad and therefore owns
    // the keyboard — fall through to the overlay branches below (Esc closes the
    // picker back onto the launchpad). The launchpad's own useInput is paused
    // via inputPaused for exactly this window, so keys the picker does not
    // consume cannot leak into the draft.
    if (launchpadShown && !launchpadOverlayUp) return
    // The session tree owns the whole terminal while it is up: plain letters
    // drive its search, clicks and Enter drive its action menu.
    if (treeOpen) return
    // The session supervisor owns the whole terminal while it is up: its rail
    // and session list bind ↑/↓/Enter/Tab/Esc, its filter box takes the plain
    // letters that would otherwise reach the prompt, and the directory picker
    // and menus it opens are its own modal layers.
    if (supervisorOpen) return
    // Same for the settings screen: plain letters (s save / d discard) and
    // the field draft editor belong to it alone.
    if (settingsOpen) return
    // Subagent dashboard or detail scene: it owns the keyboard while open.
    if (subagentDashboardOpen || subagentDetailId !== null) return
    // The main-screen Agent View owns the whole terminal while open (its
    // composer, scrolling and Esc layering live in the scene).
    if (agentView !== null) return
    // The `/jobs` panel replaces the conversation too, so it owns Esc (close)
    // and k (kill) while open. Unguarded, Esc meant to CLOSE the panel also
    // reached the chat:cancel branch below whenever a turn was in flight —
    // dismissing the panel and killing the turn with one key.
    if (jobsPanelOpen) return
    // The ⤢ btw thread scene owns the keyboard the same way: Esc there
    // returns to the sidebar (never the chat:cancel branch below).
    if (btwSceneOpen) return
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
      // 焦点在右栏时滚轮不回落到转录：落在面板矩形上的滚轮已由命中
      // 测试路由给面板自己的 ScrollBox，到达这里的兜底事件不应在
      // 用户操作右栏时误滚左栏。
      if (helpOpen || sidePanel.focus === 'panel') return
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
    // PgUp/PgDn page the transcript a full viewport at a time — the keyboard
    // counterpart of the wheel branch above. Without it, a fullscreen session
    // has no keyboard route to scrollback at all: the alt screen holds no
    // native scrollback (see MessageList's historyPaint gate), so a mouse-less
    // user cannot reach an earlier turn.
    //
    // Fullscreen only, on purpose. Inline mode paints committed history onto
    // the main screen, so the terminal's OWN scrollback owns these keys there;
    // claiming them would break paging that already works, exactly like the
    // wheel branch above is a no-op inline.
    //
    // Routing mirrors the wheel branch: help stays yielded (PromptInput pages
    // its help viewport with the same keys) and open pickers/dialogs are modal,
    // so the transcript behind them must not move. Every guard above (session
    // tree, settings, scenes, dashboards) already claimed the keyboard — those
    // surfaces page their own lists with these keys.
    //
    // The question/approval/dialog panels deliberately do NOT yield: like the
    // wheel branch above (whose comment spells this out), those panels mount
    // BELOW the transcript — replacing the prompt, not covering it — so the
    // transcript above them stays visible and scrollable while a decision is
    // pending. The panels bind ↑/↓/Space/Tab/Enter/Esc and never these keys,
    // so paging cannot steal anything from them.
    if ((key.pageUp || key.pageDown) && fullscreen) {
      // 焦点在右栏时 PgUp/PgDn 属于活动面板（经侧栏键盘分发）。
      if (helpOpen || sidePanel.focus === 'panel') return
      const overlayModal =
        overlay.kind !== 'none' &&
        (overlay.kind !== 'workspace-picker' || workspaceTargets.length > 0)
      if (overlayModal) return
      // One less than the viewport keeps a row of context so a page never
      // reads as a blank jump; a not-yet-measured handle falls back to a
      // fixed page rather than paging by 0 (a dead key). The final page
      // overshoots and the renderer clamps it exactly onto maxScroll, whose
      // positional at-bottom restore re-pins sticky (the #421/#422 wheel
      // contract) — so paging back home clears the new-messages pill too.
      const viewport = handle?.getViewportHeight() ?? 0
      const page = viewport > 1 ? viewport - 1 : 12
      handle?.scrollBy(key.pageUp ? -page : page)
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
    // ↑/↓/Space/Tab/Enter/Esc; the prompt input is suspended, so nothing
    // else should see these keys).
    if (approvalSnapshot !== null || dialogSnapshot !== null) return
    if (questionSnapshot !== null) {
      // Only transcript navigation belongs here. The mounted questionnaire
      // owns fold/expand keys, including when it interrupts another screen.
      if (questionMinimized && !isSticky && (isPlainReturnInput(input, key) || key.end)) {
        handle?.scrollToBottom()
        event.stopImmediatePropagation()
      }
      return
    }
    // 侧栏键盘分发（v2.1 优先级）：上面的审批 / 问卷 / 对话框守卫仍然
    // 最先，其次是侧栏全局快捷键（Ctrl+B / Alt+Z，两种焦点都生效），
    // 然后焦点在右栏时一切按键归侧栏——活动面板的业务键优先，宿主
    // 回退键（←/→ 切面板、z、+/-、Esc 回聊天）兜底。
    if (sidePanel.handleKey(input, key, event)) return
    const returnCandidate = isPlainReturnInput(input, key)
    const returnNow = Date.now()
    const plainReturn = returnCandidate && returnNow - lastModalEnterAtRef.current >= 80
    if (plainReturn) lastModalEnterAtRef.current = returnNow
    if (overlay.kind === 'image-preview') {
      // Modal gallery owns plain left/right. Caret peeks below still leave
      // navigation with PromptInput. Esc/Ctrl+C/Enter keep their close semantics.
      if (key.escape || (key.ctrl && input === 'c') || plainReturn) {
        dispatchOverlay({ type: 'close' })
      } else if (!key.ctrl && !key.meta && !key.shift && (key.leftArrow || key.rightArrow)) {
        dispatchOverlay({ type: 'image-step', delta: key.leftArrow ? -1 : 1 })
      }
      event.stopImmediatePropagation()
      return
    }
    if (peekPreview !== null && key.escape) {
      // Caret-driven preview: Esc dismisses it until the caret leaves the
      // token (PromptInput's own Esc arm normally gets there first; this is
      // the fallback when the prompt is not listening). Every other key
      // stays with the prompt, so the caret keeps moving (and the card
      // follows it) while the preview is up.
      dismissPeek()
      event.stopImmediatePropagation()
      return
    }
    // Esc clears a settled mouse selection before the ordinary chat meanings
    // below, but never before a top-level modal. Otherwise a preview opened
    // over selected transcript text needed two Esc presses to close.
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
        // Enter commits; 0-match junk queries don't persist.
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
    // The query persists across bar open/close so n/N keep working.
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
    if (overlay.kind === 'help') {
      // 帮助盖屏（第八版）：Esc/Ctrl+C/Enter 收起回落地页；纵向导航归这个
      // 视口（与 PromptInput 的 helpOpen 分支同一套键位），其余按键模态吞掉
      // ——绝不漏进落地页草稿。
      const page = Math.max(1, helpCoverViewportHeight - 2)
      if (key.upArrow || key.wheelUp) {
        helpCoverScrollRef.current?.scrollBy(key.wheelUp ? -3 : -1)
      } else if (key.downArrow || key.wheelDown) {
        helpCoverScrollRef.current?.scrollBy(key.wheelDown ? 3 : 1)
      } else if (key.pageUp || key.pageDown) {
        helpCoverScrollRef.current?.scrollBy(key.pageUp ? -page : page)
      } else if (key.home) {
        helpCoverScrollRef.current?.scrollTo(0)
      } else if (key.end) {
        helpCoverScrollRef.current?.scrollTo(Number.MAX_SAFE_INTEGER)
      } else if (key.escape || (key.ctrl && (input === 'c' || input === 'd')) || plainReturn) {
        dispatchOverlay({ type: 'close' })
      }
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
    // Armed migration hint (PRD #4): bare Enter while the hint notification
    // is up — no overlay and an EMPTY prompt — jumps into the picker with the
    // hinted source pre-checked; every other key disarms silently. The empty
    // check is explicit because the composer owns that state: an Enter that
    // submitted a written message must not also open the picker, and this
    // listener runs before PromptInput's, so the event is consumed here too.
    if (migrateHintAgent !== null && overlay.kind === 'none') {
      if (plainReturn && !(promptControllerRef.current?.hasText() ?? false)) {
        const agent = migrateHintAgent
        event.stopImmediatePropagation()
        setMigrateHintAgent(null)
        setMigrateRows(null)
        setMigrateChecked(new Set([agent]))
        dispatchOverlay({ type: 'open', overlay: { kind: 'migrate', index: 0 } })
        void collectMigrateRows().then(setMigrateRows)
        return
      }
      setMigrateHintAgent(null)
    }
    if (overlay.kind === 'migrate') {
      const rows = migrateRows ?? []
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: rows.length })
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      } else if (rows.length > 0) {
        const row = rows[overlay.index]
        if (input === ' ' && row !== undefined) {
          setMigrateChecked(current => {
            const next = new Set(current)
            if (next.has(row.agentId)) next.delete(row.agentId)
            else next.add(row.agentId)
            return next
          })
        } else if (input === 'a' && !key.ctrl && !key.meta) {
          // All/none toggle: a checked-everything state collapses to none.
          setMigrateChecked(current =>
            current.size >= rows.length ? new Set() : new Set(rows.map(candidate => candidate.agentId)))
        } else if (plainReturn) {
          // Checked set wins; the focused row acts as a single selection
          // when nothing is checked (PRD #1).
          const chosen = migrateChecked.size > 0
            ? rows.filter(candidate => migrateChecked.has(candidate.agentId))
            : row !== undefined ? [row] : []
          if (chosen.length > 0) {
            setMigratePending(chosen)
            dispatchOverlay({ type: 'close' })
            dispatchOverlay({ type: 'open', overlay: { kind: 'migrate-confirm' } })
          }
        }
      }
      return
    }
    if (overlay.kind === 'migrate-confirm') {
      if (key.escape) {
        // Back to the picker with the checked set preserved (PRD #2's
        // "cancel" reads cheapest as "let me change the selection").
        dispatchOverlay({ type: 'close' })
        dispatchOverlay({ type: 'open', overlay: { kind: 'migrate', index: 0 } })
      } else if (plainReturn) {
        dispatchOverlay({ type: 'close' })
        spawnMigrateSources(migratePending, false)
      } else if (input === 'd' && !key.ctrl && !key.meta) {
        dispatchOverlay({ type: 'close' })
        spawnMigrateSources(migratePending, true)
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
        if (option !== undefined) void runPermissionCommand(` ${option.value}`)
      } else if (key.escape) {
        permissionOverlayFocusRef.current = null
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'mode') {
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: overlay.modes.length })
      } else if (plainReturn) {
        const option = overlay.modes[overlay.index]
        dispatchOverlay({ type: 'close' })
        if (option !== undefined) void runBackendModeCommand(option.id, option.name)
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'kernel') {
      // 名册不冻在 overlay 里（kernelOptions 是渲染期派生值）：探测落地后
      // 选择器自己就刷新成完整目录，不需要重开。
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: kernelOptions.length })
      } else if (plainReturn) {
        pickKernel(overlay.index)
      } else if (key.escape) {
        dispatchOverlay({ type: 'close' })
      }
      return
    }
    if (overlay.kind === 'sdk-install') {
      // 向导按键按步骤态分派；checking/running 期间除 Esc（取消安装）外
      // 全部吞掉——异步落地只发生在面板还在的窗口内（见 sdkPhase 注释）。
      if (sdkPhase.kind === 'confirm') {
        if (plainReturn) confirmSdkInstall(sdkPhase.dir)
        else if (key.escape) closeSdkInstallToKernelPicker()
      } else if (sdkPhase.kind === 'checking') {
        // 亚秒级预检，无键可按。
      } else if (sdkPhase.kind === 'running') {
        if (key.escape) sdkInstallerRef.current?.cancel()
      } else if (sdkPhase.kind === 'done') {
        if (plainReturn) closeSdkInstallToKernelPicker()
        else if (key.escape) closeSdkInstall()
      } else if (sdkPhase.kind === 'failed' || sdkPhase.kind === 'store-mismatch') {
        // 两种失败都留着 r 重试：store 漂移常常是重装一次就好了。
        if (input === 'r' && !key.ctrl && !key.meta) confirmSdkInstall(sdkPhase.dir)
        else if (key.escape) closeSdkInstallToKernelPicker()
      } else {
        // pnpm-missing / cancelled / no-target：Esc 回内核选择器。
        if (key.escape) closeSdkInstallToKernelPicker()
      }
      return
    }
    if (overlay.kind === 'channel') {
      // 名册不冻在 overlay 里（channelRows 是渲染期派生值）：切换/导入后
      // 选择器自己就刷新成新状态，不需要重开。
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: channelRows.length })
      } else if (plainReturn) {
        pickChannel(overlay.index)
      } else if (key.escape) {
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
        void runExternalCommand('plan', on ? '' : ' off')
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
    if (overlay.kind === 'panel') {
      if (key.upArrow || key.downArrow) {
        dispatchOverlay({ type: 'move', delta: key.upArrow ? -1 : 1, count: panelPickerRows.length })
      } else if (plainReturn) {
        const row = panelPickerRows[overlay.index]
        dispatchOverlay({ type: 'close' })
        if (row !== undefined) sidePanel.openPanel(row.id, { focus: true })
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
        // History search cancels on ctrl+c/ctrl+d too.
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
        // History search next — ↓ and the history key (default Ctrl+R)
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
      // The subagent dashboard key (default Ctrl+A) opens the dashboard —
      // split mode routes it to the agents side panel instead. Consume the
      // key: without the stop the prompt editor's readline binding ALSO
      // fires (Ctrl+A moves the caret to line start), so one press both
      // opens the view and jumps the cursor.
      openSubagentDashboard()
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
      setHistoryEntries(loadHistory(channel.cwd))
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
    } else if (key.escape && promptControllerRef.current?.consumeEscape()) {
      // Selection/editor Esc stays with the composer even though Chat's
      // global listener runs first. Consume it before interrupting the turn.
      event.stopImmediatePropagation()
    } else if (key.escape && channel.working && !helpOpen && !promptControllerRef.current?.vimActive()) {
      // Esc interrupts a running turn (the prompt input
      // only sees esc when idle, where it has the double-tap-clear meaning).
      // With messages queued, the queue DOCKS (Claude Code parity): the
      // abort drops the backend copies, the previews park channel-side and
      // the composer's dock hint offers ↑ to edit one / ⏎ to send them all
      // — nothing auto-sends. Already-docked rows dock nothing new; the
      // turn still needs its plain abort.
      // vim mode (either submode) yields: there Esc is a MODE key (INSERT→
      // NORMAL, NORMAL = no-op/cancel pending d) and the prompt owns it;
      // interrupting still works via Ctrl+C / Ctrl+Enter.
      if (channel.pending.length > 0) {
        if (channel.interruptAndDock() === 0) channel.cancel()
      } else {
        channel.cancel()
      }
      event.stopImmediatePropagation()
    } else if (
      key.escape
      && !helpOpen
      && !channel.working
      && channel.compaction?.cancellable === true
      && !promptControllerRef.current?.vimActive()
    ) {
      // Idle Esc otherwise falls through to the prompt's double-tap-clear;
      // while a manual compaction runs, stopping it is what the status row
      // promises (and the host closes the bracket cleanly on abort).
      channel.cancelCompact()
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
      // `/` in transcript mode (Ctrl+O expanded):
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
      // Ctrl+C interrupts a running turn; idle Ctrl+C
      // CLEARS a non-empty prompt (single press) and only arms the
      // double-press exit when the input is empty; ctrl+d keeps the
      // time-based double-press exit regardless.
      if (input === 'c' && !channel.working && channel.compaction?.cancellable === true) {
        // Ctrl+C during a manual compaction stops the compaction instead of
        // arming the double-press exit: exiting the process mid-bracket is how
        // a session log ends up with an unmatched `compaction/start`. Ctrl+D
        // keeps its exit meaning, and the next Ctrl+C behaves normally again.
        channel.cancelCompact()
        exitPendingRef.current = false
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
      } else if (channel.working) {
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
      // Redraw (default Ctrl+L) — clear the physical terminal and
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
    } else if (actionMatches('star', input, key)) {
      // 一键 star（默认 Alt+S）——与 `/star`、开屏标语点击同一个动作。
      // 消费事件：alt 组合不该再落进输入框当普通字符。
      runStarAction()
      event.stopImmediatePropagation()
    } else if (plainReturn && !isSticky) {
      // Enter while scrolled up returns to the bottom: the
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
  }, {
    // Chat's global layer must see every key before the composer and the
    // panels it hosts (the handler's yield guards and readline shadowing
    // both assume it), whether or not they mounted in the same
    // commit — child effects run first, so append order would put a
    // first-mount PromptInput ahead of Chat (#1155).
    prepend: true,
  })

  // Working-activity line (spinner slot): context-pressure prefix shares the
  // StatusLine thresholds (amber ≥ 80, red ≥ 95) and its occupancy source.
  const activityWarnPct = contextPressurePct(channelContextOccupancy(channel))

  // Who owns the spinner slot: with the working-activity line on, that slot
  // draws the user's `/activity` preset, so the compaction row borrows the same
  // indicator instead of answering with the classic dot.
  const activitySlot = channel.activityEnabled && !channel.minimalUi

  // An automatic compaction runs INSIDE the turn, so it rides whichever spinner
  // the slot shows as a badge instead of a second row (the spinner's timer is
  // the turn's, not the compaction's).
  const compactionBadge = channel.compaction === undefined ? undefined : t('compact-badge')

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
      onDecide={(outcome, decision) => approvals.decide(outcome, decision)}
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
      onAnswer={selection => {
        if (!questionStore.stillCurrent(questionSnapshot.key)) return
        questionStore.answerCurrent(selection)
      }}
      onCancel={() => questionStore.cancelCurrent()}
      onEscape={draft => {
        // Esc means "back" once a later question is showing, including when
        // → and Esc share one stdin batch and this panel was mounted for
        // question 1 (no onBack). Ctrl+C stays on onCancel: it cancels the
        // whole ask from any question, so a same-batch → must not swallow it.
        const live = questionStore.getSnapshot()
        if (live?.canGoBack) {
          // A same-batch → already saved this panel's draft on the question
          // it left. Passing that draft into backCurrent would write it onto
          // the question → just opened.
          questionStore.backCurrent(
            questionStore.stillCurrent(questionSnapshot.key) ? draft : undefined,
          )
          return
        }
        if (live !== null && questionStore.stillCurrent(questionSnapshot.key)) {
          questionStore.cancelCurrent()
        }
      }}
      onBack={questionSnapshot.canGoBack
        ? draft => {
            if (!questionStore.stillCurrent(questionSnapshot.key)) return
            questionStore.backCurrent(draft)
          }
        : undefined}
      onForward={questionSnapshot.canGoForward
        ? draft => {
            if (!questionStore.stillCurrent(questionSnapshot.key)) return
            questionStore.forwardCurrent(draft)
          }
        : undefined}
      collapsed={questionMinimized}
      onExpand={() => setMinimizedQuestionKey(null)}
      onToggleFold={() => setMinimizedQuestionKey(previous =>
        previous === questionSnapshot.key ? null : questionSnapshot.key)}
      fullscreen={fullscreen}
    />
  ) : null
  const interruptPanel = approvalPanelNode ?? questionPanelNode
  /**
   * Transient picker panels (pickers/dialogs) - this JSX feeds TWO mount
   * points since the fifth launchpad revision: the chat page OverlayAbove
   * (above the input cluster) and the launchpad itself (above its input
   * card, see the launchpad branch). Defined once so the two never drift.
   */
  const backendModeStatus = modeStatus(channel.backendModes?.()?.snapshot(), () => { void runCommand('permission', '') })
  /**
   * 底栏模型段/思考档位段的点击（与模式段同一契约）：后端声明了模型目录或
   * effort 能力（backendCapabilities 位）才挂，点击 = 既有 /model · /effort
   * 命令（同一批选择器）；无能力不挂点击，hover 也不承诺（StatusLine 的
   * effort hover id 与点击同乘，model hover 只是不追加操作行）。
   */
  const backendCaps = channel.backendCapabilities as Channel['backendCapabilities'] | undefined
  const modelPickerStatus = backendCaps?.models === false
    ? undefined
    : { onOpen: () => { void runCommand('model', '') } }
  const effortPickerStatus = backendCaps?.effort === false
    ? undefined
    : { onOpen: () => { void runCommand('effort', '') } }

  const pickerPanels = (
    <>
          {overlay.kind === 'help' && (
            <Box flexDirection="column" marginBottom={1}>
              <HelpMenu
                commands={channel.commandList}
                viewportHeight={helpCoverViewportHeight}
                viewportWidth={chatColumns}
                scrollRef={helpCoverScrollRef}
                onCommandPick={(name) => {
                  // 点击命令行 = 把 /name 填进落地页草稿（聊天页 Tab 补全的
                  // 鼠标等价），浮层收起、人还在启动页（第八版：不许进对话页）。
                  dispatchOverlay({ type: 'close' })
                  const filled = '/' + name + ' '
                  setLaunchpadDraft(filled)
                  setLaunchpadCaret(filled.length)
                  setLaunchpadFocus(-1)
                }}
              />
            </Box>
          )}
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
          {overlay.kind === 'migrate' && (
            <Box flexDirection="column" marginTop={1}>
              <MigratePicker
                rows={migrateRows ?? []}
                focusIndex={overlay.index}
                checked={migrateChecked}
                loading={migrateRows === null}
                onPick={(index) => {
                  const row = (migrateRows ?? [])[index]
                  if (!row) return
                  setMigrateChecked(current => {
                    const next = new Set(current)
                    if (next.has(row.agentId)) next.delete(row.agentId)
                    else next.add(row.agentId)
                    return next
                  })
                }}
              />
            </Box>
          )}
          {overlay.kind === 'migrate-confirm' && (
            <Box flexDirection="column" marginTop={1}>
              <MigrateConfirm rows={migratePending} />
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
          {overlay.kind === 'panel' && panelPickerRows.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <PanelPicker
                rows={panelPickerRows}
                focusIndex={overlay.index}
                activeId={sidePanel.activePanelId}
                onPick={(index) => {
                  const row = panelPickerRows[index]
                  dispatchOverlay({ type: 'close' })
                  if (row !== undefined) sidePanel.openPanel(row.id, { focus: true })
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
                levelsFallback={effortLevelsFallback}
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
                  if (option !== undefined) void runPermissionCommand(` ${option.value}`)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'mode' && overlay.modes.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <ModePicker
                modes={overlay.modes}
                focusIndex={overlay.index}
                currentId={overlay.currentId}
                onPick={(index) => {
                  if (approvalSnapshot !== null || questionSnapshot !== null || dialogSnapshot !== null) return
                  const option = overlay.modes[index]
                  dispatchOverlay({ type: 'close' })
                  if (option !== undefined) void runBackendModeCommand(option.id, option.name)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'kernel' && (
            <Box flexDirection="column" marginTop={1}>
              <KernelPicker
                options={kernelOptions}
                focusIndex={overlay.index}
                pinned={kernelPinned === true}
                onPick={(index) => {
                  if (approvalSnapshot !== null || questionSnapshot !== null || dialogSnapshot !== null) return
                  pickKernel(index)
                }}
              />
            </Box>
          )}
          {overlay.kind === 'sdk-install' && sdkPhase.kind !== 'idle' && (
            <Box flexDirection="column" marginTop={1}>
              <SdkInstallWizard phase={sdkPhase} />
            </Box>
          )}
          {overlay.kind === 'channel' && (
            <Box flexDirection="column" marginTop={1}>
              <ChannelPicker
                rows={channelRows}
                focusIndex={overlay.index}
                onPick={(index) => {
                  if (approvalSnapshot !== null || questionSnapshot !== null || dialogSnapshot !== null) return
                  pickChannel(index)
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
                  void runExternalCommand('plan', on ? '' : ' off')
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
          {overlay.kind === 'search' && <TranscriptSearch query={searchQuery} cursorOffset={searchCursor} count={searchCount} current={searchCurrent} />}
    </>
  )
    const screenOpen = channel.pluginScene !== undefined || supervisorOpen || settingsOpen
    || subagentDetailId !== null || subagentDashboardOpen || sceneOpen
    || agentView !== null
    || launchpadShown || onboardingOpen
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
        {renderScene ? renderScene(pluginScene.id, channel) : <Text>Scene unavailable: {pluginScene.id}</Text>}
      </PluginSceneBoundary>
    )
    return fullscreen ? node : <AlternateScreen>{node}</AlternateScreen>
  }

  /**
   * The first-run guide — the FIRST frame of a fresh installation.
   *
   * It sits above every other screen because it answers a question that comes
   * before all of them: "is this thing wired up at all". A launch that needs
   * setup has nothing useful to show behind a browser or a landing page.
   *
   * `activeModel` is deliberately undefined here: the wizard's model step
   * switches models through `channel.switchModel`, which is the same path the
   * chat screen uses, so a switch made inside the wizard is already live when
   * the user lands on the launcher.
   */
  if (onboardingOpen) {
    const node = (
      <Onboarding
        channel={channel}
        themeHost={themeHost}
        onClose={closeOnboarding}
        onApplyLang={applyLang}
        onRunCommand={(name) => {
          // 与落地页的 onAction 同一条规则：打开整屏界面的命令要先把向导收掉。
          // 走 `closeOnboarding('skipped')` 而不是直接置 false——用户是去试命令、
          // 没答完引导，按 skipped 的口径不记账（下次启动还会问）。
          if (!overlayCommandNames.has(name)) closeOnboarding('skipped')
          void runCommand(name, '')
        }}
      />
    )
    return fullscreen ? node : <AlternateScreen>{node}</AlternateScreen>
  }


  /**
   * The session supervisor: a screen in the same sense as the tree — an early
   * return after every hook above has run, so there is no transcript
   * underneath to repaint or bled through.
   *
   * It sits ABOVE the session tree because it is the surface a launch can
   * start on (`openHomeOnBoot`): a first launch has no conversation to come
   * back to, and every action it offers either mounts a session (which closes
   * it) or starts a new one.
   *
   * Behind it, every session this terminal hosts keeps running — that is the
   * runtime the screen describes, not an implementation detail of it. A turn
   * that was in flight when the user opened this screen is still in flight
   * while they read the list, which is why closing the screen only repaints
   * the transcript when the attached session actually changed.
   */
  if (supervisorOpen && launchpadGate()) {
    /**
     * Live state per session, from the channel's own agent-view projection.
     * Reading the projection rather than a parallel source is what keeps this
     * screen and the attention hints in the composer footer from disagreeing
     * about which session is waiting for input.
     */
    const agentRowOf = (sessionId: string) => agentViewRows.find(row => row.id === sessionId)
    const supervisorNode = (
      <SessionSupervisor
        channel={channel}
        home={homeDir()}
        onClose={closeHome}
        approval={approvalSnapshot}
        onApprove={(outcome, decision) => approvals.decide(outcome, decision)}
        onOpenSession={async (sessionId) => {
          // A refusal is reported by the screen itself (see `openSession`):
          // the composer that draws channel notifications is not mounted here.
          const result = await channel.resumeTo(sessionId)
          if (!result.ok) return result
          channel.notify(t('resume-resumed'))
          suppressLogoIntroRef.current = true
          setAgentViewReturnId(undefined)
          setSupervisorOpen(false)
          // 第七版：明确选中一个会话 = 有意导航（与 Esc「退出」相对）——浏览页
          // 与盖在它底下的落地页**一起收**，人落在那个会话的聊天页。只收浏览页
          // 会露出启动页，正是用户实测的「选完会话还是回到启动页」。落地页的
          // 草稿/焦点也按 closeLaunchpad 同一口径清掉（进入的是别的会话，旧草稿
          // 不该跟过去）。
          setLaunchpadOpen(false)
          setLaunchpadFocus(-1)
          setLaunchpadDraft('')
          setLaunchpadCaret(0)
          repaintTranscript()
          return result
        }}
        onNewSession={async (target) => {
          const ok = await channel.switchWorkspace(target)
          if (ok) {
            suppressLogoIntroRef.current = true
            setAgentViewReturnId(undefined)
            setSupervisorOpen(false)
            // 同 onOpenSession：新建/切工作区会话也是有意导航，落地页一并收。
            setLaunchpadOpen(false)
            setLaunchpadFocus(-1)
            setLaunchpadDraft('')
            setLaunchpadCaret(0)
            repaintTranscript()
          }
          return ok
        }}
        onStopSession={async (sessionId) => channel.stopBackgroundAgent?.(sessionId) ?? false}
        liveStateOf={(sessionId) => {
          const row = agentRowOf(sessionId)
          if (row !== undefined) return { status: row.status, live: row.live, current: row.current, summary: row.summary }
          // Without agent view, only this terminal's current session has live state.
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: headless hosts render Chat with a partial channel
          const hasAgentView = (channel.backendCapabilities as Channel['backendCapabilities'] | undefined)?.commands.includes('agentview') ?? true
          if (hasAgentView || sessionId !== channel.agentId) return undefined
          return { status: channel.working ? 'working' : 'idle', live: true, current: true, summary: '' }
        }}
      />
    )
    // Inline hosts enter the alternate screen for the duration; full-screen
    // hosts are already in it and must not nest a second one.
    return fullscreen ? supervisorNode : <AlternateScreen>{supervisorNode}</AlternateScreen>
  }

  // The session tree follows the browser's rule exactly: it REPLACES the
  // conversation (an early return after every hook above has run), so there
  // is no transcript underneath to be repainted or bled through. The dropped
  // turn's prompt returns through the same fill path a rewind picker uses.
  if (treeOpen && launchpadGate()) {
    const tree = (
      <SessionTree
        channel={channel}
        currentSessionId={channel.agentId}
        onClose={() => setTreeOpen(false)}
        onRestoreText={(text) => {
          // The tree rewound to a node and is handing that turn's prompt back,
          // exactly like the picker does. It belongs to the binding the tree
          // action just created.
          pendingFillRef.current = String(channel.agentId)
          setHistoryFill(text)
        }}
      />
    )
    return fullscreen ? tree : <AlternateScreen>{tree}</AlternateScreen>
  }

  // The settings screen follows the browser's rule exactly: it REPLACES the
  // conversation (an early return after every hook above has run), so there
  // is no transcript underneath to be repainted or bled through.
  if (settingsOpen && launchpadGate()) {
    const screen = <Settings channel={channel} onClose={() => setSettingsOpen(false)} />
    return fullscreen ? screen : <AlternateScreen>{screen}</AlternateScreen>
  }

  // Main-screen read-only Agent View: a scene over the mounted Chat, with no
  // second Channel and no change of the bound session. It borrows the screen
  // the way the trajectory scene does; Chat stays mounted, so the parent's
  // rows, draft, pending queue and usage are untouched by the round trip.
  // Esc returns to wherever the view was opened from.
  if (agentView !== null && launchpadGate()) {
    const viewSubagent = channel.subagents.find(s => s.agentId === agentView.agentId)
    if (!viewSubagent) {
      // The roster lost this child (session switch): pop the view, don't crash.
      setAgentView(null)
      return null
    }
    // Headless stubs mount Chat without a subagentControl at all.
    const messageControl = channel.subagentControl?.message
    const loadTranscript = channel.subagentControl?.history
    const viewMessages = messageControl === undefined ? [] : messageControl.messages().filter(m => m.from === agentView.agentId || m.to === agentView.agentId)
    const viewTarget = agentComposeTargetOf(agentView.agentId, new Map(channel.subagents.map(s => [s.agentId, s.description])))
    const viewScene = (
      <AgentTranscriptScene
        subagent={viewSubagent}
        source={agentView.source}
        onExit={() => exitAgentView(agentView.source)}
        {...(loadTranscript === undefined ? {} : { loadTranscript })}
        messages={viewMessages}
        {...(messageControl === undefined ? {} : { compose: { control: messageControl, target: viewTarget } })}
        roster={channel.subagents}
        // Switching to a sibling or the parent swaps the viewed agent in
        // place; Esc still returns to the original entry point.
        onSwitchAgent={switchViewedAgent}
      />
    )
    return fullscreen ? viewScene : <AlternateScreen>{viewScene}</AlternateScreen>
  }

  // Subagent detail scene: displays detailed view of a specific subagent.
  // Like the browser and settings, it replaces the conversation entirely.
  if (subagentDetailId !== null && launchpadGate()) {
    const subagent = channel.subagents.find(s => s.agentId === subagentDetailId)
    if (!subagent) {
      // Agent not found, go back to the dashboard (side panel when split).
      setSubagentDetailId(null)
      openSubagentDashboard()
      return null
    }
    const detailControl = channel.subagentControl?.message
    const detailMessages = detailControl === undefined ? [] : detailControl.messages().filter(m => m.from === subagent.agentId || m.to === subagent.agentId)
    const detailTarget = agentComposeTargetOf(subagent.agentId, new Map(channel.subagents.map(s => [s.agentId, s.description])))
    const scene = (
      <SubagentDetailScene
        subagent={subagent}
        onInterrupt={(id) => channel.subagentControl?.interrupt(id)}
        {...(channel.subagentControl?.history === undefined ? {} : { loadTranscript: channel.subagentControl.history })}
        onOpenView={() => openAgentView(subagent.agentId, { kind: 'agent-detail', agentId: subagent.agentId })}
        messages={detailMessages}
        {...(detailControl === undefined ? {} : { compose: { control: detailControl, target: detailTarget } })}
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
  if (jobsPanelOpen && launchpadGate()) {
    const panel = (
      <JobsPanel
        jobs={channel.backgroundJobs ?? []}
        initialFocusId={jobsPanelFocusId ?? undefined}
        onClose={() => { setJobsPanelOpen(false); setJobsPanelFocusId(null) }}
        onWatchOutput={watchJobOutput}
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

  // ⤢ btw thread scene (openPanelFullscreen 'btw'): the whole-terminal form
  // of the sidebar panel. Esc returns to the sidebar exactly as it was — the
  // thread and the composer draft live in btwThreads, nothing is cleared.
  if (btwSceneOpen && launchpadGate()) {
    const scene = (
      <BtwThreadScene
        channel={channel}
        onClose={() => setBtwSceneOpen(false)}
      />
    )
    return fullscreen ? scene : <AlternateScreen>{scene}</AlternateScreen>
  }

  // Subagent dashboard: displays all active and completed subagents.
  // Like the browser and settings, it replaces the conversation entirely.
  if (subagentDashboardOpen && launchpadGate()) {
    // No kernel serves agents from other sessions yet, so the dashboard gets
    // no `peers`; once one does, pass them here.
    const dashboard = (
      <SubagentDashboard
        subagents={[...channel.subagents]}
        onSelect={(id) => {
          setSubagentDashboardOpen(false)
          setSubagentDetailId(id)
        }}
        onOpenView={(id) => openAgentView(id, { kind: 'agents-dashboard' })}
        messages={channel.subagentControl?.message?.messages()}
        onClose={() => setSubagentDashboardOpen(false)}
      />
    )
    return fullscreen ? dashboard : <AlternateScreen>{dashboard}</AlternateScreen>
  }

  /** Prompt input is inert while a modal dialog owns the keyboard. The
   *  overlay union covers every picker/dialog and /tips in one check;
   *  message-selection mode and the /btw panel live outside it. */
  const promptSelectionActive =
    selectionActive || overlay.kind !== 'none' || btwOverlayOpen

  // These panels replace the visible composer, but PromptInput remains
  // mounted (suspended) so an async registry command cannot lose its exact
  // text/image draft while it waits for a user decision.
  const promptReplacementOpen =
    approvalPanelNode !== null
    || dialogSnapshot !== null
    || overlay.kind === 'tips'
    || (recap !== null && (!recap.auto || recap.expanded))
    || btwOverlayOpen
    || questionPanelNode !== null
    || starModal !== null
    || couponVisible

  // The trajectory scene replaces the conversation for as long as it is open.
  // Rendering it INSTEAD of (not above) the transcript is what makes it a
  // screen rather than an overlay: it owns the full viewport, and the
  // conversation's own frame is never resized while it is up. Chat stays
  // mounted, so every hook above has already run and no state is lost.
  // `<AlternateScreen>` is skipped when the app is already fullscreen —
  // nesting it would emit a second DEC 1049, and its unmount would drop the
  // whole app back to the main screen.
  if (sceneOpen && launchpadGate()) {
    const scene = <TrajectoryScene channel={channel} build={trajectory} onClose={closeScene} />
    return fullscreen ? scene : <AlternateScreen>{scene}</AlternateScreen>
  }

  /**
   * The launchpad — the landing page an ordinary launch starts on.
   *
   * 第七版渲染姿态：early-return 排在**所有整屏界面（会话浏览器 / 设置 /
   * 任务面板 / 家谱 / 子代理 / 轨迹场景）之后**——从落地页打开的整屏盖在
   * 落地页之上，Esc 退出整屏回到这里（草稿/参数/焦点原样保留）。硬约束：
   * 从启动页进入对话页的唯一路径是**提交一条非命令消息**（Enter 发送）；
   * 任何 Esc/返回都回到启动页。参数行点开的选择器经 `pickerPanels` +
   * `inputPaused` 渲染在本屏之上，Esc 关掉它也回到这里。
   */
  if (launchpadShown) {
    // 参数行的「模式/权限」两段（第三版）：模式看 channel.mode.plan；权限看
    // permissionPresets() 的当前身份——只认 runtime 名册，legacy/unavailable 与
    // 抛错都按「拿不到」处理（缺省不画那一段，两段都可选）。
    let launchpadPermission: string | undefined
    try {
      const snapshot = channel.permissionPresets()
      launchpadPermission = snapshot.availability === 'runtime' ? snapshot.current?.name : undefined
    } catch {
      launchpadPermission = undefined
    }
    // 第七版动作表：状态快照全部来自既有数据源（详见 launchpadActions.ts）——
    //   - lastSessionTitle = agentViewRows（含持久化名册）里最近一条非当前会话
    //     的标题——listing 是异步的，落地前没有 Continue、落地后自动长出来；
    //   - jobsRunning / updateAvailable / starDue = 条件位三连（后台任务面 /
    //     checkForTuiUpdate / usageStats 里程碑口径）。
    const resumableRows = agentViewRows
      .filter(row => !row.current && row.id !== channel.agentId && row.title.trim() !== '')
    const latestRow = resumableRows.reduce<typeof resumableRows[number] | undefined>(
      (best, row) => (best === undefined || row.updatedAt > best.updatedAt ? row : best), undefined)
    const launchpadActions = resolveLaunchpadActions({
      lastSessionTitle: latestRow?.title,
      // 条件位①：后台任务面是真数据（JobsPanel 同一个 channel.backgroundJobs），
      // running/stopping 都算「在跑」。
      jobsRunning: (channel.backgroundJobs ?? []).some(
        job => job.status === 'running' || job.status === 'stopping',
      ),
      updateAvailable: launchpadUpdateAvailable,
      starDue: launchpadStarDue,
      // 内核入口带名（「内核 · Claude」）：backendId 是内核身份的唯一来源。
      backendId: kernelCurrentId,
    })
    const launchpad = (
      <Launchpad
        query={launchpadDraft}
        cursorOffset={launchpadCaret}
        focusIndex={launchpadFocus}
        isTerminalFocused={terminalFocused}
        whale={channel.whale}
        whaleIdle={channel.whaleIdle}
        whaleGirl={channel.whaleGirl}
        fontId={splashFontIdOf(channel.splashFont)}
        brand={brand}
        starred={starred}
        onStarClick={runStarAction}
        firstRun={onboardingPending}
        actions={launchpadActions}
        // 参数行四段点开的既有选择器（第五版）：pickerPanels 与聊天页共用
        // 同一份 JSX，盖在落地页之上；选择器开着时落地页键盘让位（inputPaused）。
        overlayPanel={launchpadOverlayUp ? pickerPanels : undefined}
        inputPaused={launchpadOverlayUp}
        onParamPick={(segment) => {
          // 四段 → 既有命令：model→/model、effort→/effort、preset→/preset、
          // permission→/permission。全部在 overlayCommandNames 白名单里，
          // 落地页不收，选择器盖上来。
          // 第八版切换式（用户原话「点一下是展开 再点一下收起来」）：**同一段**
          // 再点/再按 Enter = 收起（展开 ↔ 收起，键盘与鼠标同一条 onParamPick）。
          // 点另一段仍直接切换，点空白/Esc 仍收起（上一版契约不回退）。
          if (overlay.kind === segment) {
            dispatchOverlay({ type: 'close' })
            return
          }
          // BUG 3（点另一段直接切换）：/effort 的选择器是异步 open-if（when:
          // ['none']），盖着别的选择器时会被丢弃——这就是"点了没反应"的根因。
          // 先把屏上的参数选择器收掉再开新的，一个在屏、且就是点的那段。
          if (overlay.kind !== 'none') {
            dispatchOverlay({ type: 'close' })
          }
          void runCommand(segment, '')
        }}
        onQueryChange={(text, cursor) => {
          setLaunchpadDraft(text)
          setLaunchpadCaret(cursor)
        }}
        onSubmit={closeLaunchpad}
        onFocusChange={setLaunchpadFocus}
        onAction={(action) => {
          // 第八版（用户实测：「刚点帮助，不知道为什么直接进入聊天页面了」）：
          // 帮助**不属于**离开启动页的两条路（Enter 发非命令消息 / 会话浏览
          // 里选中会话）——它盖在落地页之上（overlay kind 'help'），再点同一
          // 入口 = 收起（与参数段同一条切换语义）。
          if (action.command === 'help') {
            dispatchOverlay(overlay.kind === 'help'
              ? { type: 'close' }
              : { type: 'open', overlay: { kind: 'help' } })
            return
          }
          // 第七版姿态：覆盖层命令（overlayCommandNames）盖在落地页之上；
          // **整屏命令**（launchpadScreenCommands：会话与工作区 / 设置 / 后台
          // 任务 / 家谱 / 子代理 / 引导）也盖在落地页之上——落地页不收，
          // Esc 退出整屏回到落地页（草稿/参数/焦点都在）。整屏要先过
          // launchpadGate 的授权位（防御：异步误置的整屏状态盖不走启动页）。
          // 其余命令（star / update——反馈在对话页的转录/通知）仍收掉落地页
          // 再执行，这是用户主动执行命令，不是「返回」。
          if (launchpadScreenCommands.has(action.command)) {
            authorizeLaunchpadCover()
          } else if (!overlayCommandNames.has(action.command)) {
            setLaunchpadOpen(false)
          }
          void runCommand(action.command, '')
        }}
        onEscape={(intent) => {
          if (intent === 'exit') {
            requestExit()
            return
          }
          // 空输入按 Esc：这一屏的"下一步"通常是去挑工作区/会话。第七版：
          // 会话浏览器**盖在落地页之上**（落地页不收）——Esc 退出浏览器回到
          // 落地页，绝不落到对话页。这是从落地页出发的交互：过闸门授权。
          agentViewOpenSessionRef.current = channel.agentId
          authorizeLaunchpadCover()
          setSupervisorOpen(true)
        }}
        onBlankClick={() => {
          // BUG 3（点别处关掉选择器）：沿用"点空白收回焦点"的兜底路径——
          // 有参数选择器盖在落地页之上时，空白点击先把选择器收掉（焦点照旧
          // 收回输入框）。选择器内部的点击已被 Launchpad 的浮层包装拦住
          // 冒泡，不会走到这里。
          if (overlay.kind !== 'none') dispatchOverlay({ type: 'close' })
          setLaunchpadFocus(-1)
        }}
        model={channel.modelDisplay ?? channel.model}
        effort={channel.reasoningEffort}
        preset={
          channel.agentPreset === undefined
            ? undefined
            : presetOptions.find(option => option.id === channel.agentPreset)?.name ?? channel.agentPreset
        }
        permission={launchpadPermission}
        commands={
          launchpadOverlayUp || !launchpadDraft.startsWith('/')
            ? undefined
            : channel.commandCompletions(launchpadDraft)
        }
        onCommandPick={(commandLine) => {
          // 补全面板选中（Enter/Tab/点击）：走 runCommand，与快捷入口同一条
          // 白名单口径——覆盖层与整屏命令（第七版 launchpadScreenCommands）
          // 不收落地页（盖在它之上），其余收掉再执行。/help 与快捷入口同一条
          // 拦截：盖屏浮层，不进对话页（第八版）。
          const parsed = parseCommandName(commandLine)
          if (parsed === undefined) return
          if (parsed.name === 'help') {
            dispatchOverlay({ type: 'open', overlay: { kind: 'help' } })
            return
          }
          if (launchpadScreenCommands.has(parsed.name)) {
            authorizeLaunchpadCover()
          } else if (!overlayCommandNames.has(parsed.name)) {
            setLaunchpadOpen(false)
          }
          void runCommand(parsed.name, parsed.rawInput)
        }}
        cwd={channel.displayCwd}
        branch={channel.gitBranch}
        tuiVersion={tuiVersion}
        // 右下角的内核行：与选择器同一份目录，标出当前内核，点它打开选择器。
        kernels={kernelOptions}
        onKernelPick={() => openKernelPicker()}
        // 左下角工作目录铭牌（第七版）：点开/回车开既有 /workspace 菜单——
        // workspace-menu 在 LAUNCHPAD_OVERLAY_KINDS 里，选择器盖在落地页之上，
        // Esc 回落地页（与参数行选择器同一姿态），不新造面板。
        onOpenWorkspace={() => { void runCommand('workspace', '') }}
      />
    )
    // 落地页这一屏的完整树（AC-4）：Tooltip 单例层挂在**最外层最后**——与下面
    // 聊天主树末尾那处（SidePanelLayout 里）是同一个组件、同一条"单例层挂树尾"
    // 姿态；参数行被截断的段（ParamChip 写的锚点）hover 600ms 后由它画完整名。
    // 本屏没有滚动、也没有面板几何过渡 ⇒ 不需要 subscribeInvalidation；但**必须**给
    // invalidationKey：选择器是**盖在落地页之上**的浮层，落地页不卸载、指针也不一定
    // 离开被悬停的那一段，没有这个键时旧卡片会继续画在选择器上方（复核场景回归见
    // `verify-launchpad-onboarding-chat` 的 R4）。
    const node = (
      <>
        {launchpad}
        <TooltipLayer invalidationKey={overlay.kind} />
      </>
    )
    return fullscreen ? node : <AlternateScreen>{node}</AlternateScreen>
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
    panelCount: panelPickerRows.length,
  }) && !(overlay.kind === 'permission'
    && (approvalSnapshot !== null || questionSnapshot !== null || dialogSnapshot !== null))

  // The sticky header pins the turn owning the viewport top row once its
  // prompt has scrolled out above it (timeline.pinnedId, reported by
  // MessageList) — scrolled up to an old turn, it carries THAT turn's
  // prompt, not the latest one. The row stays while scrolled up and goes
  // blank when nothing is pinned, so the viewport never shifts under it.
  // channel.rows is a live in-place array, so the lookup is per-render.
  const anchorUserRowId = timeline.pinnedId
  const anchorUserText =
    anchorUserRowId === null
      ? null
      : channel.rows.find(row => row.id === anchorUserRowId)?.text ?? null

  // Modal image preview, shared by the composer's [Image #N] tokens and the
  // transcript thumbnails. It normally lives INSIDE the transcript row, so
  // the card centers over the conversation and the sticky header, prompt
  // and status rows stay visible. While the fullscreen draft editor is open
  // it moves to the root, after PromptEditorLayer, so it still paints above
  // the editor (the editor state stays put; closing the preview restores it).
  // The layer needs its region before its first paint (see the component):
  // the transcript viewport height from the ScrollBox handle and the content
  // column width. The full-screen (editor-open) placement uses the terminal.
  const imagePreviewRegion = promptEditorOpen
    ? { columns: chatColumns, rows: terminalRows }
    : { columns: chatColumns, rows: handle?.getViewportHeight() ?? terminalRows }
  const imagePreviewNode = activePreview !== null && (activePreview.peek || imagePreviewOwned)
    ? (
      <ImagePreviewOverlay
        image={activePreview.image}
        title={activePreview.title}
        navigation={previewGallery.length > 1 && previewIndex >= 0 ? {
          index: previewIndex, total: previewGallery.length,
          onPrevious: () => stepPreview(-1), onNext: () => stepPreview(1),
        } : undefined}
        onClose={activePreview.peek
          ? () => setPeekSuppressed(peekKey(activePreview.image, activePreview.title))
          : () => dispatchOverlay({ type: 'close-if', kind: 'image-preview' })}
        region={imagePreviewRegion}
      />
    )
    : null

  return (
    <Box ref={wakeTickRef} flexDirection="column" flexGrow={1} width="100%">
      {/* 分栏布局：geometry 为 null（收起 / 窄屏 / inline / 编辑器展开）
          时 SidePanelLayout 原样渲染 children，与现状逐字节一致；分栏时
          左栏拿到 chatColumns 的 TerminalSizeContext 覆盖与出血边界。 */}
      <SidePanelLayout
        geometry={sidePanel.geometry}
        focus={sidePanel.focus}
        onActivateChat={sidePanel.focusChat}
        onActivatePanel={sidePanel.focusPanel}
        side={
          <SidePanelColumn
            width={sidePanel.panelColumns}
            controller={sidePanel}
            channel={channel}
            activity={workingActivity}
            attention={{
              approvals: approvalSnapshot !== null ? 1 : 0,
              questions: questionSnapshot !== null ? 1 : 0,
            }}
            trajectory={trajectory}
            onExpand={openPanelFullscreen}
          />
        }
      >
      {!isSticky && timeline.activeId !== null && (
        <PinnedTurnHeader
          text={anchorUserText || null}
          onClick={() => {
            // Click snaps the pinned prompt to the viewport top. Jump by the
            // SAME content coordinate the
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
      <Box flexDirection="row" flexGrow={1} flexShrink={1} marginRight={sidePanel.split ? 0 : -pageInsetX}>
        <ScrollBox ref={setHandle} flexDirection="column" flexGrow={1} flexShrink={1} stickyScroll>
        <LogoHeader
          key={logoNonce}
          model={channel.modelDisplay ?? channel.model}
          effort={channel.reasoningEffort}
          cwd={channel.displayCwd}
          // 大字字面（设置项 `dsh-tui.splashFont`）：`daily` 交回按天轮换
          // （`undefined`），其余 pin 住一款。
          fontId={splashFontIdOf(channel.splashFont)}
          whale={channel.whale}
          whaleIdle={channel.whaleIdle && whaleArtVisible}
          whaleGirl={channel.whaleGirl}
          brand={brand}
          starred={starred}
          onStarClick={runStarAction}
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
          failureHint={t('traj-hint-failure', { key: primaryComboString('trajectory') })}
          expanded={expanded}
          expandedRows={expandedRows}
          selectedId={selectionActive ? selectedId : null}
          onToggleRow={toggleRowExpanded}
          streamViewToggledRows={streamViewToggledRows}
          onToggleStreamView={toggleStreamView}
          model={channel.modelDisplay ?? channel.model}
          diffLayout={channel.diffLayout}
          thinkingFold={channel.thinkingFold}
          jobGroupFold={channel.jobGroupFold}
          toolBackground={channel.toolBackground}
          foldTerminalCommand={channel.foldTerminalCommand}
          turnUsageRow={channel.turnUsageRow}
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
          onOpenSubagent={setSubagentDetailId}
          onOpenSubagentView={openSubagentViewFromCard}
          onOpenJobs={openJobsPanel}
          onOpenFile={openFileActions}
          sessionCwd={channel.cwd}
          onPreviewImage={openImagePreview}
          suppressImageGraphics={activePreview !== null}
          olderHistory={channel.olderHistory}
          onWatchJobOutput={watchJobOutput}
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
            return <ScrollbarGutter handle={handle} terminalWidth={chatColumns} />
          }
          return (
            <TimelineRail
              handle={handle}
              turns={timeline.turns}
              activeId={timeline.activeId}
              upId={timeline.upId}
              downId={timeline.downId}
              terminalWidth={chatColumns}
              hoverEnabled={!promptSelectionActive}
              onRevealTurn={revealAndSeekRow}
            />
          )
        })()}
        {!promptEditorOpen && imagePreviewNode}
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
          (activitySlot &&
          workingActivity !== undefined &&
          workingActivity.line !== '' &&
          workingActivity.phase !== 'idle' ? (
            // The working-activity line replaces the random-verb spinner
            // while a turn runs: the plugin's live line (thinking copy /
            // running tool / narration) is the status, with the spinner
            // slot's token counter preserved as a suffix. Only real activity
            // data replaces the spinner — before the first event, or with
            // `activity: false`, the classic spinner still renders. The line
            // hugs the left edge (no padding) so the self-narration reads as
            // part of the transcript, aligned with the `❯` prompt below.
              <Box marginTop={1}>
                <ActivityLine
                  activity={workingActivity}
                  activityFrames={channel.activityFrames}
                  warnPct={activityWarnPct}
                  warnDanger={activityWarnPct !== undefined && activityWarnPct >= 95}
                  // Upload = real tokens of the last request; download =
                  // the animated chars/4 estimate, matching the classic
                  // spinner's counter (the suffix used raw chars before,
                  // inflating the reading next to a real upload number). An
                  // automatic compaction mid-turn badges THIS line too — it is
                  // the spinner slot whenever real activity data exists.
                  suffix={`${lastUploadTokens > 0 ? ` · ↑ ${formatTokens(lastUploadTokens)}` : ''} · ↓ ${formatTokens(Math.round(channel.responseChars / 4))} tokens${compactionBadge === undefined ? '' : ` · ${compactionBadge}`}`}
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
                suffix={compactionBadge}
              />
            ))}
        {!channel.working && channel.compaction !== undefined && (
          // Manual `/compact` runs while the session is idle: the row takes the
          // spinner slot so the screen never looks frozen for its ~25-70s.
          <CompactionStatusRow
            compaction={channel.compaction}
            activityPreset={activitySlot ? channel.activityFrames : undefined}
          />
        )}
        {/* 分栏且 todo Panel 已启用时，Goal/Todo 由右栏 Panel 承载，
            底部 chrome 不再挂载（窄屏 / inline / 未启用时保留现状）。 */}
        {!(sidePanel.split && sidePanel.enabledPanelIds.includes('todo')) && (
          <GoalTodoPanel
            channel={channel}
            collapsed={todoCollapsed}
            onToggle={() => setTodoCollapsed(previous => !previous)}
          />
        )}
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
            model={channel.modelDisplay ?? channel.model}
            provider={channel.provider}
            mainCost={channel.mainCost}
            subagentCost={channel.subagentCost}
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
        {activePreview === null && statusViews.map(view => (
          <PluginStatusViewBoundary
            key={`${view.key}:${view.registrationId}`}
            viewKey={view.key}
            onError={(key, error) => statusContributions.reportViewError(key, error)}
          >
            <Box
              flexDirection="column"
              flexShrink={0}
              maxHeight={view.maxRows}
              overflow="hidden"
            >
              <Box flexDirection="column" flexShrink={0}>
                {React.createElement(view.component, {
                  React,
                  ui: STATUS_VIEW_UI,
                })}
              </Box>
            </Box>
          </PluginStatusViewBoundary>
        ))}
        {/* 输入簇：可替换输入行链 + 状态行 + 瞬态浮层。浮层锚点收窄到本簇
            顶边（= 输入行顶边），picker 紧贴输入框向上展开，盖住其上
            todo/spinner/转录尾部行（用户接受的取舍），自身零布局高度、
            不推动帧布局。 */}
        <Box flexDirection="column" flexShrink={0}>
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
        ) : btwOverlayOpen && !sidePanel.enabledPanelIds.includes('btw') ? (
          // 浮层只在 btw 面板未启用时显示；面板中途被启用就立即让位。
          <Box flexDirection="column" marginTop={1}>
            <BtwPanelFallback
              thread={btwOverlayThread}
              onClose={closeBtwOverlay}
              onCopy={answer => {
                void setClipboard(answer).then(raw => { if (raw) writeRaw?.(raw) })
                channel.notify(t('copied-chars', { n: answer.length }), { timeoutMs: 1500 })
              }}
            />
          </Box>
        ) : questionPanelNode !== null ? (
          questionPanelNode
        ) : null}
        <PromptInput
          key="prompt-input"
          channel={channel}
          suspended={promptReplacementOpen}
          // 宠物面板是活动面板时，通知由它的头顶气泡「说出来」，输入框上方
          // 不再重复弹同一条（error 色除外——可能要行动的信号永远走 toast）。
          // 渲染期判定（split + activePanelId），与气泡同一次提交切换，不会
          // 先闪一帧 toast 再消失。
          toastSuppressed={petSaysNotices}
          draftCache={promptDraftRef.current}
          helpOpen={helpOpen}
          onToggleHelp={() =>{  setHelpOpen(previous => !previous) }}
          onRunCommand={runCommand}
          selectionActive={promptSelectionActive}
          fillText={historyFill}
          onFillConsumed={() => setHistoryFill(null)}
          onRewindRequest={openRewind}
          onBackgroundRequest={backgroundToAgentView}
          // The 🏠 at the head of the input row opens the same session screen
          // `/resume` and `/agentview` open — one surface, three doors. It is
          // gated on this prop rather than a setting, so hosts that mount the
          // prompt without a session screen (and the layout regressions that
          // pin the row's column budget) keep the row they had.
          onOpenSessions={() => {
            agentViewOpenSessionRef.current = channel.agentId
            setSupervisorOpen(true)
          }}
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
          onCaretImage={handleCaretImage}
          caretPreviewOpen={peekPreview !== null}
          onDismissCaretPreview={dismissPeek}
        />
        <StatusLine
          channel={channel}
          activity={workingActivity}
          selectionActive={selectionActive}
          helpOpen={helpOpen}
          // Backend-native permission modes: the footer mode segment always
          // shows (the base mode included) and clicks into the same
          // /permission picker the command opens (the launchpad param row's
          // route). DSH answers an empty list here — no prop, byte-identical
          // rendering.
          backendMode={backendModeStatus}
          // 模型段/思考档位段：能力位在才可点，点击走既有 /model · /effort
          // 命令（与模式段打开 /permission 完全同构）。
          modelPicker={modelPickerStatus}
          effortPicker={effortPickerStatus}
          wake={
            wakeBand === undefined
              ? undefined
              : {
                  band: wakeBand,
                  hint: trajectorySeen ? undefined : primaryComboString('trajectory'),
                  tick: Math.floor(wakeTime / 120),
                  onOpen: openScene,
                  hoverHint: primaryComboString('trajectory'),
                }
          }
        />
        {/* 瞬态面板浮层：absolute + bottom:'100%' 钉在输入簇 Box 顶边（=
            输入行顶边），紧贴输入框向上覆盖其上 todo/spinner/转录尾部行，
            自身零布局高度。in-flow 挂载会让帧高随面板开关涨落，把帧顶行滚进
            scrollback 并在关闭重绘时二次写入（每切一次 /model 多一份启动画
            的根因）。浮层盖住 todo 是刻意取舍（贴输入框优先）；maxHeight
            预留 prompt/statusline 行，防短会话高列表探出帧顶。整体条件
            挂载：见 dialogOverlayOpen 注释。 */}
        {dialogOverlayOpen && (
        <OverlayAbove maxHeight={Math.max(terminalRows - 8, 1)}>
          {pickerPanels}
        </OverlayAbove>
        )}
        </Box>
      </Box>
      {/* Tooltip 悬停浮层：absolute 零布局高度，挂在聊天栏内最后（v2.1
          surface 边界）——它读到的是聊天列宽，clamp 后永远不会越过中缝
          压进右栏；yoga 的 absolute 相对父级，聊天栏原点即内容区原点，
          指针 anchor 的屏幕坐标换算（anchorCol - inset.x）保持正确。
          订阅模块级 store，锚点/内容由各处 useTooltip hover props 写入；
          resize 时自行隐藏（几何失效）。 */}
      <TooltipLayer
        invalidationKey={`${overlay.kind}:${dialogOverlayOpen}:${btwOverlayOpen}`}
        subscribeInvalidation={subscribeTooltipInvalidation}
      />
      </SidePanelLayout>
      {/* 全屏草稿编辑浮层：必须挂在 TooltipLayer 之后，才能盖住包括
          状态栏在内的全部普通后绘兄弟。内容由 PromptInput 经 module
          store 发布（见 PromptEditor.tsx）。图片预览是唯一有意后绘于它
          的 top modal：这样编辑器状态留在原处，关闭预览即可原样恢复。 */}
      <PromptEditorLayer />
      {/* 模态图片预览的全屏位：只在全屏草稿编辑器展开时用（编辑器盖住了
          transcript 行，预览必须作为根的最后一个孩子才压得过它）；平时
          预览挂在上面的 transcript 行内，见 imagePreviewNode。 */}
      {promptEditorOpen && imagePreviewNode}
      {/* 开屏"求 star"弹窗（99h / 999 次）：最后一个孩子，压过包括全屏
          草稿编辑器在内的全部后绘兄弟；关闭即整树卸载——键盘自然交还，
          没有残留的监听会再抢键。onClose 用 useCallback 钉死引用：弹窗
          开着的每一帧 Chat 重渲染都不弄脏它的绝对定位捕获层。 */}
      {starModal !== null && STAR_MILESTONES[starModal.index] !== undefined && (
        <StarPrompt
          milestone={STAR_MILESTONES[starModal.index]}
          actions={starModalActions}
          onClose={closeStarModal}
          initialPhase={starModal.phase}
        />
      )}
      {couponVisible && coupon !== null && (
        <WhaleCouponPrompt notice={coupon} onShown={markCouponShown} onClose={closeCoupon} />
      )}
    </Box>
  )
}

/**
 * The pinned prompt header shown above the ScrollBox while the user has
 * scrolled up. It pins the prompt of the turn the viewport top is showing
 * once that prompt has scrolled out above it, so it tracks which turn the
 * user is reading instead of always carrying the latest prompt. With no
 * such prompt (it still sits on the top row, or the logo owns the top) the
 * row renders blank rather than repeat on-screen text. Fixed at 1 row so
 * the ScrollBox never shifts when the text changes or goes blank.
 */
function PinnedTurnHeader({
  text,
  onClick,
}: {
  text: string | null
  onClick: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  if (text === null) return <Box flexShrink={0} width="100%" height={1} />
  // A one-row Box does not clip its children. Flatten hard line breaks before
  // truncating, otherwise later prompt lines paint down the transcript gutter.
  const label = cleanRenderText(`${POINTER} ${text}`, Math.max(1, columns - 1))
  return (
    <Box
      flexShrink={0}
      width="100%"
      height={1}
      overflow="hidden"
      paddingRight={1}
      onClick={onClick}
    >
      <Text color="userPromptLabel" bold wrap="truncate-end">
        {label}
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

/** /model while the provider catalog is still loading. */
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
 * The `/` incsearch bar: a
 * single row above the prompt input with the query, a block cursor, and the
 * match counter (`current/count`) or a red `no matches` when nothing hits.
 */function TranscriptSearch({
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
    // screen-space highlight would self-match).
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
