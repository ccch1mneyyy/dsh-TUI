/**
 * Command-line parsing for the cc-tui surface. The dsh CLI hands everything
 * after its own flags (`--profile`, `--patch`, …) to the booted tree verbatim
 * through the optional `cmdlineArgs` service (see @deepseek-ai/dsh-cmdline),
 * so this app owns its flag family instead of the launcher knowing it:
 *   -c / --continue        resume the last session (from ~/.dsh-cc/resume.txt)
 *   --resume <session-id>  resume a specific persisted session
 *   -h / --help            print usage and exit
 *   "<prompt>"             submit the prompt as the first turn
 */

/** Usage text printed for `-h` / `--help`. */
export const CC_TUI_USAGE = `Usage: dsh --profile cc-tui [options] [prompt...]

Options:
  -c, --continue           resume the last session (from ~/.dsh-cc/resume.txt)
  -r, --resume <id>        resume a specific persisted session
      --resume [<id>]      resume a specific session, or the last one when bare
  -h, --help               show this help

Prompt:
  anything else joins into the first turn, e.g.:
    dsh --profile cc-tui "run the tests"
`

/** The cc-tui surface facts parsed from the launcher's inner arguments. */
export interface CcTuiArgs {
  /** Session id requested by `--resume <id>` / `-r <id>`. */
  resumeId?: string
  /** Resume the last-session marker (`-c`, `--continue`, bare `--resume`). */
  continueLast: boolean
  /** Positional prompt to submit as the first turn, when any. */
  prompt?: string
  /** True when `-h` / `--help` was requested. */
  help: boolean
}

/**
 * Parse the invocation's inner arguments. Multiple positional words join with
 * spaces (Claude Code task semantics); `--resume` without a value falls back
 * to the last-session marker, matching the legacy `dsh-cc --resume` wrapper
 * contract. Unknown flags are kept in the prompt verbatim — the TUI has no
 * other flags today (use `--help` to see the supported ones).
 * @param args - the immutable launcher argument snapshot, in argv order.
 * @returns the parsed surface facts.
 */
export function parseCcTuiArgs(args: readonly string[]): CcTuiArgs {
  let resumeId: string | undefined
  let continueLast = false
  let help = false
  const promptParts: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '-c' || arg === '--continue') {
      continueLast = true
    } else if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg === '--resume' || arg === '-r') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) {
        continueLast = true
      } else {
        resumeId = value
        i += 1
      }
    } else if (arg.startsWith('--resume=')) {
      const value = arg.slice('--resume='.length)
      if (value !== '') resumeId = value
      else continueLast = true
    } else {
      promptParts.push(arg)
    }
  }
  const prompt = promptParts.join(' ').trim() || undefined
  return { resumeId, continueLast, prompt, help }
}
