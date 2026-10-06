/**
 * The one entry to the vendored app-server protocol (docs/codex-backend-design.md
 * D3): the generated types this backend annotates call sites with, and the
 * method-name tables every dispatcher switches on. The tables are checked
 * against the generated unions twice: by `tsc` (`satisfies`) and by
 * `verify:codex-contract`, which also rejects a protocol-shaped string
 * literal anywhere in the backend that is not a generated method name.
 *
 * Types only beyond the tables: nothing here is read at run time without
 * narrowing (`../narrow.ts`).
 */
import type { ClientNotification } from './generated/ClientNotification.js'
import type { ClientRequest } from './generated/ClientRequest.js'
import type { ServerNotification } from './generated/ServerNotification.js'
import type { ServerRequest } from './generated/ServerRequest.js'

export type { ClientInfo } from './generated/ClientInfo.js'
export type { ClientNotification } from './generated/ClientNotification.js'
export type { ClientRequest } from './generated/ClientRequest.js'
export type { InitializeCapabilities } from './generated/InitializeCapabilities.js'
export type { InitializeParams } from './generated/InitializeParams.js'
export type { InitializeResponse } from './generated/InitializeResponse.js'
export type { RequestId } from './generated/RequestId.js'
export type { ServerNotification } from './generated/ServerNotification.js'
export type { ServerRequest } from './generated/ServerRequest.js'
export type { AccountRateLimitsUpdatedNotification } from './generated/v2/AccountRateLimitsUpdatedNotification.js'
export type { CommandAction } from './generated/v2/CommandAction.js'
export type { CommandExecutionApprovalDecision } from './generated/v2/CommandExecutionApprovalDecision.js'
export type { CommandExecutionRequestApprovalParams } from './generated/v2/CommandExecutionRequestApprovalParams.js'
export type { CommandExecutionRequestApprovalResponse } from './generated/v2/CommandExecutionRequestApprovalResponse.js'
export type { ErrorNotification } from './generated/v2/ErrorNotification.js'
export type { FileChangeApprovalDecision } from './generated/v2/FileChangeApprovalDecision.js'
export type { FileChangeRequestApprovalParams } from './generated/v2/FileChangeRequestApprovalParams.js'
export type { FileChangeRequestApprovalResponse } from './generated/v2/FileChangeRequestApprovalResponse.js'
export type { FileUpdateChange } from './generated/v2/FileUpdateChange.js'
export type { PermissionsRequestApprovalParams } from './generated/v2/PermissionsRequestApprovalParams.js'
export type { PermissionsRequestApprovalResponse } from './generated/v2/PermissionsRequestApprovalResponse.js'
export type { ThreadItem } from './generated/v2/ThreadItem.js'
export type { ThreadResumeParams } from './generated/v2/ThreadResumeParams.js'
export type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse.js'
export type { ThreadStartParams } from './generated/v2/ThreadStartParams.js'
export type { ThreadStartResponse } from './generated/v2/ThreadStartResponse.js'
export type { ThreadTokenUsageUpdatedNotification } from './generated/v2/ThreadTokenUsageUpdatedNotification.js'
export type { ThreadTurnsListParams } from './generated/v2/ThreadTurnsListParams.js'
export type { ThreadTurnsListResponse } from './generated/v2/ThreadTurnsListResponse.js'
export type { ToolRequestUserInputParams } from './generated/v2/ToolRequestUserInputParams.js'
export type { ToolRequestUserInputResponse } from './generated/v2/ToolRequestUserInputResponse.js'
export type { Turn } from './generated/v2/Turn.js'
export type { TurnInterruptParams } from './generated/v2/TurnInterruptParams.js'
export type { TurnStartParams } from './generated/v2/TurnStartParams.js'
export type { TurnStartResponse } from './generated/v2/TurnStartResponse.js'
export type { TurnSteerParams } from './generated/v2/TurnSteerParams.js'
export type { TurnSteerResponse } from './generated/v2/TurnSteerResponse.js'
export type { UserInput } from './generated/v2/UserInput.js'

/** Client → server requests and notifications the backend sends. */
export const CLIENT = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadFork: 'thread/fork',
  threadUnsubscribe: 'thread/unsubscribe',
  threadList: 'thread/list',
  threadRead: 'thread/read',
  threadTurnsList: 'thread/turns/list',
  threadNameSet: 'thread/name/set',
  threadArchive: 'thread/archive',
  threadCompactStart: 'thread/compact/start',
  threadSettingsUpdate: 'thread/settings/update',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  modelList: 'model/list',
  configRead: 'config/read',
  accountRead: 'account/read',
  accountLoginStart: 'account/login/start',
} as const satisfies Readonly<Record<string, ClientRequest['method'] | ClientNotification['method']>>

/** Server notifications the backend reads. */
export const NOTIFY = {
  error: 'error',
  threadStarted: 'thread/started',
  threadStatusChanged: 'thread/status/changed',
  threadArchived: 'thread/archived',
  threadDeleted: 'thread/deleted',
  threadClosed: 'thread/closed',
  threadNameUpdated: 'thread/name/updated',
  threadSettingsUpdated: 'thread/settings/updated',
  threadTokenUsageUpdated: 'thread/tokenUsage/updated',
  threadCompacted: 'thread/compacted',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  turnDiffUpdated: 'turn/diff/updated',
  turnPlanUpdated: 'turn/plan/updated',
  hookStarted: 'hook/started',
  hookCompleted: 'hook/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  planDelta: 'item/plan/delta',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  reasoningSummaryPartAdded: 'item/reasoning/summaryPartAdded',
  reasoningTextDelta: 'item/reasoning/textDelta',
  commandOutputDelta: 'item/commandExecution/outputDelta',
  terminalInteraction: 'item/commandExecution/terminalInteraction',
  mcpToolCallProgress: 'item/mcpToolCall/progress',
  serverRequestResolved: 'serverRequest/resolved',
  autoApprovalReviewStarted: 'item/autoApprovalReview/started',
  autoApprovalReviewCompleted: 'item/autoApprovalReview/completed',
  strictReviewRequired: 'autoApprovalReview/strictReviewRequired',
  accountRateLimitsUpdated: 'account/rateLimits/updated',
  accountUpdated: 'account/updated',
  accountLoginCompleted: 'account/login/completed',
  mcpServerStartupStatusUpdated: 'mcpServer/startupStatus/updated',
  skillsChanged: 'skills/changed',
  modelRerouted: 'model/rerouted',
  modelVerification: 'model/verification',
  warning: 'warning',
  guardianWarning: 'guardianWarning',
  configWarning: 'configWarning',
  deprecationNotice: 'deprecationNotice',
} as const satisfies Readonly<Record<string, ServerNotification['method']>>

/** Server → client requests the backend answers. */
export const SERVER_REQUEST = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  userInput: 'item/tool/requestUserInput',
  elicitation: 'mcpServer/elicitation/request',
  dynamicToolCall: 'item/tool/call',
  chatgptAuthTokensRefresh: 'account/chatgptAuthTokens/refresh',
  attestation: 'attestation/generate',
  currentTime: 'currentTime/read',
  legacyApplyPatchApproval: 'applyPatchApproval',
  legacyExecCommandApproval: 'execCommandApproval',
} as const satisfies Readonly<Record<string, ServerRequest['method']>>

/**
 * High-rate notifications the backend never reads, suppressed at
 * `initialize` (`optOutNotificationMethods`): raw response items, file
 * watches, realtime, fuzzy search, external-agent import, the app list.
 */
export const OPT_OUT_NOTIFICATIONS = [
  'rawResponseItem/completed',
  'rawResponse/completed',
  'fs/changed',
  'thread/realtime/started',
  'thread/realtime/itemAdded',
  'thread/realtime/item/started',
  'thread/realtime/item/transcript/delta',
  'thread/realtime/item/completed',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/error',
  'thread/realtime/closed',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
  'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed',
  'app/list/updated',
] as const satisfies readonly ServerNotification['method'][]

/** Every name in the tables above (the contract gate's input). */
export const PROTOCOL_NAMES = {
  client: Object.values(CLIENT),
  notifications: [...Object.values(NOTIFY), ...OPT_OUT_NOTIFICATIONS],
  serverRequests: Object.values(SERVER_REQUEST),
} as const
