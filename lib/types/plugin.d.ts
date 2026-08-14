import type { Context } from '@deepseek-ai/cordis';
import { Config } from './index.js';
/**
 * Claude Code style interactive TUI front door for DeepSeek Harness agents.
 *
 * The plugin attaches to (or creates) one agent, renders a chat transcript
 * from the agent's session log and live `session/event` records, and submits
 * user turns through `Agent.followup`. It is a client-driver front door like
 * `dsh-jsonrpc`: the surrounding `cordis.yml` supplies the agent spine, the
 * LLM adapter, and the tool plugins.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
/**
 * Distinguish a user-driven exit from a cordis context teardown (issue #12).
 *
 * Both paths settle the Ink instance's exit promise, but only a user exit
 * (`/exit`, double Ctrl+C, render crash) may leave the process. A teardown —
 * the DSH launcher's boot-time recompose disposes every entry once — must
 * only unmount the UI: the recomposed tree re-runs `apply` and mounts a
 * fresh instance, so exiting here would kill the process mid-recompose
 * (the "flash back to bash with no error" symptom).
 *
 * `markTeardown` must run before the unmount that settles the exit promise
 * (the settle reaches `handleExit` through a microtask, so a same-tick flag
 * is always observed). Exported for scripts/verify-teardown-exit.tsx.
 */
export declare function createExitFunnel(deps: {
    onUserExit: (error?: unknown) => void;
}): {
    handleExit: (error?: unknown) => void;
    markTeardown: () => void;
};
//# sourceMappingURL=plugin.d.ts.map