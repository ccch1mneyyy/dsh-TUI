export type FileCandidateKind = 'file' | 'directory'

export interface FileCandidate {
  id: string
  path: string
  displayPath: string
  name: string
  kind: FileCandidateKind
  score: number
}

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

export function preserveSelection(previous: FileCandidate | undefined, next: readonly FileCandidate[], fallback = 0): number {
  if (previous) {
    const index = next.findIndex(candidate => candidate.id === previous.id)
    if (index >= 0) return index
  }
  return next.length === 0 ? 0 : Math.min(Math.max(0, fallback), next.length - 1)
}
