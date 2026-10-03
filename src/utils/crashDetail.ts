/**
 * Crash serialization for the exit funnel (src/dsh-adapter/plugin.ts).
 *
 * The user's React #185 crashes (maximum update depth exceeded) reached the
 * funnel as nothing but `dsh-tui crashed: Minified React error #185` — the
 * message-only line drops the stack, the whole `.cause` chain, and the React
 * extras (componentStack / digest) a minified production build still carries,
 * so four real crashes left zero post-mortem evidence. These helpers turn an
 * unknown crash value into a fully serialized detail block plus the
 * crash.log line format, so the next crash leaves its stack on disk.
 *
 * Deliberately dependency-free (node builtins + paths only): verify scripts
 * load it without the whole plugin graph (initialPromptFromCmdlineArgs
 * precedent, plugin.ts's "moved to its own dependency-free module" note).
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './paths.js'

/** One serialized level: the crash itself or a link of its `.cause` chain. */
export interface CrashDetailLevel {
  /** Constructor name (`TypeError`), or the JS typeof for non-Errors. */
  readonly name: string
  readonly message: string
  /** Raw multi-frame stack when this level is an Error that carries one. */
  readonly stack?: string
}

/** Full crash serialization: the error, its cause chain, and React extras. */
export interface CrashDetail {
  readonly message: string
  /** Head-level stack (=== levels[0].stack). */
  readonly stack?: string
  /** The error followed by every `.cause` link, outermost first. */
  readonly levels: readonly CrashDetailLevel[]
  /** React component tree trace when attached to the error object. */
  readonly componentStack?: string
  /** React production digest when attached to the error object. */
  readonly digest?: string
  /** `${name}: ${message}` one-liner for logs that must stay one line. */
  readonly summary: string
  /** Full multi-line block crash.log stores after its header line. */
  readonly text: string
}

/** A pathological (self- or mutually-referring) cause chain must not loop. */
const MAX_CAUSE_LEVELS = 8
/** Cap the serialized block so huge synthetic stacks cannot grow crash.log unbounded. */
const MAX_TEXT_CHARS = 32 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Stringify without letting a hostile toString/symbol take the path down. */
function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function serializeLevel(error: unknown): CrashDetailLevel {
  if (error instanceof Error) {
    const name = typeof error.name === 'string' && error.name !== '' ? error.name : 'Error'
    const stack = typeof error.stack === 'string' && error.stack !== '' ? error.stack : undefined
    return { name, message: error.message, ...(stack === undefined ? {} : { stack }) }
  }
  return { name: typeof error, message: safeString(error) }
}

/** Indent every line of a (multi-frame) block for the text serialization. */
const indentBlock = (block: string): string => block.replace(/^/gm, '    ')

/**
 * Serialize an unknown crash value: head message + stack, the `.cause` chain
 * level by level, and componentStack / digest when attached. Never throws and
 * never loops — the crash path's own diagnostics must not become a second
 * crash. Exported for scripts/verify-crash-detail.
 */
export function serializeCrashDetail(error: unknown): CrashDetail {
  const levels: CrashDetailLevel[] = [serializeLevel(error)]
  // Follow .cause links (ES2022 Error cause + manually attached ones); the
  // seen-set stops self/mutual references, the cap stops absurd chains.
  const seen = new Set<unknown>([error])
  let current = isRecord(error) ? error.cause : undefined
  while (levels.length < MAX_CAUSE_LEVELS && current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    levels.push(serializeLevel(current))
    current = isRecord(current) ? current.cause : undefined
  }
  const head = levels[0]
  const componentStack =
    isRecord(error) && typeof error.componentStack === 'string' && error.componentStack !== ''
      ? error.componentStack
      : undefined
  const digest = isRecord(error) && typeof error.digest === 'string' && error.digest !== '' ? error.digest : undefined
  const summary = error instanceof Error ? `${head.name}: ${head.message}` : head.message
  const lines: string[] = [`dsh-tui crashed: ${summary}`]
  levels.forEach((level, index) => {
    lines.push(`level ${index}${index === 0 ? '' : ' (cause)'}: ${level.name}: ${level.message}`)
    if (level.stack !== undefined) lines.push('  stack:', indentBlock(level.stack))
  })
  if (componentStack !== undefined) lines.push('componentStack:', indentBlock(componentStack))
  if (digest !== undefined) lines.push(`digest: ${digest}`)
  let text = lines.join('\n')
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n...(truncated)`
  return {
    message: head.message,
    ...(head.stack === undefined ? {} : { stack: head.stack }),
    levels,
    ...(componentStack === undefined ? {} : { componentStack }),
    ...(digest === undefined ? {} : { digest }),
    summary,
    text,
  }
}

/**
 * The crash.log line: restart.log's `<UTC ISO> pid=<pid>` header style
 * (writeRestartLine precedent, src/update.ts) followed by the detail block.
 * @param detail - Serialized crash (serializeCrashDetail).
 * @param at - Timestamp of the crash (injected so the format stays testable).
 * @param pid - Process id (injected so the format stays testable).
 */
export function formatCrashLogLine(detail: CrashDetail, at: Date, pid: number): string {
  return `${at.toISOString()} pid=${pid} ${detail.text}\n`
}

/**
 * Append the crash detail to `<dir>/crash.log` (default `~/.dsh-tui`,
 * DATA_DIR — same home-dir resolution as restart.log, never a hard-coded
 * path). Every failure is swallowed: post-mortem diagnostics must never take
 * the exit path down (mouse-debug.log precedent).
 * @param detail - Serialized crash (serializeCrashDetail).
 * @param dir - Data directory override (verify scripts point at a temp dir).
 */
export function appendCrashLog(detail: CrashDetail, dir: string = DATA_DIR): void {
  try {
    mkdirSync(dir, { recursive: true })
    // 0600 on creation: the stack can mirror message content (mouse-debug.log
    // and history.jsonl precedent, see scripts/verify-data-file-perms).
    appendFileSync(join(dir, 'crash.log'), formatCrashLogLine(detail, new Date(), process.pid), { mode: 0o600 })
  } catch {
    // Post-mortem only — see doc comment.
  }
}
