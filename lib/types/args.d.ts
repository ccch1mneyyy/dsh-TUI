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
export declare const CC_TUI_USAGE = "Usage: dsh --profile cc-tui [options] [prompt...]\n\nOptions:\n  -c, --continue           resume the last session (from ~/.dsh-cc/resume.txt)\n  -r, --resume <id>        resume a specific persisted session\n      --resume [<id>]      resume a specific session, or the last one when bare\n  -h, --help               show this help\n\nPrompt:\n  anything else joins into the first turn, e.g.:\n    dsh --profile cc-tui \"run the tests\"\n";
/** The cc-tui surface facts parsed from the launcher's inner arguments. */
export interface CcTuiArgs {
    /** Session id requested by `--resume <id>` / `-r <id>`. */
    resumeId?: string;
    /** Resume the last-session marker (`-c`, `--continue`, bare `--resume`). */
    continueLast: boolean;
    /** Positional prompt to submit as the first turn, when any. */
    prompt?: string;
    /** True when `-h` / `--help` was requested. */
    help: boolean;
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
export declare function parseCcTuiArgs(args: readonly string[]): CcTuiArgs;
//# sourceMappingURL=args.d.ts.map