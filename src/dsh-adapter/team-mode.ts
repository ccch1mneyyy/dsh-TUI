/**
 * Agent Teams status at run time (issue #1241, see
 * docs/agent-teams-design.md「开关机制」).
 *
 * Switching is the upstream team bundle itself: `/plugin enable|disable`
 * selects or drops its layer through the host plugin manager, which persists
 * to the profile and, with `hmr` mounted, applies at once. `/team` is the
 * read-only side: it reports the bundle, the service and this session's
 * teammates, and is exposed only while the `agentTeams` service is mounted —
 * the same availability the desktop UI gives the feature. A typed `/team`
 * before that still answers with the enable route instead of reaching the
 * model.
 *
 * What stays here besides the command is the one decision that cannot live in
 * a preset — which legacy delegation tools a request carries.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { LocalCommand } from '../commands.js'
import { t } from '../i18n.js'
import type { TeamActiveMembers } from './plugin-manage.js'
import { pluginManagerOf } from './plugin-manager.js'
import { cell } from './plugins-info.js'
import { TEAM_BUNDLE } from './team-roster.js'
import { TEAM_SPAWN_TOOL } from './team-tools.js'

/** The slash-command name this module owns. */
const TEAM_COMMAND_NAME = 'team'

/**
 * Whether the team service is mounted. This is the one signal `/team` appears
 * on: the desktop UI shows the same feature only while its service is there.
 * @param ctx - Host context of the composition root.
 */
export function teamServiceActive(ctx: Context): boolean {
  return ctx.get('agentTeams', false) !== undefined
}

/**
 * Hide `/team` from Help and `/` completion while the service is not mounted.
 * The typed form stays a local command (`isLocalCommandName` still knows the
 * name), so it can answer with the enable route instead of becoming text sent
 * to the model.
 * @param commands - The current command catalog.
 * @param visible - Whether the team service is mounted.
 * @returns The catalog with `/team` removed when it is not.
 */
export function withTeamCommandVisibility(commands: readonly LocalCommand[], visible: boolean): readonly LocalCommand[] {
  return visible ? commands : commands.filter(command => command.name !== TEAM_COMMAND_NAME)
}

/**
 * Legacy delegation tools that `spawn_teammate` replaces. The four control
 * tools the team shares names with (`send_message`, `list_agents`,
 * `interrupt_agent`, `wait_agent`) need no entry: the team copies live in the
 * Agent's own scope and shadow the preset's, in the assembly and at execution.
 */
const TEAM_REPLACED_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork'])

/**
 * Keep one delegation tool set per request. Presets keep their legacy rows,
 * so whether the team replaces them is decided where the tools are known: an
 * assembly carrying `spawn_teammate` drops `subagent` / `subagent_fork`. This
 * follows a bundle toggled at run time into the sessions already joined (a
 * preset revision cannot), and a team service that never activated leaves the
 * legacy tools in place. The agent loop diffs these final tools against the
 * logged request header, so the model is told about each swap.
 * @param assembly - Fully assembled prompt inputs for one model request.
 * @returns The original assembly, or a copy without the replaced tools.
 */
export function filterTeamReplacedTools(assembly: PromptAssembly): PromptAssembly {
  if (!assembly.tools.some(tool => tool.name === TEAM_SPAWN_TOOL)) return assembly
  if (!assembly.tools.some(tool => TEAM_REPLACED_TOOLS.has(tool.name))) return assembly
  return { ...assembly, tools: assembly.tools.filter(tool => !TEAM_REPLACED_TOOLS.has(tool.name)) }
}

/** What `/team` was asked. */
export type TeamCommand =
  | { readonly kind: 'status' }
  /** `on` / `off`: the switch moved to `/plugin enable|disable`. */
  | { readonly kind: 'switch' }
  | { readonly kind: 'unknown'; readonly sub: string }

export function parseTeamArgs(args: string): TeamCommand {
  const sub = args.trim().split(/\s+/)[0] ?? ''
  if (sub === '' || sub === 'status') return { kind: 'status' }
  if (sub === 'on' || sub === 'off') return { kind: 'switch' }
  return { kind: 'unknown', sub }
}

/** What the screen supplies: the bound session's live team counts. */
export interface TeamCommandSink {
  /** Teammates of the bound session, how many are running or provisioning, and how many may be running. */
  readonly members: () => { readonly total: number } & TeamActiveMembers
}

/** The entry the screen calls: argument text in, report lines out. */
export type TeamCommandEntry = (args: string, sink: TeamCommandSink) => Promise<readonly string[]>

/**
 * Wire `/team` to the running composition. The command only reports; the
 * bundle switch is `/plugin enable|disable`, which shares the lifecycle flow
 * and its confirmations.
 * @param ctx - Host context of the composition root.
 * @param options - The profile a CLI route names.
 * @returns the command entry the screen calls.
 */
export function createTeamCommandEntry(
  ctx: Context,
  options: { readonly profileName?: string | undefined } = {},
): TeamCommandEntry {
  const profile = options.profileName ?? 'dsh-tui'
  return async (args, sink) => {
    const parsed = parseTeamArgs(args)
    if (parsed.kind === 'unknown') {
      return [t('team-cmd-usage', { sub: cell(parsed.sub) })]
    }
    // The mounted service is the only state `/team` reports on.
    if (parsed.kind === 'status' && teamServiceActive(ctx)) {
      return teamStatusLines(ctx, sink)
    }
    // Everything else answers where the switch is: but only with a route this
    // launch can take. Without the profile plugin service that route cannot run
    // here, and a bundle the running installation does not ship has no target
    // at all (`/plugin` would answer with every addressable name).
    return teamSwitchRouteLines(ctx, profile, parsed.kind === 'switch' ? 'switch' : 'not-enabled')
  }
}

/**
 * Where the switch went, checked against this launch: the in-session lifecycle
 * command only when the plugin service can run it and the installation lists
 * the bundle; the CLI route or the DSH-line reason otherwise. A bundle the
 * profile already selects is not told to enable itself: with no service running
 * the answer is the restart or the failed activation.
 */
async function teamSwitchRouteLines(
  ctx: Context,
  profile: string,
  kind: 'switch' | 'not-enabled',
): Promise<readonly string[]> {
  const manager = pluginManagerOf(ctx)
  if (manager === undefined) {
    return [t('team-cmd-no-manager-route', { profile: cell(profile), bundle: TEAM_BUNDLE })]
  }
  let listed = true
  let selected = false
  try {
    const bundle = (await manager.listBundles()).find(candidate => candidate.name === TEAM_BUNDLE)
    listed = bundle !== undefined
    selected = bundle?.enabled === true
  } catch {
    // A failing read is the status path's to report; name the general route.
  }
  if (!listed) return [t('team-cmd-bundle-absent', { bundle: TEAM_BUNDLE })]
  // Selected but nothing runs: `/plugin enable` would be a no-op, so name the
  // state instead (a restart, or an activation that failed — see the log).
  if (kind === 'not-enabled' && selected) return [t('team-cmd-pending-on')]
  return [t(kind === 'switch' ? 'team-cmd-switch-moved' : 'team-cmd-not-enabled', { bundle: TEAM_BUNDLE })]
}

/**
 * `/team` and `/team status`: whether the profile selects the bundle and the
 * bound session's team. The caller only runs this while the service is mounted,
 * so the service line states that state instead of re-reading it.
 */
async function teamStatusLines(ctx: Context, sink: TeamCommandSink): Promise<readonly string[]> {
  const manager = pluginManagerOf(ctx)
  const lines: string[] = []
  if (manager === undefined) {
    lines.push(t('team-cmd-service', { state: t('team-cmd-running') }))
    lines.push(t('team-cmd-no-manager'))
  } else {
    let selected: boolean | undefined
    try {
      const bundle = (await manager.listBundles()).find(candidate => candidate.name === TEAM_BUNDLE)
      selected = bundle?.enabled
      lines.push(selected === undefined
        ? t('team-cmd-bundle-unknown')
        : t('team-cmd-bundle', { state: t(selected ? 'team-cmd-on' : 'team-cmd-off') }))
    } catch (error) {
      lines.push(t('plugins-service-error', { err: cell(error instanceof Error ? error.message : String(error)) }))
    }
    lines.push(t('team-cmd-service', { state: t('team-cmd-running') }))
    // The service is mounted (the caller gates on that), so a profile that
    // already deselected the bundle is the case that waits for a restart.
    if (selected === false) lines.push(t('team-cmd-pending-off'))
  }
  const { total, active, unseen } = sink.members()
  lines.push(total === 0
    ? t('team-cmd-no-members')
    : t(unseen === 0 ? 'team-cmd-members' : 'team-cmd-members-unseen', { total: String(total), active: String(active), unseen: String(unseen) }))
  return lines
}
