/**
 * Stable dispatcher facade for the package main entry (design §S04, G0).
 *
 * The Cordis host loader resolves the TUI plugin row by package name, so the
 * package's own main export is the only stable, Node-resolvable seam this
 * process controls. This forwarder pins the runtime root FIRST (generation
 * + lease, before any dynamic import of generation code — see
 * dispatch/resolve.mjs), then re-exports the pinned module's plugin surface.
 *
 * The forwarded names are the package entry's complete runtime export set
 * (src/index.ts re-exports src/dsh-adapter/index.ts); the regression keeps
 * them in lockstep with the canonical module. "default" carries the raw
 * module so non-loader consumers of the bare package name keep working.
 *
 * M0 scope note: only the MAIN plugin row dispatches; the subpath export
 * rows stay canonical until the design's M1/M2 subpath coverage.
 */
import { resolveTuiEntry } from "./resolve.mjs"

const mod = await resolveTuiEntry(import.meta.url, "lib/types/index.js")

export const name = mod.name
export const inject = mod.inject
export const Config = mod.Config
export const apply = mod.apply
export const normalizeBackendChoice = mod.normalizeBackendChoice
export default mod.default ?? mod
