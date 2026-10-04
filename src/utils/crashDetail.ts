/**
 * Crash serialization for the exit funnel (src/dsh-adapter/plugin.ts).
 *
 * A message-only crash line (`Minified React error #185`) loses the stack,
 * the `.cause` chain and the React extras (componentStack, digest) that a
 * production build still carries. These helpers serialize all of it and
 * append it to ~/.dsh-tui/crash.log.
 *
 * Dependency-free (node builtins and paths only) so verify scripts can load
 * it without the plugin graph.
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

/** Stand-in text for a value whose own string conversion throws. */
export const UNSERIALIZABLE = '[unserializable value]'

/**
 * Read one property of a value that may throw on access (a getter or a Proxy
 * trap); a throw reads as undefined. The crash funnel runs after the exit
 * latch is set, so an exception escaping from here would skip the cleanup
 * that follows it.
 */
function safeProp(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

/** instanceof through a maybe-hostile value: a Proxy can trap
 * getPrototypeOf too, and that must degrade the same way as a property read. */
function safeInstanceOfError(value: unknown): boolean {
  try {
    return value instanceof Error
  } catch {
    return false
  }
}

/**
 * Three-tier stringify: String(value), then Object.prototype.toString.call
 * (itself re-wrapped — a Symbol.toStringTag getter can throw too), then the
 * fixed literal. Never throws.
 */
function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    // Fall through to the second conversion.
  }
  try {
    return Object.prototype.toString.call(value)
  } catch {
    // Fall through to the fixed literal.
  }
  return UNSERIALIZABLE
}

function serializeLevel(error: unknown): CrashDetailLevel {
  if (safeInstanceOfError(error) && isRecord(error)) {
    const rawName = safeProp(error, 'name')
    const rawStack = safeProp(error, 'stack')
    const rawMessage = safeProp(error, 'message')
    const name = typeof rawName === 'string' && rawName !== '' ? rawName : 'Error'
    const stack = typeof rawStack === 'string' && rawStack !== '' ? rawStack : undefined
    // A non-string message still stringifies (a hostile Error can carry 42);
    // only a THROWING conversion degrades to the fixed literal.
    const message = typeof rawMessage === 'string' ? rawMessage : safeString(rawMessage)
    return { name, message, ...(stack === undefined ? {} : { stack }) }
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
  let current = isRecord(error) ? safeProp(error, 'cause') : undefined
  while (levels.length < MAX_CAUSE_LEVELS && current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    levels.push(serializeLevel(current))
    current = isRecord(current) ? safeProp(current, 'cause') : undefined
  }
  const head = levels[0]
  const rawComponentStack = isRecord(error) ? safeProp(error, 'componentStack') : undefined
  const rawDigest = isRecord(error) ? safeProp(error, 'digest') : undefined
  const componentStack =
    typeof rawComponentStack === 'string' && rawComponentStack !== ''
      ? rawComponentStack
      : undefined
  const digest = typeof rawDigest === 'string' && rawDigest !== '' ? rawDigest : undefined
  const summary = safeInstanceOfError(error) ? `${head.name}: ${head.message}` : head.message
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
 * Crash detail built from literals only, for when serializing or logging
 * the real one failed. It never touches the thrown value, so it cannot throw.
 */
export function unserializableCrashDetail(): CrashDetail {
  const text = [
    `dsh-tui crashed: ${UNSERIALIZABLE}`,
    `level 0: Error: ${UNSERIALIZABLE}`,
    '(crash detail serialization failed; every property of the thrown value was left unread)',
  ].join('\n')
  return {
    message: UNSERIALIZABLE,
    levels: [{ name: 'Error', message: UNSERIALIZABLE }],
    summary: `Error: ${UNSERIALIZABLE}`,
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
