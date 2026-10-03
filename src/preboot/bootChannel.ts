/**
 * The boot-phase `ChannelUi`: what the real `Chat` renders against while dsh
 * is still composing the profile (`dst` fast start).
 *
 * `ready` is false, the transcript is empty, and every member of the port has
 * a deliberate boot-time answer: display properties come from the same
 * settings layer the plugin will read, queries return their neutral value,
 * actions that would need a session refuse with a "not ready" notice and
 * otherwise do nothing. Notifications are live — the composer's Enter and
 * Ctrl+C notices ride them — and so is `subscribe`.
 *
 * Both tables below are typed as exhaustive mappings over the port, so a
 * member added to `ChannelUi` fails to compile here until it gets a boot
 * answer. That is the whole point: the boot screen can never fall behind
 * the live one, because there is no second screen — only a second channel.
 *
 * This module never imports `@deepseek-ai/*`: it must be cheap to load
 * before dsh does.
 */
import type { AgentCapabilities } from '../adapter/ports/channel-capabilities.js'
import type { ChannelUi } from '../adapter/ports/channel-ui.js'
import type { NotificationItem } from '../adapter/ports/channel-view.js'
import { completeCommands, LOCAL_COMMANDS } from '../commands.js'
import { normalizeSplashFont } from '../components/splashFonts.js'
import { t } from '../i18n.js'
import { DEFAULT_SESSION_MODES } from '../sessionModes.js'
import {
  normalizeJobGroupFold,
  normalizePageMargin,
  normalizeScrollGutter,
  normalizeStatusBar,
  normalizeToolBackground,
} from '../tuiDisplayPrefs.js'

type MethodKeys<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T]
type PropertyKeys = Exclude<keyof ChannelUi, MethodKeys<ChannelUi>>
type BootProperties = { -readonly [K in PropertyKeys]: ChannelUi[K] }
type BootMethods = { [K in MethodKeys<ChannelUi>]: ChannelUi[K] }

/** What the boot channel knows before dsh runs: display settings + last-used route. */
export interface BootSnapshot {
  model: string
  effort: string | undefined
  cwd: string
  gitBranch: string | undefined
  /** The `dsh-tui:` settings layer, loosely typed (missing keys → defaults). */
  settings: Readonly<Record<string, unknown>>
}

export interface BootChannel extends ChannelUi {
  /** Test seam: the notifications currently shown. */
  readonly notifications: readonly NotificationItem[]
}

const bool = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback
const BOOT_CAPABILITIES: AgentCapabilities = Object.freeze({
  compact: Object.freeze({ route: 'local' }),
  plan: Object.freeze({ route: 'registry' }),
  compaction: true,
  pruner: true,
  questionTool: true,
  skills: true,
})
const ZERO_BUCKET = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
// Snapshot-returning queries feed `useSyncExternalStore`, which re-renders
// until two consecutive reads are identical: hand back the same frozen
// empties every time, never a fresh array.
const NO_ROWS: readonly never[] = Object.freeze([])

/**
 * Build the boot channel. `ready` is false for its whole life: the deferred
 * wrapper swaps the live channel in underneath the screen instead of ever
 * flipping this one.
 */
export function createBootChannel(snapshot: BootSnapshot): BootChannel {
  const settings = snapshot.settings
  const listeners = new Set<() => void>()
  let version = 0
  let notifications: NotificationItem[] = []
  let nextNotificationId = 1
  const emit = (): void => {
    version += 1
    for (const listener of [...listeners]) listener()
  }
  const notify: ChannelUi['notify'] = (text, options) => {
    const id = nextNotificationId++
    const timeoutMs = options?.timeoutMs ?? 4000
    notifications = [...notifications, { id, text, color: options?.color, timeoutMs }]
    emit()
    let timer: ReturnType<typeof setTimeout> | undefined
    const dismiss = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (!notifications.some(item => item.id === id)) return
      notifications = notifications.filter(item => item.id !== id)
      emit()
    }
    if (timeoutMs > 0) {
      timer = setTimeout(dismiss, timeoutMs)
      timer.unref?.()
    }
    return dismiss
  }
  /** The uniform answer to an action that needs a session. */
  const refuse = (): void => {
    notify(t('preboot-not-ready'), { color: 'warning', timeoutMs: 2500 })
  }
  const refused = <T>(value: T): T => {
    refuse()
    return value
  }
  const refusedAsync = <T>(value: T): Promise<T> => Promise.resolve(refused(value))

  const properties: BootProperties = {
    get version() {
      return version
    },
    ready: false,
    rows: [],
    selection: undefined,
    status: 'starting',
    sessionTitle: '',
    sessionColor: '',
    // No agent yet: the status line hides its `#id` field on an empty id,
    // and Chat's session-switch effects treat the arrival of the live agent
    // id as adoption rather than a switch (see `ready` there).
    agentId: '',
    sessionId: '',
    agentBindingGeneration: 0,
    autoRecapOnOpen: false,
    settingsNamespace: 'dsh-tui',
    model: snapshot.model,
    provider: '',
    configuredProvider: undefined,
    configuredModel: undefined,
    configuredPreset: undefined,
    configuredActivityFrames: undefined,
    configuredLang: undefined,
    tokens: { ...ZERO_BUCKET, peak: { ...ZERO_BUCKET }, idle: { ...ZERO_BUCKET } },
    mainCost: {},
    subagentCost: [],
    cwd: snapshot.cwd,
    displayCwd: snapshot.cwd,
    gitBranch: snapshot.gitBranch,
    working: false,
    compaction: undefined,
    cancelPending: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    get notifications() {
      return notifications
    },
    contextWindow: undefined,
    contextOccupancy: undefined,
    attachedContexts: NO_ROWS,
    reasoningEffort: snapshot.effort,
    effortLevels: undefined,
    lastUsage: undefined,
    tps: undefined,
    tpsSamples: [],
    activityFrames: undefined,
    diffLayout: 'auto',
    thinkingFold: 'preview',
    jobGroupFold: normalizeJobGroupFold(settings.jobGroupFold),
    toolBackground: normalizeToolBackground(settings.toolBackground),
    scrollGutter: normalizeScrollGutter(settings.scrollGutter),
    pageMargin: normalizePageMargin(settings.pageMargin),
    foldTerminalCommand: bool(settings.foldTerminalCommand, false),
    promptSessionLabel: bool(settings.promptSessionLabel, false),
    expandEditor: bool(settings.expandEditor, true),
    smoothStreaming: bool(settings.smoothStreaming, true),
    statusBar: normalizeStatusBar(settings.statusBar),
    whale: bool(settings.whale, true),
    whaleIdle: bool(settings.whaleIdle, true),
    whaleGirl: bool(settings.whaleGirl, false),
    splashFont: normalizeSplashFont(settings.splashFont),
    // Settings key `minimal` (never renamed) drives the minimal-UI flag; the
    // deprecated `minimal` alias mirrors it (the boot channel never mutates).
    minimalUi: bool(settings.minimal, false),
    minimal: bool(settings.minimal, false),
    activityEnabled: true,
    contextBarEnabled: true,
    goal: undefined,
    todos: [],
    loadedContext: undefined,
    pending: [],
    commandList: LOCAL_COMMANDS,
    pluginScene: undefined,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subagents: [],
    subagentControl: { interrupt: () => false },
    backgroundJobs: [],
    jobControl: { kill: () => false },
    mode: DEFAULT_SESSION_MODES[0]!,
    modeIndex: 0,
    agentPreset: undefined,
  }

  const methods: BootMethods = {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notify,
    // ── composer ─────────────────────────────────────────────────────────
    // The composer refuses Enter itself while `ready` is false (the draft
    // stays put); these are the backstop for any other caller.
    submit: () => refuse(),
    steer: () => refuse(),
    removePending: () => false,
    // ── panel contexts (no session to attach them to yet) ────────────────
    attachContext: () => refuse(),
    detachContext: () => {},
    cancel: () => {},
    interruptAndDeliver: () => refused(0),
    commandCompletions: input => completeCommands(input, LOCAL_COMMANDS),
    // No agent yet: report the full composition so Help and `/` completion do
    // not mark entries unavailable for the boot frames and then flip back.
    // Every route still refuses below until the live channel takes over.
    capabilities: () => BOOT_CAPABILITIES,
    runExternalCommand: () => refusedAsync(undefined),
    runExternalCommandOutcome: () => refusedAsync(undefined),
    // ── staged images (no attachment service yet) ────────────────────────
    stagedImageGeneration: () => 0,
    stageImage: () => refusedAsync(''),
    stageComposerImage: () => refusedAsync({ stageId: '' }),
    hasStagedImage: () => false,
    discardStagedImage: () => {},
    stagedImage: () => undefined,
    stagedImageLimits: () => undefined,
    // ── session navigation ───────────────────────────────────────────────
    rewindTo: () => refusedAsync(null),
    promptRewind: () => Promise.resolve('cancel'),
    buildSessionTree: () => refusedAsync(null),
    rewindToNode: () => refusedAsync(null),
    forkSession: () => refusedAsync(false),
    resumeTo: () => refusedAsync({ ok: false, reason: 'unavailable' }),
    newSession: () => refusedAsync(false),
    listWorkspaces: () => Promise.resolve([]),
    listWorkspaceRegistry: () => Promise.resolve([]),
    removeWorkspace: () => refusedAsync(false),
    renameWorkspaceAt: () => refusedAsync(false),
    resolveWorkspace: () => Promise.resolve(undefined),
    switchWorkspace: () => refusedAsync(false),
    renameWorkspace: () => refusedAsync(false),
    workspaceCommands: () => NO_ROWS,
    runWorkspaceCommand: () => refusedAsync(undefined),
    // ── route / mode / preset ────────────────────────────────────────────
    switchModel: () => refusedAsync(false),
    listEfforts: () => Promise.resolve({ efforts: [], defaultEffort: undefined }),
    setEffort: () => refusedAsync(false),
    setDefaultEffort: () => {},
    cycleMode: () => refusedAsync(undefined),
    permissionPresets: () => ({ availability: 'unavailable', options: [] }),
    runPermissionPreset: () => refusedAsync(false),
    listPresets: () => Promise.resolve([]),
    switchPreset: () => refusedAsync(false),
    // ── transcript / notices ─────────────────────────────────────────────
    clear: () => {},
    loadOlder: () => 0,
    setActivityFrames: () => false,
    pushLocal: () => {},
    // ── catalogs ─────────────────────────────────────────────────────────
    listModels: () => Promise.resolve([]),
    listProviders: () => Promise.resolve([]),
    invalidateModelCompletion: () => {},
    listSkills: () => Promise.resolve(undefined),
    describeCredential: () => Promise.resolve(undefined),
    balanceInfo: () => refusedAsync({ ok: false, reason: 'network' }),
    providerSetup: () => undefined,
    oauthProviderStatuses: () => Promise.resolve(undefined),
    settingsHost: () => undefined,
    settingsSections: () => NO_ROWS,
    subscribeSettingsSections: () => () => {},
    listFileCandidates: () => Promise.resolve([]),
    listFiles: () => Promise.resolve([]),
    // ── persisted sessions ───────────────────────────────────────────────
    cachedSessions: () => undefined,
    listSessions: () => Promise.resolve([]),
    listForeignSources: () => Promise.resolve([]),
    listForeignSessions: () => Promise.resolve([]),
    importForeignSession: () => refusedAsync({ kind: 'failed', reason: 'unknown-source' }),
    previewSession: () => Promise.resolve([]),
    setResumeTarget: () => {},
    renameSession: () => refuse(),
    setSessionColor: () => refuse(),
    recapRecent: () => refusedAsync({ summary: null, error: t('preboot-not-ready') }),
    deleteSession: () => refusedAsync(false),
    renameSessionTo: () => refusedAsync(false),
    compact: () => refuse(),
    cancelCompact: () => {},
    // ── diagnostics ──────────────────────────────────────────────────────
    mcpStatus: () => [],
    exportSession: () => refused(null),
    initWorkspace: () => refused(null),
    doctorInfo: () => [],
    pluginsInfo: () => [],
    listSubagents: () => Promise.resolve([]),
    // ── agent view ───────────────────────────────────────────────────────
    agentViewRows: () => NO_ROWS,
    subscribeAgentView: () => () => {},
    dispatchBackgroundAgent: () => refusedAsync({ ok: false, reason: 'unavailable' }),
    stopBackgroundAgent: () => refusedAsync(false),
    attachToAgent: () => refusedAsync({ ok: false, reason: 'unavailable' }),
    peekAgentSession: () => Promise.resolve([]),
    backgroundCurrent: () => refusedAsync({ ok: false }),
    replyToAgent: () => refusedAsync(false),
    traceEvents: () => NO_ROWS,
    sideQuestion: () => refusedAsync({ answer: null, error: t('preboot-not-ready') }),
    // ── plugin scenes ────────────────────────────────────────────────────
    openPluginScene: () => false,
    closePluginScene: () => {},
    // ── display preferences (the settings screen is unreachable before
    //    ready; these keep the port satisfied) ───────────────────────────
    setDiffLayout: () => {},
    setThinkingFold: () => {},
    setJobGroupFold: () => {},
    setToolBackground: () => {},
    setScrollGutter: () => {},
    setPageMargin: () => {},
    setFoldTerminalCommand: () => {},
    setPromptSessionLabel: () => {},
    setExpandEditor: () => {},
    setSmoothStreaming: () => {},
    setStatusBar: () => {},
    setWhale: () => {},
    setWhaleIdle: () => {},
    setWhaleGirl: () => {},
    setSplashFont: () => {},
    setMinimalUi: () => {},
    setMinimal: () => {},
  }

  // Getters (`version`, `notifications`) must survive the merge: copy the
  // property descriptors instead of spreading values.
  const channel = Object.create(null) as Record<string, unknown>
  Object.defineProperties(channel, Object.getOwnPropertyDescriptors(properties))
  Object.assign(channel, methods)
  return Object.freeze(channel) as unknown as BootChannel
}
