/**
 * Plugin identity as a host namespace — the one grammar every host surface
 * uses to decide whether a plugin id may name what the host files under it:
 * the `<pluginId>:<sub>` side-panel address (and so a `sidePanel.panels`
 * entry that survives a restart) and the `/<pluginId>:<name>` qualified
 * command.
 *
 * It is the union of two grammars, on purpose:
 *
 * - The Community manifest `namespacedId` (`dsh-plugin.json` `id`, schema
 *   dsh-plugin-0.15 `$defs.namespacedId`): lowercase alphanumeric segments
 *   joined by `.` or `-`, with at least one separator — `com.example.echo`,
 *   `dsh-context`. A verified Component id
 *   (`componentIdentityOf(ctx).componentId`) is always one, so admission
 *   alone decides which plugin gets a stable namespace; reverse-DNS ids, the
 *   norm in the spec's fixtures and docs, no longer fall back to a
 *   session-only address.
 * - The legacy single slug `[a-z][a-z0-9_-]*` the host accepted before it
 *   honoured manifest ids (`echo`, `my_plugin`). Every persisted value and
 *   fixture written under it keeps parsing identically.
 *
 * Neither branch admits `:` (the namespace separator), whitespace, uppercase,
 * or a leading, trailing or doubled `.`, so `<pluginId>:<rest>` still splits
 * at its first colon and no value accepted before changes meaning.
 *
 * Keys a plugin chooses for itself — status-field/view keys, theme names,
 * scene ids, settings-section namespaces, renderer types, panel sub-ids and
 * command names — are not identities: the host never derives them from, or
 * checks them against, the Component id, and they keep their own grammars.
 */

/** The manifest `namespacedId`, rewritten so that every input has exactly one
 *  way to match. The schema's own spelling,
 *  `[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+`, lets each `-` either end a
 *  segment or extend one. On input that fails to match, a backtracking engine
 *  tries all of those splits, so the time doubles with every extra `-x`. These
 *  patterns run on what the user types (`/a-a-…-a:X`), so that would freeze
 *  the composer. This form accepts the same strings: the first `.`/`-` opens
 *  the separated part, after which `-` is an ordinary character and `.` must
 *  be followed by an alphanumeric. `verify-plugin-commands` checks it against
 *  the vendored schema by enumeration. */
const MANIFEST_ID = '[a-z][a-z0-9]*[.-][a-z0-9](?:[a-z0-9-]|\\.[a-z0-9])*'
const LEGACY_ID = '[a-z][a-z0-9_-]*'

/** Unanchored, non-capturing source of the namespace grammar, for composing
 *  larger ones (`<pluginId>:<name>`). */
export const PLUGIN_NAMESPACE_SOURCE = `(?:${MANIFEST_ID}|${LEGACY_ID})`

/** A whole value that may serve as a plugin's host namespace. */
export const PLUGIN_NAMESPACE_PATTERN = new RegExp(`^${PLUGIN_NAMESPACE_SOURCE}$`, 'u')

/** Whether `id` may name a plugin's namespace on a host surface. */
export function isPluginNamespace(id: string): boolean {
  return PLUGIN_NAMESPACE_PATTERN.test(id)
}

const MANIFEST_ID_PATTERN = new RegExp(`^${MANIFEST_ID}$`, 'u')

/** Whether `id` matches the manifest `namespacedId` alone (no legacy slug):
 *  the grammar of a Component id and of a declared command id. Linear time,
 *  so it is safe on scopes read from grant files and on typed command names. */
export function isManifestNamespacedId(id: string): boolean {
  return MANIFEST_ID_PATTERN.test(id)
}
