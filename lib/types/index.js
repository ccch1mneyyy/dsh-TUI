import Schema from '@deepseek-ai/schemastery';
export const name = 'cc-tui';
export const inject = ['agents'];
export const Config = Schema.object({
    sessionId: Schema.string().required(false),
    provider: Schema.string().default('deepseek-official'),
    model: Schema.string().default('deepseek-v4-flash'),
    cwd: Schema.string().required(false),
    effort: Schema.string().required(false),
    activity: Schema.boolean().default(true),
    activityFrames: Schema.string().required(false),
    fullscreen: Schema.boolean().default(true),
});
/**
 * Start the interactive TUI front door, delegating to the JSX implementation
 * in `./plugin.tsx` (see its module doc for the full contract).
 * @param ctx - the plugin context.
 * @param config - the validated cc-tui configuration.
 * @returns a promise settling when the TUI teardown completes.
 */
export async function apply(ctx, config) {
    const { apply: ccTuiApply } = await import('./plugin.js');
    return ccTuiApply(ctx, config);
}
//# sourceMappingURL=index.js.map