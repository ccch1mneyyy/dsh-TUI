/**
 * Whether the running package lets the TUI write to its plugin profile.
 *
 * The Nix package has two shapes: the default managed profile links
 * `node_modules` at the immutable store runtime, while
 * `allowUserPlugins = true` turns it into a writable overlay. The launcher
 * exports {@link ALLOW_USER_PLUGINS_ENV}, so the screen and completion tree
 * can hide the write forms (`install`, `update`, `remove`) instead of offering
 * an action the profile will refuse.
 *
 * npm/source launches leave the variable unset and keep the writable behavior.
 */
export const ALLOW_USER_PLUGINS_ENV = 'DSH_TUI_ALLOW_USER_PLUGINS'

export function userPluginsAllowed(): boolean {
  return process.env[ALLOW_USER_PLUGINS_ENV] !== '0'
}

/** The `/plugin` forms that need a writable profile. */
export type GatedPluginWrite = 'install' | 'update' | 'remove'

/** The write form in an argument string, or `undefined` for every other form. */
export function gatedPluginWrite(args: string): GatedPluginWrite | undefined {
  const first = args.trim().split(/\s+/)[0]
  return first === 'install' || first === 'update' || first === 'remove' ? first : undefined
}
