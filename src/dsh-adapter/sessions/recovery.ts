/** Best-effort, process-local deep title recovery outside the listing path. */
import { fileFacts } from './frames.js'
import { recoverSessionTitle } from './digest.js'
import { indexFileStamp, readIndex, writeIndex, type DerivedEntry } from './store.js'

interface RecoveryWork {
  readonly id: string
  readonly revision: string
  readonly path: string
  readonly bytes: number
  readonly stamp: string
  readonly priority: number
  readonly listeners: Set<(derived: DerivedEntry) => void>
}

const pending = new Map<string, RecoveryWork>()
const retries = new Map<string, { revision: string; attempts: number; retryAfter: number }>()
const RETRY_DELAYS = [1000, 5000, 30_000, 300_000] as const
let running: RecoveryWork | undefined
let scheduled = false

function deferRetry(work: RecoveryWork): void {
  const old = retries.get(work.id)
  const attempts = old?.revision === work.revision ? old.attempts + 1 : 1
  retries.set(work.id, {
    revision: work.revision,
    attempts,
    retryAfter: Date.now() + RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]!,
  })
}

function kick(): void {
  if (scheduled || running !== undefined || pending.size === 0) return
  scheduled = true
  setImmediate(() => {
    scheduled = false
    if (running !== undefined) return
    const work = [...pending.values()].sort((a, b) => b.priority - a.priority)[0]
    if (work === undefined) return
    pending.delete(work.id)
    running = work
    void recover(work).finally(() => {
      running = undefined
      kick()
    })
  })
}

async function recover(work: RecoveryWork): Promise<void> {
  try {
    const recovered = await recoverSessionTitle(work.path, work.bytes)
    const facts = fileFacts(work.path)
    if (facts?.stamp !== work.stamp) return
    if (!recovered.complete) {
      deferRetry(work)
      return
    }
    const stamp = indexFileStamp()
    const index = readIndex()
    const entry = index.get(work.id)
    if (entry?.derived?.revision !== work.revision || entry.derived.titleComplete) return
    const derived: DerivedEntry = {
      ...entry.derived,
      title: recovered.title?.text ?? '',
      titleSource: recovered.title?.source ?? 'fallback',
      titleComplete: true,
      hasPrompt: recovered.hasPrompt ?? entry.derived.hasPrompt,
    }
    index.set(work.id, { ...entry, derived })
    if (indexFileStamp() !== stamp) return
    writeIndex(index)
    retries.delete(work.id)
    for (const listener of work.listeners) {
      try { listener(derived) } catch { /* UI observers cannot fail recovery. */ }
    }
  } catch {
    // An unreadable or changing artifact remains visible with conservative
    // metadata. Reopen retries under backoff, or immediately on revision change.
    deferRetry(work)
  }
}

/** Deduplicate recovery per session/revision and retry damaged logs with backoff. */
export function scheduleTitleRecovery(work: Omit<RecoveryWork, 'listeners'>, onComplete?: (derived: DerivedEntry) => void): void {
  const retry = retries.get(work.id)
  if (retry?.revision !== work.revision) retries.delete(work.id)
  else if (Date.now() < retry.retryAfter) return
  const existing = pending.get(work.id) ?? (running?.id === work.id ? running : undefined)
  if (existing?.revision === work.revision) {
    if (onComplete !== undefined) existing.listeners.add(onComplete)
    return
  }
  const listeners = new Set<(derived: DerivedEntry) => void>()
  if (onComplete !== undefined) listeners.add(onComplete)
  pending.set(work.id, { ...work, listeners })
  kick()
}

/** A queued or backed-off revision needs no path lookup on another open. */
export function titleRecoveryNeedsWork(id: string, revision: string, onComplete?: (derived: DerivedEntry) => void): boolean {
  const existing = [pending.get(id), running?.id === id ? running : undefined]
    .find(item => item?.revision === revision)
  if (existing?.revision === revision) {
    if (onComplete !== undefined) existing.listeners.add(onComplete)
    return false
  }
  const retry = retries.get(id)
  return retry?.revision !== revision || Date.now() >= retry.retryAfter
}
