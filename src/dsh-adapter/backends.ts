/** Non-DSH backend loading, detection and startup session ownership. */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentBackend, BackendHost, OAuthCredentialSource, OpenTarget, SdkInstallSurface, SdkInstallTarget, SdkInstaller } from '../agent/backend.js'
import type { AgentEvent } from '../agent/events.js'
import type { AgentSession } from '../agent/session.js'
import { formatSessionRef } from '../agent/refs.js'
import { getBackend, listBackends, loadBackend } from './backend-registry.js'
import type { KernelStatus } from '../components/kernelCatalog.js'
import { reserveMount, reserveNewSession } from '../sessionMounts.js'
import { resumeTargetFromArgv } from '../sessionHistory.js'
import { mountFailureText } from '../sessions/resumeFailure.js'
import { logForDebugging } from '../utils/debug.js'
import { installExecutor } from './install/executors.js'
import { fileChannelTokens } from '../backends/shared/channel-tokens.js'

/**
 * The install surface of one registered backend (Stage B / B-1): the manifest's
 * recipe with the actions of the executor that recipe names. Undefined when the
 * entry declares no recipe, is not registered, or names an executor this host
 * does not implement — all three are "no install surface", which the picker
 * renders as the dim row's dead-end reason.
 *
 * The manifest says **what** (specifier + pin) and **which executor**; nothing
 * here imports a backend, and nothing is resolved before the user picks a row:
 * the entry behind that row is the one whose recipe gets run (§6 item 12).
 *
 * The id is a plain `string` on purpose, exactly like `getBackend`: membership is
 * half of what this answers, so asking about an id that was never registered is a
 * question with an answer, not a type error.
 */
export function installSurfaceFor(id: string): SdkInstallSurface | undefined {
  const recipe = getBackend(id)?.manifest.install
  if (recipe === undefined) return undefined
  const executor = installExecutor(recipe.executor)
  if (executor === undefined) return undefined
  return {
    ...recipe,
    resolveTarget: (): SdkInstallTarget => executor.resolveTarget(),
    start: (dir: string): SdkInstaller => executor.start(recipe.specifier, dir),
    preflight: (): Promise<boolean> => executor.preflight(),
  }
}

const credentialSources = new Map<string, OAuthCredentialSource>()

/** All probes and sessions share one credential source per provider. */
export async function createBackendHost(ctx: Context, cwd: string, stderr: (line: string) => void): Promise<BackendHost> {
  const { createOAuthCredentialSource } = await import('./oauth-credential-source.js')
  return {
    cwd,
    debug: message => logForDebugging(message),
    warn: message => ctx.logger.warn(message),
    stderr,
    tokenStore: fileChannelTokens(undefined, message => logForDebugging(message)),
    oauthCredential: provider => {
      let source = credentialSources.get(provider)
      if (source === undefined) {
        source = createOAuthCredentialSource(provider)
        credentialSources.set(provider, source)
      }
      return source
    },
  }
}

/** Resume failures abort boot; history is read before the channel's first paint. */
export async function openBackendStartup(ctx: Context, backend: AgentBackend, input: {
  readonly cwd: string
  readonly stderr: (line: string) => void
  readonly configuredSessionId?: string
  readonly argv: readonly string[]
}) {
  const launch = backend.launch
  if (launch === undefined) throw new Error(`dsh-tui: backend "${backend.id}" does not support startup`)
  const host = await createBackendHost(ctx, input.cwd, input.stderr)
  const prefs = launch.sessionPrefs(host.debug)
  const requested = (input.configuredSessionId ?? resumeTargetFromArgv(input.argv, () => prefs.lastSession()))?.trim()
  const resumeId = requested === undefined || requested === ''
    ? undefined
    : requested.startsWith(`${backend.id}:`) ? requested.slice(backend.id.length + 1) : requested
  let session: AgentSession
  let initialHistory: readonly AgentEvent[] = []
  if (resumeId !== undefined) {
    const key = formatSessionRef({ backendId: backend.id, sessionId: resumeId })
    const reserved = await reserveMount(key)
    if (!reserved.ok) {
      throw new Error(`dsh-tui: cannot resume ${backend.descriptor.label} session "${resumeId}": ${mountFailureText(reserved)} — ` +
        'two processes driving one session would interleave its transcript. Close that terminal, or drop --resume to start a fresh session.')
    }
    try {
      session = await backend.open({ kind: 'resume', sessionId: resumeId }, host)
      try {
        initialHistory = await session.history()
      } catch (error) {
        await session.dispose().catch(() => undefined)
        throw error
      }
    } catch (error) {
      reserved.reservation.abandon()
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`dsh-tui: cannot resume ${backend.descriptor.label} session "${resumeId}": ${reason} — no fresh session was started instead. ` +
        'Drop --resume to start a fresh session.', { cause: error })
    }
    reserved.reservation.settle()
    prefs.setLastSession(resumeId)
    prefs.touch(resumeId)
  } else {
    session = await backend.open({ kind: 'create', cwd: input.cwd }, host)
    const { reservation } = await reserveNewSession(formatSessionRef(session.ref))
    reservation.settle()
  }
  return {
    session,
    // Boot and landing-page state use the target this backend actually opened.
    resumedSessionId: resumeId,
    label: backend.descriptor.label,
    backendId: backend.id,
    initialHistory,
    catalog: backend.catalog,
    sessionPrefs: prefs,
    // A submitted user row means the backend has persisted a resumable transcript.
    persisted: (_sessionId: string, rows: readonly { readonly kind: string }[]) => rows.some(row => row.kind === 'user'),
    resumeCommand: (sessionId: string) => launch.resumeCommand(sessionId),
    open: (target: Extract<OpenTarget, { readonly kind: 'create' | 'resume' }>) =>
      backend.open(target, target.kind === 'create' ? { ...host, cwd: target.cwd } : host),
  }
}

/**
 * Probe every optional backend once (`dsh` is always available and has no
 * loader). Loading goes through the registry, so a probed backend's pool hook is
 * booked just like an opened one's — a backend that builds its pool in `detect()`
 * (the contract does not forbid it) is then still closed at exit. Failures leave
 * their row unavailable instead of failing the probe.
 */
export async function probeKernels(ctx: Context, cwd: string): Promise<Record<string, KernelStatus>> {
  const host = await createBackendHost(ctx, cwd, () => undefined)
  const statuses: Record<string, KernelStatus> = {}
  for (const entry of listBackends()) {
    if (entry.load === undefined) continue
    try {
      statuses[entry.id] = await (await loadBackend(entry.id)).detect(host)
    } catch (error) {
      host.debug('dsh-tui: kernel probe failed (' + (error instanceof Error ? error.message : String(error)) + ')')
      statuses[entry.id] = { installed: false }
    }
  }
  return statuses
}
