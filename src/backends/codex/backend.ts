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
import { detectCodex } from './detect.js'
import { errorText } from './narrow.js'
import { fileCodexPrefs } from './prefs.js'
import { buildCodexEnv, resolveCodexExecutable } from './rpc/binary.js'
import { acquireCodexHub, type HubSettings } from './rpc/hub.js'
import { openCodexSession } from './session/session.js'

/** Child stderr that is known start-up noise, reported by `/doctor` only. */
const STDERR_NOISE = [/bubblewrap/iu, /could not create PATH aliases/iu]

export const codexBackend: AgentBackend = {
  id: CODEX_BACKEND_ID,
  descriptor: { label: CODEX_BACKEND_LABEL },

  detect: (host: BackendHost) => detectCodex(host),

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
    const executable = await resolveCodexExecutable()
    if (executable === undefined) throw new Error(t('codex-not-installed'))
    if (!codexVersionSupported(executable.version)) throw new Error(t('codex-too-old', { version: executable.version ?? '', min: MIN_CODEX_VERSION }))
    let bubblewrapMissing = false
    const settings: HubSettings = {
      executable: executable.path,
      args: ['app-server'],
      env: buildCodexEnv(),
      cwd: target.kind === 'create' ? target.cwd : host.cwd,
    }
    const hub = acquireCodexHub(settings, {
      debug: message => host.debug(message),
      stderr: line => {
        if (STDERR_NOISE.some(pattern => pattern.test(line))) {
          if (/bubblewrap/iu.test(line)) bubblewrapMissing = true
          return
        }
        host.stderr?.(line)
      },
      clientVersion: installedTuiVersion() ?? 'dev',
    })
    const release = hub.retain()
    try {
      await hub.ready
    } catch (error) {
      release()
      host.debug(`codex: app-server start failed (${errorText(error)})`)
      throw new Error(t('codex-start-failed', { err: errorText(error) }), { cause: error })
    }
    return openCodexSession({
      hub,
      release,
      target,
      cwd: target.kind === 'create' ? target.cwd : host.cwd,
      prefs: fileCodexPrefs(undefined, message => host.debug(message)),
      executable,
      host: { debug: message => host.debug(message) },
      doctor: { get bubblewrapMissing() { return bubblewrapMissing } },
    })
  },
}
