/**
 * Host seams every channel composition reads: the optional Cordis service
 * rows (themes, workspaces, command trees, scenes, settings sections,
 * custom-entry renderers), the default-deny decision gate with its
 * dispatch-topology marker, the runtime subscriptions that re-render on host
 * changes, and the git-branch breadcrumb. Each lookup degrades when its row
 * is not mounted, whatever backend serves the session.
 */
import type { Context } from '@deepseek-ai/cordis'
import { adapterRuntimeFor } from '../../../adapter/kernel/runtime-context.js'
import type { AdapterRuntimeOptions } from '../../../adapter/kernel/runtime.js'
import { readGrantStore } from '../../../adapter/standard/grants.js'
import { getHostCommandTrees } from '../../command-trees.js'
import { runForegroundShell, type ForegroundShell } from '../../compat/shell.js'
import { installDecisionGuard, markDecisionDispatchTopology } from '../../decision-guard.js'
import { getHostGrantStore } from '../../host-grants.js'
import { getHostRenderers, type TuiRendererRuntime } from '../../renderers.js'
import { getHostSceneRuntime, type TuiSceneRuntime } from '../../scenes.js'
import { getHostSettingsSections, getLocalSettingsSectionsHost, type TuiSettingsSectionsRuntime } from '../../settings-sections.js'
import { getHostThemes, type TuiThemeRuntime } from '../../themes.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime } from '../../workspaces.js'
import type { ChannelOwner } from '../owner.js'
import type { ChannelState } from '../types.js'

/** The host services a channel composition resolved at construction. */
export interface CoreHost {
  readonly adapterRuntime: AdapterRuntimeOptions
  readonly themeHost: ReturnType<typeof getHostThemes>
  /** Workspace registry runtime; the local-only runtime without the row. */
  readonly workspaceService: NonNullable<ReturnType<typeof getHostWorkspaceRuntime>> | ReturnType<typeof createLocalWorkspaceRuntime>
  readonly commandTrees: ReturnType<typeof getHostCommandTrees>
  readonly sceneRuntime: ReturnType<typeof getHostSceneRuntime>
  readonly settingsSectionsRuntime: ReturnType<typeof getHostSettingsSections>
  readonly rendererRuntime: ReturnType<typeof getHostRenderers>
  /** The live grant store: the host-owned one when the plugin-host row is
   *  mounted, else this channel's private fallback (re-read per operation). */
  currentGrantStore(): ReturnType<typeof readGrantStore>
}

/**
 * Resolve the host seams and install the decision gate. The topology marker
 * is effectful state, so it is owned at acquisition: a later construction
 * failure rolls it back.
 */
export function resolveCoreHost(ctx: Context, owner: Pick<ChannelOwner, 'own'>): CoreHost {
  const adapterRuntime = adapterRuntimeFor(ctx)
  const themeHost = getHostThemes(ctx.get('tuiThemes') as TuiThemeRuntime | undefined)
  // Backstop: the extensions row installs the decision-subscription gate,
  // but the channel is the dispatch path. A stale patch without that row (or
  // a bare embed mounting neither) would otherwise leave tui/input and
  // friends subscribable by default, silently voiding default-deny.
  // Idempotent per cordis root, so the full-patch path installs exactly
  // once whichever side runs first. Keep a private fallback for
  // bare embedders, but resolve the host-owned store on every operation so
  // a plugin-host row mounted later (or a custom live GrantStore) is not
  // shadowed by an early snapshot.
  const fallbackGrantStore = readGrantStore(undefined, undefined, adapterRuntime)
  const currentGrantStore = (): ReturnType<typeof readGrantStore> =>
    getHostGrantStore(ctx.get('tuiPluginHost')) ?? fallbackGrantStore
  installDecisionGuard(ctx, currentGrantStore())
  // The channel is the real DecisionEvents dispatch path. Record that
  // topology so the live driver can distinguish "guard installed" (not a
  // live feature) from "events can actually be dispatched here".
  owner.own(markDecisionDispatchTopology(ctx))
  return {
    adapterRuntime,
    themeHost,
    // Workspace registry runtime (optional service, issue #183): mounted by
    // the bundle patch's dsh-tui-workspaces row; absent the row (stale patch
    // or a bare embedder), degrade to the local-only runtime.
    workspaceService: getHostWorkspaceRuntime(ctx.get('tuiWorkspaces')) ?? createLocalWorkspaceRuntime(),
    commandTrees: getHostCommandTrees(ctx.get('tuiCommandTrees')),
    // Plugin scene runtime (optional, dsh-tui-scenes row): absent the row,
    // `pluginScene` simply stays undefined.
    sceneRuntime: getHostSceneRuntime(ctx.get('tuiScenes') as TuiSceneRuntime | undefined),
    // Falls back to the in-package local host when the composition's
    // service row is unavailable (issue #557).
    settingsSectionsRuntime: getHostSettingsSections(
      ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined,
    ) ?? getLocalSettingsSectionsHost(ctx),
    // Custom-entry text renderers (optional, dsh-tui-extensions row): absent
    // the row, unknown plugin event types stay invisible in the transcript.
    rendererRuntime: getHostRenderers(ctx.get('tuiRenderers') as TuiRendererRuntime | undefined),
    currentGrantStore,
  }
}

/** Re-render on settings-section and plugin-scene changes (owner-scoped). */
export function startHostSubscriptions(
  host: Pick<CoreHost, 'settingsSectionsRuntime' | 'sceneRuntime'>,
  owner: Pick<ChannelOwner, 'own' | 'current'>,
  state: Pick<ChannelState, 'pluginScene' | 'emit'>,
): void {
  owner.own(host.settingsSectionsRuntime?.subscribe(() => { if (owner.current()) state.emit() }) ?? (() => undefined))
  const sceneRuntime = host.sceneRuntime
  let unsubscribeScenes: (() => void) | undefined
  const disposeScenes = sceneRuntime?.subscribe(() => {
    if (state.pluginScene === sceneRuntime.active) return
    state.pluginScene = sceneRuntime.active
    state.emit()
  })
  if (disposeScenes !== undefined) {
    unsubscribeScenes = disposeScenes
    owner.own(() => {
      if (unsubscribeScenes !== disposeScenes) return
      unsubscribeScenes = undefined
      disposeScenes()
    })
  }
}

/**
 * Statusline breadcrumb: the current git branch of the session cwd
 * (best-effort, through the host `shell` service). Re-run when an adoption
 * lands on a different cwd (/resume, /workspace, issue #96) so the
 * breadcrumb never shows the previous workspace's branch.
 */
export function createGitBranchRefresher(ctx: Context, deps: {
  owner: Pick<ChannelOwner, 'current'>
  state: Pick<ChannelState, 'cwd' | 'gitBranch' | 'emit'>
  /** Record the resolved branch against the bound session (the session
   *  browser's branch column); absent = nothing records it. */
  noteBranch?(branch: string): void
}): () => void {
  return () => {
    const { state } = deps
    state.gitBranch = undefined
    const shell = ctx.get('shell') as ForegroundShell | undefined
    if (!shell) return
    // Capture the requested cwd: a /resume landing while this query is in
    // flight refreshes the branch for the new cwd, so a late reply from the
    // old workspace must be dropped (stale statusline, issue #96).
    const requestedCwd = state.cwd
    void runForegroundShell(shell, {
      command: 'git branch --show-current',
      workdir: requestedCwd,
      timeoutMs: 3000,
    })
      .then((result) => {
        if (!deps.owner.current() || state.cwd !== requestedCwd) return
        const branch = result.stdout.text.trim()
        if (branch !== '') {
          state.gitBranch = branch
          deps.noteBranch?.(branch)
          state.emit()
        }
      })
      .catch(() => {
        // Git branch detection is best-effort; on Windows the sandbox
        // backend may be unavailable (no confinement yet) or the cwd may
        // not be a git repo. Either way the statusline simply stays blank.
      })
  }
}
