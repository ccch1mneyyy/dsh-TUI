import type { ChannelState } from './types.js'

/**
 * The Channel installs its effectful command delegates atomically after every
 * specialist has been constructed.  Construction-time callers fail closed
 * rather than receiving a plausible no-op while the Channel is incomplete.
 */
export type ChannelActionDelegates = Pick<ChannelState,
  | 'commandCompletions'
  | 'loadOlder'
  | 'rewindTo'
  | 'rewindToNode'
  | 'forkSession'
  | 'resumeTo'
  | 'newSession'
  | 'listWorkspaces'
  | 'listWorkspaceRegistry'
  | 'removeWorkspace'
  | 'renameWorkspaceAt'
  | 'resolveWorkspace'
  | 'switchWorkspace'
  | 'renameWorkspace'
  | 'workspaceCommands'
  | 'runWorkspaceCommand'
  | 'switchModel'
  | 'listEfforts'
  | 'setEffort'
  | 'setDefaultEffort'
  | 'cycleMode'
  | 'runPermissionPreset'
  | 'clear'
  | 'setActivityFrames'
  | 'listPresets'
  | 'switchPreset'
  | 'listModels'
  | 'listProviders'
  | 'invalidateModelCompletion'
  | 'listSkills'
  | 'describeCredential'
  | 'balanceInfo'
  | 'sideQuestion'
  | 'listFileCandidates'
  | 'listFiles'
  | 'cachedSessions'
  | 'listSessions'
  | 'previewSession'
  | 'listForeignSources'
  | 'listForeignSessions'
  | 'importForeignSession'
  | 'bindApprovalStore'
  | 'agentViewRows'
  | 'subscribeAgentView'
  | 'dispatchBackgroundAgent'
  | 'stopBackgroundAgent'
  | 'attachToAgent'
  | 'peekAgentSession'
  | 'replyToAgent'
  | 'backgroundCurrent'
  | 'setResumeTarget'
  | 'renameSession'
  | 'setSessionColor'
  | 'recapRecent'
  | 'deleteSession'
  | 'renameSessionTo'
  | 'compact'
  | 'cancelCompact'
  | 'runExternalCommand'
  | 'runExternalCommandOutcome'
  | 'pushLocal'
  | 'mcpStatus'
  | 'exportSession'
  | 'initWorkspace'
  | 'doctorInfo'
  | 'pluginsInfo'
  | 'listSubagents'
> & {
  runLocalCommand(command: string, includeInContext: boolean): Promise<void>
}

type ChannelActionMethodName = Exclude<keyof ChannelActionDelegates, 'runLocalCommand'>
export type ChannelActionMethods = Pick<ChannelState, ChannelActionMethodName>

/** The ChannelState-facing half of the readiness cell is deliberately pure:
 * one typed forwarding method per public action, with no service access. */
export function createChannelActionMethods(
  getReadyActions: () => ChannelActionDelegates,
): ChannelActionMethods {
  return {
    commandCompletions: input => getReadyActions().commandCompletions(input),
    loadOlder: () => getReadyActions().loadOlder(),
    rewindTo: (row, mode = null) => getReadyActions().rewindTo(row, mode),
    rewindToNode: (sessionId, seq, mode = 'rewind') => getReadyActions().rewindToNode(sessionId, seq, mode),
    forkSession: () => getReadyActions().forkSession(),
    resumeTo: sessionId => getReadyActions().resumeTo(sessionId),
    newSession: () => getReadyActions().newSession(),
    listWorkspaces: () => getReadyActions().listWorkspaces(),
    listWorkspaceRegistry: () => getReadyActions().listWorkspaceRegistry(),
    removeWorkspace: path => getReadyActions().removeWorkspace(path),
    renameWorkspaceAt: (path, title) => getReadyActions().renameWorkspaceAt(path, title),
    resolveWorkspace: uri => getReadyActions().resolveWorkspace(uri),
    // Preserve ChannelUi's promise rejection contract after release: a caller
    // which already received this async method must observe a rejected promise,
    // not a synchronous throw from the readiness guard.
    async switchWorkspace(target) { return getReadyActions().switchWorkspace(target) },
    renameWorkspace: title => getReadyActions().renameWorkspace(title),
    workspaceCommands: () => getReadyActions().workspaceCommands(),
    runWorkspaceCommand: (name, input) => getReadyActions().runWorkspaceCommand(name, input),
    switchModel: (provider, model) => getReadyActions().switchModel(provider, model),
    listEfforts: route => getReadyActions().listEfforts(route),
    setEffort: id => getReadyActions().setEffort(id),
    setDefaultEffort: id => getReadyActions().setDefaultEffort(id),
    cycleMode: () => getReadyActions().cycleMode(),
    runPermissionPreset: name => getReadyActions().runPermissionPreset(name),
    clear: () => getReadyActions().clear(),
    setActivityFrames: name => getReadyActions().setActivityFrames(name),
    listPresets: () => getReadyActions().listPresets(),
    switchPreset: presetId => getReadyActions().switchPreset(presetId),
    listModels: () => getReadyActions().listModels(),
    listProviders: () => getReadyActions().listProviders(),
    invalidateModelCompletion: () => getReadyActions().invalidateModelCompletion(),
    listSkills: () => getReadyActions().listSkills(),
    describeCredential: ref => getReadyActions().describeCredential(ref),
    balanceInfo: () => getReadyActions().balanceInfo(),
    sideQuestion: (question, options) => getReadyActions().sideQuestion(question, options),
    listFileCandidates: (query, options) => getReadyActions().listFileCandidates(query, options),
    listFiles: () => getReadyActions().listFiles(),
    cachedSessions: () => getReadyActions().cachedSessions(),
    listSessions: (onEnriched, onPartial) => getReadyActions().listSessions(onEnriched, onPartial),
    previewSession: sessionId => getReadyActions().previewSession(sessionId),
    listForeignSources: () => getReadyActions().listForeignSources(),
    listForeignSessions: (agentId, onRow) => getReadyActions().listForeignSessions(agentId, onRow),
    importForeignSession: (agentId, key) => getReadyActions().importForeignSession(agentId, key),
    bindApprovalStore: store => getReadyActions().bindApprovalStore(store),
    agentViewRows: () => getReadyActions().agentViewRows(),
    subscribeAgentView: listener => getReadyActions().subscribeAgentView(listener),
    dispatchBackgroundAgent: prompt => getReadyActions().dispatchBackgroundAgent(prompt),
    stopBackgroundAgent: sessionId => getReadyActions().stopBackgroundAgent(sessionId),
    attachToAgent: sessionId => getReadyActions().attachToAgent(sessionId),
    peekAgentSession: sessionId => getReadyActions().peekAgentSession(sessionId),
    replyToAgent: (sessionId, text) => getReadyActions().replyToAgent(sessionId, text),
    backgroundCurrent: () => getReadyActions().backgroundCurrent(),
    setResumeTarget: sessionId => getReadyActions().setResumeTarget(sessionId),
    renameSession: title => getReadyActions().renameSession(title),
    setSessionColor: color => getReadyActions().setSessionColor(color),
    recapRecent: options => getReadyActions().recapRecent(options),
    deleteSession: sessionId => getReadyActions().deleteSession(sessionId),
    renameSessionTo: (sessionId, title) => getReadyActions().renameSessionTo(sessionId, title),
    compact: () => getReadyActions().compact(),
    cancelCompact: () => getReadyActions().cancelCompact(),
    runExternalCommand: (name, rawInput) => getReadyActions().runExternalCommand(name, rawInput),
    runExternalCommandOutcome: (name, rawInput, images) => getReadyActions().runExternalCommandOutcome(name, rawInput, images),
    pushLocal: (title, lines) => getReadyActions().pushLocal(title, lines),
    mcpStatus: () => getReadyActions().mcpStatus(),
    exportSession: () => getReadyActions().exportSession(),
    initWorkspace: () => getReadyActions().initWorkspace(),
    doctorInfo: () => getReadyActions().doctorInfo(),
    pluginsInfo: args => getReadyActions().pluginsInfo(args),
    listSubagents: () => getReadyActions().listSubagents(),
  }
}

export function createChannelActionReadiness() {
  let delegates: ChannelActionDelegates | undefined
  return {
    install(next: ChannelActionDelegates): void {
      if (delegates !== undefined) throw new Error('dsh-tui: Channel actions are already installed')
      delegates = Object.freeze(next)
    },
    getReadyActions(): ChannelActionDelegates {
      if (delegates === undefined) throw new Error('dsh-tui: Channel actions are not installed')
      return delegates
    },
  }
}

/**
 * The explicit-unavailable half of a non-DSH composition: one delegate per
 * public action, each failing per its own contract (`false`, `null`,
 * `undefined`, an empty list or an `{ ok: false }` result) and, for an
 * action the user invoked, saying so through `unavailable(name)` (which
 * notifies `capability-unavailable-backend`). Nothing here pretends to succeed.
 *
 * Passive reads the renderer performs on its own (agent-view rows and their
 * subscription, the cached session list, workspace sub-commands, cache
 * invalidation, approval-store wiring) answer with their empty value
 * silently: they are not user actions, and a toast per render would be
 * noise. The composition overrides the generic actions (submit path, clear,
 * local rows, file queries, completions, `/new`, `/doctor`) and every action
 * whose capability the session does have.
 */
export function createUnavailableActionDelegates(
  unavailable: (name: string) => void,
  unavailableLines: (name: string) => string[],
): ChannelActionDelegates {
  const refuse = <T>(name: string, value: T): T => {
    unavailable(name)
    return value
  }
  const refuseAsync = <T>(name: string, value: T): Promise<T> => Promise.resolve(refuse(name, value))
  return {
    commandCompletions: () => [],
    runLocalCommand: () => refuseAsync('shell', undefined),
    runPermissionPreset: () => refuseAsync('permission', false),
    loadOlder: () => 0,
    rewindTo: () => refuseAsync('rewind', null),
    rewindToNode: () => refuseAsync('tree', null),
    forkSession: () => refuseAsync('fork', false),
    resumeTo: () => refuseAsync('resume', { ok: false, reason: 'unavailable' } as const),
    newSession: () => refuseAsync('new', false),
    listWorkspaces: () => refuseAsync('workspace', []),
    listWorkspaceRegistry: () => refuseAsync('workspace', []),
    removeWorkspace: () => refuseAsync('workspace', false),
    renameWorkspaceAt: () => refuseAsync('workspace', false),
    resolveWorkspace: () => refuseAsync('workspace', undefined),
    switchWorkspace: () => refuseAsync('workspace', false),
    renameWorkspace: () => refuseAsync('workspace', false),
    workspaceCommands: () => [],
    runWorkspaceCommand: () => refuseAsync('workspace', undefined),
    switchModel: () => refuseAsync('model', false),
    listEfforts: () => refuseAsync('effort', { efforts: [], defaultEffort: undefined }),
    setEffort: () => refuseAsync('effort', false),
    // Silent: the settings layer applies the configured default on every
    // boot (not a user action), and a toast per launch would be noise.
    setDefaultEffort: () => undefined,
    cycleMode: () => refuseAsync('mode', undefined),
    clear: () => { unavailable('clear') },
    setActivityFrames: () => refuse('activity', false),
    listPresets: () => refuseAsync('preset', []),
    switchPreset: () => refuseAsync('preset', false),
    listModels: () => refuseAsync('model', []),
    listProviders: () => refuseAsync('provider', []),
    invalidateModelCompletion: () => undefined,
    listSkills: () => refuseAsync('skills', undefined),
    describeCredential: () => refuseAsync('login', undefined),
    // No DeepSeek account stands behind this backend: report the key as
    // absent rather than inventing a network/HTTP failure.
    balanceInfo: () => refuseAsync('balance', { ok: false, reason: 'no-key' } as const),
    sideQuestion: () => {
      unavailable('btw')
      return Promise.resolve({ answer: null, error: unavailableLines('btw').join(' ') })
    },
    listFileCandidates: () => Promise.resolve([]),
    listFiles: () => Promise.resolve([]),
    cachedSessions: () => undefined,
    listSessions: () => refuseAsync('resume', []),
    previewSession: () => refuseAsync('resume', []),
    listForeignSources: () => refuseAsync('migrate', []),
    listForeignSessions: () => refuseAsync('migrate', []),
    importForeignSession: () => refuseAsync('migrate', { kind: 'failed', reason: 'unknown-source' } as const),
    bindApprovalStore: () => undefined,
    agentViewRows: () => NO_AGENT_VIEW_ROWS,
    subscribeAgentView: () => () => undefined,
    dispatchBackgroundAgent: () => refuseAsync('agentview', { ok: false, reason: 'unavailable' } as const),
    stopBackgroundAgent: () => refuseAsync('agentview', false),
    attachToAgent: () => refuseAsync('agentview', { ok: false, reason: 'unavailable' } as const),
    peekAgentSession: () => refuseAsync('agentview', []),
    replyToAgent: () => refuseAsync('agentview', false),
    backgroundCurrent: () => refuseAsync('bg', { ok: false } as const),
    setResumeTarget: () => { unavailable('resume') },
    renameSession: () => { unavailable('rename') },
    setSessionColor: () => { unavailable('color') },
    recapRecent: () => {
      unavailable('recap')
      return Promise.resolve({ summary: null, error: unavailableLines('recap').join(' ') })
    },
    deleteSession: () => refuseAsync('resume', false),
    renameSessionTo: () => refuseAsync('rename', false),
    compact: () => { unavailable('compact') },
    // Contract: a no-op when this process runs no compaction it may abort.
    cancelCompact: () => undefined,
    // Contract: `undefined` = no such registry command, so the caller sends
    // the line to the model — exactly what a backend with its own command
    // set (Claude's native slash commands) needs.
    runExternalCommand: () => Promise.resolve(undefined),
    runExternalCommandOutcome: () => Promise.resolve(undefined),
    pushLocal: () => { unavailable('pushLocal') },
    // The report lines are the explicit answer for these three reports.
    mcpStatus: () => unavailableLines('mcp'),
    exportSession: () => refuse('export', null),
    initWorkspace: () => refuse('init', null),
    doctorInfo: () => unavailableLines('doctor'),
    pluginsInfo: () => unavailableLines('plugins'),
    listSubagents: () => Promise.resolve(unavailableLines('agents')),
  }
}

/** Stable empty agent-view snapshot (useSyncExternalStore needs one reference). */
const NO_AGENT_VIEW_ROWS: readonly never[] = Object.freeze([])
