/**
 * Local slash commands for the dsh-cc TUI. Claude Code's command system is
 * deeply wired into its engine; cc-tui ships a small built-in set with the
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

export const LOCAL_COMMANDS: LocalCommand[] = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'compact', description: 'Compact the conversation history' },
  { name: 'help', description: 'Show shortcuts and commands' },
  { name: 'model', description: 'Show the active model' },
  { name: 'thinking', description: 'Toggle extended thinking display' },
  { name: 'tokens', description: 'Show session token usage' },
  { name: 'resume', description: 'Resume a previous session' },
  { name: 'exit', description: 'Exit dsh-cc' },
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
  return { name: match[1]!, rawInput: line.slice(match[0].length) }
}

/** Commands that must not be sent to the model when typed alone. */
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
