import type { Context } from 'cordis';
import Schema from 'schemastery';
/**
 * Claude Code style interactive TUI front door for DeepSeek Harness agents.
 *
 * The plugin attaches to (or creates) one agent, renders a chat transcript
 * from the agent's session log and live `session/event` records, and submits
 * user turns through `Agent.followup`. It is a client-driver front door like
 * `dsh-jsonrpc`: the surrounding `cordis.yml` supplies the agent spine, the
 * LLM adapter, and the tool plugins.
 */
export declare const name = "cc-tui";
export declare const inject: string[];
export interface Config {
    /** Existing session to attach; a fresh session is created when absent. */
    sessionId?: string;
    /** LLM provider route; the harness `deepseek-official` route by default. */
    provider?: string;
    /** Model override passed to the agent (adapter default when absent). */
    model?: string;
    /** Session working directory; defaults to the invoking directory. */
    cwd?: string;
    /** Configured reasoning effort, displayed from startup (the live value
     *  from request headers replaces it once the first turn runs). */
    effort?: string;
    /** Show the dsh-working-activity live working line on the status bar
     *  (consumes its log-only `activity/status` events; off hides it). */
    activity?: boolean;
    /** Working-activity indicator preset: `claude`/`moon`/`comet`/`dots`/…
     *  or `random` (see activityFrames.ts). */
    activityFrames?: string;
    /** Run in the terminal's alternate screen (Claude Code fullscreen layout). */
    fullscreen?: boolean;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map