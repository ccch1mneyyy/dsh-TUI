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
 *
 * `publish` is forced off at this mount point: the TUI derives its working
 * line in-process (issue #143) and never wants activity/status snapshots in
 * the session log — they make the shared JSONL unreadable for Web (issue
 * #153). A stale global-launcher patch (≤0.6.x, resolved anchor-first by
 * the dsh CLI) still carries `publish: true` on this row, which re-enabled
 * the pollution even on an up-to-date profile install. A local `apply`
 * shadows the star re-export, so the row config can never turn publishing
 * back on; a log-replaying consumer mounts the bare package instead.
 * @module @deepseek-harness-tui/dsh-tui/working-activity
 */
import { apply as mountedApply } from 'dsh-working-activity'

export * from 'dsh-working-activity'

// Types derive from the mounted plugin's own signature: importing
// @deepseek-ai/cordis here would violate the adapter boundary gate.
type MountedContext = Parameters<typeof mountedApply>[0]

export const apply = (ctx: MountedContext, config: Parameters<typeof mountedApply>[1]): void => {
  mountedApply(ctx, { ...config, publish: false })
}
