import type { LocalCommand, LocalizedDescriptions, CommandCompletion } from './adapter/ports/channel-catalog.js'
export type { LocalCommand, LocalizedDescriptions, CommandCompletion } from './adapter/ports/channel-catalog.js'
/**
 * Local slash commands for dsh-tui, presented as `/name — description`.
 * The built-in set is merged with plugin-registered commands (plan/goal/…)
 * from the DSH command registry (`dsh-commands`); `runCommand` in the Chat
 * screen dispatches either kind.
 *
 * Locals win on name collisions: the merge skips a registry descriptor whose
 * name a local command already declares (`channel/skill-catalog.ts`), and the
 * Chat switch answers the local name before the registry path. `/compact` is
 * the live case — the TUI's own transaction is the primary route and the
 * official `dsh-command-compact` handler is only the fallback when the local
 * path cannot run (see `dsh-adapter/channel/capabilities.ts`).
 */

import { getLang, tOr } from './i18n.js'

/** One child in a slash-command tree contributed by a local feature/plugin. */
export interface CommandCompletionNode {
  name: string
  aliases?: readonly string[]
  description: string
  descriptions?: LocalizedDescriptions
  tag?: string
  /** Optional i18n key; plugin nodes normally rely on fallback text. */
  descriptionKey?: string
}

export type CommandChildren = (canonicalPath: readonly string[]) => readonly CommandCompletionNode[]

/**
 * Whether a value can occupy one command-completion token. Keep this aligned
 * with the grammar accepted by {@link completeCommands}; callers that need an
 * empty prefix handle that case separately.
 */
export function isCommandCompletionToken(value: string): boolean {
  return /^[a-z0-9_.:\/-]+$/iu.test(value)
}

/**
 * The built-in slash commands (name + description pairs). Plugin-registered
 * commands merge in at runtime; locals win on name collisions.
 */
export const LOCAL_COMMANDS: LocalCommand[] = [
  // Conversation
  { name: 'new', description: 'Start a new conversation' },
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'compact', description: 'Summarize earlier turns to free context space' },
  { name: 'resume', description: 'Continue a saved session' },
  { name: 'rename', description: 'Rename the current session' },
  { name: 'recap', description: 'Generate a recap of recent session activity' },
  { name: 'rewind', description: 'Return the session to an earlier message' },
  { name: 'tree', description: 'Browse the session family tree (rewind / fork / adopt)' },
  { name: 'fork', description: 'Fork the current session into a resumable copy' },
  { name: 'export', description: 'Save the session as a Markdown file' },
  { name: 'btw', description: 'Ask a quick side question without interrupting the conversation' },
  { name: 'trace', description: 'Show the session event trace timeline' },
  { name: 'agentview', description: 'Open the agent view (all sessions)' },
  { name: 'bg', description: 'Open the session manager (DSH backgrounds this session first)' },
  { name: 'background', description: 'Open the session manager (DSH backgrounds this session first)', tag: 'alias of /bg' },
  // Session / environment
  { name: 'context', description: 'Show loaded context details' },
  { name: 'status', description: 'Show session status' },
  { name: 'cost', description: 'Show session token usage' },
  { name: 'config', description: 'Show the dsh-tui configuration source' },
  { name: 'reload', description: 'Reload preference files from disk and apply live' },
  { name: 'settings', description: 'View and edit plugin settings' },
  { name: 'setup', description: 'Re-run the first-run guide (API key / language + theme / model + workspace / shortcuts)' },
  { name: 'star', description: 'Star this project on GitHub (one-key via the gh CLI)' },
  { name: 'doctor', description: 'Run environment checks' },
  { name: 'migrate', description: 'Import conversations from other coding agents (claude-code / codex / omp / zcode / grok-build)' },
  { name: 'init', description: 'Create AGENTS.md in the working directory' },
  { name: 'agents', description: 'Show subagents of this session' },
  { name: 'jobs', description: 'Show background jobs of this session' },
  { name: 'panel', description: 'Side panel: toggle / focus / zoom / switch panels' },
  // Model / display
  { name: 'activity', description: 'Switch the working-activity indicator preset' },
  { name: 'preset', description: 'Switch the agent preset (including Liangshen mode)' },
  { name: 'theme', description: 'Switch the color theme (auto, built-in or custom)' },
  { name: 'color', description: 'Set the current session accent color' },
  { name: 'lang', description: 'Switch the UI language (en / zh)' },
  { name: 'model', description: 'Show the active model' },
  { name: 'effort', description: 'Adjust the reasoning effort (slider)' },
  { name: 'thinking', description: 'Toggle extended thinking display' },
  { name: 'tokens', description: 'Show session token usage' },
  // Account / policy
  { name: 'balance', description: 'Show DeepSeek account balance' },
  { name: 'provider', description: 'Add, edit or delete an LLM provider (catalog or custom API endpoint)' },
  { name: 'login', description: 'Show API credential status' },
  { name: 'logout', description: 'Clear the API credential' },
  { name: 'add-dir', description: 'Show the filesystem policy scope' },
  { name: 'hooks', description: 'Show hooks status' },
  { name: 'mcp', description: 'Show MCP status' },
  { name: 'skills', description: 'List available skills' },
  { name: 'plugins', description: 'Show plugin contract, grant, and ledger diagnostics' },
  { name: 'update', description: 'Update dsh-tui and restart' },
  // Skills are discovered through the DSH registry and added at runtime.
  // A local entry of the same name would win the collision filter.
  // Misc / not applicable on this leaf
  { name: 'vim', description: 'Turn Vim keybindings on or off' },
  { name: 'terminal-setup', description: 'Show terminal setup instructions' },
  { name: 'connect', description: 'Connect to a remote machine' },
  { name: 'workspace', description: 'Resume, rename, or open a workspace' },
  { name: 'home', description: 'Workspace home: manage workspaces and open their sessions' },
  // Help / exit
  { name: 'help', description: 'Show shortcuts and commands' },
  { name: 'tips', description: 'Show usage tips and shortcuts' },
  { name: 'kernel', description: 'Choose the kernel dsh-tui runs on (DSH or Claude)' },
  { name: 'restart', description: 'Restart dsh-tui and resume this session' },
  { name: 'exit', description: 'Exit dsh-tui' },
  { name: 'quit', description: 'Exit dsh-tui', tag: 'alias of /exit' },
  { name: 'q', description: 'Exit dsh-tui', tag: 'alias of /exit' },
]

/**
 * `/permission` as a modes-capable backend serves it. Deliberately NOT a
 * LOCAL_COMMANDS entry: DSH's own /permission comes from the permission-
 * presets registry row, and a local entry would shadow it in the merged
 * list (locals win collisions), flipping the external-command route the
 * DSH pipeline depends on. The backend capability snapshot appends this
 * shape instead (channel/capabilities.ts → session-controls), so a session
 * with the typed `modes` capability offers the same command surface
 * without touching DSH's.
 */
export const BACKEND_PERMISSION_COMMAND: LocalCommand = {
  name: 'permission',
  description: 'Show or switch the permission mode',
  descriptionKey: 'cmd-desc-permission',
}

/**
 * `/channel` as a channels-capable backend serves it (the Claude backend's
 * relay channel profiles, backends/claude/channels.ts). Like /permission,
 * deliberately NOT a LOCAL_COMMANDS entry: the command must appear only on a
 * backend that declares the typed `channels` capability — a DSH session
 * (every built-in) and other backends never list it, so typing `/channel`
 * there keeps today's not-a-command behavior. The capability snapshot
 * appends the name (channel/capabilities.ts) and session-controls rides it
 * here.
 */
export const BACKEND_CHANNEL_COMMAND: LocalCommand = {
  name: 'channel',
  description: 'Manage relay channel profiles (switch, import, view mappings)',
  descriptionKey: 'cmd-desc-channel',
}

/**
 * `/goal` as a goals-capable backend serves it (the typed `goals`
 * capability; the channel core's `backendGoals` host). Like /permission,
 * deliberately NOT a LOCAL_COMMANDS entry: DSH's own /goal is the
 * `dsh-command-goal` registry row, and a local entry would shadow it. The
 * capability snapshot appends the name (channel/capabilities.ts) and
 * session-controls rides it here. On a backend without the capability the
 * typed command is refused as unavailable (`isUnavailableLocalCommand`).
 */
export const BACKEND_GOAL_COMMAND: LocalCommand = {
  name: 'goal',
  description: 'Set or show the session goal',
  descriptionKey: 'cmd-desc-goal',
}

/**
 * What a built-in command needs from the bound backend session: `any` works
 * on every backend (UI-only, or served by the channel's backend-neutral
 * core); a capability name needs that session capability; `dsh` needs the
 * DSH-only specialists. Commands not listed here default
 * to `dsh`, so a new built-in never silently appears on a backend that
 * cannot serve it.
 */
export type LocalCommandRequirement =
  | 'any' | 'dsh' | 'models' | 'effort' | 'compact' | 'rewind' | 'fork' | 'resume'
  | 'subagents' | 'tasks' | 'mcp' | 'context' | 'login' | 'sideQuery' | 'rename' | 'color' | 'init'

const LOCAL_COMMAND_REQUIREMENTS: ReadonlyMap<string, LocalCommandRequirement> = new Map<string, LocalCommandRequirement>([
  ['new', 'any'], ['clear', 'any'], ['status', 'any'], ['cost', 'any'], ['tokens', 'any'],
  ['settings', 'any'], ['star', 'any'], ['doctor', 'any'], ['help', 'any'], ['tips', 'any'],
  ['exit', 'any'], ['quit', 'any'], ['q', 'any'], ['theme', 'any'], ['lang', 'any'],
  ['activity', 'any'], ['thinking', 'any'], ['vim', 'any'], ['terminal-setup', 'any'],
  ['connect', 'any'], ['update', 'any'], ['export', 'any'], ['panel', 'any'],
  // The composition root serves these by respawning the process, so every
  // backend offers them. /kernel is also the only way back to DSH from
  // inside a non-DSH conversation (the launchpad's kernel entry is the other).
  ['kernel', 'any'], ['restart', 'any'],
  ['compact', 'compact'], ['resume', 'resume'], ['home', 'resume'], ['agentview', 'resume'],
  ['bg', 'resume'], ['background', 'resume'], ['rewind', 'rewind'], ['fork', 'fork'],
  ['model', 'models'], ['effort', 'effort'], ['agents', 'subagents'], ['jobs', 'tasks'], ['mcp', 'mcp'],
  ['context', 'context'], ['login', 'login'], ['logout', 'login'], ['init', 'init'],
  ['recap', 'sideQuery'], ['btw', 'sideQuery'], ['rename', 'rename'], ['color', 'color'],
  // /trace opens on every backend; one without trajectory data shows the
  // unsupported state (channel.trajectorySource() decides, not this table).
  ['trace', 'any'],
])

/** The requirement of one built-in command name (unlisted → `dsh`). */
export function localCommandRequirement(name: string): LocalCommandRequirement {
  return LOCAL_COMMAND_REQUIREMENTS.get(name) ?? 'dsh'
}

/**
 * Names of the built-in commands a backend supports, in catalog order. A DSH
 * session supports every built-in (today's list, unchanged); any other
 * session supports the `any` commands plus those whose capability it has.
 */
export function supportedLocalCommandNames(
  backend: { readonly dsh: boolean; readonly has: (capability: Exclude<LocalCommandRequirement, 'any' | 'dsh'>) => boolean },
): readonly string[] {
  return LOCAL_COMMANDS.filter(command => {
    if (backend.dsh) return true
    const requirement = localCommandRequirement(command.name)
    if (requirement === 'any') return true
    if (requirement === 'dsh') return false
    return backend.has(requirement)
  }).map(command => command.name)
}

/**
 * Whether a typed name is a built-in command the bound backend lacks. Such a
 * line must neither run nor reach the model: the caller shows
 * `cmd-unavailable-backend`. An absent snapshot (a partial embedder channel)
 * means everything is supported. `/goal` counts as one when the snapshot
 * says goals are not served (a backend without the `goals` capability; a
 * snapshot without the flag predates it and serves everything).
 */
export function isUnavailableLocalCommand(
  name: string,
  capabilities: { readonly commands: readonly string[]; readonly goals?: boolean } | undefined,
): boolean {
  if (capabilities === undefined) return false
  if (name === BACKEND_GOAL_COMMAND.name) return capabilities.goals === false
  return LOCAL_COMMANDS.some(command => command.name === name) && !capabilities.commands.includes(name)
}

/**
 * Hidden slash commands: intentionally not exposed in the `/` suggestion
 * menu or Help, but still recognized as local commands when typed. They are
 * kept out of `LOCAL_COMMANDS` so `filterCommands`/`completeCommands` never
 * surface them; dispatch recognizes them via {@link HIDDEN_COMMAND_NAMES}.
 */
export const HIDDEN_COMMANDS: readonly LocalCommand[] = [
  { name: 'deepseek', description: 'Hidden DeepSeek easter egg' },
]

/** Names of hidden commands, for fast dispatch/lookup. */
export const HIDDEN_COMMAND_NAMES: ReadonlySet<string> = new Set(
  HIDDEN_COMMANDS.map(command => command.name),
)

/**
 * Whether the input names a hidden command (same slash-optional trimming
 * rules as {@link isLocalCommandName}).
 */
export function isHiddenCommandName(input: string): boolean {
  const name = input.replace(/^\//, '').trim()
  return HIDDEN_COMMAND_NAMES.has(name)
}

/**
 * Commands that may run while the channel is not ready (`ChannelUi.ready`
 * false): the purely local ones. Everything else is refused before dispatch.
 */
const BOOT_SAFE_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'exit', 'quit', 'q',
  'help', 'tips',
  'theme', 'lang', 'vim',
  'kernel',
  'deepseek',
  // Opening a session by hand: the retry after a failed startup open. Run
  // while the open is still going, the binding drops the startup candidate.
  'new', 'resume',
])

/** Whether a command name (no slash) may run before the channel is ready. */
export function isBootSafeCommand(name: string): boolean {
  return BOOT_SAFE_COMMAND_NAMES.has(name)
}

/**
 * Resolve a command's description in the active UI language. The en text in
 * `LOCAL_COMMANDS` (and the registry's own text for external commands) is
 * the fallback; zh translations live in the i18n dict under
 * `cmd-desc-<name>`. Resolved at call time — components call this during
 * render, so a `/lang` switch repaints descriptions immediately.
 * @param command - The command whose description to localize.
 */
export function localizedDescription(command: LocalCommand & { descriptionKey?: string }): string {
  const translated = command.descriptions?.[getLang()]
  if (translated !== undefined) return translated
  return tOr(command.descriptionKey ?? `cmd-desc-${command.name}`, command.description)
}

/**
 * Commands the channel REFUSES to run while a turn is streaming, mapped to the
 * i18n key of the refusal notice. This table is the single source of truth for
 * what a gate SAYS and for the `/` suggestion overlay that sinks the rows
 * affecting the running conversation — so the refusal text and the overlay
 * annotation can never drift. WHETHER a command is refused still lives in each
 * gate's own `state.working` / `channel.working` branch — the 11 bail-outs under
 * `src/dsh-adapter/` plus the UI-side gates that share the same refusals — so
 * a new gate means a new entry here: `scripts/verify-command-hold.ts` fails when
 * a `working` bail-out under `src/dsh-adapter/` notifies with a literal key of
 * its own, and when a new name joins this dictionary without a conscious edit
 * there. A `t(...)` call in a gate pins the key type, so removing an entry from
 * the dict fails the build.
 */
export const WORKING_GATE_NOTICES = {
  new: 'new-session-while-working',
  compact: 'compact-while-working',
  fork: 'fork-while-working',
  model: 'model-switch-while-working',
  preset: 'preset-agent-running',
  workspace: 'workspace-switch-working',
  update: 'update-working',
  restart: 'update-working',
  // `/resume` and the core's `/rewind` refuse mid-turn in the session-switch
  // transaction; under DSH the rewind extension instead CANCELS the turn and
  // re-arms (session-rewind.ts), so the refusal is the core's own path. The
  // `/resume` KEY stays here for that core path and for `resumeFailureText`,
  // but its ROW is not gray-zoned — see GRAY_ZONE_EXEMPT_COMMANDS.
  resume: 'resume-while-working',
  rewind: 'rewind-while-working',
  // Both backend pickers open while a turn runs, but every mutating row inside
  // them is refused (`/kernel` confirms a switch; `/channel` imports, adds,
  // manages or switches to a profile that needs a process restart).
  kernel: 'kernel-switch-while-working',
  channel: 'channel-switch-while-working',
} as const

/**
 * Commands that DO have a mid-turn refusal notice of their own, yet whose ROW
 * stays in the overlay's normal region: the command only OPENS a browser, and
 * the refusals belong to the separate, separately confirmed actions INSIDE it.
 *
 * `/resume` opens the session manager (`Chat.tsx` `setSupervisorOpen`); the
 * per-row switch is a separate action that PARKS the outgoing session and lets
 * its turn keep running (`session-resume.ts`), so neither the command nor the
 * switch interrupts the running turn — the same reason `/tree` is in the normal
 * region. Its key stays in {@link WORKING_GATE_NOTICES} because the core's own
 * session-switch transaction still refuses mid-turn on a backend that gets no
 * DSH extension (Claude, `core/session-switch.ts`), and `resumeFailureText`
 * reports that reason with it.
 */
export const GRAY_ZONE_EXEMPT_COMMANDS: readonly string[] = ['resume']

/**
 * Commands that MAY run while a turn is streaming but act ON the conversation
 * itself rather than on the running turn: `clear` empties the visible view (the
 * running turn keeps writing into it, `local-actions.ts`), and `exit` (with its
 * `quit`/`q` aliases) tears the process — and the running turn — down.
 *
 * `/rewind` used to live here, because it cancels only once a target is
 * CONFIRMED (`session-rewind.ts`) and replacing the conversation is its whole
 * purpose. It moved to {@link WORKING_GATE_NOTICES} when the session-switch
 * transaction grew its own mid-turn refusal: under DSH the extension still
 * cancels and re-arms, but the core's rewind path REFUSES, and one command
 * cannot be both. `/tree` deliberately stays out of both families: it only
 * opens the family-tree browser (`Chat.tsx` `setTreeOpen(true)`) and leaves the
 * running turn untouched — its per-node rewind/fork/adopt are separate,
 * separately confirmed actions (`session-tree-actions.ts`), and browsing the
 * tree is inspection, not impact (issue #1072 review: measured on a real turn —
 * `/tree` does not interrupt). `/resume` belongs to that same normal region for
 * the same reason, even though it does own a notice key for the core's refusal:
 * see {@link GRAY_ZONE_EXEMPT_COMMANDS}.
 */
export const WORKING_CONVERSATION_COMMANDS: readonly string[] = [
  'clear', 'exit', 'quit', 'q',
]

/**
 * How a command affects the RUNNING conversation:
 * - `gated` — refused by the channel while a turn runs (see
 *   {@link WORKING_GATE_NOTICES});
 * - `conversation` — allowed, but ends the current conversation (process exit);
 * - `inject` — steers a line into the current turn (skills).
 * `undefined` means the normal region: message-like commands, or commands that
 * leave the running conversation alone.
 */
export type WorkingHold = 'gated' | 'conversation' | 'inject'

/**
 * Classify a command by its impact on the running conversation.
 * @param name Bare command name or a completion path (`model deepseek-chat`);
 *   only the first token is classified, so every child of a gated command
 *   (`/model <id>`, `/workspace rename <t>`) inherits the parent's hold.
 * @param skill Whether the entry is a user-invocable skill.
 * @returns The hold, or `undefined` for the normal region.
 */
export function workingHoldOf(name: string, skill?: boolean): WorkingHold | undefined {
  if (skill === true) return 'inject'
  const root = name.replace(/^\//, '').trim().split(/[\t ]+/u)[0]?.toLowerCase() ?? ''
  if (root === '') return undefined
  if (GRAY_ZONE_EXEMPT_COMMANDS.includes(root)) return undefined
  if (Object.hasOwn(WORKING_GATE_NOTICES, root)) return 'gated'
  return WORKING_CONVERSATION_COMMANDS.includes(root) ? 'conversation' : undefined
}

/**
 * Parse a slash-command line into its name and the verbatim input following
 * the name (separator whitespace included) — the same split the DSH command
 * registry uses, so `/plan off` dispatches `plan` with ` off`.
 *
 * @param line - Complete candidate command line.
 * @returns The parsed name and raw input, or `undefined` when the line is
 *   not a command.
 */
export function parseCommandName(
  line: string,
): { name: string; rawInput: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/.exec(line)
  if (match === null) return undefined
  return { name: match[1], rawInput: line.slice(match[0].length) }
}

/**
 * Whether the input names a local command. Local commands must never be sent
 * to the model when typed alone; trailing whitespace is legal.
 * @param input - Candidate command line (slash optional).
 * @param list - Command list to match against; defaults to LOCAL_COMMANDS.
 * @returns True when the trimmed input names a command in `list`.
 */
export function isLocalCommandName(
  input: string,
  list: readonly LocalCommand[] = LOCAL_COMMANDS,
): boolean {
  // Trailing whitespace is legal (Tab completion leaves a space after the
  // name so the user can type arguments).
  const name = input.replace(/^\//, '').trim()
  return HIDDEN_COMMAND_NAMES.has(name) || list.some(command => command.name === name)
}

/**
 * Filter commands by a `/…` input prefix.
 * The prefix is the whole input after the slash, so `/plan off` matches
 * nothing and the overlay stays closed — Enter still dispatches through
 * `parseCommandName`.
 * @param input - Slash-command input; the prefix is the whole text after the slash.
 * @param list - Command list to filter; defaults to LOCAL_COMMANDS.
 * @returns Commands whose name starts with the prefix, in list order.
 */
export function filterCommands(
  input: string,
  list: readonly LocalCommand[] = LOCAL_COMMANDS,
): LocalCommand[] {
  const prefix = input.replace(/^\//, '').trim().toLowerCase()
  return list.filter(command =>
    command.name.toLowerCase().startsWith(prefix),
  )
}

/**
 * Complete an arbitrary slash-command path. Root commands come from the
 * ordinary DSH/TUI catalog; each resolved token asks the caller for its
 * children, so PromptInput never needs feature- or plugin-specific cases.
 */
export function completeCommands(
  input: string,
  roots: readonly LocalCommand[] = LOCAL_COMMANDS,
  children: CommandChildren = () => [],
): CommandCompletion[] {
  if (!input.startsWith('/') || /[\r\n]/u.test(input)) return []
  const body = input.slice(1)
  // Token charset includes `. : /` so provider/model specs (e.g.
  // `deepseek/deepseek-flash`, `openai/gpt-4.1`) survive as ONE token —
  // the /model completion matches its candidates against the whole spec.
  if (!body.split(/[\t ]+/u).every(token => token === '' || isCommandCompletionToken(token))) return []
  const trailingSeparator = /[\t ]$/u.test(body)
  const tokens = body.split(/[\t ]+/u)
  const prefix = trailingSeparator ? '' : (tokens.pop() ?? '')
  if (trailingSeparator && tokens.at(-1) === '') tokens.pop()

  const canonicalPath: string[] = []
  let candidates: readonly CommandCompletionNode[] = roots
  for (const token of tokens) {
    const resolved = resolveCompletionNode(candidates, token)
    if (resolved === undefined) return []
    canonicalPath.push(resolved.name)
    candidates = children(canonicalPath)
  }

  const normalizedPrefix = prefix.toLowerCase()
  return candidates.flatMap(candidate => {
    const completionToken = matchingCompletionToken(candidate, normalizedPrefix)
    if (completionToken === undefined || !isCommandCompletionToken(completionToken)) return []
    const path = [...tokens, completionToken]
    const commandLine = `/${path.join(' ')}`
    return [{
      name: path.join(' '),
      description: candidate.description,
      ...(candidate.descriptions === undefined ? {} : { descriptions: candidate.descriptions }),
      ...(candidate.descriptionKey === undefined ? {} : { descriptionKey: candidate.descriptionKey }),
      ...(candidate.tag === undefined && candidate.aliases?.length
        ? { tag: `aliases: ${candidate.aliases.join(', ')}` }
        : candidate.tag === undefined ? {} : { tag: candidate.tag }),
      replacement: `${commandLine} `,
      commandLine,
    }]
  })
}

function resolveCompletionNode(
  candidates: readonly CommandCompletionNode[],
  token: string,
): CommandCompletionNode | undefined {
  const normalized = token.toLowerCase()
  return candidates.find(candidate =>
    candidate.name.toLowerCase() === normalized
    || candidate.aliases?.some(alias => alias.toLowerCase() === normalized))
}

function matchingCompletionToken(candidate: CommandCompletionNode, prefix: string): string | undefined {
  if (candidate.name.toLowerCase().startsWith(prefix)) return candidate.name
  return candidate.aliases?.find(alias => alias.toLowerCase().startsWith(prefix))
}
