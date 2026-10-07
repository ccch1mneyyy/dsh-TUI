/**
 * The Codex backend (docs/codex-backend-design.md §5.5): detection, opening
 * a thread (create or resume) on the process-wide app-server hub, and the
 * launcher's per-backend session markers.
 *
 * The child runs the user's own `codex` with the user's own `CODEX_HOME`
 * (D6): their config, instructions, MCP servers, provider and login apply
 * as in the official client, and threads are shared with it. dsh-tui's
 * choices (start mode, model, effort) travel per thread as request
 * parameters; nothing is written into Codex's configuration.
 */
import type { AgentBackend, BackendHost, OpenTarget } from '../../agent/backend.js'
import type { AgentSession } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { installedTuiVersion } from '../../update.js'
import { CODEX_BACKEND_ID, CODEX_BACKEND_LABEL, codexResumeCommand, codexVersionSupported, MIN_CODEX_VERSION } from './contract.js'
import { acquireCodexAuth, CODEX_OAUTH_PROVIDER, type CodexAuthRuntime } from './auth/external-tokens.js'
import { codexAuthRoute } from './auth/route.js'
import { createCodexChannelsRuntime, fileCodexChannels, type CodexChannels, type CodexChannelsRuntime } from './channels.js'
import type { ChannelTokenStore } from '../shared/channel-tokens.js'
import { createCodexCatalog } from './catalog.js'
import { detectCodex } from './detect.js'
import { errorText, rec, str, type Rec } from './narrow.js'
import { CLIENT } from './protocol/index.js'
import { fileCodexPrefs } from './prefs.js'
import { buildCodexEnv, resolveCodexExecutable, type CodexExecutable } from './rpc/binary.js'
import { acquireCodexHub, type CodexHub, type CodexHubDeps, type HubSettings } from './rpc/hub.js'
import type { RpcClock } from './rpc/client.js'
import { openCodexSession } from './session/session.js'

/** Child stderr that is known start-up noise, reported by `/doctor` only. */
const STDERR_NOISE = [/bubblewrap/iu, /could not create PATH aliases/iu]

/** Structural until the neutral BackendHost addition is merged; the shared
 * ChannelTokenStore interface is the real host read/write/erase/declared seam. */
export type CodexBackendHost = BackendHost & { readonly tokenStore?: ChannelTokenStore }

export interface CodexRuntime {
  readonly hub: CodexHub
  readonly release: () => void
  readonly cwd: string
  readonly executable: CodexExecutable & { readonly version?: string }
  readonly config?: Rec
  readonly auth: CodexAuthRuntime
  readonly channels: CodexChannelsRuntime
  readonly startNotices?: readonly string[]
}
export interface CodexRuntimeOptions {
  readonly executable?: CodexExecutable & { readonly version?: string }
  readonly channels?: CodexChannels
  readonly env?: NodeJS.ProcessEnv
  readonly hubDeps?: CodexHubDeps
  readonly authClock?: RpcClock
}

/** Acquire the same platform runtime for open/resume/catalog. Tests replace
 * only the process, executable discovery and profile file, not the plumbing. */
export async function prepareCodexRuntime(target: OpenTarget, host: CodexBackendHost, options: CodexRuntimeOptions = {}): Promise<CodexRuntime> {
  const env = options.env ?? process.env
  const executable = options.executable ?? await resolveCodexExecutable(env)
  if (executable === undefined) throw new Error(t('codex-not-installed'))
  if (!codexVersionSupported(executable.version)) throw new Error(t('codex-too-old', { version: executable.version ?? '', min: MIN_CODEX_VERSION }))
  const channels = createCodexChannelsRuntime({ store: options.channels ?? fileCodexChannels(undefined, host.debug), tokens: host.tokenStore, env })
  const launch = channels.launch()
  const credential = launch.provider === undefined ? host.oauthCredential?.(CODEX_OAUTH_PROVIDER) : undefined
  let cwd = target.cwd ?? host.cwd
  let settings: HubSettings = {
    executable: executable.path, args: ['app-server', ...launch.args], env: buildCodexEnv(env, launch.env), cwd,
    credentialMode: launch.provider !== undefined ? 'channel' : credential === undefined ? 'codex' : 'external',
    injectedEnvKeys: launch.injectedEnvKeys,
  }
  const deps: CodexHubDeps = {
    debug: host.debug,
    stderr: line => { if (!STDERR_NOISE.some(pattern => pattern.test(line))) host.stderr?.(line) },
    clientVersion: installedTuiVersion() ?? 'dev',
    ...options.hubDeps,
  }
  let hub = acquireCodexHub(settings, deps)
  let release = hub.retain()
  try {
    await hub.ready
    let locationKnown = true
    if (target.kind === 'resume' && target.cwd === undefined) {
      // Route/project configuration must be checked for the recorded thread
      // directory, not the launcher's unrelated current directory.
      try {
        const answer = rec(await hub.call(CLIENT.threadRead, { threadId: target.sessionId, includeTurns: false }))
        const recorded = str(rec(answer?.thread)?.cwd)
        if (recorded === undefined || recorded === '') locationKnown = false
        else cwd = recorded
      } catch { locationKnown = false }
    }
    let config: Rec | undefined
    if (locationKnown) {
      try { config = rec(rec(await hub.call(CLIENT.configRead, { includeLayers: false, cwd }))?.config) }
      catch { host.debug('codex: config/read failed; managed injection disabled') }
    }
    const route = codexAuthRoute(config, env, launch.provider !== undefined)
    const externalAllowed = settings.credentialMode === 'external' && route.firstParty
    if (settings.credentialMode === 'external' && !externalAllowed) {
      // A native-only route must not reuse a hub whose other sessions loaded
      // a managed token. Probing config does not issue any model request.
      release()
      settings = { ...settings, credentialMode: 'codex' }
      hub = acquireCodexHub(settings, deps)
      release = hub.retain()
      await hub.ready
    }
    channels.refreshConfig(config)
    const profile = channels.active()
    let auth = acquireCodexAuth({
      hub, cwd, config, env, credential, externalAllowed,
      ...(launch.provider === undefined || profile === undefined ? {} : { channel: { name: profile.name, baseUrl: profile.baseUrl } }),
      ...(options.authClock === undefined ? {} : { clock: options.authClock }),
      debug: host.debug,
    })
    await auth.start()
    let startNotices: readonly string[] | undefined
    if (auth.managedFailed) {
      startNotices = [t('codex-auth-login-failed')]
      // Only an already-observed startup failure takes this path. No logout:
      // a different process starts clean on the user's native credentials.
      release()
      settings = { ...settings, credentialMode: 'native-fallback' }
      hub = acquireCodexHub(settings, deps)
      release = hub.retain()
      await hub.ready
      auth = acquireCodexAuth({ hub, cwd, config, env, credential, externalAllowed: route.firstParty, skipStoredCredential: true, debug: host.debug })
      await auth.start()
    }
    return { hub, release, cwd, executable, config, auth, channels, ...(startNotices === undefined ? {} : { startNotices }) }
  } catch (error) {
    release()
    host.debug(`codex: app-server start failed (${errorText(error)})`)
    throw new Error(t('codex-start-failed', { err: errorText(error) }), { cause: error })
  }
}

let catalogHost: CodexBackendHost | undefined
const catalogPrefs = fileCodexPrefs()

export const codexBackend: AgentBackend = {
  id: CODEX_BACKEND_ID,
  descriptor: { label: CODEX_BACKEND_LABEL },

  detect: (host: BackendHost) => { catalogHost = host; return detectCodex(host) },

  catalog: createCodexCatalog({
    acquire: cwd => {
      const host = catalogHost ?? { cwd: process.cwd(), debug: () => undefined, warn: () => undefined }
      return prepareCodexRuntime({ kind: 'create', cwd: cwd ?? host.cwd }, host)
    },
    cwd: () => catalogHost?.cwd ?? process.cwd(),
    lastUsed: () => catalogPrefs.read().lastUsed ?? {},
  }),

  launch: {
    sessionPrefs: debug => {
      const prefs = fileCodexPrefs(undefined, debug)
      return {
        lastSession: () => prefs.read().lastSession,
        setLastSession: threadId => { prefs.write({ lastSession: threadId }) },
        touch: threadId => { prefs.touch(threadId) },
        forget: threadId => { prefs.forget(threadId) },
      }
    },
    resumeCommand: codexResumeCommand,
  },

  async open(target: OpenTarget, host: BackendHost): Promise<AgentSession> {
    catalogHost = host
    const runtime = await prepareCodexRuntime(target, host)
    const params = {
      ...runtime, target,
      prefs: fileCodexPrefs(undefined, host.debug),
      host: { debug: host.debug },
      doctor: { get bubblewrapMissing() { return runtime.hub.bubblewrapMissing } },
    }
    return openCodexSession(params)
  },
}
