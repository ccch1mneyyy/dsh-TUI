/**
 * What a bounded read can learn about a session log.
 *
 * Two windows, one at each end, and never anything in between:
 *
 * - The HEAD normally holds the session envelope, boot policy events, and the
 *   opening prompt. Measured across a real corpus, the first user prompt lands
 *   within 8,107 bytes of the start (524 in its `agent/inbox/spliced` form),
 *   so a 64 KB window is the cheap path. A larger modern context prefix can
 *   exceed it; listSummaries schedules the progressive opening scan below
 *   after returning the immediately usable session list.
 * - The TAIL holds whatever was appended most recently: the current title
 *   (titles are re-emitted, and the last one wins), the model of the last
 *   request, and the last exchanges for the preview.
 *
 * Titles carry their own provenance, so this module does not have to guess.
 * A title written by a provider records `source.kind: 'provider'`; the TUI's
 * own rename paths append `{ title }` with no source at all. That difference
 * is the evidence behind {@link SessionTitle.source}, which is why the picker
 * can dim a fallback and explain a name instead of merely displaying one.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/digest
 */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { scheduler } from 'node:timers/promises'
import { decodeFrame, decodeTail, readWindow, resyncFrames, walkFrames, type FrameRange, type LogLine } from './frames.js'
import type { PreviewEntry, SessionDigest, SessionTitle } from './types.js'

/** Head window budget. Eight times the measured worst-case prompt offset. */
export const HEAD_WINDOW_BYTES = 64 * 1024
/** Head frame ceiling — a cost bound independent of how the bytes compress. */
export const HEAD_MAX_FRAMES = 128
/** Tail window budget. Wider than the head: trailing frames carry payloads. */
export const TAIL_WINDOW_BYTES = 128 * 1024
/** Compressed bytes read per progressive title-scan page. */
const TITLE_SCAN_PAGE_BYTES = 128 * 1024
/** Largest compressed frame the fallback scanner will materialize. */
const TITLE_SCAN_MAX_FRAME_BYTES = 16 * 1024 * 1024
/** Old EOF neighborhood hashed for the JSONL backend's append-only contract. */
const TITLE_ANCHOR_BYTES = 256
/** Longest preview excerpt kept per message, in characters. */
const PREVIEW_CHARS = 400

/** The first text block of a message `content` payload. */
function textOfContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record['type'] !== 'text') continue
    const value = record['text']
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * Whether a message's `source` marks it as typed by the person at the
 * keyboard. Plugin injections, instruction snapshots, skill catalogues and
 * sub-agent reports all arrive as user-role messages too, and counting them
 * would report a conversation where none happened.
 */
function isHumanSource(source: unknown): boolean {
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return false
  return (source as Record<string, unknown>)['kind'] === 'user'
}

/** A human message is conversation evidence even when it has no title text. */
function humanPrompt(line: LogLine): { readonly text: string | undefined } | undefined {
  const data = line['data']
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>

  if (line['type'] === 'user/message') {
    return isHumanSource(record['source']) ? { text: textOfContent(record['content']) } : undefined
  }
  // The inbox splice precedes the durable user/message and reaches the log
  // several frames earlier, which is what keeps the head window small.
  if (line['type'] === 'agent/inbox/spliced') {
    const inserted = record['inserted']
    if (!Array.isArray(inserted)) return undefined
    let found = false
    for (const message of inserted) {
      if (message === null || typeof message !== 'object') continue
      const entry = message as Record<string, unknown>
      if (entry['role'] !== 'user' || !isHumanSource(entry['source'])) continue
      found = true
      const text = textOfContent(entry['content'])
      if (text !== undefined) return { text }
    }
    if (found) return { text: undefined }
  }
  return undefined
}

/** A `session/title` payload, with the provenance that classifies it. */
function titleOf(line: LogLine): SessionTitle | undefined {
  if (line['type'] !== 'session/title') return undefined
  const data = line['data']
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const text = record['title']
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  const source = record['source']
  const byProvider =
    source !== null &&
    typeof source === 'object' &&
    (source as Record<string, unknown>)['kind'] === 'provider'
  return { text: text.trim(), source: byProvider ? 'auto' : 'renamed' }
}

/** Request headers own the route; context events support historical logs. */
function modelOf(line: LogLine): string | undefined {
  const data = line['data']
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  let model: unknown
  if (line['type'] === 'request/header') {
    const header = record['header'] as { config?: { model?: unknown } } | undefined
    model = header?.config?.model
  } else if (line['type'] === 'request/context') model = record['model']
  return typeof model === 'string' && model.length > 0 ? model : undefined
}

/** The label a delegated run was started under. */
function labelOf(line: LogLine): string | undefined {
  if (line['type'] !== 'subagent/descriptor') return undefined
  const data = line['data']
  if (data === null || typeof data !== 'object') return undefined
  const label = (data as Record<string, unknown>)['label']
  return typeof label === 'string' && label.trim().length > 0 ? label.trim() : undefined
}

/** Epoch-ms of a log line, when it carries one. */
function timeOf(line: LogLine): number | undefined {
  const time = line['time']
  return typeof time === 'number' && Number.isFinite(time) ? time : undefined
}

/**
 * Read both windows of one session log.
 *
 * @param path - Absolute artifact path.
 * @param cwd - Working directory, for the last-resort title.
 * @returns The digest. An unreadable log still yields a usable record: the
 *   title falls back to the directory basename and says so through its source.
 */
export function digestSession(path: string, cwd: string): SessionDigest {
  const head = readWindow(path, HEAD_WINDOW_BYTES)
  if (head === undefined) {
    return { title: undefined, hasPrompt: true, model: undefined, label: undefined }
  }
  const headFrames = walkFrames(head.buffer, 0, HEAD_MAX_FRAMES)
  const headLines: LogLine[] = []
  let completeHead = head.whole && headFrames.at(-1)?.end === head.buffer.length
  for (const frame of headFrames) {
    const lines = decodeFrame(head.buffer, frame)
    if (lines === undefined) completeHead = false
    else headLines.push(...lines)
  }
  completeHead &&= headLines[0]?.['type'] === 'session'

  let prompt: string | undefined
  let hasHumanMessage = false
  let headTitle: SessionTitle | undefined
  let label: string | undefined
  for (const line of headLines) {
    const human = humanPrompt(line)
    hasHumanMessage ||= human !== undefined
    prompt ??= human?.text
    headTitle ??= titleOf(line)
    label ??= labelOf(line)
  }

  // The byte window, frame limit, decoding and parsing must ALL cover the
  // log before absence proves emptiness. Unknown is visible, never eligible
  // for destructive cleanup; title text is not required for image-only input.
  const hasPrompt = hasHumanMessage || !completeHead

  // Only a completely decoded head can stand in for the tail.
  const tail = completeHead ? undefined : readWindow(path, TAIL_WINDOW_BYTES, true)
  const tailLines = tail === undefined ? headLines : decodeTail(tail)

  let tailTitle: SessionTitle | undefined
  let model: string | undefined
  for (const line of tailLines) {
    const title = titleOf(line)
    if (title !== undefined) tailTitle = title
    const route = modelOf(line)
    if (route !== undefined) model = route
  }

  const resolved: SessionTitle | undefined =
    tailTitle ??
    headTitle ??
    (prompt === undefined ? undefined : { text: prompt, source: 'prompt' })

  return {
    title: resolved ?? { text: basename(cwd), source: 'fallback' },
    hasPrompt,
    model,
    modelComplete: model !== undefined || completeHead,
    label,
    ...(!completeHead && tailTitle === undefined ? {} : { titleComplete: true as const }),
  }
}

type SessionLogHandle = Awaited<ReturnType<typeof open>>

export interface SessionTitleRecovery {
  readonly title: SessionTitle | undefined
  /** False means a damaged/oversized frame prevented a conclusive answer. */
  readonly complete: boolean
  /** Known only when a full no-title scan then reached/ruled out the prompt. */
  readonly hasPrompt?: boolean
}

/** Read exactly one stable range from an already-open snapshot. */
async function readRange(
  handle: SessionLogHandle,
  start: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    signal?.throwIfAborted()
    let bytesRead: number
    try {
      const result = await handle.read(buffer, filled, length - filled, start + filled)
      bytesRead = result.bytesRead
    } catch {
      signal?.throwIfAborted()
      return undefined
    }
    if (bytesRead === 0) return undefined
    filled += bytesRead
  }
  return buffer
}

/** A forward page beginning on a known frame boundary. */
async function forwardPage(
  handle: SessionLogHandle,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; frames: readonly FrameRange[] } | undefined> {
  const remaining = end - start
  let length = Math.min(TITLE_SCAN_PAGE_BYTES, remaining)
  while (length > 0) {
    const buffer = await readRange(handle, start, length, signal)
    if (buffer === undefined) return undefined
    const frames = walkFrames(buffer)
    if (frames.length > 0) return { buffer, frames }
    if (length >= remaining || length >= TITLE_SCAN_MAX_FRAME_BYTES) return undefined
    length = Math.min(remaining, TITLE_SCAN_MAX_FRAME_BYTES, length * 2)
  }
  return undefined
}

/** A reverse page ending on a known frame boundary. */
async function reversePage(
  handle: SessionLogHandle,
  end: number,
  signal?: AbortSignal,
): Promise<{ start: number; buffer: Buffer; frames: readonly FrameRange[] } | undefined> {
  let length = Math.min(TITLE_SCAN_PAGE_BYTES, end)
  while (length > 0) {
    const start = end - length
    const buffer = await readRange(handle, start, length, signal)
    if (buffer === undefined) return undefined
    const frames = start === 0 ? walkFrames(buffer) : resyncFrames(buffer)
    const last = frames[frames.length - 1]
    if (last !== undefined && last.end === buffer.length) return { start, buffer, frames }
    if (length >= end || length >= TITLE_SCAN_MAX_FRAME_BYTES) return undefined
    length = Math.min(end, TITLE_SCAN_MAX_FRAME_BYTES, length * 2)
  }
  return undefined
}

export interface SessionModelRecovery {
  readonly model: string | undefined
  readonly complete: boolean
}

interface LatestMetadata {
  readonly title: SessionTitle | undefined
  readonly titleComplete: boolean
  readonly model: string | undefined
  readonly modelComplete: boolean
}

/** One newest-to-oldest pass; each wanted fact is last-write-wins and conclusive once found. */
async function recoverLatestMetadata(
  path: string,
  bytes: number,
  want: { readonly title: boolean; readonly model: boolean },
  signal?: AbortSignal,
): Promise<LatestMetadata> {
  signal?.throwIfAborted()
  let title: SessionTitle | undefined
  let model: string | undefined
  let titleDone = !want.title
  let modelDone = !want.model
  const partial = (): LatestMetadata => ({ title, titleComplete: titleDone, model, modelComplete: modelDone })
  let handle: SessionLogHandle
  try {
    handle = await open(path, 'r')
  } catch {
    signal?.throwIfAborted()
    return partial()
  }
  try {
    let end = bytes
    while (end > 0 && !(titleDone && modelDone)) {
      signal?.throwIfAborted()
      const page = await reversePage(handle, end, signal)
      if (page === undefined) return partial()
      for (let frameIndex = page.frames.length - 1; frameIndex >= 0 && !(titleDone && modelDone); frameIndex--) {
        const lines = decodeFrame(page.buffer, page.frames[frameIndex]!)
        if (lines === undefined) return partial()
        for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
          if (!titleDone) titleDone = (title = titleOf(lines[lineIndex]!)) !== undefined
          if (!modelDone) modelDone = (model = modelOf(lines[lineIndex]!)) !== undefined
        }
        // Proving no route needs the session header; title absence never did.
        if (!modelDone && page.start === 0 && frameIndex === 0 && lines[0]?.['type'] !== 'session') {
          titleDone = true
          return partial()
        }
      }
      const nextEnd = page.start + page.frames[0]!.start
      if (nextEnd >= end) return partial()
      end = nextEnd
      await scheduler.yield()
    }
    return { title, titleComplete: true, model, modelComplete: modelDone || bytes > 0 }
  } finally {
    await handle.close().catch(() => {})
  }
}

export interface AppendedDigest {
  readonly title: SessionTitle | undefined
  readonly model: string | undefined
  readonly label: string | undefined
  readonly hasHumanPrompt: boolean
  /** Only a fully decoded suffix may be folded onto cached prefix facts. */
  readonly complete: boolean
}

/** Scan all newly appended frames from the previous EOF frame boundary. */
export async function digestAppendedSuffix(
  path: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<AppendedDigest> {
  signal?.throwIfAborted()
  let handle: SessionLogHandle
  try {
    handle = await open(path, 'r')
  } catch {
    signal?.throwIfAborted()
    return { title: undefined, model: undefined, label: undefined, hasHumanPrompt: false, complete: false }
  }
  let title: SessionTitle | undefined
  let model: string | undefined
  let label: string | undefined
  let hasHumanPrompt = false
  const result = (complete: boolean): AppendedDigest => ({ title, model, label, hasHumanPrompt, complete })
  try {
    let position = start
    while (position < end) {
      signal?.throwIfAborted()
      const page = await forwardPage(handle, position, end, signal)
      if (page === undefined) return result(false)
      for (const frame of page.frames) {
        const lines = decodeFrame(page.buffer, frame)
        if (lines === undefined) return result(false)
        for (const line of lines) {
          title = titleOf(line) ?? title
          model = modelOf(line) ?? model
          label = labelOf(line) ?? label
          hasHumanPrompt ||= humanPrompt(line) !== undefined
        }
      }
      const consumed = page.frames[page.frames.length - 1]!.end
      if (consumed <= 0) return result(false)
      position += consumed
      await scheduler.yield()
    }
    return result(true)
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Find the first human prompt after a complete reverse scan proved no title. */
async function recoverFirstPrompt(
  path: string,
  bytes: number,
  signal?: AbortSignal,
): Promise<{ prompt: string | undefined; complete: boolean; hasPrompt?: boolean }> {
  signal?.throwIfAborted()
  let handle: SessionLogHandle
  try {
    handle = await open(path, 'r')
  } catch {
    signal?.throwIfAborted()
    return { prompt: undefined, complete: false }
  }
  try {
    let position = 0
    let hasPrompt = false
    while (position < bytes) {
      signal?.throwIfAborted()
      const page = await forwardPage(handle, position, bytes, signal)
      if (page === undefined) return { prompt: undefined, complete: false }
      for (const frame of page.frames) {
        const lines = decodeFrame(page.buffer, frame)
        if (lines === undefined) return { prompt: undefined, complete: false }
        if (position === 0 && frame.start === 0 && lines[0]?.['type'] !== 'session') {
          return { prompt: undefined, complete: false }
        }
        for (const line of lines) {
          const prompt = humanPrompt(line)
          hasPrompt ||= prompt !== undefined
          if (prompt?.text !== undefined) return { prompt: prompt.text, complete: true, hasPrompt: true }
        }
      }
      const consumed = page.frames[page.frames.length - 1]!.end
      if (consumed <= 0) return { prompt: undefined, complete: false }
      position += consumed
      await scheduler.yield()
    }
    return { prompt: undefined, complete: bytes > 0, ...(bytes > 0 ? { hasPrompt } : {}) }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Fall back to the first human prompt only after a complete scan proved no title. */
async function titleRecovery(
  latest: LatestMetadata,
  path: string,
  bytes: number,
  signal?: AbortSignal,
): Promise<SessionTitleRecovery> {
  if (latest.title !== undefined || !latest.titleComplete) return { title: latest.title, complete: latest.titleComplete }
  const opening = await recoverFirstPrompt(path, bytes, signal)
  return {
    title: opening.prompt === undefined ? undefined : { text: opening.prompt, source: 'prompt' },
    complete: opening.complete,
    ...(opening.hasPrompt === undefined ? {} : { hasPrompt: opening.hasPrompt }),
  }
}

/**
 * Recover the requested display facts for one immutable file snapshot in a
 * single reverse pass: the LAST title and/or route, then (only when no title
 * exists) a forward scan for the FIRST human prompt. Pages stay on verified
 * frame boundaries.
 */
export async function recoverSessionMetadata(
  path: string,
  bytes: number,
  want: { readonly title: boolean; readonly model: boolean },
  signal?: AbortSignal,
): Promise<{ title?: SessionTitleRecovery; model?: SessionModelRecovery }> {
  const latest = await recoverLatestMetadata(path, bytes, want, signal)
  return {
    ...(want.title ? { title: await titleRecovery(latest, path, bytes, signal) } : {}),
    ...(want.model ? { model: { model: latest.model, complete: latest.modelComplete } } : {}),
  }
}

/** Title-only recovery; see {@link recoverSessionMetadata}. */
export async function recoverSessionTitle(path: string, bytes: number, signal?: AbortSignal): Promise<SessionTitleRecovery> {
  return titleRecovery(await recoverLatestMetadata(path, bytes, { title: true, model: false }, signal), path, bytes, signal)
}

/** Route-only recovery; absence is proven only by a complete scan reaching the session header. */
export async function recoverSessionModel(path: string, bytes: number, signal?: AbortSignal): Promise<SessionModelRecovery> {
  const latest = await recoverLatestMetadata(path, bytes, { title: false, model: true }, signal)
  return { model: latest.model, complete: latest.modelComplete }
}

/** Hash the previous EOF neighborhood; this detects replacement near the old tail. */
export async function sessionTitleAnchor(
  path: string,
  bytes: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  let handle: SessionLogHandle
  try {
    handle = await open(path, 'r')
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
  try {
    const length = Math.min(TITLE_ANCHOR_BYTES, bytes)
    const buffer = length === 0 ? Buffer.alloc(0) : await readRange(handle, bytes - length, length, signal)
    if (buffer === undefined) return undefined
    return createHash('sha256').update(buffer).digest('hex')
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * The last exchanges of a session, for the browser's preview pane.
 *
 * Bounded like everything else here: the preview shows the end of the
 * conversation because that is what the tail window holds, and because the end
 * is what tells you whether this is the session you meant.
 *
 * @param path - Absolute artifact path.
 * @param limit - How many entries to keep, newest last.
 * @returns Entries in log order.
 */
export function previewSession(path: string, limit: number): PreviewEntry[] {
  const window = readWindow(path, TAIL_WINDOW_BYTES, true)
  if (window === undefined) return []
  const lines = decodeTail(window)
  const entries: PreviewEntry[] = []
  for (const line of lines) {
    const data = line['data']
    if (data === null || typeof data !== 'object') continue
    const record = data as Record<string, unknown>
    if (line['type'] === 'user/message') {
      if (!isHumanSource(record['source'])) continue
      const text = textOfContent(record['content'])
      if (text !== undefined) entries.push({ role: 'user', text: text.slice(0, PREVIEW_CHARS), at: timeOf(line) })
      continue
    }
    if (line['type'] === 'assistant/message') {
      const message = record['message']
      if (message === null || typeof message !== 'object') continue
      const text = textOfContent((message as Record<string, unknown>)['content'])
      if (text !== undefined) {
        entries.push({ role: 'assistant', text: text.slice(0, PREVIEW_CHARS), at: timeOf(line) })
      }
    }
  }
  return entries.slice(-limit)
}
