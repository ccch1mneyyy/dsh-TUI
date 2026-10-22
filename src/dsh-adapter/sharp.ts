/**
 * Host-first `sharp` loader.
 *
 * dsh-tui runs inside the dsh process, and the host attachment service
 * (`@deepseek-ai/dsh-attachment-local`) loads its own `sharp` first when it
 * encodes an attachment. Loading a second copy from this package's optional
 * dependency puts two libvips dylibs into one process; on macOS the
 * Objective-C runtime reports the duplicate classes on stderr, and that text
 * lands on the alternate screen (issue #17). It bypasses `patchStderr()`
 * because the runtime writes to fd 2 directly instead of through
 * `process.stderr`, so the only reliable fix is to never map a second copy.
 *
 * Resolution order:
 * 1. a `sharp` the host handed over through `Symbol.for('dsh.sharp')`;
 * 2. a `sharp` already present in the CommonJS module cache (the host's);
 * 3. the host tree, then this package's own optional copy.
 *
 * If a libvips is already mapped but its module is not reachable (bundled or
 * loaded by a worker), return `undefined` rather than mapping a second copy;
 * callers keep their text fallback.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export type SharpModule = Awaited<typeof import('sharp')>['default']

/** Slot a host can use to hand its loaded `sharp` to in-process plugins. */
const SHARP_HANDOFF = Symbol.for('dsh.sharp')

let loader: Promise<SharpModule | undefined> | undefined

/** Load `sharp` once per process, preferring the host's copy. */
export function loadSharp(): Promise<SharpModule | undefined> {
  loader ??= resolveSharp()
  return loader
}

/**
 * `sharp` as the host already loaded it.
 *
 * The host is CommonJS, so the module it required sits in `require.cache`
 * even though this package is ESM. Reusing that instance keeps one libvips in
 * the process.
 */
export function sharpFromModuleCache(): SharpModule | undefined {
  const cache = createRequire(import.meta.url).cache
  for (const [path, cached] of Object.entries(cache)) {
    if (!/(?:^|[\\/])sharp[\\/](?:dist[\\/])?index\.c?js$/.test(path)) continue
    const exported = (cached as { exports?: unknown } | undefined)?.exports as
      | { default?: unknown }
      | undefined
    const candidate = exported?.default ?? exported
    if (typeof candidate === 'function') return candidate as SharpModule
  }
  return undefined
}

/** True when some copy of libvips is already mapped into this process. */
export function nativeImageLibraryLoaded(): boolean {
  try {
    const report = process.report?.getReport?.() as { sharedObjects?: string[] } | undefined
    return report?.sharedObjects?.some(path => /libvips-cpp[.-]/.test(path)) ?? false
  } catch {
    return false
  }
}

/**
 * Candidate `sharp` entry files, host first. The host anchor is a blessed
 * upstream package: profile installs alias `@deepseek-ai/*` to the running
 * dsh, so resolving `sharp` from that location walks the host's tree.
 */
export function sharpCandidatePaths(): string[] {
  const local = createRequire(import.meta.url)
  const paths: string[] = []
  try {
    const anchor = local.resolve('@deepseek-ai/dsh-session/package.json')
    paths.push(createRequire(anchor).resolve('sharp'))
  } catch {
    // The host tree has no sharp (or no dsh-session); use our own copy.
  }
  try {
    paths.push(local.resolve('sharp'))
  } catch {
    // Optional dependency not installed.
  }
  return [...new Set(paths)]
}

async function resolveSharp(): Promise<SharpModule | undefined> {
  const handed = (globalThis as Record<symbol, unknown>)[SHARP_HANDOFF]
  if (typeof handed === 'function') return handed as SharpModule

  const cached = sharpFromModuleCache()
  if (cached) return cached

  // Another libvips is already mapped: do not map ours on top of it.
  if (nativeImageLibraryLoaded()) return undefined

  for (const path of sharpCandidatePaths()) {
    try {
      const mod = await import(pathToFileURL(path).href) as { default?: unknown }
      const candidate = mod.default ?? mod
      if (typeof candidate === 'function') {
        // Publish it for the host's lazy loader so the next reader reuses it.
        (globalThis as Record<symbol, unknown>)[SHARP_HANDOFF] = candidate
        return candidate as SharpModule
      }
    } catch {
      // A broken native build in one tree must not hide a working one.
    }
  }
  return undefined
}
