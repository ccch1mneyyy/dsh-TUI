/**
 * The host's profile plugin manager (`ctx.pluginManager`), as this package
 * consumes it.
 *
 * The service is host-provided: the dsh CLI ships
 * `@deepseek-ai/dsh-plugin-manager` and the `plugin-manager` row dsh-base
 * patches in mounts it for `dsh --profile` boots. A profile has no copy of the
 * package, so the service is optional here — every consumer soft-probes it and
 * degrades to a readable diagnostic instead of failing (issue #183: consumers
 * never take it through `inject`).
 *
 * {@link PluginManagerView} is the surface this package uses, declared
 * structurally so a regression can hand in a fake. The record types come from
 * the host package's own published declarations, so a field rename on the
 * upstream line fails the build rather than the screen.
 *
 * Types only: a profile has no copy of the package at run time (the dsh CLI
 * ships it), so importing a value from it — `parseInstallSpec`, say — would
 * fail on exactly the machines this code runs on. Anything this package needs
 * to compute (a spec's name, a version) it takes from `inspect()` instead.
 *
 * The view covers the write half as well (install / cancel / enable / disable /
 * remove / version exemptions), because both write flows reach the same probe:
 * a second manager lookup could only drift from this one.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  BundleInfo,
  ChangeResult,
  InspectOptions,
  InstallBundleOptions,
  ListVersionsOptions,
  PluginEntryId,
  PluginInfo,
  PluginInstallCancellation,
  PluginInstallLogChunk,
  PluginInstallProgress,
  PluginInstallRequestId,
  PluginRegistries,
  PluginSpecInspection,
  PluginUpdateProgress,
  PluginUpdateResult,
  PluginVersionList,
  UpdateBundleOptions,
} from '@deepseek-ai/dsh-plugin-manager/types'
import { getLang, type Lang } from '../i18n.js'
import { isCompositionOwned } from './plugin-declaration.js'

/** The host service operations this package consumes. */
export interface PluginManagerView {
  /** Every installed or installation-provided bundle, in profile layer order. */
  listBundles(): Promise<BundleInfo[]>
  /** Every running-profile loader entry and its persistent control availability. */
  listPlugins(): Promise<PluginInfo[]>
  /** The registries an installation asks, in order. */
  registries(): Promise<PluginRegistries>
  /**
   * What a spec names, read before installing it. The host bounds the lookup
   * with its own timeout; nothing here passes an `AbortSignal`, so a cancel
   * during the read stops the flow rather than the request (there is nothing to
   * install yet either way).
   */
  inspect(spec: string, options?: InspectOptions): Promise<PluginSpecInspection>
  /**
   * Install one spec into the profile. The call owns the whole run: it resolves
   * only once pnpm (or the git check) has finished and the profile was restored
   * or changed, so the returned promise IS the result — `waitForInstall` is the
   * recovery path for a caller that lost it, not the way to collect it.
   */
  installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult>
  /** Stop an installation this manager owns and wait until its files are back. */
  cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation>
  /**
   * Select or drop one bundle's composition layer, keeping its installed
   * dependencies. Dropping a layer the manager itself lives in is refused by
   * the host (`management-required`), and selecting one re-checks the running
   * version (`incompatible-version`); both arrive in-band as
   * `application: 'failed'`.
   */
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>
  /**
   * Persist one loader entry's desired enablement, by the `entryId`
   * `listPlugins()` reports. An entry the host cannot address
   * (`readOnlyReason`) is refused before anything is written.
   */
  setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult>
  /**
   * Uninstall one bundle: drop its layer and remove it from the profile's
   * dependencies. The host refuses a bundle it did not install
   * (`not-removable`), one whose rows are live on a profile without hot reload
   * (`stop-profile`), and one whose contributions are still running
   * (`bundle-in-use`). Restores `package.json` and the lockfile on failure.
   */
  removeBundle(name: string): Promise<ChangeResult>
  /**
   * Newer published versions of one installed registry bundle, newest first.
   * The service refuses a bundle it did not resolve from a registry, and marks
   * every version that is not a bundle, is deprecated, or rejects the running
   * DSH line — the update flow filters those before choosing a target.
   */
  listVersions(name: string, options?: ListVersionsOptions): Promise<PluginVersionList>
  /**
   * Replace one installed registry bundle with an exact newer version. The
   * service checks the target, keeps the bundle's selection, and restores the
   * removed version if the target fails or is cancelled.
   */
  updateBundle(name: string, version: string, options?: UpdateBundleOptions): Promise<PluginUpdateResult>
  /** The exact-version exemptions the profile's compatibility file carries. */
  listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] }
  /** Grant or revoke one `package@version` × runtime exemption. */
  setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk?: boolean): Promise<ChangeResult>
}

/**
 * Soft-probe the profile plugin manager. `undefined` when the row is not
 * mounted (a non-DSH kernel composition, an older host, a bare Cordis root):
 * the caller reports what it cannot do instead of throwing.
 */
export function pluginManagerOf(ctx: Context): PluginManagerView | undefined {
  const manager = ctx.get('pluginManager', false)
  if (manager === undefined || manager === null) return undefined
  return manager as PluginManagerView
}

let installRequestSeq = 0

/**
 * A fresh id for one installation. `PluginInstallRequestId` is a branded string
 * and no published subpath exports a constructor for the brand, so this is the
 * one place that asserts one into existence; the counter is per process, which
 * is all an id has to be for the service to correlate a cancel or a recovery
 * with the run that asked.
 */
export function newInstallRequestId(): PluginInstallRequestId {
  installRequestSeq += 1
  return `dsh-tui-${process.pid}-${installRequestSeq}` as PluginInstallRequestId
}

/** The manager's install events, narrowed to the install that asked for them. */
export interface PluginInstallEvents {
  /** One installation's pnpm output, chunk by chunk. */
  onLog(requestId: PluginInstallRequestId, listener: (chunk: PluginInstallLogChunk) => void): () => void
  /** One installation's phase changes. */
  onState(requestId: PluginInstallRequestId, listener: (progress: PluginInstallProgress) => void): () => void
}

/**
 * Subscribe to the manager's install events for one request. The events are
 * emitted on the shared context, so a profile running two installations would
 * otherwise render both in one report; the request id is the only thing that
 * tells them apart. Chunks the service leaves unidentified (its git connection
 * check runs without a request) are not one installation's output and are
 * dropped with the rest.
 */
export function pluginInstallEvents(ctx: Context): PluginInstallEvents {
  return {
    onLog: (requestId, listener) => ctx.on('plugin-manager/install-log', (chunk: PluginInstallLogChunk) => {
      if (chunk.requestId === requestId) listener(chunk)
    }),
    onState: (requestId, listener) => ctx.on('plugin-manager/install-state', (progress: PluginInstallProgress) => {
      if (progress.requestId === requestId) listener(progress)
    }),
  }
}

/** The manager's update-phase events. */
export interface PluginUpdateEvents {
  onState(listener: (progress: PluginUpdateProgress) => void): () => void
}

export function pluginUpdateEvents(ctx: Context): PluginUpdateEvents {
  return {
    onState: listener => ctx.on('plugin-manager/update-state', listener),
  }
}

/**
 * The bundles a person added to this profile: the ones its own dependencies
 * hold (`installed`), minus the composition itself. The installation-supplied
 * bundles and this application's own rows are not plugins anybody installed,
 * so the short list leaves them out — a clean profile reports "nothing added"
 * instead of listing the launcher's base. One predicate, so the list and the
 * `/plugin info` completion cannot drift apart.
 */
export function extraBundles(bundles: readonly BundleInfo[]): BundleInfo[] {
  return bundles.filter(bundle => bundle.installed && !isCompositionOwned(bundle.name))
}

/** The host's localized display text: a literal, or translations by language id. */
export type LocalizedPluginText = string | { readonly en: string; readonly [locale: string]: string }

/**
 * What a bundle or loader entry calls itself, in the reader's language. The
 * entry stays `unknown` on purpose: `meta` arrived after the 0.1.5 line, so the
 * alpha.2 compat line's own declarations may not carry the field at all
 * (`verify:alpha-source` type-checks this package against them), and reading it
 * structurally is what keeps one reader compiling on every line. An older host
 * that answers without it takes the caller's fallback — the package name, the
 * module specifier — and one reader means the report's rows and the completion
 * popup cannot disagree about a title.
 */
export function localizedPluginText(entry: unknown, fallback: string): string {
  return pluginTitleIn(entry, getLang(), fallback)
}

/**
 * {@link localizedPluginText} pinned to one named language — the completion
 * catalog caches every shipped language at once, so it cannot ask the active
 * one and then serve a stale answer after `/lang`.
 */
export function pluginTitleIn(entry: unknown, lang: Lang, fallback: string): string {
  const meta = (entry as { readonly meta?: { readonly title?: LocalizedPluginText } } | undefined)?.meta
  const title = meta?.title
  if (title === undefined) return fallback
  if (typeof title === 'string') return title
  return title[lang] ?? title.en ?? fallback
}
