import type { Context } from '@deepseek-ai/cordis';
/**
 * Register every `skills/<name>/SKILL.md` shipped in this package. No-op when
 * the composition mounts no skill registry (bare standalone boots); duplicate
 * or invalid entries are skipped so a skill can never take down the TUI boot.
 *
 * @param ctx - the plugin's cordis context
 */
export declare function registerPackagedSkills(ctx: Context): void;
//# sourceMappingURL=packaged-skills.d.ts.map