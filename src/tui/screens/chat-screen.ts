import {
  Key,
  matchesKey,
  truncateToWidth,
  VStack,
  type Component,
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
import { PromptEditor } from '../components/prompt-editor.js'
import { HeaderView } from '../components/header.js'
import { WorkingIndicator } from '../components/working-indicator.js'
import { StatusLineView } from '../components/status-line.js'
import { ApprovalPanelView } from '../components/overlays/approval-panel.js'
import { ExtensionDialogView } from '../components/overlays/extension-dialog.js'
import { QuestionPanelView } from '../components/overlays/question-panel.js'
import { SessionBrowserScreen } from './session-browser.js'
import { SettingsScreen } from './settings-screen.js'
import { TrajectoryScene } from './trajectory-scene.js'
import {
  SubagentDashboardScreen,
  SubagentDetailScreen,
} from './subagent-scenes.js'

/** The host-only scene controls consumed by the single chat root. */
export type ChatSceneHost = Pick<TuiSceneHost, 'active' | 'close' | 'create'>

/** Options for the single imperative chat root. */
export interface ChatScreenOptions {
  readonly ui: TUI
  readonly commands: TuiCommands
  readonly controller: TuiController
  readonly onExit: () => void
  readonly onUpdate?: () => void
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
  | 'settings'
  | 'trajectory'
  | 'subagent-dashboard'
  | 'subagent-detail'
  | 'plugin-scene'

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
  private readonly status: StatusLineView
  private readonly statusEntries: StatusEntriesView
  private readonly approval: ApprovalPanelView
  private readonly dialog: ExtensionDialogView
  private readonly question: QuestionPanelView
  private readonly root: VStack

  private vm: ChatViewModel | undefined
  private subagents: SubagentsProjection = EMPTY_SUBAGENTS
  private transientScreen: Component | undefined
  private transientKind: TransientKind | undefined
  private pluginSceneId: string | undefined
  private pluginSceneAbortController: AbortController | undefined
  private subagentDetailId: string | undefined
  private disposed = false
  private readonly unsubscribeController: () => void

  constructor(options: ChatScreenOptions) {
    this.ui = options.ui
    this.commands = options.commands
    this.controller = options.controller
    this.onExit = options.onExit
    this.onUpdate = options.onUpdate
    this.onOpenExternalEditor = options.onOpenExternalEditor
    this.home = options.home ?? ''
    this.sameProject = options.sameProject ?? ((a, b) => a === b)
    this.sceneHost = options.sceneHost
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
    this.header = new HeaderView(this.ui, EMPTY_HEADER)
    this.working = new WorkingIndicator(this.ui, EMPTY_SPINNER)
    this.status = new StatusLineView(this.ui, EMPTY_STATUS)
    this.statusEntries = new StatusEntriesView()
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
    this.promptEditor.onExitRequest = () => this.onExit()
    this.promptEditor.onOpenExternalEditor = (draft) => {
      if (this.onOpenExternalEditor === undefined) {
        this.commands.info.notify('External editor is not wired into this root yet.', { color: 'warning' })
      } else {
        this.onOpenExternalEditor(draft, text => this.promptEditor.setText(text))
      }
    }
    this.promptEditor.onClearOrExit = () => this.promptEditor.setText('')
    this.promptEditor.onRewindRequest = () => {
      this.commands.info.notify('Rewind picker is not wired into this root yet.', { color: 'warning' })
    }
    this.promptEditor.focused = true

    // VStack owns the vertical component composition. Visibility predicates are
    // layout predicates only; every component still receives its own bounded
    // projection through update().
    this.root = new VStack([
      { component: this.header, visible: () => this.shouldShowHeader() },
      this.transcript,
      { component: this.working, visible: () => this.vm?.spinner.working === true },
      { component: this.approval, visible: () => this.activeOverlayKind() === 'approval' },
      { component: this.dialog, visible: () => this.activeOverlayKind() === 'dialog' },
      { component: this.question, visible: () => this.activeOverlayKind() === 'question' },
      { component: this.statusEntries, visible: () => this.hasStatusEntries() },
      this.promptEditor,
      this.status,
    ])

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
    this.promptEditor.update(vm.prompt)
    this.approval.update(vm.overlays.approval)
    this.dialog.update(vm.overlays.dialog)
    this.question.update(vm.overlays.question)
    this.subagents = this.controller.getSubagents?.() ?? EMPTY_SUBAGENTS
    this.updatePluginScene()
    this.updateTransient()
    this.ui.requestRender()
  }

  /** Route transient screens first, then the active inline modal, then prompt. */
  handleInput(data: string): void {
    if (this.disposed) return

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

    this.promptEditor.handleInput(data)
    this.ui.requestRender()
  }

  /** Render the transient replacement or the main VStack, clipping every row. */
  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width))
    if (safeWidth === 0) return []

    if (this.transientScreen !== undefined) {
      this.updateTransientViewport()
      return fitLines(this.transientScreen.render(safeWidth), safeWidth)
    }

    this.promptEditor.focused = this.activeOverlayKind() === undefined
    return fitLines(this.root.render(safeWidth), safeWidth)
  }

  invalidate(): void {
    this.root.invalidate()
    this.transientScreen?.invalidate()
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

  /** Replace the conversation with the settings screen. */
  openSettings(): void {
    this.replaceTransient(
      new SettingsScreen({
        commands: this.commands,
        onClose: () => this.closeTransientScreen(),
      }),
      'settings',
    )
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

  /** Minimal local dispatcher; unknown slash commands fall back to the model. */
  private dispatchSlashCommand(name: string, rawInput: string, original: string): void {
    switch (name.toLowerCase()) {
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
        this.commands.info.notify('Rewind picker is not wired into this root yet.', { color: 'warning' })
        return
      case 'update':
        if (this.onUpdate === undefined) {
          this.commands.info.notify('Update is not available in this host.', { color: 'warning' })
        } else {
          this.onUpdate()
        }
        return
      case 'exit':
      case 'quit':
      case 'q':
        this.onExit()
        return
      default:
        void this.commands.input.runExternalCommand(name, rawInput).then((result) => {
          if (result === undefined) {
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
