import type { FileCandidate, FileCandidateKind, MentionCandidate, ProvidedMentionCandidate } from '../adapter/ports/channel-catalog.js'
export type { FileCandidate, FileCandidateKind, MentionCandidate, ProvidedMentionCandidate } from '../adapter/ports/channel-catalog.js'


export interface FileSuggestionOptions {
  topK?: number
  maxFiles?: number
  maxDirectories?: number
}

const pathSeparators = /[\\/]/

export function isPathLikeQuery(query: string): boolean {
  return query.startsWith('.') || query.startsWith('~') || query.startsWith('/') || /^[A-Za-z]:[\\/]/.test(query) || pathSeparators.test(query)
}

export function fuzzySubsequenceScore(query: string, candidate: string): number | undefined {
  const needle = query.toLocaleLowerCase()
  const haystack = candidate.toLocaleLowerCase()
  if (!needle) return 0
  let cursor = 0
  let first = -1
  let gaps = 0
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor)
    if (found === -1) return undefined
    if (first === -1) first = found
    gaps += found - cursor
    cursor = found + 1
  }
  const prefixBonus = first === 0 ? 20 : 0
  const boundaryBonus = first > 0 && /[\\/_. -]/.test(haystack[first - 1] ?? '') ? 8 : 0
  return needle.length * 10 + prefixBonus + boundaryBonus - gaps - haystack.length / 100
}

export function rankFileCandidates(candidates: readonly FileCandidate[], query: string, topK = 50): FileCandidate[] {
  const ranked = candidates
    .map(candidate => ({ ...candidate, score: fuzzySubsequenceScore(query, `${candidate.path} ${candidate.name}`) ?? -Infinity }))
    .filter(candidate => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path))
  return ranked.slice(0, Math.max(0, topK))
}

/**
 * Merge plugin provider rows (tuiMentions) into the ranked file list. Files
 * keep their order; a provider row is scored with the same fuzzy scorer on
 * its label and placed before the first file it outscores (a tie goes to the
 * file), and rows whose label does not match `query` follow in provider order.
 * Returns `files` itself when there is nothing to merge, so a host without
 * providers renders the file-only list unchanged.
 */
export function mergeMentionCandidates(
  files: readonly FileCandidate[],
  provided: readonly ProvidedMentionCandidate[],
  query: string,
): readonly MentionCandidate[] {
  if (provided.length === 0) return files
  const scored = provided.map((candidate, order) => ({
    candidate,
    order,
    score: fuzzySubsequenceScore(query, candidate.label) ?? -Infinity,
  }))
  const matched = scored
    .filter(entry => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || a.order - b.order)
  const merged: MentionCandidate[] = []
  let next = 0
  for (const file of files) {
    while (next < matched.length && matched[next]!.score > file.score) merged.push(matched[next++]!.candidate)
    merged.push(file)
  }
  while (next < matched.length) merged.push(matched[next++]!.candidate)
  for (const entry of scored) if (!Number.isFinite(entry.score)) merged.push(entry.candidate)
  return merged
}

export function preserveSelection<T extends { readonly id: string }>(previous: T | undefined, next: readonly T[], fallback = 0): number {
  if (previous) {
    const index = next.findIndex(candidate => candidate.id === previous.id)
    if (index >= 0) return index
  }
  return next.length === 0 ? 0 : Math.min(Math.max(0, fallback), next.length - 1)
}
