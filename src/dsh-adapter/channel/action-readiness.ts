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
  | 'listSessions'
  | 'previewSession'
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
    resolveWorkspace: uri => getReadyActions().resolveWorkspace(uri),
    // Preserve ChannelUi's promise rejection contract after release: a caller
    // which already received this async method must observe a rejected promise,
    // not a synchronous throw from the readiness guard.
    async switchWorkspace(target) { return getReadyActions().switchWorkspace(target) },
    renameWorkspace: title => getReadyActions().renameWorkspace(title),
    workspaceCommands: () => getReadyActions().workspaceCommands(),
    runWorkspaceCommand: (name, input) => getReadyActions().runWorkspaceCommand(name, input),
    switchModel: (provider, model) => getReadyActions().switchModel(provider, model),
    listEfforts: () => getReadyActions().listEfforts(),
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
    listSessions: () => getReadyActions().listSessions(),
    previewSession: sessionId => getReadyActions().previewSession(sessionId),
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
