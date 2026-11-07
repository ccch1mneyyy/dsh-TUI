/**
 * Edit-transaction signal: forwards successful durable file-tool results to
 * the IDE channel so a companion extension can review (keep or undo) the
 * edits without parsing model-facing tool text.
 *
 * The source of truth is the session event, not the rendered result:
 * `dsh-tool-fs` attaches a tool-private `meta` payload to `tool/result`
 * carrying the changed files' old/new hunk texts
 * (`{ path, diffs: [{ path, oldText, newText }] }` for edit/write and
 * `{ diffs, stopped }` for apply_patch). That payload is JSON-only and
 * durable, so a resumed session's card replay reproduces the same hunks —
 * which is exactly why this module may only forward LIVE events. The raw
 * subscriber (`native.subscribeRaw`) taps live appends, and the binding
 * resets this forwarder on every rebind, so a parked session cannot leak an
 * old call into the next one.
 *
 * Everything here is best-effort: a malformed meta, an oversized
 * transaction, an unknown tool, or a disconnected channel all degrade to
 * "send nothing". The receiver re-reads the file before trusting a hunk, so
 * a missed notification costs a review entry, never correctness.
 *
 * Bounds (long sessions must stay flat): {@link MAX_TRACKED_CALLS} live
 * calls, {@link MAX_SENT_CALL_IDS} forwarded ids, {@link MAX_FILES} files per
 * notification, {@link MAX_HUNKS} hunks per notification,
 * {@link MAX_TEXT_CHARS} per hunk side, {@link MAX_NOTIFICATION_CHARS} per
 * serialized notification. Anything above a bound is dropped whole rather
 * than truncated — a partial hunk would be a wrong review entry.
 */
import { isAbsolute, resolve } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { toolResultPayload } from './compat/messages.js'
import type {
  EditTransactionDiff,
  EditTransactionNotification,
} from './ide-channel.js'

/** Tools whose result meta carries replayable file hunks. */
export const EDIT_TRANSACTION_TOOLS: readonly string[] = ['edit', 'write', 'apply_patch']

/** Live calls kept between `tool/call` and its `tool/result`. */
const MAX_TRACKED_CALLS = 128
/** Recently forwarded call ids, for duplicate-result suppression. */
const MAX_SENT_CALL_IDS = 256
/** Files one notification may carry; bigger transactions are dropped whole. */
const MAX_FILES = 64
/** Hunks one notification may carry; bigger transactions are dropped whole. */
const MAX_HUNKS = 512
/** Longest single hunk text (either side) accepted, in characters. */
const MAX_TEXT_CHARS = 64 * 1024
/** Longest serialized notification accepted, in characters. */
const MAX_NOTIFICATION_CHARS = 256 * 1024

/** Where the forwarder attributes the events it sees. */
export type EditSignalSession = {
  /** DSH session id, sent to the receiver for attribution. */
  sessionId: string
  /** Session cwd, used to resolve a tool's relative result path. */
  cwd: string
}

/**
 * Consumer side of the channel: the IDE channel's `sendEditTransaction`.
 * Returns false for every degraded outcome; the forwarder never retries.
 */
export type EditSignalSink = (notification: EditTransactionNotification) => boolean

/** One file's hunks, as the pieces of the tool-result meta that survived validation. */
type FileHunks = {
  path: string
  operation?: 'create' | 'update'
  diffs: EditTransactionDiff[]
}

export type EditSignalForwarder = {
  /** Re-target attribution; resets per-session state (called per binding). */
  bind(session: EditSignalSession): void
  /** Feed one live durable session event (`session/event` payload). */
  onSessionEvent(event: unknown): void
  /** Drop every reference; later events are ignored. */
  dispose(): void
}

/**
 * Build the forwarder. One instance per channel composition; `send` is the
 * channel's sender, so this module stays free of socket and capability
 * details (the channel decides whether a notification can be delivered).
 */
export function createEditSignalForwarder(send: EditSignalSink): EditSignalForwarder {
  let session: EditSignalSession | undefined
  let disposed = false
  /** callId → tool name, insertion-ordered so the oldest call is evicted first. */
  const openCalls = new Map<string, string>()
  /** Forwarded call ids, insertion-ordered like `openCalls`. */
  const sentCalls = new Set<string>()

  const remember = (callId: string): void => {
    sentCalls.add(callId)
    while (sentCalls.size > MAX_SENT_CALL_IDS) {
      const oldest = sentCalls.values().next().value
      if (oldest === undefined) break
      sentCalls.delete(oldest)
    }
  }

  const trackCall = (callId: string, tool: string): void => {
    openCalls.set(callId, tool)
    while (openCalls.size > MAX_TRACKED_CALLS) {
      const oldest = openCalls.keys().next().value
      if (oldest === undefined) break
      openCalls.delete(oldest)
    }
  }

  const forward = (event: Record<string, unknown>): void => {
    if (session === undefined) return
    // Only appends are new edits: a surface replace/repair rewrites history
    // and must never be re-announced as a transaction. `surfaceOp` is a
    // string marker on today's appends but the durable log also carries
    // object-shaped surface ops (`{ op: 'replace', … }`), so anything other
    // than the append marker — object or unknown string — is refused.
    const surfaceOp = event.surfaceOp
    if (surfaceOp !== undefined && surfaceOp !== 'append') return
    if (event.type === 'tool/call') {
      const data = asRecord(event.data)
      if (data === undefined) return
      const callId = asNonEmptyString(data.callId)
      const tool = asNonEmptyString(data.name)
      if (callId === undefined || tool === undefined || !EDIT_TRANSACTION_TOOLS.includes(tool)) return
      trackCall(callId, tool)
      return
    }
    if (event.type !== 'tool/result') return
    const data = asRecord(event.data)
    if (data === undefined) return
    const message = asRecord(data.message)
    const source = message === undefined ? undefined : asRecord(message.source)
    const callId = source === undefined ? undefined : asNonEmptyString(source.callId)
    if (callId === undefined) return
    const tool = openCalls.get(callId)
    openCalls.delete(callId)
    if (tool === undefined || sentCalls.has(callId)) return
    const meta = asRecord(data.meta)
    // Failure uses the repository's one durable-result reading (see
    // `translate.ts`): the envelope's `error` OR the message's own `isError`
    // (0.1.7 field, older logs wrap it in the first result block). A failed
    // call is reviewable only when the tool reports a stopped run that
    // already wrote some effects: `apply_patch` stops at the first failure
    // and still attaches the completed hunks (error + meta.stopped). Any
    // other error wrote nothing usable. `error: null` is a success shape.
    const messagePayload = message as unknown as Parameters<typeof toolResultPayload>[0]
    const failed = (data.error !== undefined && data.error !== null) || toolResultPayload(messagePayload).isError
    if (failed && meta?.stopped !== true) return
    const notification = buildNotification(session, callId, tool, meta)
    if (notification === undefined) return
    if (!send(notification)) return
    remember(callId)
  }

  return {
    bind(next) {
      // A reattach of the SAME session keeps in-flight calls and the dedupe
      // set: /resume can rebind while a turn is mid-flight, and its later
      // `tool/result` still belongs to this session. A cwd move inside the
      // same session clears the in-flight calls instead: their relative hunk
      // paths would otherwise resolve against the new directory (a wrong
      // ledger entry is worse than a missed one). A different session starts
      // from a clean ledger.
      const sameSession = session?.sessionId === next.sessionId
      if (!sameSession) {
        openCalls.clear()
        sentCalls.clear()
      } else if (session?.cwd !== next.cwd) {
        openCalls.clear()
      }
      session = next
    },
    onSessionEvent(event) {
      if (disposed) return
      const record = asRecord(event)
      if (record !== undefined) forward(record)
    },
    dispose() {
      disposed = true
      session = undefined
      openCalls.clear()
      sentCalls.clear()
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Absolute path for a meta path: the tool's own coordinate when absolute,
 *  else the session cwd; `undefined` when a relative path has no cwd. */
function absolutePath(path: string, cwd: string): string | undefined {
  if (isAbsolute(path)) return path
  if (cwd === '') return undefined
  return resolve(cwd, path)
}

/** Validate one `{path, oldText, newText}` hunk from a tool result's meta. */
function parseHunk(value: unknown): { path: string; oldText: string; newText: string } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const path = asNonEmptyString(record.path)
  const oldText = record.oldText
  const newText = record.newText
  if (path === undefined || typeof oldText !== 'string' || typeof newText !== 'string') return undefined
  if (oldText.length > MAX_TEXT_CHARS || newText.length > MAX_TEXT_CHARS) return undefined
  return { path, oldText, newText }
}

/**
 * Turn a durable `tool/result.meta` into the wire notification, or undefined
 * when the payload is absent, malformed, out of bounds, or changes nothing.
 */
function buildNotification(
  session: EditSignalSession,
  callId: string,
  tool: string,
  meta: Record<string, unknown> | undefined,
): EditTransactionNotification | undefined {
  if (meta === undefined) return undefined
  const operation = meta.operation === 'create' || meta.operation === 'update' ? meta.operation : undefined
  // `write` records a creation explicitly and needs no hunks: the receiver
  // reads the file for its content, so dropping hunks also keeps a large new
  // file from tripping the text bound. This is the documented shape of
  // `dsh-tool-fs` (a `null` before yields no diffs); a tool that still
  // attaches hunks is harmless because the receiver trusts the disk.
  if (operation === 'create') {
    const rawPath = asNonEmptyString(meta.path)
    if (rawPath === undefined) return undefined
    const path = absolutePath(rawPath, session.cwd)
    if (path === undefined) return undefined
    const created: EditTransactionNotification = {
      sessionId: session.sessionId,
      callId,
      tool,
      files: [{ path, operation: 'create', diffs: [] }],
      ...(meta.stopped === true ? { stopped: true } : {}),
    }
    return fitsNotification(created) ? created : undefined
  }
  const files = new Map<string, FileHunks>()
  let hunks = 0
  let chars = 0
  const rawDiffs = meta.diffs
  if (rawDiffs !== undefined && !Array.isArray(rawDiffs)) return undefined
  if (Array.isArray(rawDiffs)) {
    for (const rawDiff of rawDiffs) {
      if (++hunks > MAX_HUNKS) return undefined
      const hunk = parseHunk(rawDiff)
      if (hunk === undefined) return undefined
      chars += hunk.path.length + hunk.oldText.length + hunk.newText.length
      if (chars > MAX_NOTIFICATION_CHARS) return undefined
      const path = absolutePath(hunk.path, session.cwd)
      if (path === undefined) return undefined
      const entry = files.get(path) ?? { path, diffs: [] }
      entry.diffs.push({ oldText: hunk.oldText, newText: hunk.newText })
      files.set(path, entry)
    }
  }
  if (files.size === 0 || files.size > MAX_FILES) return undefined
  // `write`'s operation describes the single path it touched; never broadcast
  // it across a multi-file patch (a created file inside a patch has no
  // operation field in this protocol).
  if (operation !== undefined && files.size === 1) {
    for (const entry of files.values()) entry.operation = operation
  }
  const notification: EditTransactionNotification = {
    sessionId: session.sessionId,
    callId,
    tool,
    files: [...files.values()].map(({ path, operation: fileOperation, diffs }) => ({
      path,
      ...(fileOperation === undefined ? {} : { operation: fileOperation }),
      diffs,
    })),
    ...(meta.stopped === true ? { stopped: true } : {}),
  }
  return fitsNotification(notification) ? notification : undefined
}

/** Final guard on the serialized envelope: the per-text accounting above
 *  already bounds a normal payload, so this only catches envelope overhead
 *  and non-string field growth before the frame leaves the process. */
function fitsNotification(notification: EditTransactionNotification): boolean {
  try {
    return JSON.stringify(notification).length <= MAX_NOTIFICATION_CHARS
  } catch {
    return false
  }
}
