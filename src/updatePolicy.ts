/**
 * Update policy for packaged builds.
 *
 * The Nix package owns both the TUI and the DSH engine: they live in one
 * immutable store path and are upgraded together by rebuilding the flake.
 * Letting the app update itself would replace the pinned runtime with a
 * mutable npm install and desynchronize that pair, so the Nix launcher sets
 * {@link UPDATES_DISABLED_ENV} before the entry loads.
 *
 * Every self-update surface (slash command, startup notice, launchpad chip,
 * CLI `update` subcommand) reads this one predicate. Ordinary npm/source
 * launches leave the variable unset and keep the upstream behaviour.
 */
export const UPDATES_DISABLED_ENV = 'DSH_TUI_UPDATE_DISABLED'

/** A module loaded from the immutable store belongs to a Nix build even when
 *  the user reaches it through `dsh --profile dsh-tui` instead of the
 *  launcher (the launcher's env marker only covers its own entry). */
const NIX_STORE_URL_PREFIX = 'file:///nix/store/'

export function updatesDisabled(): boolean {
  return process.env[UPDATES_DISABLED_ENV] === '1' || import.meta.url.startsWith(NIX_STORE_URL_PREFIX)
}
