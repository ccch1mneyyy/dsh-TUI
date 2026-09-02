import { randomUUID } from 'node:crypto'
import React from 'react'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { Config } from './index.js'
import { createChannel } from './channel.js'
import { createChildStderrReporter, installChildStderrGuard } from './childStderr.js'
import { logForDebugging } from '../utils/debug.js'
import { QuestionStore } from './questions.js'
import { prepareQuestionAnswerer } from './questions-answerer.js'
import { ApprovalStore } from './approvals.js'
import { registerPromptDebug } from './promptDebug.js'
import { readActivityFrames } from '../activityPrefs.js'
import { commitFullscreenFactoryMigration, planFullscreenFactoryMigration, readAppliedMigrations } from '../migrationPrefs.js'
import { readModelPref } from '../modelPrefs.js'
import { explicitModelRoute, recordedModelRoute, resolveModelRoute, validateModelRoute } from '../modelRoute.js'
import type { ModelRoute } from '../modelRoute.js'
import { migratePresetPref, readPresetPref } from '../presetPrefs.js'
import { composePreset, filterMinimalPresetTools, resolvePersistedPreset, resolvePersistedRoute, runningPresetOf } from './presets.js'
import { ensurePackagedPresets } from './packaged-presets.js'
import { ensureLegacySessionEventTypes, snapshotLiveSessionEvents } from './compat/index.js'
import { clearResumeTarget, resumeTargetFromArgv, writeResumeTarget } from '../sessionHistory.js'
import { resolveSessionCwd } from '../utils/workspaceRoot.js'
import { beginRestartAttempt, checkForTuiUpdate, installedTuiVersion, isBootDeadlockTarget, isStandaloneRuntime, isVersionNewer, logRestartEvent, resolveDshProfileName, resolveTuiUpdateTarget, restartTui, updateTuiAndRestart, writeHandoffNotice } from '../update.js'
import { getLang, isLang, resolveStartupLang, setLang, t, writeLangPref } from '../i18n.js'
import { DEFAULT_PAGE_MARGIN, DEFAULT_STATUS_BAR, applyPageMargin, isPageMarginMode, normalizePageMargin, normalizeScrollGutter, normalizeStatusBar, normalizeToolBackground, parsePageMarginSpec, type PageMarginSetting, type ScrollGutterMode, type StatusBarConfig, type ToolBackground } from '../tuiDisplayPrefs.js'
import {
  draftComboConflicts,
  effectiveComboString,
  parseComboDraft,
  setKeymapOverrides,
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
} from '../utils/keymap.js'
import { detectLegacyEnv, migrateLegacyDataDir, RENAMED_ENV } from '../utils/paths.js'
import { attachHerdrIntegration } from '../herdr.js'
import { logMouseDebug } from '../utils/debug.js'
import { Chat } from '../screens/Chat.js'
import { openInjectChannel, type InjectController } from './inject-channel.js'
import { getHostDialogStore, type TuiDialogRuntime } from './dialogs.js'
import { getHostStatusStore, type TuiStatusRuntime } from './status.js'
import { getHostToastStore, type TuiToastRuntime } from './toast.js'
import { getHostShortcuts, type TuiShortcutRuntime } from './shortcuts.js'
import { getHostThemes, type TuiThemeRuntime } from './themes.js'
import { attachSessionToWorkspace } from './workspace.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime } from './workspaces.js'
import { getHostSettingsSections, getLocalSettingsSectionsHost, type TuiSettingsField, type TuiSettingsSectionsRuntime } from './settings-sections.js'
import { withHostRootCapability } from './host-access.js'
import { render, ThemeProvider, AlternateScreen } from '../ui.js'
import { PageMargin } from '../components/PageMargin.js'
import instances from '../ink/instances.js'
import { cursorMove, DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS, DISABLE_WIN32_INPUT_MODE } from '../ink/termio/csi.js'
import { DBP, DFE, DISABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN, SHOW_CURSOR } from '../ink/termio/dec.js'
import { CLEAR_ITERM2_PROGRESS, CLEAR_TAB_STATUS, supportsTabStatus, wrapForMultiplexer } from '../ink/termio/osc.js'

/**
 * Claude Code style interactive TUI front door for DeepSeek Harness agents.
 *
 * The plugin attaches to (or creates) one agent, renders a chat transcript
 * from the agent's session log and live `session/event` records, and submits
 * user turns through `Agent.followup`. It is a client-driver front door like
 * `dsh-jsonrpc`: the surrounding `cordis.yml` supplies the agent spine, the
 * LLM adapter, and the tool plugins.
 */
/**
 * Fullscreen decision latched across host recomposes. The launcher disposes
 * and re-mounts the plugin tree (teardown → apply() runs again) — a fresh
 * apply() re-resolves `bootedFullscreen` from cordis config, and the
 * settings user layer (settings.yaml) can arrive after the 300ms
 * `settingsReady` bound when the recompose is also re-mounting the settings
 * service. The tree would then mount INLINE and `fullscreenFrozen` would
 * swallow the late application — the app lands on the main screen
 * ("exited fullscreen", dead mouse, unpinned input) until restart. A
 * session that already mounted fullscreen must never regress on a
 * recompose: latch the decision.
 */
let lastBootedFullscreen: boolean | undefined

/**
 * Extract the startup prompt from raw app argv. `--resume <session>` selects
 * a persisted session and must not leak its id into the conversation.
 */
export function initialPromptFromCmdlineArgs(args: readonly string[] | undefined): string {
  if (args === undefined) return ''
  const promptArgs: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--resume') {
      if (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) i += 1
      continue
    }
    if (arg.startsWith('--resume=')) continue
    if (arg.startsWith('-')) continue
    promptArgs.push(arg)
  }
  return promptArgs.join(' ').trim()
}

/**
 * How this process should treat the TUI frontend, given the terminal it runs on.
 *
 * Three startup identities exist:
 *  1. `dsh-tui` / standalone — the user explicitly asked for the terminal UI;
 *  2. Web / Tauri / other GUI hosts — the profile merely has dsh-tui installed
 *     and the current process is NOT a dsh-tui frontend. stdout is a pipe or
 *     null there, and mounting a TUI would fail the whole composition.
 *
 * The official launcher (and the standalone runtime) mark explicit launches,
 * so an explicit `dsh-tui` run without a TTY keeps failing loudly, while
 * foreign hosts skip the plugin and let the host boot.
 */
export type TuiHostMode = 'interactive' | 'invalid-explicit-launch' | 'headless-host'

export function resolveTuiHostMode(
  stdoutIsTTY = process.stdout.isTTY === true,
  env: NodeJS.ProcessEnv = process.env,
): TuiHostMode {
  if (stdoutIsTTY) {
    return 'interactive'
  }

  const explicitTuiLaunch =
    env.DSH_TUI_LAUNCHER_VERSION !== undefined || isStandaloneRuntime()

  return explicitTuiLaunch ? 'invalid-explicit-launch' : 'headless-host'
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  // /restart handoff diagnosis: the replacement process is marked by env and
  // logs its boot progress to ~/.dsh-tui/restart.log (ordinary launches stay
  // silent). First line lands before anything in this function can throw.
  if (process.env.DSH_TUI_RESTART_CHILD === '1') {
    logRestartEvent('boot: plugin apply', {
      stdoutTty: process.stdout.isTTY === true,
      stdinTty: process.stdin.isTTY === true,
      stderrTty: process.stderr.isTTY === true,
    })
    // Field evidence (2026-08-24): the restarted TUI mounts but takes no
    // input, and the terminal's DA reply surfaced on PS's prompt line in an
    // earlier attempt — meaning NO process was reading console input. Probe
    // whether THIS process's stdin pump ever sees bytes: wrap read()
    // transparently (delegates; purely observational) and sample the pump
    // state, so the log distinguishes "bytes never arrive" (console-level
    // theft/mode) from "bytes arrive but the UI ignores them".
    const probedStdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean }
    const originalRead = probedStdin.read.bind(probedStdin)
    let loggedChunks = 0
    probedStdin.read = ((...args: Parameters<typeof originalRead>) => {
      const chunk = originalRead(...args)
      if (chunk !== null && chunk !== '' && loggedChunks < 12) {
        loggedChunks += 1
        const text = String(chunk)
        logRestartEvent('boot: stdin chunk arrived', {
          bytes: text.length,
          preview: text.slice(0, 24).replace(/[^\x20-\x7e]/g, '.'),
        })
      }
      return chunk
    }) as typeof originalRead
    const sampleStdinState = (label: string): void => {
      logRestartEvent(`boot: ${label}`, {
        isRaw: probedStdin.isRaw === true,
        readableListeners: probedStdin.listenerCount('readable'),
        dataListeners: probedStdin.listenerCount('data'),
        paused: probedStdin.isPaused,
        buffered: probedStdin.readableLength,
        chunksSeen: loggedChunks,
      })
    }
    sampleStdinState('stdin state at plugin apply')
    let pendingSamples = 0
    const sampleAt = (delayMs: number, label: string): void => {
      pendingSamples += 1
      const timer = setTimeout(() => {
        pendingSamples -= 1
        sampleStdinState(label)
      }, delayMs)
      timer.unref?.()
    }
    sampleAt(2000, 'stdin state +2s')
    sampleAt(5000, 'stdin state +5s')
    sampleAt(12000, 'stdin state +12s')
  }
  const hostMode = resolveTuiHostMode()
  if (hostMode === 'invalid-explicit-launch') {
    if (process.env.DSH_TUI_RESTART_CHILD === '1') {
      logRestartEvent('boot: TTY gate failed - stdout is not a TTY')
    }
    throw new Error('dsh-tui requires an interactive terminal (stdout must be a TTY).')
  }
  if (hostMode === 'headless-host') {
    // Web / Tauri / GUI hosts load the plugin from the profile without being
    // a dsh-tui frontend (stdout is a pipe or null). Mounting a TUI there
    // would fail the whole composition, so skip quietly and let the host
    // boot. The launcher marker above keeps explicit `dsh-tui` launches
    // failing loudly instead of silently producing no UI.
    ctx.logger.info(
      'dsh-tui: non-interactive host detected (stdout is not a TTY); skipping the TUI frontend',
    )
    return
  }

  // The official profile launcher owns the system preset root and replaces
  // any bundle-supplied roots at boot. Install dsh-tui's bundled presets via
  // the roster's supported user-root seam before resolving the first agent.
  // Never overwrite an existing directory unless it carries our marker.
  try {
    for (const result of ensurePackagedPresets()) {
      if (result.status === 'conflict') {
        ctx.logger.warn(
          `dsh-tui: packaged preset "${result.id}" was not installed because an unmanaged preset already uses that id`,
        )
      }
    }
  } catch (error) {
    // A read-only home must not make the whole terminal unusable; the other
    // official and user presets remain available.
    ctx.logger.warn(`dsh-tui: unable to install packaged presets (${error instanceof Error ? error.message : String(error)})`)
  }

  // Data-directory rename (~/.dsh-cc → ~/.dsh-tui, issue #120): copy the
  // legacy directory before ANY preference read below (resolveStartupLang
  // already touches lang.json). Copy, not move — old launchers keep working
  // and the user deletes the legacy directory themselves.
  const migrated = migrateLegacyDataDir()

  // UI language resolution: DSH_TUI_LANG env var wins, then the
  // settings.yaml `dsh-tui.lang` user layer (applied once the settings
  // namespace registers below), then cordis.yml `lang`, then the
  // persisted `/lang` choice, then `zh`. Must settle before the first
  // render so every module resolves strings in the same language.
  const envLang = process.env.DSH_TUI_LANG
  setLang(isLang(envLang) ? envLang : isLang(config.lang) ? config.lang : resolveStartupLang())

  // Rename notices must land before the first render — stderr writes break
  // the fullscreen UI once it is up. The bin launcher prints the same
  // warnings; this covers direct `dsh --profile dsh-tui` boots.
  if (migrated) {
    ctx.logger.warn('dsh-tui: data directory copied from ~/.dsh-cc to ~/.dsh-tui (legacy kept)')
    if (process.stderr.isTTY) {
      process.stderr.write(`\n[dsh-tui] ${t('legacy-dir-migrated')}\n`)
    }
  }
  for (const oldName of detectLegacyEnv()) {
    ctx.logger.warn(`dsh-tui: env ${oldName} renamed to ${RENAMED_ENV[oldName]}; the old name no longer takes effect`)
    if (process.stderr.isTTY) {
      process.stderr.write(`\n[dsh-tui] ${t('legacy-env-renamed', { old: oldName, new: RENAMED_ENV[oldName] })}\n`)
    }
  }

  // /update restart verification: the pre-update process stamps the version
  // it was leaving behind; if the freshly loaded one is not newer, the
  // package manager "succeeded" without actually moving the version (mirror
  // lag, cached manifest, wrong profile). Say so instead of silently
  // pretending the update landed.
  {
    const updatedFrom = process.env.DSH_TUI_UPDATED_FROM
    if (updatedFrom !== undefined) {
      // Assigning undefined would stringify to "undefined" and leak the
      // marker into every child process; remove it for real.
      delete process.env.DSH_TUI_UPDATED_FROM
      const now = installedTuiVersion()
      if (now === undefined || !isVersionNewer(now, updatedFrom)) {
        ctx.logger.warn(
          `dsh-tui: /update restarted but the version did not advance (still ${now ?? 'unknown'}, was ${updatedFrom})`,
        )
        if (process.stderr.isTTY) {
          process.stderr.write(
            `\ndsh-tui: 更新后版本未变化（仍为 ${now ?? 'unknown'}，原为 ${updatedFrom}）；` +
              `可能是镜像 registry 未同步，请稍后重试或检查 registry 配置。\n`,
          )
        }
      } else if (process.stderr.isTTY) {
        // Launcher alignment bridge (0.8.3): /update only replaces the
        // package inside the DSH profile; a globally installed `dsh-tui`
        // launcher is a separate copy that keeps its old version. Launchers
        // >=0.8.3 export DSH_TUI_LAUNCHER_VERSION so we can tell whether
        // the outer launcher lags the freshly installed profile. Launchers
        // <=0.8.2 never set the marker — the generic branch below is
        // intentionally one-shot: DSH_TUI_UPDATED_FROM exists only on the
        // replacement process immediately after /update.
        const launcherVersion = process.env.DSH_TUI_LAUNCHER_VERSION
        if (launcherVersion === undefined) {
          process.stderr.write(`\n[dsh-tui] ${t('update-launcher-align-unknown', { version: now })}\n`)
        } else if (isVersionNewer(now, launcherVersion)) {
          process.stderr.write(
            `\n[dsh-tui] ${t('update-launcher-outdated', { profile: now, launcher: launcherVersion })}\n`,
          )
        }
      }
    }
  }

  // DSH user-interaction seam: the model's ask_user_question tool parks on
  // the userQuestions service until a UI answerer responds. Mount the
  // service when the composition doesn't (the official dsh-base
  // user-interaction config row does; a bare plugin mount creates it on
  // this context), then expose the model-facing tool before resolving the
  // agent so per-step assembly includes ask_user_question. rc.2's provider
  // seat is registered below; the 0.1.2 line's agent-aware waterfall needs the
  // channel owner and is therefore registered immediately after the channel
  // is created. Optional-service access goes through `ctx.get`, not the
  // inject proxy.
  const userQuestions = ctx.get('userQuestions') ?? new UserQuestionService(ctx)
  ctx.plugin(toolAskUser)
  // The host-level tool mount above is intentional for the TUI and for user
  // presets, but the official Minimal preset is a strict two-tool trajectory
  // (persistent bash + str_replace_editor). Filter only that preset at the
  // final assembly boundary. Reading the session on every assembly also makes
  // blank-session /preset switches and resumed sessions behave correctly.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const presetId = context.agent === undefined ? undefined : runningPresetOf(context.agent.session)
    return filterMinimalPresetTools(assembled, presetId)
  })
  const questionStore = new QuestionStore()
  // One store, one teardown effect on both API lines. The compatibility
  // adapter binds either registration to this Cordis fiber; this separate
  // effect rejects asks still parked in the UI during teardown.
  ctx.effect(() => () => questionStore.rejectAll())
  // `/debug-prompt` snapshots the final provider-neutral request at the
  // llm/stream boundary, after every prompt and tool contributor has run.
  registerPromptDebug(ctx)
  // API selection and registration live behind one adapter boundary. The UI
  // bootstrap only translates a legacy seat conflict into its visible notice.
  const questionAnswererRegistration = prepareQuestionAnswerer(ctx, userQuestions, questionStore)
  const questionSeatDecision = questionAnswererRegistration.kind === 'legacy'
    ? questionAnswererRegistration.yieldDecision
    : undefined
  let questionSeatNotice: string | undefined
  if (questionSeatDecision?.action === 'alert-unverified') {
    ctx.logger.error(
      `dsh-tui: user-questions provider seat is held by a component self-reporting as ${questionSeatDecision.incumbentId} ` +
        '(identity not host-verified); this TUI will not register its questionnaire and model questions may be answered by it',
    )
    questionSeatNotice = t('question-provider-occupied-unverified', { id: questionSeatDecision.incumbentId ?? '' })
  } else if (questionSeatDecision?.action === 'alert') {
    const displayId = questionSeatDecision.incumbentId ?? t('question-provider-occupied-unknown')
    ctx.logger.error(
      `dsh-tui: user-questions provider seat is held by a non-host component (${displayId}); ` +
        'this TUI will not register its questionnaire and model questions may be answered by it',
    )
    questionSeatNotice = t('question-provider-occupied', { id: displayId })
  }

  // Child-process stderr guard (issue #17): MCP servers spawned with an
  // inherited stderr (the MCP SDK's stdio default) write straight to the
  // terminal device from the child process, bypassing the renderer's own
  // stderr patch and corrupting the alt-screen. Take over those spawns and
  // surface their stderr as deduplicated notifications instead. Installed
  // before agent resolution so servers spawned during startup are covered;
  // notices posted before the channel exists are buffered and flushed then.
  const stderrBacklog: Array<[string, { color?: 'error' | 'warning' | 'success'; timeoutMs?: number }?]> = []
  let notifyStderr: ((text: string, options?: { color?: 'error' | 'warning' | 'success'; timeoutMs?: number }) => void) | undefined
  const stderrReporter = createChildStderrReporter((text, options) => {
    if (notifyStderr !== undefined) notifyStderr(text, options)
    else stderrBacklog.push([text, options])
  })
  ctx.effect(() => {
    const restoreSpawn = installChildStderrGuard(line => {
      logForDebugging(`[child-stderr] ${line}`)
      stderrReporter.push(line)
    })
    return () => {
      restoreSpawn()
      stderrReporter.dispose()
    }
  })

  // Config-only route: resolveAgent applies the persisted `/model`
  // preference on CREATE only — a resumed session keeps the route its own
  // log records (last request/header), matching the preset rule.
  const configuredRoute = {
    provider: config.provider,
    model: config.model,
  }
  // Atomic route resolution (issue #67): a complete cordis.yml route wins
  // whole, else the persisted `/model` choice wins whole, else Harness's
  // provider-neutral agent-default-model selection. The local DeepSeek pair
  // remains the final fallback for bare embedders without that service. This
  // lets optional provider bundles supply the same default to Web and TUI
  // without patching this front door by name.
  const configuredDefault = (ctx.get('agentDefaultModel') as {
    currentSelection?(): { provider?: unknown; model?: unknown }
  } | undefined)?.currentSelection?.()
  const harnessDefault = typeof configuredDefault?.provider === 'string'
    && configuredDefault.provider.length > 0
    && typeof configuredDefault.model === 'string'
    && configuredDefault.model.length > 0
    ? { provider: configuredDefault.provider, model: configuredDefault.model }
    : undefined
  const startupRoute = resolveModelRoute(configuredRoute, readModelPref(), harnessDefault)
  // Session cwd (issue #96): explicit cordis.yml `cwd` wins; otherwise the
  // git worktree root containing the launch directory (the launch directory
  // itself outside any worktree), so `@` completion and mention expansion
  // see the repository, not an arbitrary launch subdirectory. Resolved ONCE
  // here — the agent meta and the channel must agree.
  const requestedWorkspace = config.workspace ?? process.env.DSH_TUI_WORKSPACE_TARGET
  // Degraded boot (issue #183): a stale bundle patch without the
  // dsh-tui-workspaces row leaves the service unmounted; resolve startup
  // targets through the local-only runtime (provider URIs then fail loud
  // below instead of crashing on an undefined service). A profile launch
  // without the service means the patch came from an older dsh-tui copy
  // than the running code — warn once so the skew is diagnosable. Bare
  // embedders (no --profile) take the same fallback by design, silently.
  const mountedWorkspaceService = getHostWorkspaceRuntime(ctx.get('tuiWorkspaces'))
  if (mountedWorkspaceService === undefined && resolveDshProfileName() !== undefined) {
    ctx.logger.warn(
      'dsh-tui: tuiWorkspaces service is not mounted; /workspace runs with the local-only fallback. ' +
      'The bundle patch is older than the installed dsh-tui package — update the globally installed dsh-tui launcher to match the profile (issue #183).',
    )
  }
  const workspaceService = mountedWorkspaceService ?? createLocalWorkspaceRuntime()
  // Same skew guard for the plugin-scene registry (dsh-tui-scenes row): the
  // channel degrades to never opening scenes when the service is absent, so
  // say why on profile launches — a plugin's open() otherwise fails with only
  // its own warn to go on.
  if (ctx.get('tuiScenes') === undefined && resolveDshProfileName() !== undefined) {
    ctx.logger.warn(
      'dsh-tui: tuiScenes service is not mounted; plugin scenes will never open. ' +
      'The bundle patch is older than the installed dsh-tui package — update the globally installed dsh-tui launcher to match the profile (issue #183).',
    )
  }
  // Same skew guard for the plugin-UI services (dsh-tui-extensions row):
  // managed dialogs park unanswered, status contributions never render,
  // shortcuts never match, custom-entry renderers stay invisible, and runtime
  // themes stay out of the picker when the row is absent — say why on profile
  // launches. The static JSON theme path remains available without this row.
  const themeHost = getHostThemes(ctx.get('tuiThemes') as TuiThemeRuntime | undefined)
  if ((ctx.get('tuiDialogs') === undefined || themeHost === undefined) && resolveDshProfileName() !== undefined) {
    ctx.logger.warn(
      'dsh-tui: tuiDialogs/tuiStatus/tuiShortcuts/tuiRenderers/tuiThemes services are not mounted; plugin dialogs, status contributions, shortcuts, custom-entry renderers and runtime themes are off. ' +
      'Static ~/.dsh-tui/themes JSON remains available. The bundle patch is older than the installed dsh-tui package — update the globally installed dsh-tui launcher to match the profile (issue #183).',
    )
  }
  // Same skew guard for the plugin-host row (dsh-tui-plugin-host): without
  // it there is no runtime generation id, no unified grant store service,
  // and no Host Descriptor — plugin interop surfaces degrade silently
  // otherwise. The D-7 decision gate does NOT depend on this row (the
  // channel installs its own), so interception gating stays intact either
  // way — what breaks is everything that rides on tuiPluginHost.
  if (ctx.get('tuiPluginHost') === undefined && resolveDshProfileName() !== undefined) {
    ctx.logger.warn(
      'dsh-tui: tuiPluginHost service is not mounted; plugin grant store, runtime generation and Host Descriptor are unavailable. ' +
      'The bundle patch is older than the installed dsh-tui package — update the globally installed dsh-tui launcher to match the profile (issue #183).',
    )
  }
  const initialWorkspace = requestedWorkspace === undefined
    ? undefined
    : await workspaceService.resolve(requestedWorkspace)
  if (requestedWorkspace !== undefined && initialWorkspace === undefined) {
    throw new Error(`dsh-tui: unsupported or unavailable workspace target: ${requestedWorkspace}`)
  }
  const sessionCwd = initialWorkspace?.cwd ?? resolveSessionCwd(config.cwd)
  const meta = { cwd: sessionCwd }
  // Launch-time resume target: the env handoff (launchers like naive-dsh) wins;
  // `dsh --profile tui` forwards `--resume` verbatim instead, so fall back to
  // parsing the forwarded app args (parity with the standalone bin).
  const launchSessionId = config.sessionId ?? resumeTargetFromArgv(process.argv.slice(2))
  const { agent, handle, agentPreset, route: createdRoute } = await resolveAgent(
    ctx,
    launchSessionId,
    configuredRoute,
    startupRoute,
    meta,
    config.preset,
  )
  try {
    // Opening a persisted TUI session is an explicit ownership action too.
    // Older TUI versions only wrote the Session log, so attaching on every
    // startup repairs those durable-but-ungrouped sessions idempotently.
    const attached = await attachSessionToWorkspace(ctx, meta.cwd, agent.session.id)
    if (!attached) {
      ctx.logger.warn(
        `dsh-tui: session "${agent.session.id}" has no workspace ownership because workspaceRegistry is not mounted`,
      )
    }
  } catch (error) {
    // The Session is already published and durable, matching Web's partial
    // failure contract. Keep the TUI usable but make the missing ownership
    // loud instead of silently leaving the conversation Ungrouped.
    ctx.logger.warn(
      `dsh-tui: session "${agent.session.id}" workspace attachment failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // Status-line route: the exact route the agent runs with — on create the
  // validated startup resolution, on resume the route the target session's
  // own records carry (a complete cordis.yml pin wins over them).
  const displayRoute = createdRoute ?? startupRoute
  const channel = createChannel(ctx, agent, {
    model: displayRoute.model,
    // A RESUMED session keeps its persisted header cwd (issue #96 review):
    // pre-upgrade sessions recorded the launch directory, and re-resolving
    // from the current launch directory would split @ expansion / file
    // completion (state.cwd) from the agent's own workspace record. Fresh
    // sessions record sessionCwd at creation, so both agree there.
    cwd: agent.session.header.cwd ?? sessionCwd,
    provider: displayRoute.provider,
    // Raw cordis.yml route (undefined when unset): the channel's
    // new-session path re-resolves prefs against these, and resume passes
    // only explicit values so the target session's own record wins.
    configuredModel: config.model,
    configuredProvider: config.provider,
    // Raw cordis.yml `lang` / `activityFrames`: /reload must not override a
    // static deployment choice with the persisted preference.
    configuredLang: config.lang,
    configuredActivityFrames: config.activityFrames,
    effort: config.effort,
    activity: config.activity,
    // Explicit cordis.yml value (static deployment choice) wins over the
    // runtime `/activity` preference, which wins over the default.
    activityFrames: config.activityFrames ?? readActivityFrames() ?? 'claude',
    // Static footer preference: cordis.yml `contextBar` (schema default on).
    contextBar: config.contextBar,
    // Same precedence for the agent preset: cordis.yml `preset` over the
    // persisted `/preset` choice; undefined adopts the roster default.
    configuredPreset: config.preset,
    agentPreset,
    // Shift+Tab session-mode cycle (undefined → the built-in default/
    // plan/full cycle in sessionModes.ts).
    modes: config.modes,
    // Edit/Write diff presentation (schema default 'auto'); the /settings
    // screen edits this key live through the dsh-tui namespace.
    diffLayout: config.diffLayout,
    thinkingFold: config.thinkingFold,
    toolBackground: config.toolBackground,
    scrollGutter: config.scrollGutter,
    pageMargin: config.pageMargin,
    foldTerminalCommand: config.foldTerminalCommand,
    promptSessionLabel: config.promptSessionLabel,
    expandEditor: config.expandEditor,
    smoothStreaming: config.smoothStreaming,
    statusBar: config.statusBar,
    handle,
  })
  // Root page-margin store: the PageMargin inset box sits ABOVE Chat, so
  // the channel version bump (which re-renders everything below Chat)
  // cannot drive it. Seed the store from config before the tree mounts;
  // applyDisplay below mirrors every settings change into it live.
  applyPageMargin(config.pageMargin)
  // Plugin toasts ride the channel's own notification surface: the runtime
  // already sanitized/rate-limited the delivery, the sink only forwards.
  // Without the extensions row (tuiToast absent) plugin toasts are dropped
  // by the runtime itself — same soft-degrade contract as the other seams.
  const toastStore = getHostToastStore(ctx.get('tuiToast') as TuiToastRuntime | undefined)
  toastStore?.setSink(delivery => {
    channel.notify(delivery.text, { color: delivery.color, timeoutMs: delivery.timeoutMs })
  })
  if (questionAnswererRegistration.kind === 'waterfall') {
    // Ownership follows the mutable channel; registration cleanup belongs to
    // this Cordis fiber.
    questionAnswererRegistration.register(channel)
  }
  // Fullscreen layout decision: the settings user layer (edited through the
  // /settings screen) overrides cordis.yml when set. The settings injection
  // below resolves it synchronously when the host settings service is up —
  // i.e. before the tree mounts. `fullscreenFrozen` latches at mount: the
  // exit funnel and the AlternateScreen wrap must keep reading the mode this
  // session ACTUALLY runs, never a mid-session edit meant for the next boot
  // (swapping layouts requires re-mounting the whole tree).
  let bootedFullscreen = config.fullscreen === true
  let fullscreenFrozen = false
  // The settings service may come up AFTER this plugin's apply: the cordis
  // inject callback defers until the service registers, so the first
  // `apply(scope.get())` below can land after the mount (field report: the
  // /settings fullscreen toggle never took effect — the frozen latch below
  // swallowed the late callback and bootedFullscreen stayed false). The
  // mount must therefore WAIT for the first settings application (bounded —
  // a bare embedder without a settings service must not deadlock).
  let resolveSettingsReady: (() => void) | undefined
  const settingsReady = new Promise<void>(resolve => {
    resolveSettingsReady = () => resolve()
    setTimeout(resolve, 300)
  })
  // Register the dsh-tui settings namespace so the /settings screen can
  // edit it (the section below was '命名空间未注册' without this): the
  // user layer in settings.yaml wins over cordis.yml's diffLayout, and
  // watch() lands commits on the live channel — no recompose needed.
  ctx.inject(['settings'], (settingsCtx) => {
    // alpha.2 removed the `settingsNamespace()` brand helper: register() now
    // takes the raw string and validates it itself, while rc.2 still wants the
    // branded handle. Brands are type-only, so the constant cast compiles
    // against both lines and the runtime value is identical ('dsh-tui' always
    // satisfied the namespace pattern).
    const tuiSettingsNs = 'dsh-tui' as SettingsNamespace
    const scope = settingsCtx.settings.register(
      tuiSettingsNs,
      Schema.object({
        diffLayout: Schema.union(['auto', 'split', 'unified']).default('auto'),
        thinkingFold: Schema.union(['preview', 'full']).default('preview'),
        toolBackground: Schema.union(['none', 'subtle', 'strong']).default('none'),
        scrollGutter: Schema.union(['timeline', 'scrollbar', 'hidden']).default('timeline'),
        // Preset names AND custom `NxM` specs (the settings field's parse
        // gate keeps junk out of the user layer; the transform normalizes
        // whatever survives — cordis.yml junk included).
        pageMargin: Schema.transform(
          Schema.string().default('normal'),
          value => normalizePageMargin(value),
        ),
        // No default on purpose (same rule as `fullscreen` below): a schema
        // default here would come back from scope.get()/watch() and shadow
        // an explicit cordis.yml `foldTerminalCommand: true` while the
        // settings user layer is unset — applyDisplay's
        // `?? config.foldTerminalCommand ?? false` already supplies the
        // default and keeps cordis.yml decisive.
        foldTerminalCommand: Schema.boolean(),
        promptSessionLabel: Schema.boolean().default(false),
        // No schema default (same rule as foldTerminalCommand): applyDisplay
        // resolves `?? config.expandEditor ?? true` so cordis.yml stays
        // decisive while the user layer is unset.
        expandEditor: Schema.boolean(),
        // Same no-default rule: applyDisplay resolves `?? config.smoothStreaming ?? true`.
        smoothStreaming: Schema.boolean(),
        statusBar: Schema.object({
          compact: Schema.boolean().default(DEFAULT_STATUS_BAR.compact),
          model: Schema.boolean().default(DEFAULT_STATUS_BAR.model),
          thinking: Schema.boolean().default(DEFAULT_STATUS_BAR.thinking),
          cwd: Schema.boolean().default(DEFAULT_STATUS_BAR.cwd),
          contextUsage: Schema.boolean().default(DEFAULT_STATUS_BAR.contextUsage),
          cache: Schema.boolean().default(DEFAULT_STATUS_BAR.cache),
          tokens: Schema.boolean().default(DEFAULT_STATUS_BAR.tokens),
          tps: Schema.boolean().default(DEFAULT_STATUS_BAR.tps),
          gitBranch: Schema.boolean().default(DEFAULT_STATUS_BAR.gitBranch),
          sessionTitle: Schema.boolean().default(DEFAULT_STATUS_BAR.sessionTitle),
          sessionId: Schema.boolean().default(DEFAULT_STATUS_BAR.sessionId),
          goal: Schema.boolean().default(DEFAULT_STATUS_BAR.goal),
          mode: Schema.boolean().default(DEFAULT_STATUS_BAR.mode),
          contextBar: Schema.boolean().default(DEFAULT_STATUS_BAR.contextBar),
          activity: Schema.boolean().default(DEFAULT_STATUS_BAR.activity),
          trajectory: Schema.boolean().default(DEFAULT_STATUS_BAR.trajectory),
          shortcutHint: Schema.boolean().default(DEFAULT_STATUS_BAR.shortcutHint),
        }).default({ ...DEFAULT_STATUS_BAR }),
        // Header pixel whale art; on unless settings.yaml says otherwise.
        whale: Schema.boolean().default(true),
        // Minimal mode: strips the header splash, emoji glyphs, and
        // decorative colors; code highlight and tool colors stay.
        minimal: Schema.boolean().default(false),
        // No default on purpose: an unset `lang` keeps the field showing
        // the effective language (see the section's format below) and lets
        // cordis.yml / lang.json keep their precedence.
        lang: Schema.union(['zh', 'en']),
        // Same no-default rule: unset keeps cordis.yml's `fullscreen`
        // decisive; set overrides it from the next boot on.
        fullscreen: Schema.boolean(),
        // Built-in action-shortcut overrides, one optional combo string per
        // action (see src/utils/keymap.ts). Unset keeps the default binding
        // and the section's format() shows the effective combos.
        shortcuts: Schema.object(
          Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action.id, Schema.string().required(false)])),
        ).required(false),
      }),
    )
    type SettingsValue = {
      diffLayout?: 'auto' | 'split' | 'unified'
      lang?: 'zh' | 'en'
      whale?: boolean
      minimal?: boolean
      fullscreen?: boolean
      thinkingFold?: 'preview' | 'full'
      toolBackground?: ToolBackground
      scrollGutter?: ScrollGutterMode
      pageMargin?: PageMarginSetting
      foldTerminalCommand?: boolean
      promptSessionLabel?: boolean
      expandEditor?: boolean
      smoothStreaming?: boolean
      statusBar?: Partial<StatusBarConfig>
      shortcuts?: Partial<Record<ShortcutActionId, string>>
    }
    const applyLayout = (value: SettingsValue): void => {
      channel.setDiffLayout(value.diffLayout ?? config.diffLayout ?? 'auto')
    }
    const applyWhale = (value: { whale?: boolean }): void => {
      channel.setWhale(value.whale ?? true)
    }
    const applyMinimal = (value: { minimal?: boolean }): void => {
      channel.setMinimal(value.minimal ?? false)
    }
    // Fullscreen: only meaningful before the tree mounts (the freeze latch
    // above). A later doc change (mid-session /settings edit) is persisted
    // by the service and picked up on the next boot; the watch below says
    // so with a notify.
    const applyFullscreen = (value: SettingsValue): void => {
      if (!fullscreenFrozen && typeof value.fullscreen === 'boolean') {
        bootedFullscreen = value.fullscreen
      }
    }
    // The /settings language field writes `lang` through the settings
    // service (user layer): apply it live and mirror it to lang.json so
    // the /lang command and next-boot resolution agree. DSH_TUI_LANG
    // stays the top precedence — a pinned env is never overridden by the
    // document.
    const applyLang = (value: SettingsValue): void => {
      if (!isLang(process.env.DSH_TUI_LANG) && isLang(value.lang)) {
        setLang(value.lang)
        writeLangPref(value.lang)
      }
    }
    // Display preferences ride the same namespace: /settings writes them
    // live and future render consumers observe the channel version bump.
    const applyDisplay = (value: SettingsValue): void => {
      channel.setThinkingFold(value.thinkingFold ?? config.thinkingFold ?? 'preview')
      channel.setToolBackground(normalizeToolBackground(value.toolBackground ?? config.toolBackground))
      channel.setScrollGutter(normalizeScrollGutter(value.scrollGutter ?? config.scrollGutter))
      // Page margin: the channel carries the mode (tests observe it), the
      // module store drives the actual inset box above Chat — keep both in
      // lockstep so a live /settings edit re-lays out immediately.
      const pageMargin = normalizePageMargin(value.pageMargin ?? config.pageMargin)
      channel.setPageMargin(pageMargin)
      applyPageMargin(pageMargin)
      channel.setFoldTerminalCommand(value.foldTerminalCommand ?? config.foldTerminalCommand ?? false)
      channel.setPromptSessionLabel(value.promptSessionLabel ?? config.promptSessionLabel ?? false)
      channel.setExpandEditor(value.expandEditor ?? config.expandEditor ?? true)
      channel.setSmoothStreaming(value.smoothStreaming ?? config.smoothStreaming ?? true)
      channel.setStatusBar(normalizeStatusBar(value.statusBar ?? config.statusBar))
    }
    // Shortcut overrides resolve per action: settings user layer wins over
    // cordis.yml's `shortcuts` (same precedence as every other field);
    // unset everywhere keeps the registry default. Applied live into the
    // keymap module — the very next keypress matches the new combos.
    const applyShortcuts = (value: SettingsValue): void => {
      const userLayer = value.shortcuts ?? {}
      const configLayer = config.shortcuts ?? {}
      const merged: Partial<Record<ShortcutActionId, string>> = {}
      for (const action of SHORTCUT_ACTIONS) {
        const user = userLayer[action.id]
        const pinned = configLayer[action.id]
        const chosen = typeof user === 'string' && user.trim() !== ''
          ? user
          : (typeof pinned === 'string' && pinned.trim() !== '' ? pinned : undefined)
        if (chosen !== undefined) merged[action.id] = chosen
      }
      setKeymapOverrides(merged)
    }
    const apply = (next: SettingsValue): void => {
      applyLayout(next)
      applyWhale(next)
      applyMinimal(next)
      applyLang(next)
      applyDisplay(next)
      applyShortcuts(next)
      applyFullscreen(next)
    }
    // One-time fullscreen factory-default migration (companion to the
    // schema + cordis.patch.yml flip false→true): a `fullscreen: false`
    // pinned in the settings user layer BEFORE the flip keeps overriding
    // the new default on every boot. The first boot past this code clears
    // that stale explicit choice; the migrations.json marker makes it
    // strictly once, so a `false` re-pinned afterwards always stands. The
    // boot decision cannot wait for the async doc write — the stale value
    // is shadowed out of the first apply below (destructuring omission,
    // not an explicit undefined), and the later watch commit (fullscreen
    // back to undefined) is a no-op for applyFullscreen.
    const bootSettings = scope.get()
    const fullscreenMigration = planFullscreenFactoryMigration(bootSettings.fullscreen, readAppliedMigrations())
    void commitFullscreenFactoryMigration(fullscreenMigration, {
      unset: () => settingsCtx.settings.mutate(tuiSettingsNs, [{ op: 'unset', path: ['fullscreen'] }]),
    })
    if (fullscreenMigration === 'unset') {
      channel.notify(t('settings-fullscreen-migrated'), { color: 'warning' })
    }
    const { fullscreen: staleFullscreen, ...migratedSettings } = bootSettings
    apply(fullscreenMigration === 'unset' ? migratedSettings : bootSettings)
    scope.watch(next => {
      apply(next)
      if (typeof next.fullscreen === 'boolean' && next.fullscreen !== bootedFullscreen) {
        channel.notify(t('settings-fullscreen-restart'), { color: 'warning' })
      }
    })
    resolveSettingsReady?.()
  })
  // The /settings screen's own section: the dsh-tui namespace comes from
  // the settings registration above, and the declared selects write `lang`
  // and `diffLayout` back through the settings service's revision-fenced
  // mutate (the watch applies both live).
  //
  // Shortcut fields: one text field per customizable action. The draft is
  // one or more ctrl+/alt+ combos (comma-separated); blank restores the
  // default, and a combo another action or a fixed editor binding already
  // owns is refused as invalid so remaps can never silently shadow.
  const shortcutFieldMeta: Record<ShortcutActionId, { label: string; zh: string; hintEn: (defaults: string) => string; hintZh: (defaults: string) => string }> = {
    paste: {
      label: 'Paste shortcut',
      zh: '粘贴快捷键',
      hintEn: d => `Clipboard paste (text, file paths, images). Default: ${d}. Alt+V works where the terminal eats Ctrl+V.`,
      hintZh: d => `剪贴板粘贴（文本、文件路径、图片）。默认 ${d}。终端吞掉 Ctrl+V 时可用 Alt+V。`,
    },
    history: {
      label: 'History search shortcut',
      zh: '历史搜索快捷键',
      hintEn: d => `Open the prompt-history search. Default: ${d}.`,
      hintZh: d => `打开输入历史搜索。默认 ${d}。`,
    },
    editor: {
      label: 'External editor shortcut',
      zh: '外部编辑器快捷键',
      hintEn: d => `Edit the draft in $VISUAL/$EDITOR. Default: ${d}.`,
      hintZh: d => `在 $VISUAL/$EDITOR 外部编辑器中编辑草稿。默认 ${d}。`,
    },
    transcript: {
      label: 'Transcript mode shortcut',
      zh: '转录模式快捷键',
      hintEn: d => `Toggle expanded transcript mode. Default: ${d}.`,
      hintZh: d => `切换展开转录模式。默认 ${d}。`,
    },
    trajectory: {
      label: 'Trajectory scene shortcut',
      zh: '轨迹场景快捷键',
      hintEn: d => `Open the trajectory scene. Default: ${d}.`,
      hintZh: d => `打开轨迹场景。默认 ${d}。`,
    },
    dashboard: {
      label: 'Subagent dashboard shortcut',
      zh: '子代理面板快捷键',
      hintEn: d => `Open the subagent dashboard. Default: ${d}.`,
      hintZh: d => `打开子代理面板。默认 ${d}。`,
    },
    contextPanel: {
      label: 'Loaded-context panel shortcut',
      zh: '加载上下文面板快捷键',
      hintEn: d => `Toggle the startup loaded-context panel. Default: ${d}.`,
      hintZh: d => `切换启动时的已加载上下文面板。默认 ${d}。`,
    },
    showAll: {
      label: 'Show-all shortcut',
      zh: '显示全部消息快捷键',
      hintEn: d => `Toggle show-all-messages. Default: ${d}.`,
      hintZh: d => `切换显示全部消息。默认 ${d}。`,
    },
    redraw: {
      label: 'Redraw shortcut',
      zh: '终端重绘快捷键',
      hintEn: d => `Clear and repaint the terminal. Default: ${d}.`,
      hintZh: d => `清空并重绘终端。默认 ${d}。`,
    },
    todoFold: {
      label: 'Todo fold shortcut',
      zh: '待办折叠快捷键',
      hintEn: d => `Fold/unfold the goal/todo panel. Default: ${d}.`,
      hintZh: d => `折叠/展开目标与待办面板。默认 ${d}。`,
    },
    expandEditor: {
      label: 'Fullscreen editor shortcut',
      zh: '全屏草稿编辑快捷键',
      hintEn: d => `Toggle the fullscreen draft editor (Enter inserts a newline, Ctrl+Enter sends). Default: ${d}.`,
      hintZh: d => `切换全屏草稿编辑器（Enter 换行、Ctrl+Enter 发送）。默认 ${d}。`,
    },
  }
  const shortcutFields: TuiSettingsField[] = SHORTCUT_ACTIONS.map(action => {
    const meta = shortcutFieldMeta[action.id]
    const defaults = action.defaults.join(', ')
    return {
      path: ['shortcuts', action.id],
      label: meta.label,
      descriptions: { zh: meta.zh },
      hint: meta.hintEn(defaults),
      hintDescriptions: { zh: meta.hintZh(defaults) },
      group: 'shortcuts',
      kind: 'text',
      format(value: unknown): string {
        return typeof value === 'string' && value.trim() !== '' ? value : effectiveComboString(action.id)
      },
      parse(text: string) {
        const draft = parseComboDraft(text)
        if (draft === undefined) return undefined
        if (draft.combos.length === 0) return { kind: 'clear' }
        if (draftComboConflicts(action.id, draft.combos)) return undefined
        return { kind: 'set', value: draft.combos.join(', ') }
      },
    }
  })
  // Prefer the composition's sections service; fall back to the in-package
  // local host. Real compositions have been observed disposing the whole
  // dsh-tui-* host-seam insert list right after load (issue #557), which
  // left this registration silently skipped and /settings read-only.
  // channel.ts reads through the same fallback, so both sides meet in the
  // same registry either way.
  {
    const settingsSections = getHostSettingsSections(
      ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined,
    ) ?? getLocalSettingsSectionsHost()
    const unregister = settingsSections.register({
      ns: 'dsh-tui',
      title: 'dsh-tui',
      groups: [
        { id: 'status-bar', title: 'Status bar', descriptions: { zh: '底栏设置' } },
        { id: 'shortcuts', title: 'Shortcuts', descriptions: { zh: '快捷键' } },
        { id: 'session', title: 'Session', descriptions: { zh: '会话' } },
      ],
      fields: [
        {
          path: ['lang'],
          label: 'Language',
          descriptions: { zh: '界面语言' },
          hint: 'UI language for the whole interface — applies immediately and is saved.',
          hintDescriptions: { zh: '整个界面的显示语言——立即生效并保存。' },
          kind: 'select',
          options: [
            { value: 'zh', label: '中文', descriptions: { zh: '中文' } },
            { value: 'en', label: 'English', descriptions: { zh: '英文' } },
          ],
          format(value: unknown): string {
            // Unset in settings.yaml: show the effective UI language
            // (env / cordis.yml / lang.json resolution) instead of a
            // blank "unset" that hides the current choice.
            return value === undefined || value === null ? getLang() : String(value)
          },
        },
        {
          path: ['fullscreen'],
          label: 'Fullscreen mode',
          descriptions: { zh: '全屏模式' },
          // 故意不用 "alt-screen" 这类终端术语：读者要的是行为差异。鼠标
          // 两种模式都可用（整屏页面自带鼠标跟踪），别让描述暗示关掉就
          // 没有鼠标——最常见的误解。长度对齐既有最长 hint（单行假设）。
          hint: 'On: app takes the whole screen (vim/less style), in-app mouse. Off: native scrollback; full-page screens keep the mouse. Restart to apply.',
          hintDescriptions: { zh: '开启：接管整个终端（同 vim/less），应用内鼠标；关闭：终端原生滚动选择；整屏页两种模式都有鼠标。重启生效。' },
          kind: 'boolean',
          format(value: unknown): string {
            // Unset in settings.yaml: show what THIS session booted with
            // (the cordis.yml resolution) instead of a misleading false.
            return value === undefined || value === null ? String(bootedFullscreen) : String(value)
          },
        },
        {
          path: ['diffLayout'],
          label: 'Diff layout',
          descriptions: { zh: 'diff 布局' },
          hint: 'Edit/Write tool cards: auto picks by terminal width, or force one layout.',
          hintDescriptions: { zh: 'Edit/Write 工具卡的 diff 呈现：auto 按终端宽度选择，或强制一种布局。' },
          kind: 'select',
          options: [
            { value: 'auto', label: 'Auto (by width)', descriptions: { zh: '自动（按宽度）' } },
            { value: 'split', label: 'Side-by-side', descriptions: { zh: '双栏对照' } },
            { value: 'unified', label: 'Unified', descriptions: { zh: '统一式' } },
          ],
        },
        {
          path: ['thinkingFold'],
          label: 'Thinking display',
          descriptions: { zh: '思考块展示' },
          hint: 'Preview shows 2-3 live lines; Full stays expanded until turn end. Click a streaming block to switch between preview and full.',
          hintDescriptions: { zh: '预览模式显示 2-3 行动态思考；展开模式保持至轮末。点击流式思考块可在预览与全文间切换。' },
          kind: 'select',
          options: [
            { value: 'preview', label: 'Preview (2-3 lines)', descriptions: { zh: '预览（2-3 行）' } },
            { value: 'full', label: 'Full until turn end', descriptions: { zh: '展开至轮末' } },
          ],
        },
        {
          path: ['toolBackground'],
          label: 'Tool background',
          descriptions: { zh: '工具卡背景' },
          hint: 'Choose whether tool-call cards add no, subtle, or strong background emphasis.',
          hintDescriptions: { zh: '选择工具调用卡片不添加、轻微或明显的背景强调。' },
          kind: 'select',
          options: [
            { value: 'none', label: 'None', descriptions: { zh: '无' } },
            { value: 'subtle', label: 'Subtle', descriptions: { zh: '轻微' } },
            { value: 'strong', label: 'Strong', descriptions: { zh: '明显' } },
          ],
        },
        {
          path: ['scrollGutter'],
          label: 'Transcript gutter',
          descriptions: { zh: '转录边栏' },
          hint: 'Right gutter of the fullscreen transcript: per-turn timeline ticks, a proportional scrollbar, or nothing.',
          hintDescriptions: { zh: '全屏转录区右侧边栏：按轮次的时间线节点、比例滚动条，或留空。' },
          kind: 'select',
          options: [
            { value: 'timeline', label: 'Turn timeline', descriptions: { zh: '轮次时间线' } },
            { value: 'scrollbar', label: 'Scrollbar', descriptions: { zh: '滚动条' } },
            { value: 'hidden', label: 'Hidden', descriptions: { zh: '隐藏' } },
          ],
        },
        {
          path: ['pageMargin'],
          label: 'Page margin',
          descriptions: { zh: '页边距' },
          hint: 'Inset the whole UI from the terminal edges. ←/→ cycles presets (none / slim / normal / roomy); Enter types a custom spec `NxM`: N columns per side, M rows top/bottom (e.g. 3x1, max 8x4; a bare `N` keeps rows at 1). Empty resets to the default `normal`. Applies immediately.',
          hintDescriptions: { zh: '让整个界面相对终端四边内缩。←/→ 循环预设（none / slim / normal / roomy）；Enter 输入自定义 `NxM`：左右各 N 列、上下各 M 行（如 3x1，上限 8x4；只填 N 则上下保持 1 行）。清空恢复默认 normal。立即生效。' },
          kind: 'text',
          placeholder: 'normal',
          options: [
            { value: 'none', label: 'None', descriptions: { zh: '无' } },
            { value: 'slim', label: 'Slim', descriptions: { zh: '窄' } },
            { value: 'normal', label: 'Normal', descriptions: { zh: '常规' } },
            { value: 'roomy', label: 'Roomy', descriptions: { zh: '宽' } },
          ],
          format(value: unknown): string {
            return String(value ?? config.pageMargin ?? DEFAULT_PAGE_MARGIN)
          },
          parse(text: string) {
            const draft = text.trim().toLowerCase()
            if (draft === '') return { kind: 'clear' }
            if (isPageMarginMode(draft)) return { kind: 'set', value: draft }
            const spec = parsePageMarginSpec(draft)
            return spec === undefined ? undefined : { kind: 'set', value: spec }
          },
        },
        {
          path: ['foldTerminalCommand'],
          label: 'Fold terminal command',
          descriptions: { zh: '折叠终端命令' },
          hint: 'Terminal cards (Bash/PowerShell): collapse a multi-line command header to its first line + count; Ctrl+O or a click expands it.',
          hintDescriptions: { zh: '终端卡（Bash/PowerShell）：多行命令头部折叠为首行 + 计数；Ctrl+O 或点击卡片展开。' },
          kind: 'boolean',
          format(value: unknown): string {
            // Unset in settings.yaml: show the effective resolution (cordis.yml
            // → off) instead of a blank — same rule as `fullscreen`'s field.
            return String(typeof value === 'boolean' ? value : config.foldTerminalCommand === true)
          },
        },
        {
          path: ['promptSessionLabel'],
          label: 'Session name chip',
          descriptions: { zh: '会话名标签' },
          hint: 'Show the session name on the prompt top border, right corner. Off by default.',
          hintDescriptions: { zh: '在输入框顶边框右上角显示会话名。默认关闭。' },
          kind: 'boolean',
        },
        {
          path: ['expandEditor'],
          label: 'Fullscreen draft editor',
          descriptions: { zh: '全屏草稿编辑' },
          hint: 'On: the ⛶ affordance in the input row and the expand-editor shortcut (default Ctrl+Shift+E) expand the draft into a whole-screen editor (Enter = newline, Ctrl+Enter = send). Off: both entry points disappear. On by default.',
          hintDescriptions: { zh: '开启：输入行尾 ⛶ 按钮与全屏编辑快捷键（默认 Ctrl+Shift+E）把草稿展开成整屏编辑器（Enter 换行、Ctrl+Enter 发送）。关闭：两个入口都不显示。默认开启。' },
          kind: 'boolean',
          format(value: unknown): string {
            // Unset in settings.yaml: the effective default is on.
            return String(typeof value === 'boolean' ? value : config.expandEditor !== false)
          },
        },
        {
          path: ['smoothStreaming'],
          label: 'Smooth streaming',
          descriptions: { zh: '流式平滑输出' },
          hint: 'Reveal live replies, expanded thinking, and tool-call bodies through an even ~30fps flow instead of per-burst jumps; one-shot non-streaming replies paint as a flow too. Replay/history always paints complete. On by default.',
          hintDescriptions: { zh: '把实时回复、展开的思考与工具卡正文按 ~30fps 匀速揭示，不再随供应商突发一跳一跳；一次性到达的非流式回复也会平滑打出。回放/历史内容始终完整直出。默认开启。' },
          kind: 'boolean',
          format(value: unknown): string {
            // Unset in settings.yaml: the effective default is on.
            return String(typeof value === 'boolean' ? value : config.smoothStreaming !== false)
          },
        },
        {
          path: ['recapOnOpen'],
          label: 'Auto recap on open',
          descriptions: { zh: '打开会话时自动总结' },
          hint: 'On: opening/resuming a session automatically summarizes its recent activity into a dim line at the bottom of the transcript (hover/click to view or apply the suggested title). Off: use /recap manually.',
          hintDescriptions: { zh: '开启：打开/恢复会话时自动把最近活动总结成一行灰字显示在会话底部（可悬停/点击查看或应用建议标题）；关闭：手动使用 /recap。' },
          kind: 'boolean',
          format(value: unknown): string {
            // Unset in settings.yaml: the default is on.
            return value === undefined || value === null ? 'true' : String(value)
          },
        },
        ...shortcutFields,
        {
          path: ['statusBar', 'compact'],
          label: 'Compact status bar',
          descriptions: { zh: '紧凑状态栏' },
          hint: 'Prefer the compact status presentation when terminal space allows.',
          hintDescriptions: { zh: '终端空间允许时优先使用紧凑状态栏布局。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'model'],
          label: 'Show model',
          descriptions: { zh: '显示模型' },
          hint: 'Show the live model id in the status bar.',
          hintDescriptions: { zh: '在状态栏显示当前模型标识。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'thinking'],
          label: 'Show thinking',
          descriptions: { zh: '显示思考' },
          hint: 'Show the live reasoning effort or thinking mode.',
          hintDescriptions: { zh: '显示当前推理强度或思考模式。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'cwd'],
          label: 'Show working directory',
          descriptions: { zh: '显示工作目录' },
          hint: 'Show the session working directory.',
          hintDescriptions: { zh: '显示当前会话的工作目录。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'contextUsage'],
          label: 'Show context usage',
          descriptions: { zh: '显示上下文用量' },
          hint: 'Show current context-window consumption.',
          hintDescriptions: { zh: '显示当前上下文窗口占用情况。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'cache'],
          label: 'Show cache',
          descriptions: { zh: '显示缓存' },
          hint: 'Show prompt-cache hit information.',
          hintDescriptions: { zh: '显示提示词缓存命中信息。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'tokens'],
          label: 'Show token totals',
          descriptions: { zh: '显示 Token 总量' },
          hint: 'Show running input and output token totals.',
          hintDescriptions: { zh: '显示累计输入与输出 Token。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'cost'],
          label: 'Show session cost estimate',
          descriptions: { zh: '显示本会话花费估算' },
          hint: 'Show the estimated session spend (≈¥) next to the token totals. Only appears for official DeepSeek providers whose model has a known price; the estimate follows the official per-million-token rates (peak/idle hours) and is not a bill.',
          hintDescriptions: { zh: '在 Token 总量旁显示本会话花费估算（≈¥）。仅在使用 DeepSeek 官方 API key 且模型有已知单价时显示；按官方每百万 token 单价（高峰/空闲时段）估算，非账单。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'tps'],
          label: 'Show output speed',
          descriptions: { zh: '显示输出速度' },
          hint: 'Show live and recent tokens-per-second metrics.',
          hintDescriptions: { zh: '显示实时及近期每秒 Token 指标。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'gitBranch'],
          label: 'Show git branch',
          descriptions: { zh: '显示 Git 分支' },
          hint: 'Show the current git branch when available.',
          hintDescriptions: { zh: '可用时显示当前 Git 分支。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'sessionTitle'],
          label: 'Show session title',
          descriptions: { zh: '显示会话标题' },
          hint: 'Show the current session title.',
          hintDescriptions: { zh: '显示当前会话标题。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'sessionId'],
          label: 'Show session id',
          descriptions: { zh: '显示会话 ID' },
          hint: 'Show the short session id (# + first 8 chars) — it matches the session log filename for --resume.',
          hintDescriptions: { zh: '显示短会话 ID（# + 前 8 位）——与日志文件名对应，方便 --resume 定位。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'goal'],
          label: 'Show goal status',
          descriptions: { zh: '显示 Goal 状态' },
          hint: 'Show a compact goal chip (phase glyph + rounds) in the status footer while a goal exists.',
          hintDescriptions: { zh: '存在 Goal 时，在底部状态栏显示紧凑的 Goal 状态（阶段符号与轮次）。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'mode'],
          label: 'Show session mode',
          descriptions: { zh: '显示会话模式' },
          hint: 'Show the active non-default session mode.',
          hintDescriptions: { zh: '显示当前启用的非默认会话模式。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'contextBar'],
          label: 'Show context progress bar',
          descriptions: { zh: '显示上下文进度条' },
          hint: 'Show the segmented context progress bar on its own footer row.',
          hintDescriptions: { zh: '在底部单独一行显示分段上下文进度条。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'activity'],
          label: 'Show activity summary',
          descriptions: { zh: '显示活动摘要' },
          hint: 'Show the idle working-activity summary.',
          hintDescriptions: { zh: '显示空闲时的工作活动摘要。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'trajectory'],
          label: 'Show trajectory strip',
          descriptions: { zh: '显示轨迹条' },
          hint: 'Show the animated mini trajectory strip at the footer edge.',
          hintDescriptions: { zh: '在状态栏边缘显示动态迷你轨迹条。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['statusBar', 'shortcutHint'],
          label: 'Show shortcut reminder',
          descriptions: { zh: '显示快捷键提示' },
          hint: 'Control only the idle `? for shortcuts` reminder; pressing ? and the Esc shortcut hints are unaffected.',
          hintDescriptions: { zh: '仅控制空闲时的 `? for shortcuts` 提示；按 ? 打开快捷键以及 Esc 快捷提示均不受影响。' },
          group: 'status-bar',
          kind: 'boolean',
        },
        {
          path: ['whale'],
          label: 'Whale art',
          descriptions: { zh: '鲸鱼娘' },
          hint: 'Show the pixel whale in the header splash.',
          hintDescriptions: { zh: '开屏头部显示像素鲸鱼娘。' },
          kind: 'boolean',
        },
        {
          path: ['minimal'],
          label: 'Minimal mode',
          descriptions: { zh: '极简模式' },
          hint: 'Hide the header splash, emoji glyphs, and decorative colors; code highlight and tool colors stay. Trims the status bar to model + cwd.',
          hintDescriptions: { zh: '隐藏开屏头部、emoji 状态符与装饰性配色；代码高亮与工具配色保留，底栏只留模型与目录。' },
          kind: 'boolean',
        },
      ],
    })
    ctx.effect(() => unregister)
  }
  // DSH approval seam: the permission layer asks ApprovalService.request(),
  // which dispatches an `approval/request` waterfall. With no answerer the
  // chain falls through to the fail-closed 'unavailable', so register this
  // TUI as the interactive answerer for EVERY agent in this process — the
  // attached session's asks and any background (agent view) session's asks
  // alike, so an unattended session surfaces as "needs input" instead of
  // failing closed. One ask is shown at a time, whichever agent asked.
  // Guarded on the service being mounted — a bare composition without the
  // dsh-base approval row has nothing to answer into.
  const approvalStore = new ApprovalStore()
  if (ctx.get('approval') !== undefined) {
    ctx.on('approval/request', (req, next) =>
      approvalStore.park(req).catch(() => next()))
    // Badge-flip push (P-4): React does not know the session log appended —
    // a source-badge verdict that only flips inside getSnapshot() surfaces
    // solely when something else re-renders. Feed the session firehose to
    // the store: it reacts only to tool/result (the sole verdict-flipping
    // event type), and its internal log-length memo skips appends from any
    // session other than the active ask's, so no agent filtering is needed
    // here. The firehose fires post-commit, after the event entered
    // the live session log, so the recheck sees the settled result.
    ctx.on('session/event', (_session, event) => approvalStore.noteSessionEvent(event))
    ctx.effect(() => () => approvalStore.settleAll('cancelled'))
  }
  // The agent view reads parked ask ids for its "needs input" state.
  channel.bindApprovalStore(approvalStore)
  const herdr = attachHerdrIntegration({
    channel,
    questions: questionStore,
    approvals: approvalStore,
  })
  if (herdr !== undefined) {
    ctx.effect(() => () => herdr.dispose())
  }
  // Positional command-line arguments are the initial prompt (issue #53):
  // `dsh-tui "run the tests"` forwards positionals through the dsh CLI,
  // which mounts them as ctx.cmdlineArgs. The service shape drifted across
  // dsh-cmdline builds — `{ get() }` is the current contract, older builds
  // exposed `{ args }` — so read both. Submit once the channel exists;
  // delivery goes through the normal pending/inbox chain, so no special
  // timing is needed; flag-shaped leftovers are not prompt text.
  const cmdline = (ctx as { cmdlineArgs?: { get?: () => readonly string[]; args?: readonly string[] } }).cmdlineArgs
  const cmdlineArgs = cmdline?.get?.() ?? cmdline?.args
  const initialPrompt = initialPromptFromCmdlineArgs(cmdlineArgs)
  if (initialPrompt) channel.submit(initialPrompt)
  // Attach the stderr reporter to the live channel and flush anything a
  // startup-spawned server produced while the channel didn't exist yet.
  notifyStderr = (text, options) => channel.notify(text, options)
  // The question-seat alert was raised before the channel existed; flush it
  // now so it lands as an in-UI notice, not only in the log file.
  if (questionSeatNotice !== undefined) {
    channel.notify(questionSeatNotice, { color: 'error' })
    questionSeatNotice = undefined
  }
  for (const [text, options] of stderrBacklog.splice(0)) {
    notifyStderr(text, options)
  }
  // Single exit funnel: `/exit` and double Ctrl+C land here, and so does
  // the unmount triggered by a cordis context teardown — but the two must
  // not share a fate (issue #12). The DSH launcher's boot-time recompose
  // disposes every entry once; treating that teardown as a user exit killed
  // the process before the recomposed tree could re-mount the TUI (the
  // "flash back to bash with no error" symptom). Teardown only unmounts the
  // UI; user exit runs the full leave sequence: unmount() restores the
  // terminal (cursor, raw mode, mouse tracking) and the explicit newlines
  // keep the shell prompt from overlapping the TUI's last line.
  let instance: Awaited<ReturnType<typeof render>> | undefined
  let exited = false
  let updateRequested = false
  let updateTargetVersion: string | undefined
  // `/restart` flag: same exit funnel as `/update` minus the pnpm step —
  // write the resume target, restore the terminal, respawn the process with
  // the original argv, and let the fresh boot attach the same session.
  let restartRequested = false
  // The profile this process was booted with (`dsh --profile <name>`); dsh
  // exposes it nowhere else, and /update must update the installation the
  // user is actually running, not a hard-coded one.
  const profile = resolveDshProfileName()
  // Single exit funnel: `/exit` and double Ctrl+C land here, and so does
  // the unmount triggered by a cordis context teardown — but the two must
  // not share a fate (issue #12). Teardown only unmounts the UI; user exit
  // runs the full leave sequence below (resume marker, terminal restore,
  // update handoff or resume hint).
  const funnel = createExitFunnel({
    onUserExit: error => {
      // Mirror the funnel's internal exited flag for the /update and
      // background-check guards that still read the outer one.
      exited = true
      if (error !== undefined) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.error(`dsh-tui: exit after error: ${message}`)
        void finishExit(
          ctx,
          instance,
          bootedFullscreen,
          undefined,
          `dsh-tui crashed: ${message}`,
          () => disposeRootAndExit(ctx, 1),
        )
        return
      }
      if (updateRequested) {
        try {
          writeResumeTarget(channel.agentId)
        } catch {
          // Resume persistence is best effort and must never block an update.
        }
        const hintText = isStandaloneRuntime()
          ? t('update-standalone-starting')
          : t('update-starting')
        void finishExit(
          ctx,
          instance,
          bootedFullscreen,
          hintText,
          undefined,
          () => runUpdate(ctx, profile, channel.agentId, updateTargetVersion),
        )
        return
      }
      // `/restart`: same handoff as the update path, no installation step.
      // The resume target is written unconditionally — the user asked to
      // restart THIS session, blank or not (mirrors the update contract).
      if (restartRequested) {
        beginRestartAttempt(channel.agentId)
        logRestartEvent('funnel: /restart branch entered')
        try {
          writeResumeTarget(channel.agentId)
          logRestartEvent('funnel: resume target written')
        } catch (error) {
          // Resume persistence is best effort and must never block a restart.
          logRestartEvent('funnel: resume target write failed', {
            message: error instanceof Error ? error.message : String(error),
          })
        }
        void finishExit(
          ctx,
          instance,
          bootedFullscreen,
          t('restart-starting'),
          undefined,
          () => runRestart(ctx, profile, channel.agentId),
        )
        return
      }

      // Judge against the live session behind the channel (channel.agentId),
      // not the boot-time agent captured above: /resume, /new and /model swap
      // the active agent, so the captured reference can go stale (see
      // isExitResumable).
      const resumable = isExitResumable({
        pendingCount: channel.pending.length,
        liveAgent: ctx.agents.get(SessionId(channel.agentId)),
        startupAgent: agent,
      })
      try {
        if (resumable) writeResumeTarget(channel.agentId)
        else clearResumeTarget()
      } catch {
        // Resume persistence is best effort and must never block shutdown.
      }
      const hint = resumable
        ? `Resume with the command below:\n${resumeCommand(profile, channel.agentId)}`
        : undefined
      void finishExit(
        ctx,
        instance,
        bootedFullscreen,
        hint,
        undefined,
        () => disposeRootAndExit(ctx, 0),
      )
    },
  })
  const handleExit = funnel.handleExit

  // External injection controller: Chat fills it with `{ append, submit }`
  // every render; the injection socket (opened below) drives it. A ref rather
  // than a prop callback so the socket handler always reaches the live Chat.
  const injectControllerRef = React.createRef<InjectController | null>() as React.RefObject<InjectController | null>

  // Chat's `fullscreen` prop must match the root wrap below, or the
  // full-screen surfaces inside Chat (session browser, settings, trajectory,
  // subagent pages) would nest a SECOND <AlternateScreen> — whose unmount
  // writes DEC 1049 exit and drops the whole app back to the main screen
  // (the stable /resume→Esc "exited fullscreen" repro). The prop is captured
  // when the element is created, so wait for the settings first-application
  // BEFORE creating Chat: the element must see the same bootedFullscreen the
  // root tree resolves after settingsReady below.
  await settingsReady
  const chat = React.createElement(Chat, {
    channel,
    questionStore,
    approvalStore,
    injectControllerRef,
    // The dsh-tui-extensions row's services (managed dialogs, status line,
    // shortcuts). Soft-consumed: absent the row (stale patch, bare embed),
    // Chat falls back to inert stores and no shortcut registry.
    extensionDialogs: getHostDialogStore(ctx.get('tuiDialogs') as TuiDialogRuntime | undefined),
    extensionStatus: getHostStatusStore(ctx.get('tuiStatus') as TuiStatusRuntime | undefined),
    extensionShortcuts: getHostShortcuts(ctx.get('tuiShortcuts') as TuiShortcutRuntime | undefined),
    themeHost,
    // Full-screen surfaces inside Chat — the trajectory scene and the session
    // browser — enter the alt screen themselves in inline mode; in fullscreen
    // the tree is already wrapped below, so they must not nest.
    fullscreen: bootedFullscreen,
    onExit: () => handleExit(),
    // `/restart`: respawn this process and resume the session, no update.
    onRestart: () => {
      if (exited || restartRequested) return
      restartRequested = true
      logRestartEvent('command: /restart accepted')
      channel.notify(t('restart-starting'))
      handleExit()
    },
    // Only a `dsh --profile <name>` launch has a profile installation for
    // `/update` to act on; source checkouts and `--config` overlays get the
    // unavailable notice instead.
    onUpdate: profile === undefined ? undefined : () => {
      if (exited || updateRequested) return
      // Confirm the target version before tearing the TUI down: on an
      // already-latest install, an unconditional update+restart would churn
      // the process and then trip the "version did not advance" warning.
      void resolveTuiUpdateTarget().then((target) => {
        if (exited || updateRequested) return
        if (target.kind === 'latest') {
          channel.notify(t('update-already-latest', { current: target.current }), { color: 'warning' })
          return
        }
        if (target.kind === 'unknown') {
          channel.notify(t('update-check-failed'))
        } else {
          // 0.7.0/0.7.1 hard-inject tuiWorkspaces at the code level; under
          // an older global launcher patch (no service row) that is a
          // permanent boot deadlock (issues #183/#307, the exact report
          // "pending (waiting for service: tuiWorkspaces)"). A stale mirror
          // pinning /update onto that range must be refused, not installed.
          if (isBootDeadlockTarget(target.latest)) {
            channel.notify(t('update-refused-deadlock', {
              latest: target.latest,
              authoritative: target.authoritative ?? target.latest,
            }), { color: 'warning' })
            return
          }
          if (target.authoritative !== undefined) {
            channel.notify(t('update-mirror-lag', { latest: target.latest, authoritative: target.authoritative }))
          }
          updateTargetVersion = target.latest
        }
        if (isStandaloneRuntime()) {
          channel.notify(t('update-standalone-starting'))
        } else {
          channel.notify(t('update-starting'))
        }
        updateRequested = true
        handleExit()
      })
    },
  })
  // Freeze the fullscreen decision only NOW, right before the tree mounts:
  // Chat above was created after the same settingsReady await, so the root
  // wrap and the `fullscreen` prop share one value; a mid-session /settings
  // edit from here on is persisted for the next boot (the watch notifies),
  // never applied live (swapping layouts requires re-mounting the tree).
  // Host recompose hardening: never regress a fullscreen session to inline
  // on a re-mount whose settings application arrived late (see the module
  // latch note). A fresh process still resolves from config + settings
  // normally — the latch is undefined there.
  if (bootedFullscreen === false && lastBootedFullscreen === true) {
    bootedFullscreen = true
  }
  fullscreenFrozen = true
  // fullscreen: wrap the tree in <AlternateScreen> (DEC 1049 + SGR mouse
  // tracking), which turns on in-app text selection (copy-on-select via
  // useCopyOnSelect), wheel scroll, and click/hover hit-testing. Inline
  // mode leaves the mouse to the terminal emulator's native selection.
  // PageMargin keeps the whole UI inset from the terminal edges (some
  // terminals — bare WSL/tmux/SSH — have no own padding, so text touches
  // the screen border). It must sit INSIDE AlternateScreen: the alt-screen
  // box sizes itself to the real terminal rows, while PageMargin reports
  // content-box dimensions to everything below it.
  const marginChildren = bootedFullscreen
    ? React.createElement(AlternateScreen, null, React.createElement(PageMargin, null, chat))
    : React.createElement(PageMargin, null, chat)
  const tree = React.createElement(ThemeProvider, {
    themeHost,
    children: marginChildren,
  })
  instance = await render(tree, { exitOnCtrlC: false })
  const isRecompose = lastBootedFullscreen !== undefined
  lastBootedFullscreen = bootedFullscreen
  logMouseDebug('apply mount', { bootedFullscreen, isRecompose })
  // /restart handoff diagnosis: the replacement got all the way to a mounted
  // UI, so any later death is post-boot (and its stderr keeps flowing to the
  // parent only within the survival window — this line is the durable mark).
  if (process.env.DSH_TUI_RESTART_CHILD === '1') {
    logRestartEvent('boot: UI mounted', { fullscreen: bootedFullscreen, isRecompose })
  }

  // External injection channel (dsh.nvim etc.): expose a per-session local
  // socket that appends text into the prompt input and submits it. Optional
  // integration — a bind failure degrades to "no channel" and never fails the
  // session. Closed on teardown so the socket and discovery record do not leak.
  const injectChannel = openInjectChannel(
    agent.session.id,
    channel.cwd,
    {
      append: (text) => injectControllerRef.current?.append(text),
      submit: () => injectControllerRef.current?.submit(),
    },
    (message) => ctx.logger.warn(`dsh-tui: ${message}`),
  )
  if (injectChannel) {
    ctx.effect(() => () => injectChannel.close())
  }

  // Check in the background so registry latency never delays the first frame.
  // A failed/offline check is intentionally silent; the manual `/update`
  // command remains available regardless of network access.
  void checkForTuiUpdate().then((update) => {
    if (update === undefined || exited || updateRequested) return
    const key = update.isStandalone ? 'update-standalone-available' : 'update-available'
    // A standalone release without a SHA256SUMS asset (published before the
    // checksum workflow landed) still updates, but the notice must say the
    // package's integrity cannot be verified — silent degradation is exactly
    // how the unverified-download window went unnoticed.
    const suffix = update.isStandalone && update.checksumUrl === undefined
      ? ` ${t('update-standalone-no-checksum')}`
      : ''
    channel.notify(
      `${t(key, { current: update.current, latest: update.latest })}${suffix}`,
      { color: 'warning', timeoutMs: 12000 },
    )
  })

  // If the surrounding tree goes down (reload, teardown), unmount the UI —
  // but flag it as teardown first so the settling waitUntilExit does not
  // run the user-exit sequence: no resume marker, no disposeRootAndExit,
  // the process stays alive and the recomposed tree re-mounts the TUI.
  // Hand back what the channel contributed to host registries on the way out:
  // the command registry scopes a registration to ITS own context, so the
  // skill commands (issue #86) would survive this exact recompose and the
  // re-mounted channel would find the names taken, freezing its menu.
  ctx.effect(() => () => {
    logMouseDebug('apply teardown')
    funnel.markTeardown()
    channel.releaseContributions()
    instance?.unmount()
  })

  // The TUI is the front door: when the user unmounts it (Ctrl+C), dispose
  // the app tree and exit the process. The rejection handler covers
  // error-driven unmounts — without it a rejected exitPromise became an
  // unhandled rejection instead of a clean exit. A teardown-driven settle
  // is swallowed by the funnel (issue #12).
  void instance.waitUntilExit().then(handleExit, handleExit)
}

/**
 * Attach to an existing agent, resume a persisted session (`dsh-tui --resume`
 * feeds the id through `config.sessionId`), or create a fresh one. Resume
 * goes through the DSH persistence seam (`ctx.agents.resume` reads the
 * session log written by dsh-session-persistence-jsonl); a missing artifact
 * or unmounted backend falls back to a fresh session, as does a plain boot
 * without a session id.
 *
 * Preset composition (issue #8): a create resolves the requested preset
 * (cordis.yml `preset` over the persisted `/preset` choice over the roster
 * default) and mounts it in the factory's setup hook; a resume re-mounts the
 * preset the session's own log records. Without the roster both paths behave
 * as before presets existed.
 *
 * Model route (issues #14/#30/#67): a create adopts the caller's atomically
 * resolved route (validated against the adapter catalog below); a resume
 * passes only a COMPLETE cordis.yml route through — a provider-only pin must
 * not half-override the route the target session's own records carry.
 */
async function resolveAgent(
  ctx: Context,
  requestedSessionId: string | undefined,
  configuredRoute: { provider?: string; model?: string },
  startupRoute: ModelRoute,
  meta: { cwd: string },
  configuredPreset?: string,
): Promise<{ agent: Agent; handle?: AgentHandle; agentPreset?: string; route?: ModelRoute }> {
  // Resume override (issue #67): cordis.yml overrides the target session's
  // recorded route only when it pins BOTH halves; undefined halves let the
  // session's own request/header records win (issue #30). The recorded route
  // is ALSO fed back into agentOptions (not just the status line): a resume
  // whose cordis.yml pins only `provider` would otherwise leave
  // agentOptions.model undefined, which breaks the `{{model}}` persona
  // variable for the resumed agent's own assembly and for every subagent it
  // spawns (dsh-subagent inherits `parent.options.model`).
  const resumeRoute = explicitModelRoute(configuredRoute)
  if (requestedSessionId !== undefined) {
    const resumeId = SessionId(requestedSessionId)
    const existing = ctx.agents.get(resumeId)
    if (existing !== undefined) {
      return { agent: existing, agentPreset: runningPresetOf(existing.session) }
    }
    try {
      // Compat boundary: register vouched-for legacy event types before the
      // strict read path (issue #153) — same seam as the /resume picker,
      // here for the launch-time --resume flow. In-process only.
      ensureLegacySessionEventTypes()
      // The resumed session keeps the preset its log records (last
      // `agent-preset/selected` wins over the creation header), never the
      // caller's current preference.
      const persisted = await resolvePersistedPreset(ctx, resumeId)
      const composed = await composePreset(ctx, persisted)
      const recorded = await resolvePersistedRoute(ctx, resumeId)
      const resumeOptions = {
        provider: resumeRoute?.provider ?? recorded?.provider,
        model: resumeRoute?.model ?? recorded?.model,
      }
      const resumed = await ctx.agents.resume({
        resumeSessionId: resumeId,
        agentOptions: resumeOptions,
        ...(composed.setup === undefined ? {} : { setup: composed.setup }),
      })
      // Status-line route on resume: the route the session actually
      // continues on — a complete cordis.yml pin, else the route its own
      // request/header records carry (a bare log yields undefined and the
      // caller falls back to the startup resolution, best effort).
      return {
        agent: resumed.agent,
        handle: resumed,
        agentPreset: composed.agentPreset,
        route: resumeRoute ?? recordedModelRoute(snapshotLiveSessionEvents(resumed.agent.session)),
      }
    } catch (error) {
      // A launch-time --resume is an explicit request: silently substituting a
      // fresh session presents a cold conversation as the resumed one (the
      // "resume did nothing" failure mode — the warn below never reached a
      // terminal). Fail the boot loudly instead; the loader surfaces this to
      // stderr. The in-session /resume picker has its own error path.
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `dsh-tui: cannot resume session "${requestedSessionId}": ${reason} — ` +
        'the stored log is unreadable or corrupt; no fresh session was started instead. ' +
        'Drop --resume to start fresh, or repair the session log first.',
      )
    }
  }
  const sessionId = SessionId(randomUUID())
  const presetPref = configuredPreset === undefined ? readPresetPref() : undefined
  const composed = await composePreset(ctx, configuredPreset ?? presetPref)
  if (!migratePresetPref(presetPref, composed.agentPreset)) {
    ctx.logger.warn(
      `dsh-tui: resolved preset preference "${presetPref}" as "${composed.agentPreset}" but could not persist the migrated id`,
    )
  }
  // Fresh-session route precedence (issues #14/#30/#67): resolved atomically
  // by the caller (complete cordis.yml route > the persisted `/model` choice
  // > the harness default), then validated against the adapter catalog — a
  // stale persisted choice falls back to the default route wholesale instead
  // of reaching the server as an unknown model name.
  const llm = ctx.get('llm') as
    | { listModels(provider: string): Promise<readonly { id: string }[]> }
    | undefined
  const { route, rejected } = await validateModelRoute(llm, startupRoute)
  if (rejected !== undefined) {
    ctx.logger.warn(
      `dsh-tui: model route ${rejected.provider}/${rejected.model} is not advertised by provider "${rejected.provider}"; falling back to ${route.provider}/${route.model}`,
    )
  }
  const created = await ctx.agents.create({
    sessionId,
    meta: {
      ...meta,
      // Durable header value: a later resume re-mounts exactly this preset.
      ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
    },
    agentOptions: route,
    ...(composed.setup === undefined ? {} : { setup: composed.setup }),
  }).catch((error: unknown) => {
    // Fail loud with the reason on stderr — a dead TUI with no message is
    // the worst outcome for a misconfigured leaf (unknown provider/model).
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `dsh-tui: failed to create agent (provider=${route.provider}, model=${route.model}): ${message}`,
    )
  })
  return { agent: created.agent, handle: created, agentPreset: composed.agentPreset, route }
}

/**
 * Distinguish a user-driven exit from a cordis context teardown (issue #12).
 *
 * Both paths settle the Ink instance's exit promise, but only a user exit
 * (`/exit`, double Ctrl+C, render crash) may leave the process. A teardown —
 * the DSH launcher's boot-time recompose disposes every entry once — must
 * only unmount the UI: the recomposed tree re-runs `apply` and mounts a
 * fresh instance, so exiting here would kill the process mid-recompose
 * (the "flash back to bash with no error" symptom).
 *
 * `markTeardown` must run before the unmount that settles the exit promise
 * (the settle reaches `handleExit` through a microtask, so a same-tick flag
 * is always observed). Exported for scripts/verify-teardown-exit.tsx.
 */
export function createExitFunnel(deps: { onUserExit: (error?: unknown) => void }): {
  handleExit: (error?: unknown) => void
  markTeardown: () => void
} {
  let exited = false
  let teardown = false
  return {
    markTeardown: () => {
      teardown = true
    },
    handleExit: (error?: unknown) => {
      if (teardown) return
      if (exited) return
      exited = true
      deps.onUserExit(error)
    },
  }
}

/**
 * Whether a user exit should leave the resume marker (and print the resume
 * hint). Must be judged against the LIVE session behind the channel, not the
 * boot-time agent apply() captured: /resume, /new and /model swap the active
 * agent (channel.agentId follows, the old handle is disposed), so the
 * captured reference can point at a stale session — wiping a marker the
 * resume path just wrote (boot empty → /resume into history) or rewriting it
 * to a fresh empty session (boot with history → /new). `liveAgent` is the
 * registry lookup of channel.agentId; it falls back to the captured agent
 * when the lookup misses. Exported for scripts/verify-exit-resume-marker.
 */
export function isExitResumable(deps: {
  pendingCount: number
  liveAgent: Agent | undefined
  startupAgent: Agent
}): boolean {
  const agent = deps.liveAgent ?? deps.startupAgent
  return (
    deps.pendingCount > 0 ||
    snapshotLiveSessionEvents(agent.session).some(
      event => event.type === 'user/message' && event.data.source.kind === 'user',
    )
  )
}

type InkShutdownState = {
  detachForShutdown?: () => void
  /**
   * Full stdin detach for the /update child handoff (issues #284/#307):
   * removes the readable/data listeners and pauses the pump so the
   * lingering parent stops racing the restarted TUI for keypresses.
   */
  detachStdinForHandoff?: () => void
  /** Drain pending stdin bytes; the exit funnel re-drains after cleanup. */
  drainStdin?: () => void
  frontFrame?: { cursor?: { x: number; y: number } }
  displayCursor?: { x: number; y: number } | null
}

/**
 * Finish terminal I/O before handing control to a process-level exit action.
 * Exported for scripts/verify-shutdown-fallback.
 */
export async function finishExit(
  ctx: Context,
  instance: Awaited<ReturnType<typeof render>> | undefined,
  fullscreen: boolean,
  notice: string | undefined,
  stderrNotice: string | undefined,
  done: () => void,
): Promise<void> {
  try {
    // Resolve the Ink runtime twice: the instances map is keyed by stdout
    // identity, so a replaced/overridden stdout misses it; the render()
    // handle is the caller's own instance and always matches (issue #522 —
    // a missed lookup skipped detachForShutdown, leaving the stdin pump,
    // TTY handlers and querier alive so the self-heal probe re-wrote
    // ENABLE_MOUSE_TRACKING after DISABLE_MOUSE_TRACKING had been sent).
    const fromMap = readInkShutdownState(instances.get(process.stdout))
    const fromHandle = instance === undefined ? undefined : readInkShutdownState(instance)
    // A handle that exposes neither detach hook is not an Ink runtime we can
    // latch (e.g. the fake render handles in shutdown regressions) — treat it
    // as a lookup miss so the full-unmount fallback below can still run.
    const runtime = fromMap ?? (
      fromHandle?.detachForShutdown === undefined && fromHandle?.detachStdinForHandoff === undefined
        ? undefined
        : fromHandle
    )
    if (runtime === undefined) {
      ctx.logger.debug('dsh-tui: Ink runtime unavailable during shutdown; using generic terminal cleanup')
      if (instance !== undefined) {
        ctx.logger.debug('dsh-tui: Ink shutdown using full unmount as the terminal-restore fallback')
        // Lookup-miss (custom stdout embedders / detach-less handles): the
        // registry cannot hand us the detach hooks, so run the full Ink
        // unmount first. It restores raw mode, alt screen and listeners
        // synchronously before the notice below is written — the process
        // must never hand a broken terminal back to the shell.
        try {
          instance.unmount()
        } catch {
          ctx.logger.debug('dsh-tui: Ink shutdown unmount fallback failed; continuing with generic terminal cleanup')
        }
      }
    } else if (fromMap === undefined) {
      ctx.logger.debug('dsh-tui: Ink runtime resolved from the render handle (instances map missed); detaching')
    }
    const cursor = fullscreen ? '' : cursorMoveToFrameEnd(runtime)

    try {
      runtime?.detachForShutdown?.()
      // The /update continuation spawns children that inherit this stdin;
      // strip the readable pump so the parent cannot swallow their input
      // (issues #284/#307). Harmless on plain exits — the process exits
      // right after this cleanup anyway.
      runtime?.detachStdinForHandoff?.()
    } catch {
      ctx.logger.debug('dsh-tui: Ink shutdown detach failed; continuing with generic terminal cleanup')
    }
    const cleanup = [
      fullscreen ? EXIT_ALT_SCREEN : '',
      cursor,
      DISABLE_MOUSE_TRACKING,
      DISABLE_MODIFY_OTHER_KEYS,
      DISABLE_KITTY_KEYBOARD,
      DISABLE_WIN32_INPUT_MODE,
      DFE,
      DBP,
      SHOW_CURSOR,
      CLEAR_ITERM2_PROGRESS,
      supportsTabStatus() ? wrapForMultiplexer(CLEAR_TAB_STATUS) : '',
    ].join('')
    const suffix = notice === undefined ? '' : `${notice}\n`
    await writeStream(process.stdout, `${cleanup}\r\n${suffix}`)
    // Re-drain AFTER the cleanup sequences have landed (#507): terminal
    // replies and mouse packets already in flight when the exit started
    // keep arriving while cleanup is being written — the detach-time drain
    // cannot see them. Unconsumed at process exit they land in the shell's
    // input queue (DECRPM/DA1/XTVERSION garbage pasted into the prompt).
    // 150ms settle covers reply RTT on slow links (ssh/ghostty is #522's
    // environment; 50ms proved too tight there) while staying well inside
    // the exit window the user already waits through.
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    runtime?.drainStdin?.()
    if (stderrNotice !== undefined) {
      await writeStream(process.stderr, `\n${stderrNotice}\n`)
    }
  } catch {
    ctx.logger.debug('dsh-tui: terminal cleanup failed; continuing with process shutdown')
  }
  done()
}

function readInkShutdownState(value: unknown): InkShutdownState | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.detachForShutdown !== undefined && typeof candidate.detachForShutdown !== 'function') return undefined
  if (candidate.detachStdinForHandoff !== undefined && typeof candidate.detachStdinForHandoff !== 'function') return undefined
  if (candidate.drainStdin !== undefined && typeof candidate.drainStdin !== 'function') return undefined
  if (candidate.frontFrame !== undefined && !isFrameState(candidate.frontFrame)) return undefined
  if (candidate.displayCursor !== undefined && candidate.displayCursor !== null && !isCursorState(candidate.displayCursor)) return undefined
  return value as InkShutdownState
}

function isFrameState(value: unknown): value is { cursor?: { x: number; y: number } } {
  if (value === null || typeof value !== 'object') return false
  const cursor = (value as Record<string, unknown>).cursor
  return cursor === undefined || isCursorState(cursor)
}

function isCursorState(value: unknown): value is { x: number; y: number } {
  if (value === null || typeof value !== 'object') return false
  const cursor = value as Record<string, unknown>
  return typeof cursor.x === 'number' && typeof cursor.y === 'number'
}

function cursorMoveToFrameEnd(runtime: InkShutdownState | undefined): string {
  const frame = runtime?.frontFrame?.cursor
  if (frame === undefined) return ''
  const parked = runtime?.displayCursor ?? frame
  return cursorMove(frame.x - parked.x, frame.y - parked.y)
}

function writeStream(stream: NodeJS.WriteStream, data: string): Promise<void> {
  if (data.length === 0) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = setTimeout(finish, 1000)
    timer.unref()
    try {
      stream.write(data, () => {
        clearTimeout(timer)
        finish()
      })
    } catch {
      clearTimeout(timer)
      finish()
    }
  })
}

/**
 * Restart the TUI in place and resume the same session — the `/restart`
 * tail of `/reload`: the soft reload cannot re-read boot-time-only state
 * (cordis.yml root config, frozen fullscreen layout, newly built code), so
 * /restart respawns the process with the original argv through the same
 * terminal handoff the /update path uses, minus the installation step.
 * The resume contract is dual-written (env + resume.txt) before this runs.
 */
function runRestart(ctx: Context, profile: string | undefined, sessionId: string): void {
  logRestartEvent('runRestart: entered, disposing cordis root')
  disposeRootAndThen(ctx, () => {
    logRestartEvent('runRestart: root disposed, starting restartTui')
    void restartTui(sessionId).then(
      restartCode => {
        logRestartEvent('runRestart: restartTui resolved', { restartCode })
        if (restartCode !== 0) {
          writeHandoffNotice(
            `\ndsh-tui restart failed to spawn (exit ${restartCode}). Your session is preserved — resume with:\n` +
              `${resumeCommand(profile, sessionId)}\n\n`,
          )
        }
        process.exit(restartCode)
      },
      restartError => {
        const message = restartError instanceof Error ? restartError.message : String(restartError)
        logRestartEvent('runRestart: restartTui rejected', { message })
        writeHandoffNotice(
          `\ndsh-tui restart failed: ${message}. Your session is preserved — resume with:\n` +
            `${resumeCommand(profile, sessionId)}\n\n`,
        )
        process.exit(1)
      },
    )
  })
}

function runUpdate(
  ctx: Context,
  profile: string | undefined,
  sessionId: string,
  targetVersion: string | undefined,
): void {
  disposeRootAndThen(ctx, () => {
    if (profile === undefined) {
      process.stderr.write(`\n${t('update-aborted-no-profile')}\n`)
      process.exit(1)
    }
    void updateTuiAndRestart(sessionId, profile, targetVersion).then(
      ({ updateCode, restartCode }) => {
        if (updateCode !== 0) {
          process.stderr.write(
            `\ndsh-tui update failed (exit ${updateCode}). Your session is preserved — resume with:\n` +
              `${resumeCommand(profile, sessionId)}\n\n`,
          )
        }
        process.exit(restartCode)
      },
      updateError => {
        const message = updateError instanceof Error ? updateError.message : String(updateError)
        process.stderr.write(
          `\ndsh-tui update failed: ${message}. Your session is preserved — resume with:\n` +
            `${resumeCommand(profile, sessionId)}\n\n`,
        )
        process.exit(1)
      },
    )
  })
}

/**
 * Dispose the whole application before process exit, with a bounded fallback.
 * Mirrors the deleted dsh-tui front-door exit semantics.
 */
function disposeRootAndExit(ctx: Context, code: number): void {
  disposeRootAndThen(ctx, () => process.exit(code), code)
}

/**
 * The real way back into a session after the TUI process is gone. The
 * package ships no `dsh-tui` bin — resuming means feeding the session id
 * through `DSH_TUI_RESUME_SESSION` (what cordis.patch.yml's `sessionId`
 * reads; the pre-rename DSH_CC_ spelling still works, issue #120) and
 * booting the same profile; on Windows the repo's dsh-tui.cmd wrapper
 * does this via --resume + ~/.dsh-tui/resume.txt.
 */
function resumeCommand(profile: string | undefined, sessionId: string): string {
  const boot = profile === undefined ? 'dsh --config cordis.yml' : `dsh --profile ${profile}`
  return process.platform === 'win32'
    ? `dsh-tui --resume ${sessionId}`
    : `DSH_TUI_RESUME_SESSION=${sessionId} ${boot}`
}

/**
 * Dispose the Cordis tree, then run a process-level handoff action. The
 * fallback exit keeps the caller's intended code when disposal stalls — the
 * handoff (update/restart) may legitimately take longer than the bound, and
 * reporting failure on a clean exit would mislead wrapper scripts.
 */
function disposeRootAndThen(ctx: Context, done: () => void, fallbackCode = 1): void {
  const timer = setTimeout(() => {
    // Diagnosis for a stalled disposal: without this line the fallback exit
    // is indistinguishable from a successful handoff in the field.
    logRestartEvent('dispose: timeout, taking fallback exit', { fallbackCode })
    process.exit(fallbackCode)
  }, 5000)
  timer.unref()
  void withHostRootCapability(() => ctx.root.fiber.dispose()).then(
    () => {
      clearTimeout(timer)
      done()
    },
    () => {
      clearTimeout(timer)
      done()
    },
  )
}
