/**
 * Stable dispatcher facade for the "./workspaces" subpath (deploy-transition
 * S04 M1: every public TUI subpath resolves through the SAME process
 * pin as the main entry, so a Cordis row loaded by package name can
 * never mix generations with the running plugin. The pin (generation +
 * lease) is established before the target module is imported; see
 * dispatch/resolve.mjs. Source/legacy modes import the canonical file
 * next to dispatch/, byte-identical to the pre-dispatch world.
 *
 * The forwarded names are this subpath's complete runtime export set;
 * scripts/verify-dispatch-subpaths.mjs keeps them in lockstep with the
 * canonical module. "default" carries the raw module namespace.
 */
import { resolveTuiEntry } from "./resolve.mjs"

const mod = await resolveTuiEntry(import.meta.url, "lib/types/workspaces.js")

export const name = mod.name
export const WORKSPACE_PROVIDER_TIMEOUT_MS = mod.WORKSPACE_PROVIDER_TIMEOUT_MS
export const TuiWorkspaceRuntime = mod.TuiWorkspaceRuntime
export const createLocalWorkspaceRuntime = mod.createLocalWorkspaceRuntime
export const localWorkspaceUri = mod.localWorkspaceUri
export const parseLocalWorkspaceReference = mod.parseLocalWorkspaceReference
export const listRegistryWorkspaces = mod.listRegistryWorkspaces
export const removeRegistryWorkspace = mod.removeRegistryWorkspace
export default mod.default ?? mod
