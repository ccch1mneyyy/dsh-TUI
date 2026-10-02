/**
 * The Claude Agent backend (docs/agent-backend-design.md §3.4, §4): detection
 * (SDK importable? executable found? validated versions?) and session
 * creation. Resume, listing and fork are Phase 4.
 */
import { randomUUID } from 'node:crypto'
import type { AgentBackend, BackendDetection, BackendHost, OpenTarget } from '../../agent/backend.js'
import type { AgentSession } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { CLAUDE_BACKEND_ID, CLAUDE_BACKEND_LABEL, cliVersionDrift, sdkVersionDrift, VALIDATED_SDK_VERSION } from './contract.js'
import { resolveStartPermissionMode } from './options.js'
import { buildClaudeEnv, readClaudeVersion, resolveClaudeExecutable } from './process.js'
import { installedSdkVersion, loadClaudeSdk } from './sdk.js'
import { openClaudeSession } from './session.js'

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

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
    try {
      const executable = await resolveClaudeExecutable()
      const version = executable.path === undefined ? undefined : await readClaudeVersion(executable.path)
      const drift = cliVersionDrift(version) ?? sdkVersionDrift(installedSdkVersion())
      return { installed: true, ...(version === undefined ? {} : { version }), ...(drift === undefined ? {} : { drift }) }
    } catch (error) {
      host.debug(`claude: detection failed (${errorText(error)})`)
      return { installed: true }
    }
  },

  /** Create a session in `target.cwd` (an explicit session id, so the TUI
   *  knows it before the CLI's first `init`). */
  async open(target: OpenTarget, host: BackendHost): Promise<AgentSession> {
    if (target.kind !== 'create') throw new Error(t('claude-resume-unavailable'))
    let sdk: Awaited<ReturnType<typeof loadClaudeSdk>>
    try {
      sdk = await loadClaudeSdk()
    } catch (error) {
      host.debug(`claude: SDK import failed (${errorText(error)})`)
      throw new Error(t('claude-sdk-missing', { version: VALIDATED_SDK_VERSION }))
    }
    const [executable, start] = await Promise.all([
      resolveClaudeExecutable(),
      resolveStartPermissionMode(sdk, target.cwd),
    ])
    const sdkVersion = installedSdkVersion()
    const startNotices: string[] = []
    if (start.downgradedFrom !== undefined) startNotices.push(t('claude-start-mode-downgraded', { mode: start.downgradedFrom }))
    // The developer override is never silent: a live-test leftover in the
    // environment would otherwise change every approval without a trace.
    if (start.source === 'env') startNotices.push(t('claude-start-mode-env', { mode: start.mode }))
    if (start.ignoredOverride !== undefined) startNotices.push(t('claude-start-mode-env-ignored', { mode: start.ignoredOverride }))
    if (sdkVersionDrift(sdkVersion) !== undefined) startNotices.push(t('claude-sdk-drift', { version: sdkVersion ?? '', validated: VALIDATED_SDK_VERSION }))
    return openClaudeSession({
      sdk,
      cwd: target.cwd,
      sessionId: randomUUID(),
      start,
      executable,
      env: buildClaudeEnv(),
      host: { debug: message => host.debug(message), ...(host.stderr === undefined ? {} : { stderr: (line: string) => host.stderr?.(line) }) },
      ...(sdkVersion === undefined ? {} : { sdkVersion }),
      startNotices,
    })
  },
}
