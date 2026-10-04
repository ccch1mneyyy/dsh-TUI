/**
 * Stable dispatcher facade for the "./extensions" subpath (deploy-transition
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

const mod = await resolveTuiEntry(import.meta.url, "lib/types/extensions.js")

export const name = mod.name
export const apply = mod.apply
export const DECISION_HANDLER_TIMEOUT_MS = mod.DECISION_HANDLER_TIMEOUT_MS
export const DECISION_TOTAL_TIMEOUT_MS = mod.DECISION_TOTAL_TIMEOUT_MS
export const normalizeCancelDecision = mod.normalizeCancelDecision
export const DIALOG_DEFAULT_TIMEOUT_MS = mod.DIALOG_DEFAULT_TIMEOUT_MS
export const INPUT_CELLS = mod.INPUT_CELLS
export const TuiDialogRuntime = mod.TuiDialogRuntime
export const TuiDialogStore = mod.TuiDialogStore
export const TuiStatusRuntime = mod.TuiStatusRuntime
export const TuiStatusStore = mod.TuiStatusStore
export const matchShortcut = mod.matchShortcut
export const parseShortcutCombo = mod.parseShortcutCombo
export const TuiShortcutRuntime = mod.TuiShortcutRuntime
export const TuiRendererRuntime = mod.TuiRendererRuntime
export const TuiToastRuntime = mod.TuiToastRuntime
export const TuiThemeRuntime = mod.TuiThemeRuntime
export const DECISION_EVENT_PERMISSIONS = mod.DECISION_EVENT_PERMISSIONS
export default mod.default ?? mod
