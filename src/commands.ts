/**
 * Local slash commands for the dsh-tui TUI. Claude Code's command system is
 * deeply wired into its engine; dsh-tui ships a small built-in set with the
 * same `/name — description` suggestion chrome, and merges plugin-registered
 * commands (plan/goal/…) from the DSH command registry (`dsh-commands`) —
 * `runCommand` in the Chat screen dispatches either kind, with the registry
 * handler winning for names both sides declare.
 */

import { getLang, tOr } from './i18n.js'

export type LocalizedDescriptions = Readonly<Partial<Record<'zh' | 'en', string>>>

export interface LocalCommand {
  /** The command name without the slash, e.g. `clear`. */
  name: string
  /**
   * One-line description shown in the suggestion overlay — the English text
   * and the fallback for languages without a `cmd-desc-<name>` dict entry
   * (see {@link localizedDescription}).
   */
  description: string
  /** Provider-owned translations selected with the active TUI language. */
  descriptions?: LocalizedDescriptions
  /** Optional bracket tag shown between name and description. */
  tag?: string
  /** True when a DSH plugin registered this command (not built in). */
  external?: boolean
  /**
   * True when the entry is a user-invocable skill discovered by the DSH
   * skill registry (issue #86). Skill entries are completion-only: dispatch
   * falls through to the model as plain text, where dsh-tool-skill's
   * pre-step hook injects the skill body — the same path a hand-typed
   * `/skill-name` takes. The help menu hides them (chrome commands only).
   */
  skill?: boolean
}

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

/** A concrete completion row, including the text inserted by Tab/Enter. */
export interface CommandCompletion extends LocalCommand {
  replacement: string
  commandLine: string
  descriptionKey?: string
}

export type CommandChildren = (canonicalPath: readonly string[]) => readonly CommandCompletionNode[]

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
  { name: 'rename', description: 'Rename the current session' },
  { name: 'rewind', description: 'Open the session tree', tag: 'alias of /tree' },
  { name: 'tree', description: 'Show the session family tree — rewind to any point' },
  { name: 'export', description: 'Export the conversation to a markdown file' },
  { name: 'btw', description: 'Ask a quick side question without interrupting the conversation' },
  { name: 'trace', description: 'Show the session event trace timeline' },
  // Session / environment
  { name: 'status', description: 'Show session status' },
  { name: 'cost', description: 'Show session token usage' },
  { name: 'config', description: 'Show the dsh-tui configuration source' },
  { name: 'settings', description: 'View and edit plugin settings' },
  { name: 'doctor', description: 'Run environment checks' },
  { name: 'init', description: 'Create AGENTS.md in the working directory' },
  { name: 'agents', description: 'Show subagents of this session' },
  // Model / display
  { name: 'activity', description: 'Switch the working-activity indicator preset' },
  { name: 'preset', description: 'Switch the agent preset (including Liangshen mode)' },
  { name: 'theme', description: 'Switch the color theme (auto, built-in or custom)' },
  { name: 'lang', description: 'Switch the UI language (en / zh)' },
  { name: 'model', description: 'Show the active model' },
  { name: 'effort', description: 'Adjust the reasoning effort (slider)' },
  { name: 'thinking', description: 'Toggle extended thinking display' },
  { name: 'tokens', description: 'Show session token usage' },
  // Account / policy
  { name: 'provider', description: 'Add an LLM provider (catalog or custom API endpoint)' },
  { name: 'login', description: 'Show API credential status' },
  { name: 'logout', description: 'Clear the API credential' },
  { name: 'permissions', description: 'Show permission policy status' },
  { name: 'add-dir', description: 'Show the filesystem policy scope' },
  { name: 'hooks', description: 'Show hooks status' },
  { name: 'mcp', description: 'Show MCP status' },
  { name: 'skills', description: 'List available skills' },
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
  { name: 'workspace', description: 'Resume, rename, or open a workspace' },
  // Help / exit
  { name: 'help', description: 'Show shortcuts and commands' },
  { name: 'exit', description: 'Exit dsh-tui' },
  { name: 'quit', description: 'Exit dsh-tui', tag: 'alias of /exit' },
  { name: 'q', description: 'Exit dsh-tui', tag: 'alias of /exit' },
]

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
  if (!/^[a-z0-9_-]*(?:[\t ]+[a-z0-9_-]*)*$/iu.test(body)) return []
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
    if (completionToken === undefined) return []
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
