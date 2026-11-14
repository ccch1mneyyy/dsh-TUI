/**
 * Gate 2: what this application refuses to change in its own profile, and why
 * (Stage C-5).
 *
 * The host's plugin manager protects a hardcoded list of first-party module
 * names, plus the bundle that inserted the manager itself. This package is
 * neither: its rows are named `@deepseek-harness-tui/dsh-tui` and friends, so
 * the host reports them as perfectly addressable and will switch them off on
 * request — `/plugin disable dsh-tui` would take the running TUI layer down
 * mid-session. The manager's own `stop-profile` guard does not stand in the
 * way either: it only throws when no HMR service is mounted, and this profile
 * runs `patchReload: live`. So this predicate is the only line that holds.
 *
 * Three properties are deliberate:
 *
 * - **It is pure.** No `ctx`, no service call, no file read — the caller reads
 *   one `listBundles()` / `listPlugins()` snapshot and hands the record in. A
 *   guard that had to ask the world would be as fallible as the world.
 * - **It never reads HMR.** The refusal has to hold on the `live` path (the one
 *   the host's own guard misses), so the question "is hot reload on?" must not
 *   be able to change the answer. `verify-plugin-guard.ts` asserts this on the
 *   source text, because a promise in a comment is not a fact.
 * - **Refusal is not greying out.** A refusal carries the rule it broke, and
 *   the caller prints it as a reason line and makes no service call at all
 *   (the `plugins-manage-refused-*` family).
 *
 * What gate 2 does *not* do: authorize. An `allowed` verdict means this
 * predicate has no objection, not that the action proceeds without asking —
 * confirmation is the flow's decision: every enable or removal asks, as does
 * disabling a host-layer row.
 */
import { COMPOSITION_PACKAGE, COMPOSITION_PACKAGES } from './plugin-declaration.js'

/**
 * The host layer this application's composition is stacked on: it provides the
 * services the TUI cannot start without, and it carries the manager row that
 * owns every patch write. Removing or disabling it is the indirect form of
 * self-destruction.
 */
export const HOST_BUNDLE = '@deepseek-ai/dsh-base'

/**
 * The bundles gate 2 refuses to `remove` / `disable`: the application's public
 * entry and private runtime, then the host layer it runs on — display order.
 *
 * Application identities are imported rather than spelled again. The list stays short on
 * purpose: it is the *core*, and every host layer row stays a legitimate thing
 * for a person to switch off (`/plugin disable tool-web` is a supported form).
 * `verify-plugin-guard.ts` pins the exact length, so widening the core is a
 * deliberate change somebody has to explain.
 */
export const CORE_BUNDLES = [...COMPOSITION_PACKAGES, HOST_BUNDLE] as const

/**
 * The module-name prefix of the rows this application itself provides. A row
 * whose module is this package, or a subpath of it, is what draws the UI a
 * person is looking at; disabling it from that UI is the row-level suicide.
 *
 * This is half of the row rule, and the smaller half. Measured on a real
 * profile (2026-10-14, `dsh --profile dsh-tui --dump-config`): this bundle's
 * patch inserts **17** rows, and **8** of them load a first-party
 * `@deepseek-ai/*` module — the composition's own storage, workspace,
 * code-runtime, agent-presets, cordis-host-runner and webserver seams. Only one
 * of those eight (`@deepseek-ai/dsh-host-webserver`) is on the host's own
 * protected list, and it is the only reason the host reports this bundle as
 * locked at all. The other seven rows are reported as perfectly addressable, so
 * a module-name rule cannot see them: {@link PluginGuardTarget} carries
 * `ownRow` for those, read from the same snapshot as everything else.
 */
export const CORE_ROW_PREFIX = COMPOSITION_PACKAGE

/** The three lifecycle actions a person can ask for. */
export type PluginGuardAction = 'remove' | 'enable' | 'disable'

/**
 * One target, reduced to what the decision reads. Both shapes are structural:
 * the caller passes what the host reported (a `BundleInfo` / `PluginInfo`),
 * and a regression can pass a literal.
 */
export type PluginGuardTarget =
  | {
    readonly kind: 'bundle'
    readonly name: string
    readonly removable: boolean
    /**
     * The host already locked this bundle (`management-required` /
     * unaddressable). Present means the host refuses both directions, so this
     * predicate refuses without naming a rule of its own.
     */
    readonly readOnlyReason?: string | undefined
  }
  | {
    readonly kind: 'row'
    readonly entryId: string
    readonly moduleName: string
    /** The patch row this entry is addressable as; absent means unaddressable. */
    readonly patchId?: string | undefined
    /**
     * Whether this application's own patch inserts the row: `patchId` is one of
     * the rows either application bundle reports. The caller reads it off the same
     * snapshot it resolved the target from, because a row of ours may load a
     * first-party module and so carry no name this predicate could recognize —
     * see {@link CORE_ROW_PREFIX}. Absent means "not known to be ours", which
     * leaves the module-name rule as the only one that applies.
     */
    readonly ownRow?: boolean | undefined
    /** As on a bundle: the host's own lock, reported rather than re-derived. */
    readonly readOnlyReason?: string | undefined
  }

/**
 * Why gate 2 refused. Every value is a statement about *this* application, so
 * the caller can turn it into a reason line and a repair hint.
 */
export type PluginGuardRefusal =
  /** The host locked the target; neither direction is ours to take. */
  | 'service-locked'
  /** The target bundle provides this application. */
  | 'app-bundle'
  /** The target bundle is the host layer this application is stacked on. */
  | 'host-bundle'
  /** The host reports the bundle as not removable (installed by the launcher). */
  | 'not-removable'
  /** A single row is never removed on its own; it goes with its bundle. */
  | 'row-not-removable'
  /**
   * The row is this application's own: either its module is this package's, or
   * this application's patch inserts it. Disabling it takes part of the
   * interface down with it.
   */
  | 'app-row'

export type PluginGuardVerdict =
  | { readonly kind: 'refused'; readonly reason: PluginGuardRefusal }
  | { readonly kind: 'allowed' }

/** Whether a module name is this package's, or a subpath of it. */
function isCoreRowModule(moduleName: string): boolean {
  return moduleName === CORE_ROW_PREFIX || moduleName.startsWith(`${CORE_ROW_PREFIX}/`)
}

/**
 * Decide one action against one target. Refusals are checked before anything
 * else can allow: the first matching rule wins, and the shape of the function
 * is fail-closed throughout — an unrecognized target is a bundle only when it
 * says so, and every branch that is not an explicit refusal is not an
 * authorization either.
 *
 * `enable` is deliberately absent from the core rules. Gate 2 stops a person
 * from killing the application they are using; switching a composition layer
 * or a row back on is the *repair* for having killed it — refusing that would
 * seal off the only in-UI way back from a profile somebody edited by hand.
 * The host's own lock is the exception that proves the rule: it refuses both
 * directions there, and this predicate reports that as `service-locked`
 * instead of pretending it could go either way.
 */
export function pluginGuardVerdict(target: PluginGuardTarget, action: PluginGuardAction): PluginGuardVerdict {
  if (target.readOnlyReason !== undefined) return { kind: 'refused', reason: 'service-locked' }
  if (target.kind === 'bundle') {
    if (action !== 'enable') {
      if (COMPOSITION_PACKAGES.some(name => name === target.name)) return { kind: 'refused', reason: 'app-bundle' }
      if (target.name === HOST_BUNDLE) return { kind: 'refused', reason: 'host-bundle' }
    }
    if (action === 'remove' && !target.removable) return { kind: 'refused', reason: 'not-removable' }
    return { kind: 'allowed' }
  }
  if (action === 'remove') return { kind: 'refused', reason: 'row-not-removable' }
  if (action === 'disable' && (target.ownRow === true || isCoreRowModule(target.moduleName))) {
    return { kind: 'refused', reason: 'app-row' }
  }
  return { kind: 'allowed' }
}
