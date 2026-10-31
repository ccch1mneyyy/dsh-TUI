/**
 * Admits third-party plugin activations via their package-root
 * `dsh-plugin.json` (`getHostAdmission()`), binding the identity to the
 * plugin's own fiber. A refused activation keeps running (an
 * unload would rewrite the user's profile) but stays outside every mediated
 * capability. Listeners and the retry timer ride the caller's `ctx.effect`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { markAdmissionBoundary, ownComponentIdentityOf } from './component-identity.js'
import { compositionRoot, parentFiberOf, withHostRootCapability } from './host-access.js'
import { getHostAdmission, type TuiPluginHost } from './plugin-host.js'
import { logForDebugging } from '../utils/debug.js'

/** Retry window for an admission not decidable yet (a required contract or
 *  the host itself arrives later). Bounded so a host that never arrives
 *  (issue #183) settles as `refused` with a diagnostic instead of ticking forever. */
const RETRY_INTERVAL_MS = 200
const RETRY_ATTEMPTS = 100

/**
 * The Loader's own ESM resolver (`cordis-plugin-loader`'s Node-internals
 * adapter, or `undefined` when this runtime exposes no internals). Admission
 * must resolve the entry through it: the Loader's active export conditions and
 * custom hooks decide which module actually executes, and that module's
 * manifest owns the identity and permissions.
 *
 * `import` is the same door `EntryTree.import()` uses — the module the Loader
 * would execute for that specifier, out of the Loader's own cache. It is
 * optional because the shape is classified by `resolveSync` alone; a
 * resolution that cannot be executed is still a resolution, and the D-1
 * assembly falls back to importing the URL the resolver returned.
 */
export type ActiveResolver =
  | { readonly version: 'v1'
      resolveSync(specifier: string, parentURL: string, attributes: object): { readonly url: string }
      import?(specifier: string, parentURL: string, attributes: object): Promise<unknown> }
  | { readonly version: 'v2'
      resolveSync(parentURL: string, request: { specifier: string; attributes: object }): { readonly url: string }
      import?(specifier: string, parentURL: string, attributes: object): Promise<unknown> }

/** The Cordis loader entry that owns a fiber (`cordis-plugin-loader`). */
interface LoaderEntryLike {
  readonly options?: { readonly name?: string }
  readonly ctx?: { readonly baseUrl?: string }
  readonly fiber?: { readonly state?: number } | null
}

/** The part of the Loader's surface this package reads. Exported (D-1) because
 *  the backend assembly resolves a bundle's entry through the same resolver. */
export interface LoaderLike {
  readonly internal?: ActiveResolver
  locate?(fiber?: object): string | undefined
  resolve?(id: string): LoaderEntryLike | undefined
  entries?(): Iterable<LoaderEntryLike>
}

interface FiberLike {
  readonly state?: number
  readonly ctx?: Context
}

type ActivationState = 'pending' | 'admitted' | 'skipped' | 'refused'

/**
 * Watch `ctx`'s composition and admit every third-party activation that
 * carries a package-root `dsh-plugin.json`. The listeners and the retry
 * timer are bound to `ctx`'s own teardown.
 */
export function armAdmissionLoader(
  ctx: Context,
  options: {
    host?: () => TuiPluginHost | undefined
    /** @internal retry bound for the regression; production uses RETRY_ATTEMPTS. */
    retryAttempts?: number
  } = {},
): void {
  const root = compositionRoot(ctx)
  const retryAttempts = options.retryAttempts ?? RETRY_ATTEMPTS
  const loader = compositionLoader(root)
  if (loader === undefined) {
    logForDebugging('dsh-tui: admission loader not armed — this composition has no cordis loader')
    return
  }

  const state = new WeakMap<object, ActivationState>()
  const manifests = new WeakMap<object, string | undefined>()
  const attempts = new WeakMap<object, number>()
  const pending = new Set<object>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const host = options.host ?? ((): TuiPluginHost | undefined => ctx.get('tuiPluginHost', false) as TuiPluginHost | undefined)

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const settle = (fiber: object, next: ActivationState): void => {
    state.set(fiber, next)
    pending.delete(fiber)
  }

  const attempt = (fiber: FiberLike): void => {
    const pluginCtx = fiber.ctx
    // LOADING (1), not ACTIVE (2): Cordis emits it before the row's callback
    // runs, so the plugin has its identity while its `apply` registers panels.
    // ACTIVE is the catch-up path for rows that activated before arming.
    if (!Context.is(pluginCtx) || (fiber.state !== 1 && fiber.state !== 2)) {
      settle(fiber, 'skipped')
      return
    }
    // Already admitted (the row called admission itself, or a previous pass
    // of this loader did): the manifest identity is host-owned and single.
    // Its OWN binding only — an identity it merely inherits from an admitted
    // ancestor must not stop a nested plugin's own manifest from admitting.
    if (ownComponentIdentityOf(pluginCtx) !== undefined) {
      settle(fiber, 'admitted')
      return
    }
    // The manifest lookup is one synchronous walk per activation, cached for
    // the fiber's lifetime (a restart reuses it; the package cannot move).
    if (!manifests.has(fiber)) manifests.set(fiber, manifestPathOf(loader, fiber))
    const resolved = manifests.get(fiber)
    // No manifest at its package root:
    // nothing to admit, and no retry will change that.
    if (resolved === undefined) {
      settle(fiber, 'skipped')
      return
    }
    const live = host()
    const admission = live === undefined ? undefined : getHostAdmission(live)
    if (admission === undefined) {
      const waited = (attempts.get(fiber) ?? 0) + 1
      attempts.set(fiber, waited)
      // The host has not arrived (an absent host looks like a late one):
      // bounded wait, then a logged refusal.
      if (waited >= retryAttempts) {
        settle(fiber, 'refused')
        logForDebugging(
          `dsh-tui: admission loader refused a Component after waiting ${waited} ticks for `
          + `tuiPluginHost / its admission seam (host ${live === undefined ? 'missing' : 'without getHostAdmission'})`,
          { manifest: resolved },
        )
      }
      return
    }
    let source: string
    try {
      source = readFileSync(resolved, 'utf8')
    } catch (error) {
      settle(fiber, 'skipped')
      logForDebugging(`dsh-tui: admission loader could not read ${resolved} (${messageOf(error)})`)
      return
    }
    const count = (attempts.get(fiber) ?? 0) + 1
    attempts.set(fiber, count)
    try {
      const identity = admission.admit(pluginCtx, source, { source: resolved })
      settle(fiber, 'admitted')
      logForDebugging('dsh-tui: admission loader admitted a Component', {
        componentId: identity.componentId,
        activationId: identity.activationId,
        manifest: resolved,
      })
    } catch (error) {
      if (count >= retryAttempts) {
        settle(fiber, 'refused')
        logForDebugging(`dsh-tui: admission loader refused a Component after ${count} attempts (${messageOf(error)})`, {
          manifest: resolved,
        })
      }
    }
  }

  const consider = (fiber: unknown): void => {
    if (typeof fiber !== 'object' || fiber === null) return
    const activation = fiber as FiberLike
    if (activation.state !== 1 && activation.state !== 2) return
    // A row of its own stops identity inheritance whatever its admission
    // turns out to be; marked here, before its `apply` can call anything.
    if (ownsLoaderEntry(fiber)) markAdmissionBoundary(fiber)
    const current = state.get(fiber)
    if (current === 'admitted' || current === 'refused') return
    // Synchronous on purpose: the row's callback runs one microtask after
    // LOADING, so any hop here would let `apply` run before the identity exists.
    pending.add(fiber)
    attempt(activation)
    if (pending.has(fiber) && timer === undefined) timer = setTimeout(flush, RETRY_INTERVAL_MS)
  }

  const flush = (): void => {
    stopTimer()
    for (const fiber of [...pending]) attempt(fiber as FiberLike)
    if (pending.size > 0) timer = setTimeout(flush, RETRY_INTERVAL_MS)
  }

  // Rows that activated before this loader was armed (the profile path
  // applies plugin rows before the TUI row) come from the entry tree; every
  // later activation arrives through the lifecycle event.
  const seed = (): void => {
    if (typeof loader.entries !== 'function') return
    try {
      for (const entry of loader.entries()) consider(entry.fiber)
    } catch (error) {
      logForDebugging(`dsh-tui: admission loader could not walk the entry tree (${messageOf(error)})`)
    }
  }

  ctx.effect(() => {
    const listener = (fiber: unknown): void => {
      // A fiber that leaves the running states loses the identity with its
      // own effects (restart): forget the pass so a re-activation is admitted
      // again.
      const fiberState = (fiber as FiberLike | null | undefined)?.state
      if (typeof fiber === 'object' && fiber !== null && (fiberState === 5 || fiberState === 4 || fiberState === 3)) {
        state.delete(fiber)
        pending.delete(fiber)
        attempts.delete(fiber)
        return
      }
      consider(fiber)
    }
    // On the composition root (plugin rows' lifecycle events never travel
    // through the TUI row), `global` so child filters cannot hide them; in the
    // host capability, since the root guard refuses `root.events.on` here.
    const disposer = withHostRootCapability(
      () => root.on('internal/status', listener, { global: true }) as unknown,
    )
    return () => {
      if (typeof disposer === 'function') {
        withHostRootCapability(() => (disposer as () => void)())
      }
    }
  })
  ctx.effect(() => stopTimer)
  seed()
}

/**
 * Whether `fiber` is a Loader row's own activation rather than a fiber that
 * row's code created. The Loader tags every fiber under a row with the row's
 * `entry`, so the row's own fiber is the one whose parent carries a different
 * entry (the Loader's own sub-fiber test) — read through the creation-time
 * parent, never the writable `fiber.parent`.
 */
function ownsLoaderEntry(fiber: object): boolean {
  try {
    const entry = (fiber as { readonly entry?: unknown }).entry
    if (entry === undefined || entry === null) return false
    return (parentFiberOf(fiber) as { readonly entry?: unknown } | undefined)?.entry !== entry
  } catch {
    return false
  }
}

/** The Loader of `ctx`'s composition, when there is one. One accessor for both
 *  readers of it (the admission loader and the D-1 backend assembly), so
 *  "which Loader" cannot drift between them. */
export function compositionLoader(ctx: Context): LoaderLike | undefined {
  const loader = compositionRoot(ctx).get('loader' as never, false) as LoaderLike | undefined
  return loader !== undefined && typeof loader.locate === 'function' && typeof loader.resolve === 'function'
    ? loader
    : undefined
}

/** The package-root `dsh-plugin.json` of the entry that owns `fiber`, if any.
 *  Both loader calls are fenced: `EntryTree.resolve` throws for nested ids
 *  (`include:<group>:<row>`); an uninspectable entry is simply skipped. */
function manifestPathOf(loader: LoaderLike, fiber: object): string | undefined {
  let entry: LoaderEntryLike | undefined
  try {
    const entryId = loader.locate?.(fiber)
    entry = entryId === undefined ? undefined : loader.resolve?.(entryId)
  } catch {
    return undefined
  }
  const name = entry?.options?.name
  if (typeof name !== 'string' || name === '') return undefined
  const entryFile = resolveEntryFile(loader, name, entry?.ctx?.baseUrl)
  return entryFile === undefined ? undefined : findManifest(entryFile)
}

/** The module an entry `name` resolves to, following the same rules the
 *  loader's own import uses (file URL, relative to `baseUrl`, bare
 *  specifier relative to the profile). */
function resolveEntryFile(loader: LoaderLike, name: string, baseUrl: string | undefined): string | undefined {
  const url = resolveEntryUrl(loader, name, baseUrl)
  if (url === undefined) return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

/**
 * The **URL** an entry `name` resolves to, through the exact resolver owned by
 * the Loader that would execute it: its active conditions and hooks must select
 * the same code and authority.
 *
 * `undefined` is a refusal to guess, not a "not found": a `cordis:` builtin has
 * no module of its own, and a Loader without Node internals leaves the question
 * open (one debug line, then out). Exported for the D-1 backend assembly, which
 * resolves a *package* the same way rather than growing a second path resolver.
 */
export function resolveEntryUrl(loader: LoaderLike, name: string, baseUrl: string | undefined): string | undefined {
  try {
    if (name.startsWith('cordis:')) return undefined
    const resolver = loader.internal
    if (resolver === undefined) {
      logForDebugging('dsh-tui: admission skipped — the Loader ESM resolver is unavailable; refusing to guess component identity')
      return undefined
    }
    const parent = moduleBase(baseUrl).href
    const resolved = resolver.version === 'v1'
      ? resolver.resolveSync(name, parent, {})
      : resolver.resolveSync(parent, { specifier: name, attributes: {} })
    return resolved.url
  } catch {
    return undefined
  }
}

/**
 * Import a module through the Loader's own door (`EntryTree.import`), so the
 * namespace handed back is the one the Loader executed — conditions, hooks and
 * module cache included. Falls back to importing the URL the resolver already
 * returned (still the Loader's answer; no second resolver) for a loader shape
 * that can resolve but not import.
 */
export async function loadThroughLoader(
  loader: LoaderLike,
  name: string,
  url: string,
  baseUrl: string | undefined,
): Promise<Record<string, unknown>> {
  const internal = loader.internal
  if (internal?.import !== undefined) {
    return await internal.import(name, moduleBase(baseUrl).href, {}) as Record<string, unknown>
  }
  return await import(/* @vite-ignore */ url) as Record<string, unknown>
}

function moduleBase(baseUrl: string | undefined): URL {
  if (baseUrl === undefined || baseUrl === '') return pathToFileURL(join(process.cwd(), 'index.js'))
  try {
    return baseUrl.startsWith('file:') ? new URL(baseUrl) : pathToFileURL(join(baseUrl, 'index.js'))
  } catch {
    return pathToFileURL(join(process.cwd(), 'index.js'))
  }
}

/** Walk up from the entry module to its package root. A manifest counts only
 *  beside the `package.json` that establishes that root: a stray copy deeper
 *  in the tree (a build output directory, say) must not claim an outer
 *  package's code for its own identity. The walk stops at the first
 *  `package.json`, so DSH's own rows (a `package.json` one level up from
 *  their entry) cost one lookup instead of a climb to the filesystem root.
 *  Exported for the D-1 backend assembly, which reads a bundle's declaration
 *  through this same rule. */
export function findManifest(from: string): string | undefined {
  let dir = dirname(resolvePath(from))
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      const candidate = join(dir, 'dsh-plugin.json')
      return existsSync(candidate) ? candidate : undefined
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
