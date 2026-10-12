/**
 * The in-tree side of the `Backend` contribution family (B-2): one projection
 * from this package's own manifest shape to the public declaration shape.
 *
 * A built-in manifest is a **superset** of `BackendSpec`: it carries in-tree
 * facts (`inTree`, `alwaysAvailable`, `nativeKey`, `vendorPackages`,
 * `backendExport`, and a `label` that may name a host i18n key) that no
 * contribution may declare. Dogfooding therefore means proving the projection:
 * `backendContributionOf()` strips those, expands the label into the literal
 * text the spec requires, and the result must satisfy `validateBackendSpec()` for
 * every built-in. A manifest that grows a field the spec cannot express reds here
 * instead of drifting (scripts/verify-backend-contribution.ts).
 *
 * `backendExport` stays in-tree on purpose: it is the build-time index's
 * mechanism (the registry reads an export name out of a module namespace), not a
 * contribution field. A contribution hands its handler object over at
 * registration, like `assertSceneHandler`'s scene handlers.
 */
import type { BackendManifest } from '../agent/backend-manifest.js'
import { t, type I18nKey } from '../i18n.js'

/** The label text a contribution would declare, or a refusal.
 *
 *  Only an in-tree manifest may carry a host i18n key, and the projection is what
 *  turns one into the literal text the spec requires — so it is also where the rule
 *  has to hold when the projection is called directly: expanding a *plugin's* key
 *  would launder it into the literal `t()` happens to return, i.e. let a contribution
 *  paint itself with this host's own name. `registerBackend` refuses that combination
 *  before projecting; this refuses it again, so the exported projection cannot be used
 *  to do what registration forbids. */
function labelTextOf(manifest: BackendManifest): string {
  if (manifest.label.kind === 'literal') return manifest.label.text
  if (!manifest.inTree) {
    throw new Error(`dsh-tui: backend "${manifest.id}" is not in-tree and may not project a host label key`)
  }
  return t(manifest.label.key as I18nKey)
}

/**
 * Project one manifest onto the public declaration. Pure: the same manifest
 * projects to a deep-equal value every time (no timestamps, no host state), which
 * is what lets the gate compare two projections and diff keys.
 */
export function backendContributionOf(manifest: BackendManifest): Record<string, unknown> {
  return {
    id: manifest.id,
    label: { text: labelTextOf(manifest) },
    shortLabel: manifest.shortLabel,
    ...(manifest.product === undefined ? {} : { product: manifest.product }),
    // Absent declarations project to the empty list: the spec requires both
    // fields, so "I declare nothing" must be sayable and must mean "nothing".
    capabilities: [...(manifest.capabilities ?? [])],
    grants: [...(manifest.grants ?? [])],
    ...(manifest.install === undefined ? {} : { install: { ...manifest.install } }),
    ...(manifest.unloadExport === undefined ? {} : { unloadExport: manifest.unloadExport }),
  }
}
