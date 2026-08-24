/**
 * Typed command sink for migrated components (plan §1.3, WP-02).
 *
 * Components never hold the Channel, cordis context, Agent or stdio — they
 * receive a readonly ViewModel (./view-model.ts) plus this sink. Every method
 * delegates to the Channel; the sink adds no behavior of its own except the
 * async fence:
 *
 * - Fenced reads (`fenced(...)` below) capture `sessionEpoch` + `generation`
 *   at call time. When the promise settles after a session/agent swap or a
 *   lifecycle resume, the result — or the rejection — is DROPPED: the caller
 *   sees `undefined` and one debug line is logged. A stale result must never
 *   be written into a projection, an overlay or the new session's transcript
 *   (plan §1.3: "晚到结果只能丢弃或记录").
 * - Writes and session replacements (`switchModel`, `resumeTo`, `rewindTo`,
 *   …) run through `fencedWrite(...)`: same capture, but a SUCCESSFUL
 *   replacement is expected to move `sessionEpoch` by exactly one — the
 *   channel bumps it in the same commit that resolves the promise. A
 *   completion whose fences moved any other way (an interleaved swap, a
 *   lifecycle resume) is DROPPED as the command's neutral shape (`false`,
 *   `null`, `{ ok: false, reason: 'cancelled' }`) and logged, so the caller
 *   commits no follow-up UI for a session it no longer shows (plan §1.3).
 *   What the fence cannot cover: the channel's own multi-step awaits
 *   (`resumeTo`/`newSession`/`switchModel` internally) keep mutating shared
 *   state after an interleaved swap — fencing THOSE needs channel-internal
 *   epoch checks, not this sink. `promptRewind` stays unfenced: the channel
 *   already guards it by agent identity, and its `'cancel'`/`null` returns
 *   must not be confused with a stale drop.
 * - Sync methods are straight passthroughs.
 *
 * Methods are grouped by the component surface that uses them (input stream,
 * session lifecycle, model/preset/effort, async queries, settings, workspace,
 * informational, scenes, overlays, display prefs) — not a flat union — so a
 * component can be handed only the group it needs.
 *
 * The `overlays` group (WP-03) answers the pending approval/question/plugin
 * dialog. It delegates to the UI stores (`QuestionStore`, `ApprovalStore`,
 * `TuiDialogStore`) rather than the channel and is deliberately NOT fenced:
 * the stores themselves no-op on stale calls (keyed decide/cancel in the
 * dialog store, active-ask identity in the others), and a user keystroke is
 * never a stale async result. `stores` is optional so tests and headless
 * hosts can construct the sink without the UI stores; the methods then no-op.
 */
import type {
  Channel,
  ChatRow,
  CredentialStatus,
  EffortOption,
  NotificationItem,
  PresetOption,
  ResumeResult,
  SkillInfo,
  StagedImageInput,
} from '../dsh-adapter/channel.js'
import type { ApprovalStore } from '../dsh-adapter/approvals.js'
import type { SessionTreeData } from '../dsh-adapter/sessionTree.js'
import type { TuiDialogAnswer, TuiDialogStore } from '../dsh-adapter/dialogs.js'
import type { QuestionSelection, QuestionStore } from '../dsh-adapter/questions.js'
import type { FileCandidate } from '../utils/fileSuggestions.js'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { CommandCompletion } from '../commands.js'
import type { SessionModeSpec } from '../sessionModes.js'
import type { TuiRewindMode } from '../dsh-adapter/extension-events.js'
import type { ProviderSetupHost } from '../dsh-adapter/providerWizard.js'
import type { PreviewEntry, SessionSummary } from '../dsh-adapter/sessions/types.js'
import type { TuiSettingsSection } from '../dsh-adapter/settings-sections.js'
import type { SettingsHost } from '../dsh-adapter/settingsEditor.js'
import type {
  TuiWorkspaceCommand,
  TuiWorkspaceCommandResult,
  TuiWorkspaceTarget,
} from '../dsh-adapter/workspaces.js'
import type { AdapterLlmModelInfo as LlmModelInfo, AdapterSessionEvent as SessionEvent } from '../dsh-adapter/channel.js'
import { logForDebugging } from '../utils/debug.js'
import { setLang as applyI18nLang, t, writeLangPref, type Lang } from '../i18n.js'
import {
  AUTO_THEME_NAME,
  getActiveThemeName,
  getTheme,
  registerCustomThemeResolver,
  setActiveThemeName,
  THEME_NAMES,
  type Theme,
} from '../theme.js'
import {
  buildTheme,
  isThemeAvailable,
  listCustomThemes,
  resolveCustomTheme,
} from '../customTheme.js'
import { writeThemePref } from '../themePrefs.js'

/** Theme keys previewed as picker swatches, chosen for visual contrast (the
 *  old ThemePicker's SWATCH_KEYS). */
const SWATCH_KEYS = ['claude', 'text', 'success'] as const

/**
 * Fence sources shared by the command sink and the controller. One instance
 * per TUI boot: `sessionEpoch` reads the channel's replacement counter,
 * `generation` reads `TuiLifecycle.generation`.
 */
export interface TuiFences {
  sessionEpoch(): number
  generation(): number
}

/** Prompt-input stream: submit/steer/queue/interrupt/pull-back plus the
 *  plugin slash-command dispatch (part of the same Enter pipeline). */
export interface TuiInputCommands {
  submit(text: string): void
  steer(text: string): void
  cancel(): void
  /** Abort the in-flight turn and re-queue `texts`; returns the count queued. */
  interruptAndDeliver(texts: readonly string[]): number
  /** Pull a queued message back for re-editing (Alt+Up). */
  removePending(id: string): boolean
  /** Dispatch a plugin-registered slash command; undefined = no such command
   *  (the caller falls back to sending the line to the model). Unfenced on
   *  purpose: undefined is a real result here, never a stale drop. */
  runExternalCommand(name: string, rawInput: string): Promise<string | undefined>
}

/** Session lifecycle: /new, /resume, rewind, compact/clear, titles, and the
 *  session permission mode (`/permission`, same machinery as Shift+Tab). */
export interface TuiSessionCommands {
  newSession(): Promise<boolean>
  resumeTo(id: string): Promise<ResumeResult>
  deleteSession(id: string): Promise<boolean>
  renameSession(title: string): void
  renameSessionTo(id: string, title: string): Promise<boolean>
  compact(): void
  clear(): void
  promptRewind(row: ChatRow): Promise<{ modes: readonly TuiRewindMode[] } | 'cancel' | null>
  rewindTo(row: ChatRow, mode?: string | null): Promise<string | null>
  /** Session-tree fork: `rewind` drops the picked user turn (its prompt comes
   *  back as the returned text), `fork` keeps the picked entry. Null = refused
   *  or failed (the channel already notified the reason). */
  rewindToNode(sessionId: string, seq: number, mode?: 'rewind' | 'fork'): Promise<string | null>
  /** `/fork`: fork the current session at its tip into a persisted copy and
   *  STAY in the source session (no swap — the fence expects no self-bump). */
  forkSession(): Promise<boolean>
  /** The configured session-mode cycle for the `/permission` picker. */
  listModes(): readonly SessionModeSpec[]
  /** Apply one configured session mode by id; false when the id is unknown. */
  setMode(id: string): Promise<boolean>
  /** Cycle to the next configured session mode (the Shift+Tab binding);
   *  fire-and-forget like compact/clear. */
  cycleMode(): void
}

/** Model / preset / effort / activity-indicator switching and pickers. */
export interface TuiModelCommands {
  switchModel(provider: string, model: string): Promise<boolean>
  listModels(): Promise<readonly LlmModelInfo[] | undefined>
  switchPreset(id: string): Promise<boolean>
  listPresets(): Promise<readonly PresetOption[] | undefined>
  /** The preset the CURRENT session runs under (channel `agentPreset`), for
   *  the `/preset` status report and the picker's active row. */
  currentPreset(): string | undefined
  setEffort(id: string): Promise<boolean>
  listEfforts(): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined } | undefined>
  setActivityFrames(name: string): boolean
}

/** Async data queries behind pickers and completions. Fenced: `undefined`
 *  means stale-dropped (or the channel's own undefined where it has one). */
export interface TuiQueryCommands {
  listSessions(): Promise<readonly SessionSummary[] | undefined>
  previewSession(id: string): Promise<readonly PreviewEntry[] | undefined>
  /** The session family tree for the double-Esc panel: null = unavailable
   *  (the channel notified the reason), undefined = stale-dropped. */
  getSessionTree(): Promise<SessionTreeData | null | undefined>
  listSkills(): Promise<readonly SkillInfo[] | undefined>
  /** Structured `@` file completion: path-shaped queries list only that
   *  directory, plain fragments rank the session-cached candidate pool.
   *  `signal` is the caller's per-keystroke abort; `undefined` = stale drop. */
  listFileCandidates(
    query: string,
    options?: { signal?: AbortSignal; topK?: number },
  ): Promise<readonly FileCandidate[] | undefined>
  listFiles(): Promise<readonly string[] | undefined>
  /** Sync slash completions (pure over the command registry) — no fence. */
  commandCompletions(value: string): readonly CommandCompletion[]
  /** Persist a pasted image; the placeholder token is stale-sensitive
   *  because a session swap clears the staged-image map. */
  stageImage(input: StagedImageInput): Promise<string | undefined>
  listSubagents(): Promise<string[] | undefined>
  subagentInterrupt(id: string): boolean
}

/** `/settings` panel capabilities (the field/write helpers live in
 *  `settingsEditor.ts`; this is the channel seam it writes through). */
export interface TuiSettingsCommands {
  settingsHost(): SettingsHost | undefined
  settingsSections(): readonly TuiSettingsSection[]
  subscribeSettingsSections(listener: () => void): () => void
}

/** Workspace picker and provider workspace subcommands. */
export interface TuiWorkspaceCommands {
  listWorkspaces(): Promise<readonly TuiWorkspaceTarget[] | undefined>
  switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean>
  renameWorkspace(title: string): Promise<boolean>
  resolveWorkspace(uri: string): Promise<TuiWorkspaceTarget | undefined>
  runWorkspaceCommand(name: string, input: string): Promise<TuiWorkspaceCommandResult | undefined>
  workspaceCommands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[]
}

/** Informational one-shots: toasts, transcript-local reports, diagnostics. */
export interface TuiInfoCommands {
  notify(text: string, options?: { color?: NotificationItem['color']; timeoutMs?: number }): () => void
  pushLocal(title: string, lines: readonly string[]): void
  exportSession(): string | null
  initWorkspace(): string | null
  doctorInfo(): string[]
  mcpStatus(): string[]
  pluginsInfo(rawInput: string): string[]
  describeCredential(name: string): Promise<CredentialStatus | undefined>
  providerSetup(): ProviderSetupHost | undefined
  /** `/btw` side question: its answer is only meaningful to the session that
   *  asked, so a session swap mid-flight drops it. */
  sideQuestion(
    question: string,
    options?: { signal?: AbortSignal; onText?: (delta: string) => void },
  ): Promise<{ answer: string | null; error?: string } | undefined>
  /** Live session-event snapshot for the trajectory view's incremental fold. */
  traceEvents(): readonly SessionEvent[]
}

/** Plugin full-screen scene controls; descriptor creation stays host-owned. */
export interface TuiSceneCommands {
  openPluginScene(id: string): boolean
  closePluginScene(): void
}

/** Transcript window commands (M2.4): restore log-folded older rows. */
export interface TuiTranscriptCommands {
  /** Restore the folded-away older rows from the session log (channel
   *  `loadOlder`). The channel mutation itself is synchronous (restore +
   *  emit); the fence only guards the REPORTED count — a completion that
   *  settles after a session swap / lifecycle resume reads as `undefined`.
   *  Resolves to the number of restored rows (0 = nothing was folded). */
  loadOlder(): Promise<number | undefined>
}

/** Overlay panels (approval / questionnaire / plugin dialog): answer the
 *  pending ask. Unfenced by design (see the module header) — every method is
 *  a straight store passthrough and no-ops when no ask is pending. */
export interface TuiOverlayCommands {
  answerQuestion(selection: QuestionSelection): void
  cancelQuestion(): void
  decideApproval(outcome: 'allowed-once' | 'rejected'): void
  decideDialog(key: string, value: TuiDialogAnswer): void
  cancelDialog(key: string): void
  /** Local wizards (e.g. `/provider`) drive the same question panel the
   *  model-facing ask_user_question tool uses. Rejects when the UI stores are
   *  absent (headless hosts) — the wizard catches and reports 'failed'. */
  askQuestion(
    request: AskUserQuestionRequest,
    options?: { redact?: boolean },
  ): Promise<AskUserQuestionAnswer>
}

/** One `/theme` picker row (auto + built-in palettes + user themes). */
export interface ThemeOption {
  readonly name: string
  readonly displayName?: string
  readonly description?: string
  /** Preview colors (Theme color values) rendered as swatches by the picker. */
  readonly colors?: readonly string[]
}

/**
 * Display preferences (theme + UI language). Unlike every other group these
 * do NOT delegate to the channel: theme/language are UI-local module state
 * (src/theme.ts, src/i18n.ts) persisted under ~/.dsh-tui — the old
 * ThemeProvider owned the same writes. `setLang` additionally mirrors into
 * the settings service's `dsh-tui` namespace when one is mounted, so
 * `/settings` and the next boot agree (best effort; lang.json stays the
 * fallback). All methods are synchronous and unfenced: they mutate no
 * session state.
 */
export interface TuiDisplayCommands {
  /** The selectable theme catalog: `auto` first, then the built-in palettes,
   *  then user themes from ~/.dsh-tui/themes (sorted by name). */
  listThemes(): readonly ThemeOption[]
  /** The active theme name (module-level mirror in src/theme.ts). */
  currentTheme(): string
  /** Validate, persist (~/.dsh-tui/theme.json) and hot-swap a theme; false
   *  when the name is unknown or the preference cannot be written. */
  setTheme(name: string): boolean
  /** Persist (~/.dsh-tui/lang.json) and hot-swap the UI language, mirroring
   *  into the settings namespace when served; false when the preference file
   *  cannot be written. */
  setLang(lang: Lang): boolean
}

/** The sink a migrated component receives, grouped by consumer surface. */
export interface TuiCommands {
  readonly input: TuiInputCommands
  readonly session: TuiSessionCommands
  readonly model: TuiModelCommands
  readonly query: TuiQueryCommands
  readonly settings: TuiSettingsCommands
  readonly workspace: TuiWorkspaceCommands
  readonly info: TuiInfoCommands
  readonly scene: TuiSceneCommands
  readonly overlays: TuiOverlayCommands
  readonly display: TuiDisplayCommands
  /** Optional so pre-M2.4 partial test fakes keep type-checking; the real
   *  sink always provides it, and consumers must tolerate its absence. */
  readonly transcript?: TuiTranscriptCommands
}

export interface TuiCommandsDeps {
  readonly channel: Channel
  readonly fences: TuiFences
  /** The UI stores backing the `overlays` group. Optional so tests/headless
   *  hosts can build the sink without them (overlay methods then no-op). */
  readonly stores?: {
    readonly questions: QuestionStore
    readonly approvals?: ApprovalStore
    readonly dialogs?: TuiDialogStore
  }
}

/** Create the command sink over one channel + one fence source. */
export function createTuiCommands(deps: TuiCommandsDeps): TuiCommands {
  const { channel, fences, stores } = deps

  // User themes resolve through the module-level resolver in src/theme.ts;
  // the old ThemeProvider registered it at mount, the sink owns it now (one
  // sink per TUI boot, and the registration is idempotent).
  registerCustomThemeResolver(resolveCustomTheme)

  /**
   * Run an async channel read fenced by sessionEpoch/generation. A result or
   * rejection settling after either fence moved belongs to a session (or TUI
   * generation) the UI no longer shows: drop it as `undefined` and log once
   * instead of letting it reach a projection, an overlay or the transcript.
   */
  const fenced = <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
    const epoch = fences.sessionEpoch()
    const generation = fences.generation()
    const stale = (): boolean => fences.sessionEpoch() !== epoch || fences.generation() !== generation
    return run().then(
      (value) => {
        if (!stale()) return value
        logForDebugging('tui command result dropped (stale fences)', { command: label, epoch, generation })
        return undefined
      },
      (error: unknown) => {
        if (!stale()) throw error
        logForDebugging('tui command failure dropped (stale fences)', { command: label, epoch, generation })
        return undefined
      },
    )
  }

  /**
   * Fence a write/replacement command. Unlike a read, a SUCCESSFUL session
   * replacement legitimately moves `sessionEpoch` itself — the channel bumps
   * it once in the same commit that resolves the promise — so the epoch
   * expectation is `epoch + 1` when `committed(value)` holds and `epoch`
   * otherwise. Any other move (an interleaved swap, a lifecycle resume)
   * means this completion belongs to a session the UI no longer shows: drop
   * it as the command's neutral shape and log once, so the caller's
   * post-await follow-ups (toasts, picker closes, reloads) never commit.
   */
  const fencedWrite = <T>(
    label: string,
    committed: (value: T) => boolean,
    neutral: T,
    run: () => Promise<T>,
  ): Promise<T> => {
    const epoch = fences.sessionEpoch()
    const generation = fences.generation()
    const stale = (expectedEpoch: number): boolean =>
      fences.sessionEpoch() !== expectedEpoch || fences.generation() !== generation
    return run().then(
      (value) => {
        if (!stale(epoch + (committed(value) ? 1 : 0))) return value
        logForDebugging('tui command result dropped (stale fences)', { command: label, epoch, generation })
        return neutral
      },
      (error: unknown) => {
        // A rejection commits nothing, so the epoch must not have moved at all.
        if (!stale(epoch)) throw error
        logForDebugging('tui command failure dropped (stale fences)', { command: label, epoch, generation })
        return neutral
      },
    )
  }

  return {
    input: {
      submit(text) {
        channel.submit(text)
      },
      steer(text) {
        channel.steer(text)
      },
      cancel() {
        channel.cancel()
      },
      interruptAndDeliver(texts) {
        return channel.interruptAndDeliver(texts)
      },
      removePending(id) {
        return channel.removePending(id)
      },
      runExternalCommand(name, rawInput) {
        return channel.runExternalCommand(name, rawInput)
      },
    },
    session: {
      newSession() {
        // Success swaps the agent: the channel bumps sessionEpoch once in
        // the same commit, so the fence expects exactly that move.
        return fencedWrite('newSession', (ok) => ok, false, () => channel.newSession())
      },
      resumeTo(id) {
        return fencedWrite<ResumeResult>(
          'resumeTo',
          (result) => result.ok,
          { ok: false, reason: 'cancelled' },
          () => channel.resumeTo(id),
        )
      },
      deleteSession(id) {
        return channel.deleteSession(id)
      },
      renameSession(title) {
        channel.renameSession(title)
      },
      renameSessionTo(id, title) {
        return channel.renameSessionTo(id, title)
      },
      compact() {
        channel.compact()
      },
      clear() {
        channel.clear()
      },
      promptRewind(row) {
        return channel.promptRewind(row)
      },
      rewindTo(row, mode) {
        // A committed rewind forks the session: same single-epoch-bump
        // expectation as newSession/resumeTo; null (refused/failed) commits
        // nothing.
        return fencedWrite('rewindTo', (childId) => childId !== null, null, () => channel.rewindTo(row, mode))
      },
      rewindToNode(sessionId, seq, mode) {
        // Same fork shape as rewindTo: a committed node rewind/fork bumps the
        // epoch exactly once; null commits nothing.
        return fencedWrite('rewindToNode', (text) => text !== null, null, () => channel.rewindToNode(sessionId, seq, mode))
      },
      forkSession() {
        // The tip fork never swaps the live session (same no-self-bump shape
        // as setEffort): a moved epoch means an interleaved replacement —
        // drop the stale completion.
        return fencedWrite('forkSession', () => false, false, () => channel.forkSession())
      },
      listModes() {
        return channel.listModes()
      },
      setMode(id) {
        // No agent swap (same no-self-bump shape as setEffort).
        return fencedWrite('setMode', () => false, false, () => channel.setMode(id))
      },
      cycleMode() {
        void channel.cycleMode()
      },
    },
    model: {
      switchModel(provider, model) {
        // Success forks the conversation onto a new agent: one epoch bump.
        return fencedWrite('switchModel', (ok) => ok, false, () => channel.switchModel(provider, model))
      },
      listModels() {
        return fenced('listModels', () => channel.listModels())
      },
      switchPreset(id) {
        // Never swaps the agent (a locked session only saves the default):
        // no self-bump, so ANY epoch move during its flight is stale.
        return fencedWrite('switchPreset', () => false, false, () => channel.switchPreset(id))
      },
      listPresets() {
        return fenced('listPresets', () => channel.listPresets())
      },
      currentPreset() {
        return channel.agentPreset
      },
      setEffort(id) {
        // Same no-self-bump shape as switchPreset.
        return fencedWrite('setEffort', () => false, false, () => channel.setEffort(id))
      },
      listEfforts() {
        return fenced('listEfforts', () => channel.listEfforts())
      },
      setActivityFrames(name) {
        return channel.setActivityFrames(name)
      },
    },
    query: {
      listSessions() {
        return fenced('listSessions', () => channel.listSessions())
      },
      previewSession(id) {
        return fenced('previewSession', () => channel.previewSession(id))
      },
      getSessionTree() {
        return fenced('getSessionTree', () => channel.buildSessionTree())
      },
      listSkills() {
        return fenced('listSkills', () => channel.listSkills())
      },
      listFileCandidates(query, options) {
        return fenced('listFileCandidates', () => channel.listFileCandidates(query, options))
      },
      listFiles() {
        return fenced('listFiles', () => channel.listFiles())
      },
      commandCompletions(value) {
        return channel.commandCompletions(value)
      },
      stageImage(input) {
        return fenced('stageImage', () => channel.stageImage(input))
      },
      listSubagents() {
        return fenced('listSubagents', () => channel.listSubagents())
      },
      subagentInterrupt(id) {
        return channel.subagentControl.interrupt(id)
      },
    },
    settings: {
      settingsHost() {
        return channel.settingsHost()
      },
      settingsSections() {
        return channel.settingsSections()
      },
      subscribeSettingsSections(listener) {
        return channel.subscribeSettingsSections(listener)
      },
    },
    workspace: {
      listWorkspaces() {
        return fenced('listWorkspaces', () => channel.listWorkspaces())
      },
      switchWorkspace(target) {
        // Success delegates to the channel's newSession, which commits the
        // swap with one epoch bump; failure rolls back with none.
        return fencedWrite('switchWorkspace', (ok) => ok, false, () => channel.switchWorkspace(target))
      },
      renameWorkspace(title) {
        // Metadata write on the current workspace: no epoch move of its own.
        return fencedWrite('renameWorkspace', () => false, false, () => channel.renameWorkspace(title))
      },
      resolveWorkspace(uri) {
        return fenced('resolveWorkspace', () => channel.resolveWorkspace(uri))
      },
      runWorkspaceCommand(name, input) {
        return fenced('runWorkspaceCommand', () => channel.runWorkspaceCommand(name, input))
      },
      workspaceCommands() {
        return channel.workspaceCommands()
      },
    },
    info: {
      notify(text, options) {
        return channel.notify(text, options)
      },
      pushLocal(title, lines) {
        channel.pushLocal(title, lines)
      },
      exportSession() {
        return channel.exportSession()
      },
      initWorkspace() {
        return channel.initWorkspace()
      },
      doctorInfo() {
        return channel.doctorInfo()
      },
      mcpStatus() {
        return channel.mcpStatus()
      },
      pluginsInfo(rawInput) {
        return channel.pluginsInfo(rawInput)
      },
      describeCredential(name) {
        return fenced('describeCredential', () => channel.describeCredential(name))
      },
      providerSetup() {
        return channel.providerSetup()
      },
      sideQuestion(question, options) {
        return fenced('sideQuestion', () => channel.sideQuestion(question, options))
      },
      traceEvents() {
        return channel.traceEvents()
      },
    },
    scene: {
      openPluginScene(id) {
        return channel.openPluginScene(id)
      },
      closePluginScene() {
        channel.closePluginScene()
      },
    },
    transcript: {
      loadOlder() {
        // channel.loadOlder() is synchronous (restore + emit); wrapping it in
        // the read fence keeps the sink's stale-drop contract for the
        // reported count without changing when the mutation lands.
        return fenced('loadOlder', () => Promise.resolve(channel.loadOlder()))
      },
    },
    overlays: {
      answerQuestion(selection) {
        stores?.questions.answerCurrent(selection)
      },
      cancelQuestion() {
        stores?.questions.cancelCurrent()
      },
      decideApproval(outcome) {
        stores?.approvals?.decide(outcome)
      },
      decideDialog(key, value) {
        stores?.dialogs?.decide(key, value)
      },
      cancelDialog(key) {
        stores?.dialogs?.cancel(key)
      },
      askQuestion(request, options) {
        if (stores === undefined) {
          return Promise.reject(new Error('dsh-tui: question store is not wired into this host'))
        }
        return stores.questions.ask(request, options)
      },
    },
    display: {
      listThemes() {
        const option = (name: string, displayName: string, theme: Theme, description: string): ThemeOption => ({
          name,
          displayName,
          description,
          colors: SWATCH_KEYS.map(key => theme[key]),
        })
        const builtins = THEME_NAMES.map(name =>
          option(name, name, getTheme(name), t('theme-builtin-base', { name })))
        const custom = listCustomThemes()
          .filter(spec => spec.name !== AUTO_THEME_NAME)
          .map(spec =>
            option(spec.name, spec.displayName, buildTheme(spec), t('theme-user-base', { base: spec.base, name: spec.name })))
        return [
          option(AUTO_THEME_NAME, AUTO_THEME_NAME, getTheme(AUTO_THEME_NAME), t('theme-auto-base')),
          ...builtins,
          ...custom,
        ]
      },
      currentTheme() {
        return getActiveThemeName()
      },
      setTheme(name) {
        // Persist first (a choice that cannot be saved never silently
        // disappears), then hot swap the module-level palette. Switching to
        // `auto` keeps the boot-detected base: the imperative root owns no
        // OSC 11 querier, so the old ThemeProvider's live re-detection has
        // no equivalent here.
        if (!isThemeAvailable(name)) {
          logForDebugging(`theme "${name}" not found`)
          return false
        }
        if (!writeThemePref(name)) {
          logForDebugging('failed to write ~/.dsh-tui/theme.json')
          return false
        }
        setActiveThemeName(name)
        return true
      },
      setLang(lang) {
        const ok = writeLangPref(lang)
        applyI18nLang(lang)
        // Mirror into the settings service's dsh-tui namespace when served,
        // so /settings and the next boot see the same last-write-wins choice
        // (best effort; lang.json stays the fallback).
        const host = channel.settingsHost()
        const view = host?.listNamespaces().find(entry => entry.ns === 'dsh-tui')
        if (host !== undefined && view !== undefined) {
          void host.write('dsh-tui', [{ op: 'set', path: ['lang'], value: lang }], view.revision).catch(() => {})
        }
        return ok
      },
    },
  }
}
