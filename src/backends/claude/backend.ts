/**
 * The Claude Agent backend: detection (SDK importable? executable found?
 * validated versions? a credential?), session creation and resume with the
 * credential plan of auth.ts, and the offline session catalog (catalog.ts).
 *
 * Resume: the session's record is looked up (its recorded working
 * directory is where the CLI must run), its model-visible transcript and
 * subagent transcripts are read and replayed (replay.ts), and only then is
 * the CLI started with `resume` — the replay fixes the turn / sequence
 * numbering the live session continues from. An unknown id or a transcript
 * the CLI refuses fails loudly; nothing falls back to a fresh session.
 */
import { randomUUID } from 'node:crypto'
import type { AgentBackend, BackendDetection, BackendHost, OpenTarget } from '../../agent/backend.js'
import type { AgentSession } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { CLAUDE_BACKEND_ID, CLAUDE_BACKEND_LABEL, cliVersionDrift, sdkVersionDrift, VALIDATED_SDK_VERSION } from './contract.js'
import { CLAUDE_OAUTH_PROVIDER, ClaudeChannelConflictError, channelMissingCredential, detectClaudeAuth, originHost, refreshFailureDebugDetail, refreshFailureStatus, resolveClaudeAuth, type ClaudeChannelConnectionInput, type ClaudeRouteSettings } from './auth.js'
import { createClaudeCatalog } from './catalog.js'
import { resolveStartPermissionMode, type StartPermissionMode } from './options.js'
import { fileClaudePrefs, type ClaudePrefs } from './prefs.js'
import { buildClaudeEnv, readClaudeVersion, resolveClaudeExecutable } from './process.js'
import { activeProfileOf, fileClaudeChannels, hasChannelConnection, type ClaudeChannelProfile, type ClaudeChannels } from './channels.js'
import { fileClaudeChannelTokens, type ClaudeChannelTokens } from './channelTokens.js'
import { replayClaudeTranscript, type ClaudeReplay, type ClaudeSubagentTranscript } from './replay.js'
import { installedSdkVersion, loadClaudeSdk, type ClaudeSessionStoreSdk } from './sdk.js'
import { openClaudeSession } from './session.js'
import { errorText } from './narrow.js'

/** The user-facing refresh failure: a fixed sentence, the HTTP status at most. */
function refreshFailedNotice(error: unknown): string {
  // A channel connection the session must not run on says so itself: the
  // refusal sentence is already the actionable one.
  if (error instanceof ClaudeChannelConflictError) return error.message
  const status = refreshFailureStatus(error)
  return t('claude-auth-refresh-failed', { detail: status === undefined ? '' : t('claude-auth-refresh-status', { status }) })
}

/** The settings credentials a channel connection replaces (named in a
 *  notice; a value never is). */
const SUPERSEDED_CREDENTIAL_KEYS: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']

/** The first non-empty value of `key` in an env record, the name matched
 *  case-insensitively (auth.ts's `valuesOf` rule). */
function firstNonEmpty(env: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const upper = key.toUpperCase()
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === upper && typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * The start notices of an active channel profile against the effective
 * settings `env`: a base URL that differs from the settings' (cc-switch),
 * and which settings credentials the channel replaces this session (key
 * names only, never values).
 */
export function channelStartNotices(
  channel: Pick<ClaudeChannelProfile, 'name' | 'baseUrl' | 'tokenRef'>,
  settingsEnv: Readonly<Record<string, unknown>>,
): string[] {
  const notices: string[] = []
  const settingsUrl = firstNonEmpty(settingsEnv, 'ANTHROPIC_BASE_URL')
  if (channel.baseUrl !== undefined && settingsUrl !== undefined && settingsUrl !== channel.baseUrl) {
    notices.push(t('channel-conn-settings-mismatch', { name: channel.name }))
  }
  if (channel.baseUrl !== undefined || channel.tokenRef !== undefined) {
    const superseded = SUPERSEDED_CREDENTIAL_KEYS.filter(key => firstNonEmpty(settingsEnv, key) !== undefined)
    if (superseded.length > 0) notices.push(t('channel-conn-creds-superseded', { keys: superseded.join(', ') }))
  }
  return notices
}

/**
 * The start notices of the resolved permission mode. A remembered bypass
 * that was not carried into this session is said once and forgotten, so
 * the next start resolves quietly.
 */
export function startModeNotices(start: StartPermissionMode, prefs: Pick<ClaudePrefs, 'write'>): string[] {
  const notices: string[] = []
  if (start.downgradedFrom !== undefined) notices.push(t('claude-start-mode-downgraded', { mode: start.downgradedFrom }))
  // The developer override is never silent: a live-test leftover in the
  // environment would otherwise change every approval without a trace.
  if (start.source === 'env') notices.push(t('claude-start-mode-env', { mode: start.mode }))
  if (start.bypassNotCarried === true) {
    prefs.write({ permissionMode: null })
    notices.push(t('claude-start-mode-bypass-not-carried'))
  }
  if (start.ignoredOverride !== undefined) notices.push(t('claude-start-mode-env-ignored', { mode: start.ignoredOverride }))
  return notices
}

/**
 * Where a persisted session lives and what it replays as. Throws (with a
 * user-facing sentence) when the store has no such session.
 */
export async function loadClaudeTranscript(
  sdk: Pick<ClaudeSessionStoreSdk, 'getSessionInfo' | 'getSessionMessages' | 'listSubagents' | 'getSubagentMessages'>,
  target: { readonly sessionId: string; readonly cwd?: string },
  fallbackCwd: string,
  debug: (message: string) => void = () => undefined,
): Promise<{ readonly cwd: string; readonly replay: ClaudeReplay }> {
  const info = (target.cwd === undefined ? undefined : await sdk.getSessionInfo(target.sessionId, { dir: target.cwd }))
    ?? await sdk.getSessionInfo(target.sessionId)
  if (info === undefined) throw new Error(t('claude-resume-not-found', { id: target.sessionId }))
  const cwd = info.cwd ?? target.cwd ?? fallbackCwd
  const [messages, subagentIds] = await Promise.all([
    sdk.getSessionMessages(target.sessionId, { dir: cwd, includeSystemMessages: true }),
    sdk.listSubagents(target.sessionId, { dir: cwd }),
  ])
  const subagents = new Map<string, ClaudeSubagentTranscript>()
  await Promise.all(subagentIds.map(async agentId => {
    const transcript = await sdk.getSubagentMessages(target.sessionId, agentId, { dir: cwd })
    // parent_agent_id: the agent that spawned this
    // child — null/absent = a depth-1 child (main loop) or old-format
    // metadata, never an orphan to drop. The transcript is keyed by the
    // delegating call when the messages carry one, and by the child's own
    // id as well, so replay can heal a nesting whose call attribution the
    // store never recorded.
    const parentAgent = transcript.find(message => typeof message.parent_agent_id === 'string')?.parent_agent_id
    const entry: ClaudeSubagentTranscript = { agentId, messages: transcript, ...(typeof parentAgent === 'string' ? { parentAgentId: parentAgent } : {}) }
    const parent = transcript.find(message => typeof message.parent_tool_use_id === 'string')?.parent_tool_use_id
    if (typeof parent === 'string') subagents.set(parent, entry)
    if (!subagents.has(agentId)) subagents.set(agentId, entry)
  }))
  const title = info.customTitle?.trim()
  const replay = replayClaudeTranscript(messages, { cwd, subagents, ...(title === undefined || title === '' ? {} : { title }), debug })
  return { cwd, replay }
}

/** The catalog of the local session store (the SDK loads on first use). */
const catalogPrefs = fileClaudePrefs()

export const claudeBackend: AgentBackend = {
  id: CLAUDE_BACKEND_ID,
  descriptor: { label: CLAUDE_BACKEND_LABEL },

  /** What is installed and whether it is the validated pair. Never throws. */
  async detect(host: BackendHost): Promise<BackendDetection> {
    try {
      await loadClaudeSdk()
    } catch (error) {
      host.debug(`claude: SDK import failed (${errorText(error)})`)
      return { installed: false, hint: t('claude-sdk-missing', { version: VALIDATED_SDK_VERSION }) }
    }
    let auth: 'ok' | 'missing' | 'unknown' = 'unknown'
    try {
      auth = await detectClaudeAuth(process.env, host.oauthCredential?.(CLAUDE_OAUTH_PROVIDER))
    } catch (error) {
      host.debug(`claude: credential detection failed (${errorText(error)})`)
    }
    try {
      const executable = await resolveClaudeExecutable()
      const version = executable.path === undefined ? undefined : await readClaudeVersion(executable.path)
      const drift = cliVersionDrift(version) ?? sdkVersionDrift(installedSdkVersion())
      return { installed: true, auth, ...(version === undefined ? {} : { version }), ...(drift === undefined ? {} : { drift }), ...(auth === 'missing' ? { hint: t('claude-auth-missing-hint') } : {}) }
    } catch (error) {
      host.debug(`claude: detection failed (${errorText(error)})`)
      return { installed: true, auth }
    }
  },

  catalog: createClaudeCatalog({
    loadSdk: loadClaudeSdk,
    cwd: () => process.cwd(),
    lastUsed: () => catalogPrefs.read().lastUsed ?? {},
  }),

  /** Create a session in `target.cwd` (an explicit session id, so the TUI
   *  knows it before the CLI's first `init`), or resume a persisted one. */
  async open(target: OpenTarget, host: BackendHost): Promise<AgentSession> {
    let sdk: Awaited<ReturnType<typeof loadClaudeSdk>>
    try {
      sdk = await loadClaudeSdk()
    } catch (error) {
      host.debug(`claude: SDK import failed (${errorText(error)})`)
      throw new Error(t('claude-sdk-missing', { version: VALIDATED_SDK_VERSION }))
    }
    const resumed = target.kind === 'resume'
      ? await loadClaudeTranscript(sdk, target, host.cwd, message => host.debug(message))
      : undefined
    const cwd = resumed?.cwd ?? (target.kind === 'create' ? target.cwd : host.cwd)
    // The backend-scoped prefs: the remembered model / effort / permission
    // picks. One store for the whole open — the start resolution reads the
    // mode here, the session's controls keep writing all three later.
    const prefs = fileClaudePrefs(undefined, message => host.debug(message))
    const [executable, start] = await Promise.all([
      resolveClaudeExecutable(),
      resolveStartPermissionMode(sdk, cwd, process.env, prefs.read().permissionMode),
    ])
    const sdkVersion = installedSdkVersion()
    // The credential: a dsh-auth login wins (refreshed now if
    // it is about to expire), else the environment, else the local login.
    const credentials = host.oauthCredential?.(CLAUDE_OAUTH_PROVIDER)
    const baseEnv = buildClaudeEnv()
    // The route decides whether the subscription token may be injected at
    // all (auth.ts): the CLI applies the settings' `env`, so a base URL set
    // in ~/.claude/settings.json counts like one in the environment.
    const settings = async (): Promise<ClaudeRouteSettings> =>
      (await sdk.resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] })).effective as ClaudeRouteSettings
    // The channel store and the token store are read fresh for every plan
    // (the open and each reconnect): a /channel switch while the session
    // lives is picked up by its next spawn.
    const channels: ClaudeChannels = fileClaudeChannels(undefined, message => host.debug(message))
    const tokens: ClaudeChannelTokens = fileClaudeChannelTokens(undefined, message => host.debug(message))
    // A custom endpoint the profile gives no credential (no token, a
    // dangling ref, no credential key in its env) never spawns; the refusal
    // says where to add the token.
    const channelConnection = (): ClaudeChannelConnectionInput | undefined => {
      const active = activeProfileOf(channels.read())
      if (active === undefined || !hasChannelConnection(active)) return undefined
      const connection: ClaudeChannelConnectionInput = {
        ...(active.baseUrl === undefined ? {} : { baseUrl: active.baseUrl }),
        ...(active.tokenRef === undefined ? {} : { token: tokens.read(active.tokenRef) }),
        ...(active.env === undefined ? {} : { env: active.env }),
      }
      if (channelMissingCredential(connection)) {
        throw new ClaudeChannelConflictError(t('claude-channel-token-missing', { name: active.name, host: originHost(active.baseUrl ?? '') }))
      }
      return connection
    }
    const startNotices: string[] = []
    // Once per start: which base URL wins this session (the profile's; the
    // settings file keeps its own for a plain `claude` run) and which
    // settings credentials the channel replaces (names only).
    try {
      const effective = await settings()
      const settingsEnv = typeof effective.env === 'object' && effective.env !== null ? effective.env as Record<string, unknown> : {}
      const activeAtStart = activeProfileOf(channels.read())
      if (activeAtStart !== undefined) startNotices.push(...channelStartNotices(activeAtStart, settingsEnv))
    } catch {
      // The notices are informational; an unreadable settings file has
      // already failed closed in the route gate below.
    }
    let plan: Awaited<ReturnType<typeof resolveClaudeAuth>>
    try {
      const connection = channelConnection()
      plan = await resolveClaudeAuth(baseEnv, credentials, { settings, ...(connection === undefined ? {} : { channel: connection }) })
    } catch (error) {
      // A channel connection that must not run (a tokenless custom
      // endpoint, an apiKeyHelper conflict) refuses the start: never a
      // silent fallback to ambient credentials or an anonymous request.
      if (error instanceof ClaudeChannelConflictError) throw error
      // A failed refresh must not stop the start: the session runs on the
      // environment or the local login, and says why. The debug log gets a
      // fixed failure category and at most the HTTP status: the refresh
      // error can carry the OAuth endpoint's response body, which may echo
      // request material (auth.ts contract).
      host.debug(`claude: dsh-auth refresh failed (${refreshFailureDebugDetail(error)})`)
      startNotices.push(refreshFailedNotice(error))
      plan = await resolveClaudeAuth(baseEnv, undefined, { settings })
    }
    startNotices.push(...startModeNotices(start, prefs))
    if (sdkVersionDrift(sdkVersion) !== undefined) startNotices.push(t('claude-sdk-drift', { version: sdkVersion ?? '', validated: VALIDATED_SDK_VERSION }))
    return openClaudeSession({
      sdk,
      store: sdk,
      cwd,
      sessionId: target.kind === 'resume' ? target.sessionId : randomUUID(),
      ...(resumed === undefined ? {} : { resume: resumed.replay }),
      start,
      executable,
      env: baseEnv,
      auth: {
        plan,
        // A reconnect re-reads the environment and settings. After an
        // authentication failure the refused token is refreshed only if
        // dsh-auth still holds it (compare-and-swap); `/login` uses the
        // stored credential as is.
        renew: renewal => {
          const channel = channelConnection()
          return resolveClaudeAuth(buildClaudeEnv(), credentials, {
            settings,
            ...(renewal.rejected === undefined ? {} : { rejected: renewal.rejected }),
            ...(channel === undefined ? {} : { channel }),
          })
        },
        failureNotice: refreshFailedNotice,
      },
      prefs,
      host: { debug: message => host.debug(message), ...(host.stderr === undefined ? {} : { stderr: (line: string) => host.stderr?.(line) }) },
      ...(sdkVersion === undefined ? {} : { sdkVersion }),
      startNotices,
    })
  },
}
