import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { Config } from './index.js'
import { createChannel } from './channel.js'
import { createChildStderrReporter, installChildStderrGuard } from './childStderr.js'
import { logForDebugging } from '../utils/debug.js'
import { QuestionStore } from './questions.js'
import { ApprovalStore } from './approvals.js'
import { registerPackagedSkills } from './packaged-skills.js'
import { registerPromptDebug } from './promptDebug.js'
import { readActivityFrames } from '../activityPrefs.js'
import { readFullscreenPref, writeFullscreenPref } from '../fullscreenPrefs.js'
import { readModelPref } from '../modelPrefs.js'
import { explicitModelRoute, recordedModelRoute, resolveModelRoute, validateModelRoute } from '../modelRoute.js'
import type { ModelRoute } from '../modelRoute.js'
import { readPresetPref } from '../presetPrefs.js'
import { composePreset, filterMinimalPresetTools, resolvePersistedPreset, resolvePersistedRoute, runningPresetOf } from './presets.js'
import { ensurePackagedPresets } from './packaged-presets.js'
import { ensureLegacySessionEventTypes } from './compat/index.js'
import { clearResumeTarget, writeResumeTarget } from '../sessionHistory.js'
import { resolveSessionCwd } from '../utils/workspaceRoot.js'
import { checkForTuiUpdate, installedTuiVersion, isBootDeadlockTarget, isVersionNewer, resolveDshProfileName, resolveTuiUpdateTarget, updateTuiAndRestart } from '../update.js'
import { getLang, isLang, resolveStartupLang, setLang, t, writeLangPref } from '../i18n.js'
import { DEFAULT_STATUS_BAR, normalizeStatusBar, normalizeToolBackground, type StatusBarConfig, type ToolBackground } from '../tuiDisplayPrefs.js'
import { detectLegacyEnv, migrateLegacyDataDir, RENAMED_ENV } from '../utils/paths.js'
import { attachHerdrIntegration } from '../herdr.js'
import { getHostDialogStore, type TuiDialogRuntime } from './dialogs.js'
import { getHostStatusStore, type TuiStatusRuntime } from './status.js'
import { getHostShortcuts, type TuiShortcutRuntime } from './shortcuts.js'
import { attachSessionToWorkspace } from './workspace.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime } from './workspaces.js'
import { getHostSettingsSections, type TuiSettingsSectionsRuntime } from './settings-sections.js'
import { getHostSceneRuntime, type TuiSceneRuntime } from './scenes.js'
import { withHostRootCapability } from './host-access.js'
import { bootstrapTui } from '../tui/bootstrap.js'
import { createTuiCommands, type TuiFences } from '../tui/commands.js'
import { TuiController } from '../tui/controller.js'
import { ChatScreen } from '../tui/screens/chat-screen.js'
import type { FinalStopReason, TuiLifecycle } from '../tui/lifecycle.js'
import { editInExternalEditor, type EditorOutcome } from '../utils/externalEditor.js'

// /reload handoff (pi-style in-process hot reload): `ctx.fiber.restart()`
// re-runs apply in the SAME process without re-importing this module, so the
// session to resume rides a module-level slot — set just before the restart,
// consumed at the top of the next apply.
let reloadResumeSessionId: string | undefined
// The positional-args initial prompt is submitted only on the FIRST apply:
// a /reload re-runs apply and would otherwise send the launch prompt to the
// model again.
let initialPromptSubmitted = false

// cordis `fiber.restart()` is a silent no-op while the fiber is still in
// its initial load: `_setEpoch` is blocked by the in-flight inertia and the
// restart resolves without re-running apply (observed with cordis 4.0.1).
// Settle the fiber first, then restart. The fiber's initial load resolves
// once this apply's setup completes, so the wait is brief; a disposed fiber
// makes `restart()` throw, which the catch reports.
function restartFiberWhenSettled(ctx: Context): void {
  void (async () => {
    await ctx.fiber.await()
    await ctx.fiber.restart()
  })().catch((error: unknown) => {
    ctx.logger.error(`dsh-tui: reload failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * Claude Code style interactive TUI front door for DeepSeek Harness agents.
 *
 * The plugin attaches to (or creates) one agent, renders a chat transcript
 * from the agent's session log and live `session/event` records, and submits
 * user turns through `Agent.followup`. It is a client-driver front door like
 * `dsh-jsonrpc`: the surrounding `cordis.yml` supplies the agent spine, the
 * LLM adapter, and the tool plugins.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!process.stdout.isTTY) {
    throw new Error('dsh-tui requires an interactive terminal (stdout must be a TTY).')
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
  // the userInteraction service until a UI provider answers. Mount the
  // service when the composition doesn't (the official dsh-base
  // user-interaction config row does; a bare plugin mount creates it on
  // this context), expose the model-facing tool, and register this TUI's
  // questionnaire as the provider. All three must be in place before the
  // agent is resolved so the per-step tool assembly includes
  // ask_user_question. Optional-service access goes through `ctx.get`, not
  // the inject proxy.
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
  // Packaged skills (/audit, /bug, …): contribute them through the host's
  // skill registry so they resolve with zero manual copying.
  registerPackagedSkills(ctx)
  // `/debug-prompt` snapshots the final provider-neutral request at the
  // llm/stream boundary, after every prompt and tool contributor has run.
  registerPromptDebug(ctx)
  // Yield to an incumbent provider instead of crashing the whole plugin tree
  // (issue #98): the harness allows exactly ONE user-questions provider per
  // context, and stacking this TUI onto a profile that already carries
  // @deepseek-ai/dsh-web-app (its api-gateway registers first) used to fail
  // the boot with DUPLICATE_PROVIDER. The incumbent UI then owns questionnaire
  // rendering; this TUI's ask_user_question requests are answered there.
  try {
    userQuestions.registerProvider({
      ask: request => questionStore.ask(request),
    })
    ctx.effect(() => () => questionStore.rejectAll())
  } catch (error) {
    if ((error as { code?: string }).code !== 'DUPLICATE_PROVIDER') throw error
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
  // Same skew guard for the plugin-scene registry (tuiScenes, mounted by the
  // dsh-tui-extensions row): the
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
  // shortcuts never match, and custom-entry renderers stay invisible when
  // the row is absent — say why on profile launches.
  if (ctx.get('tuiDialogs') === undefined && resolveDshProfileName() !== undefined) {
    ctx.logger.warn(
      'dsh-tui: tuiDialogs/tuiStatus/tuiShortcuts/tuiRenderers services are not mounted; plugin dialogs, status contributions, shortcuts and custom-entry renderers are off. ' +
      'The bundle patch is older than the installed dsh-tui package — update the globally installed dsh-tui launcher to match the profile (issue #183).',
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
  // A /reload restart re-runs this apply in the same process: resume the
  // session the previous root was showing (its agent was disposed with the
  // old fiber) instead of opening a fresh one.
  const resumeAfterReload = reloadResumeSessionId
  reloadResumeSessionId = undefined
  const { agent, handle, agentPreset, route: createdRoute } = await resolveAgent(
    ctx,
    resumeAfterReload ?? config.sessionId,
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
    statusBar: config.statusBar,
    handle,
  })
  // Register the dsh-tui settings namespace so the /settings panel can
  // edit it (the section below was '命名空间未注册' without this): the
  // user layer in settings.yaml wins over cordis.yml's diffLayout, and
  // watch() lands commits on the live channel — no recompose needed.
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      settingsNamespace('dsh-tui'),
      Schema.object({
        diffLayout: Schema.union(['auto', 'split', 'unified']).default('auto'),
        thinkingFold: Schema.union(['preview', 'full']).default('preview'),
        toolBackground: Schema.union(['none', 'subtle', 'strong']).default('none'),
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
        // No default either: unset keeps cordis.yml's `fullscreen` effective
        // (and the panel shows it); a set value wins and switches the layout
        // through a fiber restart (the watch below).
        fullscreen: Schema.boolean(),
      }),
    )
    type SettingsValue = {
      diffLayout?: 'auto' | 'split' | 'unified'
      lang?: 'zh' | 'en'
      fullscreen?: boolean
      whale?: boolean
      minimal?: boolean
      thinkingFold?: 'preview' | 'full'
      toolBackground?: ToolBackground
      statusBar?: Partial<StatusBarConfig>
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
      channel.setStatusBar(normalizeStatusBar(value.statusBar ?? config.statusBar))
    }
    // Fullscreen is fixed per bootstrap (inline vs alt-screen), so a change
    // rides the /reload fiber restart. cordis inject callbacks always run
    // asynchronously — after the bootstrap below — so the boot cannot
    // consume this settings value: a set toggle mirrors to fullscreen.json
    // and the next boot reads it synchronously (this also self-heals a
    // settings.yaml fullscreen that predates the mirror — the initial apply
    // writes it and restarts into the requested layout). Compare the
    // resolved value against the one this boot started with: flipping the
    // toggle back to its origin must not restart. The later-declared flags
    // (`reloading` & friends) are safe to touch here — this callback never
    // runs before the synchronous body below completes.
    const applyFullscreen = (value: boolean | undefined): void => {
      if (typeof value === 'boolean') writeFullscreenPref(value)
      const resolved = value ?? readFullscreenPref() ?? config.fullscreen === true
      if (resolved === bootedFullscreen) return
      if (exited || teardown) return
      if (channel.working || channel.pending.length > 0) {
        // A restart would kill the running turn; the choice is already
        // persisted (settings.yaml + fullscreen.json) and takes effect on
        // the next launch/reload.
        channel.notify(t('fullscreen-reload-deferred'), { color: 'warning' })
        return
      }
      reloading = true
      reloadResumeSessionId = channel.agentId
      channel.notify(t('reload-starting'))
      restartFiberWhenSettled(ctx)
    }
    const apply = (next: SettingsValue): void => {
      applyLayout(next)
      applyWhale(next)
      applyMinimal(next)
      applyLang(next)
      applyDisplay(next)
      applyFullscreen(next.fullscreen)
    }
    apply(scope.get())
    scope.watch(next => apply(next))
  })
  // The /settings panel's own section: the dsh-tui namespace comes from
  // the settings registration above, and the declared selects write `lang`
  // and `diffLayout` back through the settings service's revision-fenced
  // mutate (the watch applies both live).
  const settingsSections = getHostSettingsSections(
    ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined,
  )
  if (settingsSections !== undefined) {
    const unregister = settingsSections.register({
      ns: 'dsh-tui',
      title: 'dsh-tui',
      groups: [{ id: 'status-bar', title: 'Status bar', descriptions: { zh: '底栏设置' } }],
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
          hint: 'Run on the terminal alternate screen (fullscreen layout); toggling reloads the TUI in place and keeps the current session — during a running turn it takes effect on the next launch or reload.',
          hintDescriptions: { zh: '在终端备用屏运行（全屏布局）；切换会原地重载 TUI 并保留当前会话，回合运行中则下次启动或重载时生效。' },
          kind: 'boolean',
          format(value: unknown): string {
            // Unset in settings.yaml: show the cordis.yml value this boot
            // resolved with instead of a blank "unset" (same as lang).
            return value === undefined || value === null ? String(config.fullscreen === true) : String(value)
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
          hint: 'Streaming thinking shows a 2-3 line live preview and each step folds when it settles; Full keeps thinking expanded until the turn ends.',
          hintDescriptions: { zh: '流式时思考显示 2-3 行动态预览，每步落定后折叠；展开模式保持思考展开直到整轮结束。' },
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
  // TUI as the interactive answerer for the agent it owns; requests for
  // other agents delegate down the chain (next()). Guarded on the service
  // being mounted — a bare composition without the dsh-base approval row
  // has nothing to answer into. channel.agentId tracks agent swaps
  // (/new, /resume, rewind), so ownership is re-evaluated per request.
  const approvalStore = new ApprovalStore()
  if (ctx.get('approval') !== undefined) {
    ctx.on('approval/request', (req, next) =>
      String(req.agent.id) === channel.agentId ? approvalStore.park(req) : next())
    ctx.effect(() => () => approvalStore.settleAll('cancelled'))
  }
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
  // which mounts them as ctx.cmdlineArgs. Submit once the channel exists —
  // delivery goes through the normal pending/inbox chain, so no special
  // timing is needed; flag-shaped leftovers are not prompt text. The module
  // level once-guard keeps a /reload re-apply from resubmitting the launch
  // prompt to the resumed session.
  const cmdlineArgs = (ctx as { cmdlineArgs?: { args?: readonly string[] } }).cmdlineArgs?.args
  const initialPrompt = cmdlineArgs?.filter(arg => !arg.startsWith('-')).join(' ').trim()
  if (initialPrompt && !initialPromptSubmitted) {
    initialPromptSubmitted = true
    channel.submit(initialPrompt)
  }
  // Attach the stderr reporter to the live channel and flush anything a
  // startup-spawned server produced while the channel didn't exist yet.
  notifyStderr = (text, options) => channel.notify(text, options)
  for (const [text, options] of stderrBacklog.splice(0)) {
    notifyStderr(text, options)
  }
  // The TUI front door owns one bootstrap, one terminal and one lifecycle.
  // Context teardown is intentionally separate from a user exit: the host may
  // recompose this plugin and mount a new root in the same process.
  let exited = false
  let teardown = false
  // Set by /reload: the upcoming teardown is a fiber restart, so finalStop
  // must skip the exit transcript replay and the process handoff.
  let reloading = false
  let updateRequested = false
  let updateTargetVersion: string | undefined
  // The profile this process was booted with (`dsh --profile <name>`); dsh
  // exposes it nowhere else, and /update must update the installation the
  // user is actually running, not a hard-coded one.
  const profile = resolveDshProfileName()
  let chat: ChatScreen | undefined

  // The alt-screen mode is fixed for this boot. The settings inject callback
  // above always runs after this bootstrap (cordis resumes it on a later
  // microtask), so settings.yaml cannot feed the boot directly — the
  // /settings toggle mirrors its choice to fullscreen.json, read here
  // synchronously; cordis.yml is the fallback. The watch compares against
  // this value to decide whether a fiber restart is needed.
  const bootedFullscreen = readFullscreenPref() ?? config.fullscreen === true
  const bootstrap = bootstrapTui({
    fullscreen: bootedFullscreen,
    getTranscript: () => {
      if (chat === undefined) return []
      // The channel folds rows beyond its MAX_ROWS window down to preview
      // text; the session log is the source of truth, so restore the folded
      // full text before the exit replay renders the complete transcript
      // into native scrollback (plan §1.2).
      try {
        channel.loadOlder()
      } catch (error) {
        // Folded rows keep their preview text; a restore failure must never
        // skip the exit replay itself.
        ctx.logger.debug(
          `dsh-tui: transcript restore for exit replay failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return chat.getTranscriptComponentsForExit()
    },
  })
  const { ui, lifecycle, takeover } = bootstrap
  const fences: TuiFences = {
    sessionEpoch: () => channel.sessionEpoch,
    generation: () => lifecycle.generation,
  }
  const dialogStore = getHostDialogStore(
    ctx.get('tuiDialogs') as TuiDialogRuntime | undefined,
  )
  const statusStore = getHostStatusStore(
    ctx.get('tuiStatus') as TuiStatusRuntime | undefined,
  )
  // The scene bridge is host-only: ChatScreen receives the structural create /
  // close controls, never the Cordis runtime or plugin context.
  const sceneHost = getHostSceneRuntime(
    ctx.get('tuiScenes') as TuiSceneRuntime | undefined,
  )
  // Keep resolving the host shortcut capability here for the migrated root;
  // ChatScreen does not consume it yet, but this keeps shortcut registration
  // independent of the removed component tree.
  const shortcutHost = getHostShortcuts(
    ctx.get('tuiShortcuts') as TuiShortcutRuntime | undefined,
  )
  void shortcutHost
  const controller = new TuiController({
    channel,
    questions: questionStore,
    approvals: approvalStore,
    dialogs: dialogStore,
    status: statusStore,
    fences,
  })
  const commands = createTuiCommands({
    channel,
    fences,
    stores: {
      questions: questionStore,
      approvals: approvalStore,
      dialogs: dialogStore,
    },
  })

  const funnel = createExitFunnel({
    onUserExit: error => {
      // A signal/exception handler may have already established the process
      // exit path; do not schedule a second completion callback.
      if (exited) return
      exited = true
      if (error !== undefined) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.error(`dsh-tui: exit after error: ${message}`)
        void finishExit(
          ctx,
          lifecycle,
          'exception',
          undefined,
          `dsh-tui crashed: ${message}`,
          () => disposeRootAndExit(ctx, 1),
          waitForExternalEditor,
        )
        return
      }
      if (updateRequested) {
        try {
          writeResumeTarget(channel.agentId)
        } catch {
          // Resume persistence is best effort and must never block an update.
        }
        void finishExit(
          ctx,
          lifecycle,
          'update',
          'Updating @deepseek-harness-tui/dsh-tui and restarting…',
          undefined,
          () => runUpdate(ctx, profile, channel.agentId, updateTargetVersion),
          waitForExternalEditor,
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
        lifecycle,
        'shutdown',
        hint,
        undefined,
        () => disposeRootAndExit(ctx, 0),
        waitForExternalEditor,
      )
    },
  })
  const handleExit = funnel.handleExit

  let externalEditorBusy = false
  // The in-flight editor round-trip, held so finishExit can wait for the
  // editor child before the process handoff — a signal/update must not exit
  // the parent while the editor still owns the tty.
  let externalEditorFlight: Promise<void> | undefined
  const waitForExternalEditor = (): Promise<void> => externalEditorFlight ?? Promise.resolve()
  const openExternalEditor = (draft: string, apply: (text: string) => void): void => {
    if (externalEditorBusy) return
    externalEditorBusy = true
    let quiesceAttempted = false
    const flight = (async () => {
      try {
        quiesceAttempted = true
        await lifecycle.quiesce('external-editor')
        const outcome: EditorOutcome = await editInExternalEditor(draft)
        if (lifecycle.finalStopEstablished) return
        if (outcome.kind === 'edited') {
          apply(outcome.text)
        } else if (outcome.kind === 'unavailable') {
          commands.info.notify('No editor configured.', { color: 'warning' })
        } else if (outcome.kind === 'failed') {
          commands.info.notify(`External editor failed: ${outcome.message}`, { color: 'warning' })
        }
      } catch (error) {
        if (!lifecycle.finalStopEstablished) {
          const message = error instanceof Error ? error.message : String(error)
          commands.info.notify(`External editor failed: ${message}`, { color: 'warning' })
        }
      } finally {
        if (quiesceAttempted) {
          try {
            await lifecycle.resume()
          } catch (error) {
            ctx.logger.debug(
              `dsh-tui: external editor resume failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        externalEditorBusy = false
        externalEditorFlight = undefined
      }
    })()
    externalEditorFlight = flight
    void flight
  }

  chat = new ChatScreen({
    ui,
    commands,
    controller,
    sceneHost,
    fullscreen: bootedFullscreen,
    onExit: () => handleExit(),
    onOpenExternalEditor: openExternalEditor,
    // Only a `dsh --profile <name>` launch has a profile installation for
    // `/update` to act on; source checkouts and `--config` overlays get the
    // unavailable notice instead.
    onUpdate: profile === undefined ? undefined : () => {
      if (exited || teardown || updateRequested) return
      // Confirm the target version before tearing the TUI down: on an
      // already-latest install, an unconditional update+restart would churn
      // the process and then trip the "version did not advance" warning.
      void resolveTuiUpdateTarget().then((target) => {
        if (exited || teardown || updateRequested) return
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
        channel.notify(t('update-starting'))
        updateRequested = true
        handleExit()
      })
    },
    // pi-style in-process hot reload: restart this plugin's fiber (dispose +
    // re-apply, same process) and resume the live session from its log
    // afterwards. Refused while a turn runs or input is queued — the
    // abort/steer plumbing owns those transitions, not a fiber restart.
    onReload: () => {
      if (exited || teardown) return
      if (channel.working || channel.pending.length > 0) {
        channel.notify(t('reload-while-working'), { color: 'warning' })
        return
      }
      reloading = true
      reloadResumeSessionId = channel.agentId
      channel.notify(t('reload-starting'))
      restartFiberWhenSettled(ctx)
    },
  })

  const stopForProcessEvent = (
    reason: 'signal' | 'exception',
    code: number,
    stderrNotice?: string,
  ): void => {
    if (exited) return
    exited = true
    void finishExit(
      ctx,
      lifecycle,
      reason,
      undefined,
      stderrNotice,
      () => disposeRootAndExit(ctx, code),
      waitForExternalEditor,
    )
  }
  const onSigint = (): void => stopForProcessEvent('signal', 130)
  const onSigterm = (): void => stopForProcessEvent('signal', 143)
  const onUncaughtException = (error: Error): void => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.error(`dsh-tui: uncaught exception: ${message}`)
    stopForProcessEvent('exception', 1, `dsh-tui crashed: ${message}`)
  }
  const onUnhandledRejection = (reason: unknown): void => {
    const message = reason instanceof Error ? reason.message : String(reason)
    ctx.logger.error(`dsh-tui: unhandled rejection: ${message}`)
    stopForProcessEvent('exception', 1, `dsh-tui crashed: ${message}`)
  }
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  process.on('uncaughtException', onUncaughtException)
  process.on('unhandledRejection', onUnhandledRejection)
  const removeProcessHandlers = (): void => {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.off('uncaughtException', onUncaughtException)
    process.off('unhandledRejection', onUnhandledRejection)
  }

  takeover.setRoot(chat)
  ui.setFocus(chat)
  ui.start()

  // The reload handoff completed: the resumed session is back on screen.
  if (resumeAfterReload !== undefined) {
    channel.notify(t('reload-done'))
  }

  // Check in the background so registry latency never delays the first frame.
  // A failed/offline check is intentionally silent; the manual `/update`
  // command remains available regardless of network access.
  void checkForTuiUpdate().then((update) => {
    if (update === undefined || exited || teardown || updateRequested) return
    channel.notify(
      t('update-available', { current: update.current, latest: update.latest }),
      { color: 'warning', timeoutMs: 12000 },
    )
  })

  // If the surrounding tree goes down (reload or teardown), release the
  // channel contributions, dispose component subscriptions, and stop this
  // root without leaving the process. The host may mount a replacement root.
  // A /reload restart marks `reloading` so finalStop skips the fullscreen
  // exit transcript replay — the resumed session repaints itself.
  ctx.effect(() => () => {
    teardown = true
    funnel.markTeardown()
    removeProcessHandlers()
    channel.releaseContributions()
    chat?.dispose()
    controller.dispose()
    return lifecycle
      .finalStop(reloading ? 'reload' : 'shutdown')
      .then(() => lifecycle.awaitStop())
      .catch(error => {
        ctx.logger.debug(
          `dsh-tui: teardown stop failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  })
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
        route: resumeRoute ?? recordedModelRoute(resumed.agent.session.events),
      }
    } catch (error) {
      // No artifact (first run / cleared storage) or persistence not
      // mounted: fall through to a fresh session, but stay loud in the log.
      ctx.logger.warn(
        `dsh-tui: resume of "${requestedSessionId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const sessionId = SessionId(randomUUID())
  const composed = await composePreset(ctx, configuredPreset ?? readPresetPref())
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
 * A teardown — the DSH launcher's boot-time recompose disposes every entry
 * once — must stop only this root and leave the process alive so the
 * recomposed tree can mount a fresh one. User exits continue through the
 * lifecycle shutdown and process handoff path.
 *
 * `markTeardown` is called before root disposal, so a teardown cannot be
 * mistaken for a user exit. Exported for scripts/verify-teardown-exit.tsx.
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
    agent.session.events.some(
      event => event.type === 'user/message' && event.data.source.kind === 'user',
    )
  )
}

/**
 * Stop the single TUI before handing control to a child or process exit.
 * Exported for test/tui/finish-exit.test.ts.
 */
export async function finishExit(
  ctx: Context,
  lifecycle: TuiLifecycle,
  reason: FinalStopReason,
  notice: string | undefined,
  stderrNotice: string | undefined,
  done: () => void,
  waitForEditor?: () => Promise<void>,
): Promise<void> {
  // An external editor child still owns the tty (quiesced stdio inherit):
  // let it finish BEFORE the terminal teardown so a signal/update cannot
  // exit the parent from under the editor.
  try {
    await waitForEditor?.()
  } catch (error) {
    ctx.logger.debug(
      `dsh-tui: external editor wait failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let result: Awaited<ReturnType<TuiLifecycle['finalStop']>> | undefined
  try {
    const stopPromise = lifecycle.finalStop(reason)
    try {
      result = await stopPromise
    } catch (error) {
      ctx.logger.debug(
        `dsh-tui: finalStop failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    // finalStop is established before awaitStop is called; this explicit
    // second wait keeps the child/exit handoff behind the lifecycle boundary.
    try {
      await lifecycle.awaitStop()
    } catch (error) {
      ctx.logger.debug(
        `dsh-tui: awaitStop failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } catch (error) {
    ctx.logger.debug(
      `dsh-tui: shutdown setup failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (result?.stdoutDrainError !== undefined) {
    ctx.logger.debug(`dsh-tui: stdout drain failed: ${result.stdoutDrainError}`)
    // A failed final flush means a dead/blocked tty: run no child and write
    // no notice into it — emergency restore + exit instead (plan §1.2).
    // Never returns.
    lifecycle.emergencyRestoreAndExit()
  }

  // The stopped-window boundary owns notices on stderr; plugin code never
  // writes terminal cleanup sequences or notices directly to stdout.
  try {
    if (notice !== undefined) process.stderr.write(`\n${notice}\n`)
    if (stderrNotice !== undefined) process.stderr.write(`\n${stderrNotice}\n`)
  } catch (error) {
    ctx.logger.debug(
      `dsh-tui: shutdown notice failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  done()
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
  const timer = setTimeout(() => process.exit(fallbackCode), 5000)
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
