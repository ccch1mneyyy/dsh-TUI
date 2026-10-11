/**
 * Admits third-party plugin activations via their package-root
 * `dsh-plugin.json` (`getHostAdmission()`), binding the identity to the
 * plugin's own fiber. A refused activation keeps running (an
 * unload would rewrite the user's profile) but stays outside every mediated
 * capability. Listeners and the retry timer ride the caller's `ctx.effect`.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { componentIdentityOf } from './component-identity.js'
import { compositionRoot, withHostRootCapability } from './host-access.js'
import { getHostAdmission, type TuiPluginHost } from './plugin-host.js'
import { logForDebugging } from '../utils/debug.js'

/** Retry window for an admission not decidable yet (a required contract or
 *  the host itself arrives later). Bounded so a host that never arrives
 *  (issue #183) settles as `refused` with a diagnostic instead of ticking forever. */
const RETRY_INTERVAL_MS = 200
const RETRY_ATTEMPTS = 100

/** The Cordis loader entry that owns a fiber (`cordis-plugin-loader`). */
interface LoaderEntryLike {
  readonly options?: { readonly name?: string }
  readonly ctx?: { readonly baseUrl?: string }
  readonly fiber?: { readonly state?: number } | null
}

interface LoaderLike {
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
  const loader = root.get('loader' as never, false) as LoaderLike | undefined
  if (loader === undefined || typeof loader.locate !== 'function' || typeof loader.resolve !== 'function') {
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
    if (componentIdentityOf(pluginCtx) !== undefined) {
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
  const entryFile = resolveEntryFile(name, entry?.ctx?.baseUrl)
  return entryFile === undefined ? undefined : findManifest(entryFile)
}

/** The module file an entry `name` resolves to, following the same rules the
 *  loader's own import uses (file URL, relative to `baseUrl`, bare
 *  specifier relative to the profile). */
function resolveEntryFile(name: string, baseUrl: string | undefined): string | undefined {
  try {
    // Builtin rows (loader groups, timers) have no package directory.
    if (name.startsWith('cordis:')) return undefined
    if (name.startsWith('file:')) return fileURLToPath(name)
    if (isAbsolute(name)) return name
    if (name.startsWith('.')) {
      return baseUrl === undefined || baseUrl === '' ? undefined : fileURLToPath(new URL(name, baseUrl))
    }
    const require = createRequire(requireBase(baseUrl))
    try {
      return require.resolve(`${name}/package.json`)
    } catch {
      // A subpath specifier (`pkg/sub`): fall back to the package root.
      const trimmed = name.replace(/\/[^/]+$/u, '')
      if (trimmed === name || trimmed === '') return undefined
      return require.resolve(`${trimmed}/package.json`)
    }
  } catch {
    return undefined
  }
}

function requireBase(baseUrl: string | undefined): string | URL {
  if (baseUrl === undefined || baseUrl === '') return pathToFileURL(join(process.cwd(), 'index.js'))
  try {
    return baseUrl.startsWith('file:') ? new URL(baseUrl) : pathToFileURL(join(baseUrl, 'index.js'))
  } catch {
    return pathToFileURL(join(process.cwd(), 'index.js'))
  }
}

/** Walk up from the entry module to its package root. The walk stops at the
 *  first `package.json`: a manifest lives at the package root, never deeper,
 *  so DSH's own rows (a `package.json` one level up from their entry) cost
 *  one lookup instead of a climb to the filesystem root. */
function findManifest(from: string): string | undefined {
  let dir = dirname(resolvePath(from))
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(dir, 'dsh-plugin.json')
    if (existsSync(candidate)) return candidate
    if (existsSync(join(dir, 'package.json'))) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
