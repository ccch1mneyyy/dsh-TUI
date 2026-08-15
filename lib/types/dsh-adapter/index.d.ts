/**
 * dsh-tui plugin entry. The TUI implementation lives in `./plugin.tsx` (its
 * render path is JSX); this module owns the plugin surface (`name`/`inject`/
 * `Config`/`apply`) at the canonical `src/index.ts` location and delegates
 * `apply` through a dynamic import so entry-scanning tooling and the Loader
 * resolve a plain `.ts` module.
 * @module @deepseek-harness-tui/dsh-tui
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { SessionModeSpec } from '../sessionModes.js';
export declare const name = "dsh-tui";
export declare const inject: string[];
/**
 * dsh-tui plugin configuration: session attachment, model route, working
 * directory, and display preferences.
 */
export interface Config {
    /** Existing session to attach; a fresh session is created when absent. */
    sessionId?: string;
    /** LLM provider route. The route resolves atomically (issue #67): when
     *  cordis.yml names BOTH `provider` and `model`, that pair wins; otherwise
     *  the `/model` choice persisted in `~/.dsh-tui/model.json` wins whole;
     *  otherwise `agentDefaultModel` supplies the provider-neutral Harness
     *  default. A bare embedder without that service falls back to DeepSeek.
     *  A provider-only pin never half-overrides the persisted choice. */
    provider?: string;
    /** Model override passed to the agent; resolved together with `provider`
     *  as one atomic route (see `provider`). */
    model?: string;
    /** Session working directory. When absent, the git worktree root
     *  containing the invoking directory wins (the invoking directory itself
     *  outside any worktree) — never a bare launch subdirectory (issue #96). */
    cwd?: string;
    /** Absolute local path, file URL, or provider URI resolved before the
     *  initial agent is created. */
    workspace?: string;
    /** Reasoning effort applied to every request, validated against the live
     *  route's adapter levels (an unlisted level is ignored and the adapter
     *  default applies). Wins over the persisted /effort choice; also seeds
     *  the startup status line until the first request header reports the
     *  live value. */
    effort?: string;
    /** Show the live working line derived in-process from base session events. */
    activity?: boolean;
    /** Working-activity indicator preset: `claude`/`moon`/`comet`/`dots`/…
     *  or `random` (see activityFrames.ts). When absent, the `/activity`
     *  choice persisted in `~/.dsh-tui/working-activity.json` wins, then the
     *  `claude` default. */
    activityFrames?: string;
    /** Show the segmented context bar (the band under the input with the
     *  `ctx used/window` readout) in the status footer; off hides that row
     *  while the status/mode lines stay (issue #29). */
    contextBar?: boolean;
    /** Run in the terminal's alternate screen (Claude Code fullscreen layout). */
    fullscreen?: boolean;
    /** UI language: `en` / `zh`. When absent, the `DSH_TUI_LANG` env var wins,
     *  then the `/lang` choice persisted in `~/.dsh-tui/lang.json`, then `zh`. */
    lang?: string;
    /** Agent preset id new sessions compose from (standard/code/minimal/
     *  cordis/… when the roster is mounted). When absent, the `/preset` choice
     *  persisted in `~/.dsh-tui/agent-preset.json` wins, then the roster
     *  default (`standard`). */
    preset?: string;
    /** Shift+Tab session-mode cycle (array order IS the cycle order; index 0
     *  is the unmarked base mode). Each entry bundles any subset of the
     *  `plan`/`sandbox`/`approval` atoms; absent → the built-in
     *  default/plan/full cycle (see sessionModes.ts). */
    modes?: SessionModeSpec[];
}
export declare const Config: Schema<Config>;
/**
 * Start the interactive TUI front door, delegating to the JSX implementation
 * in `./plugin.tsx` (see its module doc for the full contract).
 * @param ctx - the plugin context.
 * @param config - the validated dsh-tui configuration.
 * @returns a promise settling when the TUI teardown completes.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map