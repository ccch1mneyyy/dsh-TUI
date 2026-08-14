/**
 * Local slash commands for the dsh-tui TUI. Claude Code's command system is
 * deeply wired into its engine; dsh-tui ships a small built-in set with the
 * same `/name — description` suggestion chrome, and merges plugin-registered
 * commands (plan/goal/…) from the DSH command registry (`dsh-commands`) —
 * `runCommand` in the Chat screen dispatches either kind, with the registry
 * handler winning for names both sides declare.
 */

export interface LocalCommand {
  /** The command name without the slash, e.g. `clear`. */
  name: string
  /** One-line description shown in the suggestion overlay. */
  description: string
  /** Optional bracket tag shown between name and description. */
  tag?: string
  /** True when a DSH plugin registered this command (not built in). */
  external?: boolean
}

/**
 * The built-in slash commands (name + description pairs). Plugin-registered
 * commands merge in at runtime; locals win on name collisions.
 */
export const LOCAL_COMMANDS: LocalCommand[] = [
  // Conversation
  { name: 'new', description: 'Start a new conversation' },
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'compact', description: 'Compact the conversation history' },
  { name: 'resume', description: 'Resume a previous session' },
  { name: 'rewind', description: 'Rewind the conversation to a previous message' },
  { name: 'export', description: 'Export the conversation to a markdown file' },
  // Session / environment
  { name: 'status', description: 'Show session status' },
  { name: 'cost', description: 'Show session token usage' },
  { name: 'config', description: 'Show the dsh-tui configuration source' },
  { name: 'doctor', description: 'Run environment checks' },
  { name: 'init', description: 'Create AGENTS.md in the working directory' },
  { name: 'agents', description: 'Show subagents of this session' },
  // Model / display
  { name: 'activity', description: 'Switch the working-activity indicator preset' },
  { name: 'preset', description: 'Switch the agent preset (standard/code/minimal/cordis)' },
  { name: 'theme', description: 'Switch the color theme (built-in or custom)' },
  { name: 'lang', description: 'Switch the UI language (en / zh)' },
  { name: 'model', description: 'Show the active model' },
  { name: 'thinking', description: 'Toggle extended thinking display' },
  { name: 'tokens', description: 'Show session token usage' },
  // Account / policy
  { name: 'login', description: 'Show API credential status' },
  { name: 'logout', description: 'Clear the API credential' },
  { name: 'permissions', description: 'Show permission policy status' },
  { name: 'add-dir', description: 'Show the filesystem policy scope' },
  { name: 'hooks', description: 'Show hooks status' },
  { name: 'mcp', description: 'Show MCP status' },
  { name: 'memory', description: 'Show memory status' },
  { name: 'update', description: 'Update dsh-tui and restart' },
  // Built-in skills (CC's skill commands, driven through DSH skills)
  { name: 'audit', description: 'Run a comprehensive code audit on this project' },
  { name: 'bug', description: 'Capture a bug report' },
  { name: 'practice', description: 'Practice programming with dsh-tui' },
  { name: 'review', description: 'Run a comprehensive code review on this project' },
  { name: 'pr_comments', description: 'Review pull request comments' },
  { name: 'release-notes', description: 'Generate release notes' },
  { name: 'vuln-check', description: 'Run a security vulnerability check' },
  // Misc / not applicable on this leaf
  { name: 'vim', description: 'Toggle vim mode' },
  { name: 'terminal-setup', description: 'Show terminal setup instructions' },
  { name: 'connect', description: 'Connect to a remote machine' },
  // Help / exit
  { name: 'help', description: 'Show shortcuts and commands' },
  { name: 'exit', description: 'Exit dsh-tui' },
]

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
  return list.some(command => command.name === name)
}

/**
 * Filter commands by a `/…` input prefix (matches the CC overlay behavior).
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
