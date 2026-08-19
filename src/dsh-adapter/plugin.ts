import { randomUUID } from 'node:crypto'
import React from 'react'
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
import { readModelPref } from '../modelPrefs.js'
import { explicitModelRoute, recordedModelRoute, resolveModelRoute, validateModelRoute } from '../modelRoute.js'
import type { ModelRoute } from '../modelRoute.js'
import { readPresetPref } from '../presetPrefs.js'
import { composePreset, filterMinimalPresetTools, resolvePersistedPreset, runningPresetOf } from './presets.js'
import { ensurePackagedPresets } from './packaged-presets.js'
import { ensureLegacySessionEventTypes } from './compat/index.js'
import { clearResumeTarget, writeResumeTarget } from '../sessionHistory.js'
import { resolveSessionCwd } from '../utils/workspaceRoot.js'
import { checkForTuiUpdate, installedTuiVersion, isBootDeadlockTarget, isVersionNewer, resolveDshProfileName, resolveTuiUpdateTarget, updateTuiAndRestart } from '../update.js'
import { getLang, isLang, resolveStartupLang, setLang, t, writeLangPref } from '../i18n.js'
import { detectLegacyEnv, migrateLegacyDataDir, RENAMED_ENV } from '../utils/paths.js'
import { Chat } from '../screens/Chat.js'
import { getHostDialogStore, type TuiDialogRuntime } from './dialogs.js'
import { getHostStatusStore, type TuiStatusRuntime } from './status.js'
import { getHostShortcuts, type TuiShortcutRuntime } from './shortcuts.js'
import { attachSessionToWorkspace } from './workspace.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime } from './workspaces.js'
import { getHostSettingsSections, type TuiSettingsSectionsRuntime } from './settings-sections.js'
import { withHostRootCapability } from './host-access.js'
import { render, ThemeProvider, AlternateScreen } from '../ui.js'
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
  const { agent, handle, agentPreset, route: createdRoute } = await resolveAgent(
    ctx,
    config.sessionId,
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
    handle,
  })
  // Register the dsh-tui settings namespace so the /settings screen can
  // edit it (the section below was '命名空间未注册' without this): the
  // user layer in settings.yaml wins over cordis.yml's diffLayout, and
  // watch() lands commits on the live channel — no recompose needed.
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      settingsNamespace('dsh-tui'),
      Schema.object({
        diffLayout: Schema.union(['auto', 'split', 'unified']).default('auto'),
        thinkingFold: Schema.union(['preview', 'full']).default('preview'),
        // No default on purpose: an unset `lang` keeps the field showing
        // the effective language (see the section's format below) and lets
        // cordis.yml / lang.json keep their precedence.
        lang: Schema.union(['zh', 'en']),
      }),
    )
    const applyLayout = (value: { diffLayout?: 'auto' | 'split' | 'unified' }): void => {
      channel.setDiffLayout(value.diffLayout ?? config.diffLayout ?? 'auto')
    }
    // The /settings language field writes `lang` through the settings
    // service (user layer): apply it live and mirror it to lang.json so
    // the /lang command and next-boot resolution agree. DSH_TUI_LANG
    // stays the top precedence — a pinned env is never overridden by the
    // document.
    const applyLang = (value: { lang?: 'zh' | 'en' }): void => {
      if (!isLang(process.env.DSH_TUI_LANG) && isLang(value.lang)) {
        setLang(value.lang)
        writeLangPref(value.lang)
      }
    }
    // thinkingFold rides the same namespace: /settings writes it live and
    // the channel picks it up at the next step seal.
    const applyThinkingFold = (value: { thinkingFold?: 'preview' | 'full' }): void => {
      channel.setThinkingFold(value.thinkingFold ?? config.thinkingFold ?? 'preview')
    }
    const apply = (next: { diffLayout?: 'auto' | 'split' | 'unified'; lang?: 'zh' | 'en'; thinkingFold?: 'preview' | 'full' }): void => {
      applyLayout(next)
      applyLang(next)
      applyThinkingFold(next)
    }
    apply(scope.get())
    scope.watch(next => {
      apply(next)
    })
  })
  // The /settings screen's own section: the dsh-tui namespace comes from
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
  // Positional command-line arguments are the initial prompt (issue #53):
  // `dsh-tui "run the tests"` forwards positionals through the dsh CLI,
  // which mounts them as ctx.cmdlineArgs. Submit once the channel exists —
  // delivery goes through the normal pending/inbox chain, so no special
  // timing is needed; flag-shaped leftovers are not prompt text.
  const cmdlineArgs = (ctx as { cmdlineArgs?: { args?: readonly string[] } }).cmdlineArgs?.args
  const initialPrompt = cmdlineArgs?.filter(arg => !arg.startsWith('-')).join(' ').trim()
  if (initialPrompt) channel.submit(initialPrompt)
  // Attach the stderr reporter to the live channel and flush anything a
  // startup-spawned server produced while the channel didn't exist yet.
  notifyStderr = (text, options) => channel.notify(text, options)
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
          config.fullscreen === true,
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
        void finishExit(
          ctx,
          instance,
          config.fullscreen === true,
          'Updating @deepseek-harness-tui/dsh-tui and restarting…',
          undefined,
          () => runUpdate(ctx, profile, channel.agentId, updateTargetVersion),
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
        config.fullscreen === true,
        hint,
        undefined,
        () => disposeRootAndExit(ctx, 0),
      )
    },
  })
  const handleExit = funnel.handleExit

  const chat = React.createElement(Chat, {
    channel,
    questionStore,
    approvalStore,
    // The dsh-tui-extensions row's services (managed dialogs, status line,
    // shortcuts). Soft-consumed: absent the row (stale patch, bare embed),
    // Chat falls back to inert stores and no shortcut registry.
    extensionDialogs: getHostDialogStore(ctx.get('tuiDialogs') as TuiDialogRuntime | undefined),
    extensionStatus: getHostStatusStore(ctx.get('tuiStatus') as TuiStatusRuntime | undefined),
    extensionShortcuts: getHostShortcuts(ctx.get('tuiShortcuts') as TuiShortcutRuntime | undefined),
    // Full-screen surfaces inside Chat — the trajectory scene and the session
    // browser — enter the alt screen themselves in inline mode; in fullscreen
    // the tree is already wrapped below, so they must not nest.
    fullscreen: config.fullscreen === true,
    onExit: () => handleExit(),
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
        channel.notify(t('update-starting'))
        updateRequested = true
        handleExit()
      })
    },
  })
  // fullscreen: wrap the tree in <AlternateScreen> (DEC 1049 + SGR mouse
  // tracking), which turns on in-app text selection (copy-on-select via
  // useCopyOnSelect), wheel scroll, and click/hover hit-testing. Inline
  // mode leaves the mouse to the terminal emulator's native selection.
  const tree = React.createElement(
    ThemeProvider,
    null,
    config.fullscreen ? React.createElement(AlternateScreen, null, chat) : chat,
  )
  instance = await render(tree, { exitOnCtrlC: false })

  // Check in the background so registry latency never delays the first frame.
  // A failed/offline check is intentionally silent; the manual `/update`
  // command remains available regardless of network access.
  void checkForTuiUpdate().then((update) => {
    if (update === undefined || exited || updateRequested) return
    channel.notify(
      t('update-available', { current: update.current, latest: update.latest }),
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
  // session's own request/header records win (issue #30).
  const resumeRoute = explicitModelRoute(configuredRoute)
  const resumeOptions = { provider: resumeRoute?.provider, model: resumeRoute?.model }
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
    agent.session.events.some(
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
  frontFrame?: { cursor?: { x: number; y: number } }
  displayCursor?: { x: number; y: number } | null
}

/** Finish terminal I/O before handing control to a process-level exit action. */
async function finishExit(
  ctx: Context,
  instance: Awaited<ReturnType<typeof render>> | undefined,
  fullscreen: boolean,
  notice: string | undefined,
  stderrNotice: string | undefined,
  done: () => void,
): Promise<void> {
  try {
    const runtime = readInkShutdownState(instances.get(process.stdout))
    if (runtime === undefined && instance !== undefined) {
      ctx.logger.debug('dsh-tui: Ink runtime unavailable during shutdown; using generic terminal cleanup')
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
