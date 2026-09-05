/**
 * Host-first `sharp` loader.
 *
 * dsh-tui runs inside the dsh process, and the host attachment service
 * (`@deepseek-ai/dsh-attachment-local`) already loads its own `sharp`. Loading
 * a second copy from this package's optional dependency puts two libvips
 * dylibs into one process; on macOS the Objective-C runtime reports the
 * duplicate classes on stderr, and that text lands on the alternate screen
 * (0.1.2-rc.1 ships sharp 0.35.4 while this package pins 0.35.3).
 *
 * Resolve `sharp` from the host tree first, fall back to our own optional
 * copy, and cache the outcome so the process holds one instance. A missing
 * module resolves to `undefined`; callers keep their text fallback.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export type SharpModule = Awaited<typeof import('sharp')>['default']

let loader: Promise<SharpModule | undefined> | undefined

/** Load `sharp` once per process, preferring the host's copy. */
export function loadSharp(): Promise<SharpModule | undefined> {
  loader ??= resolveSharp()
  return loader
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
  for (const path of sharpCandidatePaths()) {
    try {
      const mod = await import(pathToFileURL(path).href) as { default?: unknown }
      const candidate = mod.default ?? mod
      if (typeof candidate === 'function') return candidate as SharpModule
    } catch {
      // A broken native build in one tree must not hide a working one.
    }
  }
  return undefined
}
