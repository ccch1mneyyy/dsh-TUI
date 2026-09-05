import type { FileCandidate } from '../../utils/fileSuggestions.js'
import { isPathLikeQuery, rankFileCandidates } from '../../utils/fileSuggestions.js'
import { listFilesDeepCandidates, listPathCandidates } from './paths.js'
import type { MentionFs } from './types.js'

/** Workspace file queries and their per-cwd scan cache. */
export function createFileActions(deps: {
  owner: { current(): boolean; readonly signal: AbortSignal }
  capture(): unknown
  current(capture: unknown): boolean
  cwd(): string
  fs(): MentionFs | undefined
}) {
  let cache: { cwd: string; load?: Promise<readonly FileCandidate[]> } = { cwd: '' }
  const isCurrent = (capture: unknown, cwd: string): boolean =>
    deps.owner.current() && deps.current(capture) && deps.cwd() === cwd
  const withOwnerSignal = (signal?: AbortSignal): AbortSignal =>
    signal === undefined ? deps.owner.signal : AbortSignal.any([signal, deps.owner.signal])

  const listFileCandidates = async (
    query: string,
    options?: { signal?: AbortSignal; topK?: number },
  ): Promise<readonly FileCandidate[]> => {
    const capture = deps.capture()
    const cwd = deps.cwd()
    const fs = deps.fs()
    const signal = withOwnerSignal(options?.signal)
    if (!fs || signal.aborted || !isCurrent(capture, cwd)) return []
    if (isPathLikeQuery(query)) {
      const result = await listPathCandidates(fs, cwd, query, signal, options?.topK ?? 50)
      return isCurrent(capture, cwd) && !signal.aborted ? result : []
    }
    if (cache.cwd !== cwd) cache = { cwd }
    const scan = cache
    // The scan belongs to this Channel/CWD cache entry, not to its first
    // waiter. A caller cancellation only suppresses that caller's result;
    // owner disposal remains the shared scan's cancellation fence.
    scan.load ??= listFilesDeepCandidates(fs, cwd, deps.owner.signal).then(candidates => {
      // Do not retain a cancelled/empty observation; a later request may have
      // a live owner or find files that appeared after this scan. An older
      // CWD scan must not clear a newer entry after it settles.
      if (candidates.length === 0 && cache === scan) scan.load = undefined
      return candidates
    })
    const candidates = await scan.load
    if (!isCurrent(capture, cwd) || signal.aborted) return []
    return rankFileCandidates(candidates, query, options?.topK ?? 50)
  }

  const listFiles = async (): Promise<readonly string[]> => {
    const capture = deps.capture()
    const cwd = deps.cwd()
    const candidates = await listFilesDeepCandidates(deps.fs(), cwd, deps.owner.signal)
    return isCurrent(capture, cwd) ? candidates.map(candidate => candidate.path) : []
  }

  return { listFileCandidates, listFiles }
}
