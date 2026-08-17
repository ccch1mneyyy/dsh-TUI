/**
 * Re-export of the `dsh-working-activity` plugin under this package's own
 * name, so the bundle patch layer can mount the working-activity row as
 * `@deepseek-harness-tui/dsh-tui/working-activity` instead of the bare package name.
 *
 * The dsh Loader resolves row names from the *profile* directory
 * (`~/.dsh/profiles/<name>/`): only the profile's direct dependencies are
 * linked into its node_modules. npm's flat layout also hoists transitive
 * dependencies there, but pnpm's isolated layout never does — so the bare
 * `dsh-working-activity` name (a transitive dependency of @deepseek-harness-tui/dsh-tui) fails
 * with ERR_MODULE_NOT_FOUND at boot and the loader disposes the whole app,
 * exiting the TUI before any UI appears (issue #60). Mounting through this
 * subpath keeps resolution anchored at @deepseek-harness-tui/dsh-tui itself — always a direct
 * profile dependency — and from its real location `dsh-working-activity`
 * resolves under every package-manager layout.
 * @module @deepseek-harness-tui/dsh-tui/working-activity
 */
import {
  apply as applyUpstream,
  Config,
  name,
  type Config as WorkingActivityConfig,
} from 'dsh-working-activity'
import { t } from './i18n.js'

export * from 'dsh-working-activity'
export { Config, name }

/** Mount working-activity with narration localized by the live TUI language. */
export function apply(
  ctx: Parameters<typeof applyUpstream>[0],
  config: WorkingActivityConfig = {},
): void {
  applyUpstream(ctx, { ...config, narrate: false })
  if (config.narrate === false) return

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'working-activity:narrate',
      order: 60,
      text: () => t('working-activity-narrate-instruction'),
    })
  })
}
