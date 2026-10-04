/**
 * Stable dispatcher facade for the "./plugin-host" subpath (deploy-transition
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

const mod = await resolveTuiEntry(import.meta.url, "lib/types/plugin-host.js")

export const name = mod.name
export const apply = mod.apply
export const PluginStorageError = mod.PluginStorageError
export const STORAGE_KEY_MAX_LENGTH = mod.STORAGE_KEY_MAX_LENGTH
export const STORAGE_MAX_BYTES = mod.STORAGE_MAX_BYTES
export const STORAGE_MAX_KEYS = mod.STORAGE_MAX_KEYS
export const OBSERVE_CALLBACK_QUEUE_LIMIT = mod.OBSERVE_CALLBACK_QUEUE_LIMIT
export const OBSERVE_CALLBACK_TIMEOUT_MS = mod.OBSERVE_CALLBACK_TIMEOUT_MS
export const OBSERVE_CONTENT_MAX_CHARS = mod.OBSERVE_CONTENT_MAX_CHARS
export const OBSERVE_ID_MAX_CHARS = mod.OBSERVE_ID_MAX_CHARS
export const OBSERVE_IMAGE_BASE64_MAX_CHARS = mod.OBSERVE_IMAGE_BASE64_MAX_CHARS
export const OBSERVE_IMAGE_MAX_BYTES = mod.OBSERVE_IMAGE_MAX_BYTES
export const OBSERVE_SCOPE_MAX_CHARS = mod.OBSERVE_SCOPE_MAX_CHARS
export const OBSERVE_SUMMARY_CELLS = mod.OBSERVE_SUMMARY_CELLS
export const COMMAND_ERROR_CODES = mod.COMMAND_ERROR_CODES
export const hasCommandErrorCode = mod.hasCommandErrorCode
export const mapCommandError = mod.mapCommandError
export const withCommandErrorMapping = mod.withCommandErrorMapping
export const DECISION_EVENT_PERMISSIONS = mod.DECISION_EVENT_PERMISSIONS
export const DECISION_HANDLER_TIMEOUT_MS = mod.DECISION_HANDLER_TIMEOUT_MS
export const DECISION_TOTAL_TIMEOUT_MS = mod.DECISION_TOTAL_TIMEOUT_MS
export const DECISION_EVENTS_COORDINATE = mod.DECISION_EVENTS_COORDINATE
export const TUI_EXTENSION_API_VERSION = mod.TUI_EXTENSION_API_VERSION
export const TUI_DECISION_EVENT_NAMES = mod.TUI_DECISION_EVENT_NAMES
export const TUI_EXTENSION_PERMISSION_NAMES = mod.TUI_EXTENSION_PERMISSION_NAMES
export default mod.default ?? mod
