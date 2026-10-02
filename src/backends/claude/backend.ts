/**
 * The Claude Agent backend (docs/agent-backend-design.md §3.4, §4): detection
 * (SDK importable? executable found? validated versions? a credential?),
 * session creation and resume with the credential plan of §4.12 (auth.ts),
 * and the offline session catalog (catalog.ts).
 *
 * Resume (§4.11): the session's record is looked up (its recorded working
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
import { CLAUDE_OAUTH_PROVIDER, detectClaudeAuth, refreshFailureStatus, resolveClaudeAuth, type ClaudeRouteSettings } from './auth.js'
import { createClaudeCatalog } from './catalog.js'
import { resolveStartPermissionMode } from './options.js'
import { fileClaudePrefs } from './prefs.js'
import { buildClaudeEnv, readClaudeVersion, resolveClaudeExecutable } from './process.js'
import { replayClaudeTranscript, type ClaudeReplay, type ClaudeSubagentTranscript } from './replay.js'
import { installedSdkVersion, loadClaudeSdk, type ClaudeSessionStoreSdk } from './sdk.js'
import { openClaudeSession } from './session.js'

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The user-facing refresh failure: a fixed sentence, the HTTP status at most. */
function refreshFailedNotice(error: unknown): string {
  const status = refreshFailureStatus(error)
  return t('claude-auth-refresh-failed', { detail: status === undefined ? '' : t('claude-auth-refresh-status', { status }) })
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
    const parent = transcript.find(message => typeof message.parent_tool_use_id === 'string')?.parent_tool_use_id
    if (typeof parent === 'string') subagents.set(parent, { agentId, messages: transcript })
  }))
  const title = info.customTitle?.trim()
  const replay = replayClaudeTranscript(messages, { cwd, subagents, ...(title === undefined || title === '' ? {} : { title }), debug })
  return { cwd, replay }
}

/** The catalog of the local session store (the SDK loads on first use). */
const catalogPrefs = fileClaudePrefs()

export const claudeBackend: AgentBackend = {
  id: CLAUDE_BACKEND_ID,
  descriptor: { label: CLAUDE_BACKEND_LABEL, vendor: 'Anthropic', version: VALIDATED_SDK_VERSION },

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
    if (target.kind === 'fork') throw new Error(t('claude-open-fork-unsupported'))
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
    const [executable, start] = await Promise.all([
      resolveClaudeExecutable(),
      resolveStartPermissionMode(sdk, cwd),
    ])
    const sdkVersion = installedSdkVersion()
    // The credential (design §4.12): a dsh-auth login wins (refreshed now if
    // it is about to expire), else the environment, else the local login.
    const credentials = host.oauthCredential?.(CLAUDE_OAUTH_PROVIDER)
    const baseEnv = buildClaudeEnv()
    // The route decides whether the subscription token may be injected at
    // all (auth.ts): the CLI applies the settings' `env`, so a base URL set
    // in ~/.claude/settings.json counts like one in the environment.
    const settings = async (): Promise<ClaudeRouteSettings> =>
      (await sdk.resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] })).effective as ClaudeRouteSettings
    const startNotices: string[] = []
    let plan: Awaited<ReturnType<typeof resolveClaudeAuth>>
    try {
      plan = await resolveClaudeAuth(baseEnv, credentials, { settings })
    } catch (error) {
      // A failed refresh must not stop the start: the session runs on the
      // environment or the local login, and says why (status only: the
      // refresh error can carry the OAuth endpoint's response body).
      host.debug(`claude: dsh-auth refresh failed (${errorText(error)})`)
      startNotices.push(refreshFailedNotice(error))
      plan = await resolveClaudeAuth(baseEnv, undefined, { settings })
    }
    if (start.downgradedFrom !== undefined) startNotices.push(t('claude-start-mode-downgraded', { mode: start.downgradedFrom }))
    // The developer override is never silent: a live-test leftover in the
    // environment would otherwise change every approval without a trace.
    if (start.source === 'env') startNotices.push(t('claude-start-mode-env', { mode: start.mode }))
    if (start.ignoredOverride !== undefined) startNotices.push(t('claude-start-mode-env-ignored', { mode: start.ignoredOverride }))
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
        renew: renewal => resolveClaudeAuth(buildClaudeEnv(), credentials, { settings, ...(renewal.rejected === undefined ? {} : { rejected: renewal.rejected }) }),
        failureNotice: refreshFailedNotice,
      },
      prefs: fileClaudePrefs(undefined, message => host.debug(message)),
      host: { debug: message => host.debug(message), ...(host.stderr === undefined ? {} : { stderr: (line: string) => host.stderr?.(line) }) },
      ...(sdkVersion === undefined ? {} : { sdkVersion }),
      startNotices,
    })
  },
}
