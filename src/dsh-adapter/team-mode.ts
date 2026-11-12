/**
 * Agent Teams status and switch at run time (issue #1241; `0.2.2-rc.2`
 * moved the team from an experimental bundle to a per-session selection).
 *
 * Two upstream mechanisms are told apart by shape, never by version:
 *
 * - **Selection hosts** (`0.2.2-rc.2` and later): the service ships in
 *   `dsh-base` and exposes `setEnabled(rootAgent, enabled)` / `isEnabled`.
 *   `/team on|off` writes that saved per-root selection; `/team` reports it.
 *   The task tools and Team guidance follow the root's selection throughout
 *   its subagent tree, and switching off keeps subagents and tasks.
 * - **Bundle hosts** (`0.2.2-rc.1` and earlier): the service is mounted by the
 *   retired `dsh-experimental-agent-team-profile` bundle, so the switch stays
 *   `/plugin enable|disable`, and `/team` only reports plus points at it.
 *
 * What stays here besides the command is the one decision that cannot live in
 * a preset — which legacy delegation tools a request carries. It is a
 * bundle-host seam: a selection host has no `spawn_teammate` tool, so the
 * predicate is inert there.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
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
 * on: a bundle host mounts it only while the feature is on, while a selection
 * host always mounts it (the saved mode decides whether the tools are there).
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
 * so whether the team replaces them is decided where the tools are known: a
 * registry carrying `spawn_teammate` drops `subagent` / `subagent_fork` on the
 * agent's own scope (the assembly no longer carries tool declarations since
 * 0.2.2). This follows a bundle toggled at run time into the sessions already
 * joined (a preset revision cannot), and a team service that never activated
 * leaves the legacy tools in place.
 *
 * Bundle hosts only: a selection host (`0.2.2-rc.2` and later) has no
 * `spawn_teammate`, and the standard `subagent` / `subagent_fork` tools are
 * its own delegation surface, so the predicate is inert there. Kept for the
 * old hosts this application still supports.
 *
 * @param registered - Effective agent tool names, including inherited preset tools.
 * @returns The replaced tool names to deny, empty when the team is inactive.
 */
export function teamReplacedToolDeny(registered: ReadonlySet<string>): readonly string[] {
  if (!registered.has(TEAM_SPAWN_TOOL)) return []
  return [...TEAM_REPLACED_TOOLS].filter(name => registered.has(name))
}

/** Keep the legacy final-assembly seam; new presentations carry no tools. */
export function filterTeamReplacedTools<T extends {
  readonly sections: readonly unknown[]
  readonly tools?: readonly { readonly name: string }[]
}>(assembly: T): T {
  if (assembly.tools === undefined) return assembly
  const deny = new Set(teamReplacedToolDeny(new Set(assembly.tools.map(tool => tool.name))))
  const tools = assembly.tools.filter(tool => !deny.has(tool.name))
  return tools.length === assembly.tools.length ? assembly : { ...assembly, tools }
}

/** What `/team` was asked. */
export type TeamCommand =
  | { readonly kind: 'status' }
  /** `on` / `off`: the per-session switch on a selection host, the bundle route on a bundle host. */
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

/** What a selection host's team service exposes (read from the service, never imported). */
interface TeamSwitchService {
  setEnabled(agent: unknown, enabled: boolean): Promise<void>
  isEnabled(agent: unknown): boolean
}

/**
 * The per-session switch, when this service has one. Bundle hosts expose task
 * methods only; their switch stays the bundle lifecycle.
 * @param ctx - Host context of the composition root.
 */
function teamSwitchOf(ctx: Context): TeamSwitchService | undefined {
  const service = ctx.get('agentTeams', false) as Partial<TeamSwitchService> | undefined
  if (service === undefined || typeof service.setEnabled !== 'function' || typeof service.isEnabled !== 'function') return undefined
  return service as TeamSwitchService
}

/** Services that know the subagent tree; the tree root owns the Team selection. */
interface SubagentsRootLike {
  rootOf?(agent: unknown): unknown
}

/**
 * Resolve the root Agent that owns the saved selection. The service rejects
 * descendants, so the walk is not merely a convenience.
 * @param ctx - Host context of the composition root.
 * @param agent - The bound session's live Agent.
 * @returns the root Agent, or `undefined` when the tree cannot be resolved.
 */
function rootAgentOf(ctx: Context, agent: unknown): unknown {
  const subagents = ctx.get('subagents', false) as SubagentsRootLike | undefined
  try {
    return subagents?.rootOf?.(agent) ?? agent
  } catch {
    return undefined
  }
}

/** `/team off force`: confirms switching off while subagents are still running. */
function switchForceRequested(args: string): boolean {
  return /(?:^|\s)(?:force|--force|-f)(?:\s|$)/i.test(args)
}

/**
 * Wire `/team` to the running composition. On a selection host it also moves
 * the switch; on a bundle host it only reports and points at
 * `/plugin enable|disable` (the lifecycle flow and its confirmations).
 * @param ctx - Host context of the composition root.
 * @param options - The profile a CLI route names, and how to reach the bound session's live Agent.
 * @returns the command entry the screen calls.
 */
export function createTeamCommandEntry(
  ctx: Context,
  options: {
    readonly profileName?: string | undefined
    /** The bound session's live Agent, when this launch has one (DSH kernels). */
    readonly rootAgent?: (() => unknown) | undefined
  } = {},
): TeamCommandEntry {
  const profile = options.profileName ?? 'dsh-tui'
  return async (args, sink) => {
    const parsed = parseTeamArgs(args)
    if (parsed.kind === 'unknown') {
      return [t('team-cmd-usage', { sub: cell(parsed.sub) })]
    }
    const service = teamSwitchOf(ctx)
    if (service !== undefined) {
      const bound = resolveBoundRoot(ctx, options.rootAgent)
      if (parsed.kind === 'status') return teamSwitchStatusLines(service, bound, sink)
      return teamSwitchActionLines(service, bound, sink, args)
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

/** The bound session's root Agent, when a live DSH Agent can be reached. */
function resolveBoundRoot(ctx: Context, rootAgent: (() => unknown) | undefined): unknown {
  if (rootAgent === undefined) return undefined
  let agent: unknown
  try {
    agent = rootAgent()
  } catch {
    return undefined
  }
  if (agent === undefined) return undefined
  return rootAgentOf(ctx, agent)
}

/**
 * `/team` and `/team status` on a selection host: the saved mode, the service
 * and the bound session's subagents.
 */
function teamSwitchStatusLines(service: TeamSwitchService, rootAgent: unknown, sink: TeamCommandSink): readonly string[] {
  const lines: string[] = []
  const enabled = readTeamMode(service, rootAgent)
  lines.push(enabled === undefined
    ? t('team-cmd-mode-unavailable')
    : t('team-cmd-mode', { state: t(enabled ? 'team-cmd-on' : 'team-cmd-off') }))
  lines.push(t('team-cmd-service', { state: t('team-cmd-running') }))
  lines.push(...memberCountLines(sink))
  if (enabled === false) lines.push(t('team-cmd-use-switch'))
  return lines
}

/** `/team on|off` on a selection host: write the saved selection and report it. */
async function teamSwitchActionLines(service: TeamSwitchService, rootAgent: unknown, sink: TeamCommandSink, args: string): Promise<readonly string[]> {
  if (rootAgent === undefined) return [t('team-cmd-switch-unavailable')]
  // The subcommand token decides the direction. Scanning the whole argument
  // string would let a stray later token flip it (`/team off on` must stay off).
  const action = args.trim().split(/\s+/)[0]?.toLowerCase()
  const enable = action === 'on'
  const members = sink.members()
  // Switching off keeps subagents and tasks on a selection host; the confirm
  // only exists because running work keeps going without Team guidance. It
  // counts subagents, which no longer appear in the team wire.
  if (!enable && !switchForceRequested(args) && members.active + members.unseen > 0) {
    return [t('team-cmd-switch-confirm', { members: String(members.active + members.unseen) })]
  }
  try {
    await service.setEnabled(rootAgent, enable)
  } catch (error) {
    return [t('team-cmd-switch-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })]
  }
  const lines: string[] = [
    t('team-cmd-mode', { state: t(enable ? 'team-cmd-on' : 'team-cmd-off') }),
    ...memberCountLines(sink),
  ]
  if (!enable) lines.push(t('team-cmd-use-switch'))
  return lines
}

/** The saved selection, or `undefined` when the live Agent cannot be read. */
function readTeamMode(service: TeamSwitchService, rootAgent: unknown): boolean | undefined {
  if (rootAgent === undefined) return undefined
  try {
    return service.isEnabled(rootAgent)
  } catch {
    return undefined
  }
}

/** The member-count tail both mechanisms share. */
function memberCountLines(sink: TeamCommandSink): readonly string[] {
  const { total, active, unseen } = sink.members()
  return [total === 0
    ? t('team-cmd-no-members')
    : t(unseen === 0 ? 'team-cmd-members' : 'team-cmd-members-unseen', { total: String(total), active: String(active), unseen: String(unseen) })]
}

/**
 * Where the switch went on a bundle host, checked against this launch: the
 * in-session lifecycle command only when the plugin service can run it and the
 * installation lists the bundle; the CLI route or the DSH-line reason
 * otherwise. A bundle the profile already selects is not told to enable
 * itself: with no service running the answer is the restart or the failed
 * activation.
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
 * `/team` and `/team status` on a bundle host: whether the profile selects the
 * bundle and the bound session's team. The caller only runs this while the
 * service is mounted, so the service line states that state instead of
 * re-reading it.
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
  lines.push(...memberCountLines(sink))
  return lines
}
