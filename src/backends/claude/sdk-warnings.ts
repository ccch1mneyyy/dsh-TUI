/**
 * Startup-warning filter for the Claude Agent SDK (a deliberate-integration
 * note, not a bug): this profile pre-approves the todo-panel tool family
 * additively via `allowedTools` (see options.ts) and can start a session in
 * the remembered `bypassPermissions` mode. In both cases the SDK calls
 * `process.emitWarning(msg, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' })`
 * to say canUseTool is shadowed for those calls. That choice is ours and
 * intentional — the per-boot stderr warning only alarms the user (it reads
 * like a defect, and it surfaced verbatim in a user crash report).
 *
 * Suppression mechanism, chosen from a probed Node 24 fact: the default
 * warning printer is itself a `warning` listener (listenerCount is >= 1 on a
 * bare boot) and keeps printing even when user listeners are added, so
 * listening cannot filter. The one reliable lever is not emitting the
 * warning at all: wrap `process.emitWarning` and drop exactly that code,
 * forwarding everything else to the original untouched (node keeps its own
 * native formatting for passthrough warnings).
 *
 * @module dsh-tui/backends/claude/sdk-warnings
 */

/** Marker the wrapper sets, so tests and double loads can recognize it. */
const FILTER_MARKER = '__dshTuiSdkWarningFilter'

const SUPPRESSED_WARNING_CODES = new Set<string>(['CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'])

/** Whether one warning code is the SDK's canUseTool-shadow notice. */
export function isSuppressedSdkWarningCode(code: string | undefined): boolean {
  return code !== undefined && SUPPRESSED_WARNING_CODES.has(code)
}

/**
 * The code argument of one emitWarning call, both shapes the SDK and node
 * core use: `(warning, { code })` and `(warning, type, code[, ctor])`.
 */
function emitWarningCode(arg1: unknown, arg2: unknown): string | undefined {
  if (typeof arg1 === 'object' && arg1 !== null) {
    const code = (arg1 as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  if (typeof arg2 === 'string') return arg2
  return undefined
}

type EmitWarning = typeof process.emitWarning

// Runs before the first query() construction (options.ts is in that import
// chain). Idempotent across double loads via a global marker.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
const globalScope = globalThis as { [FILTER_MARKER]?: boolean }
if (!globalScope[FILTER_MARKER]) {
  globalScope[FILTER_MARKER] = true
  const original: EmitWarning = process.emitWarning.bind(process)
  const patched = ((warning: string | Error, arg1?: never, arg2?: never, arg3?: never) => {
    if (isSuppressedSdkWarningCode(emitWarningCode(arg1, arg2))) return
    return original(warning as string, arg1, arg2, arg3)
  }) as EmitWarning
  Object.defineProperty(patched, FILTER_MARKER, { value: true })
  process.emitWarning = patched
}
