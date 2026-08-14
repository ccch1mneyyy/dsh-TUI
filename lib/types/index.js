import Schema from '@deepseek-ai/schemastery';
export const name = 'dsh-tui';
export const inject = ['agents'];
export const Config = Schema.object({
    sessionId: Schema.string().required(false),
    // No schema defaults on the route: a `.default()` here would make an
    // unset key indistinguishable from an explicit cordis.yml choice and the
    // persisted `/model` preference could never win (issue #30). The defaults
    // live at the end of the fallback chain in modelRoute.ts instead.
    provider: Schema.string().required(false),
    model: Schema.string().required(false),
    cwd: Schema.string().required(false),
    effort: Schema.string().required(false),
    activity: Schema.boolean().default(true),
    activityFrames: Schema.string().required(false),
    contextBar: Schema.boolean().default(true),
    fullscreen: Schema.boolean().default(false),
    lang: Schema.string().required(false),
    preset: Schema.string().required(false),
});
/**
 * Start the interactive TUI front door, delegating to the JSX implementation
 * in `./plugin.tsx` (see its module doc for the full contract).
 * @param ctx - the plugin context.
 * @param config - the validated dsh-tui configuration.
 * @returns a promise settling when the TUI teardown completes.
 */
export async function apply(ctx, config) {
    const { apply: ccTuiApply } = await import('./plugin.js');
    return ccTuiApply(ctx, config);
}
