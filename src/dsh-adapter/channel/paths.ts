import { join } from 'node:path'
import { rankFileCandidates, type FileCandidate } from '../../utils/fileSuggestions.js'
import { homeDir } from '../../utils/paths.js'
import type { FileSuggestionFs } from './types.js'

/** Trailing path segment (`C:/a/b` → `b`). */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** Normalize a cwd for comparison: forward slashes, no trailing slash; case
 *  folded when the platform's filesystem semantics are case-insensitive. */
export function normalizeCwd(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

/**
 * `/resume` project filter (issue #96): exact cwd match, PLUS sessions
 * recorded in a subdirectory — pre-upgrade launches recorded the launch
 * subdirectory as the header cwd, and with the cwd default now resolving to
 * the git worktree root an exact match would hide those sessions forever.
 * They belong to the same workspace, so they stay listed. Comparison follows
 * the platform's filesystem semantics (case-insensitive on Windows — a
 * pre-upgrade header may record `C:\Repo` where the current launch resolves
 * `c:\repo`). `caseInsensitive` is a parameter (not a platform read) so the
 * verifier can exercise both modes on any host. Exported for
 * scripts/verify-session-cwd.mjs.
 *
 * Boundary rule (issue #153): container directories are nobody's workspace.
 * $HOME and the Windows root forms — plain drive roots (`C:`), UNC share
 * roots (`//server/share`), and extended-length roots (`//?/C:`,
 * `//?/UNC/server/share`) — are ancestors of unrelated projects, so the
 * descendant rules below would list every session on the machine from `~`
 * (and every session on the drive/share from those roots). At these
 * boundaries, in either direction, only an exact match passes.
 */
export function sessionCwdMatches(
  stateCwd: string,
  headerCwd: string,
  caseInsensitive: boolean = process.platform === 'win32',
): boolean {
  const cwd = normalizeCwd(stateCwd, caseInsensitive)
  const recorded = normalizeCwd(headerCwd, caseInsensitive)
  if (recorded === '' || cwd === '') return false
  const home = normalizeCwd(homeDir(), caseInsensitive)
  // Paths below arrive backslash-normalized (`\\server\share` →
  // `//server/share`, `\\?\C:\` → `//?/C:`), trailing slashes stripped.
  const isContainer = (path: string): boolean =>
    (home !== '' && path === home) ||
    /^[a-z]:$/i.test(path) || // drive root: C:
    /^\/\/[^/]+\/[^/]+$/.test(path) || // UNC share root: //server/share
    /^\/\/\?\/[a-z]:$/i.test(path) || // extended drive root: //?/C:
    /^\/\/\?\/unc\/[^/]+\/[^/]+$/i.test(path) // extended UNC root: //?/UNC/server/share
  if (isContainer(cwd) || isContainer(recorded)) return recorded === cwd
  return (
    recorded === cwd ||
    // Pre-upgrade subdirectory session of this workspace.
    recorded.startsWith(`${cwd}/`) ||
    // Resumed INTO a pre-upgrade subdirectory session (state.cwd adopted its
    // recorded subdirectory): the workspace-root sessions it belongs with
    // must stay visible, or /resume looks like it lost them for the rest of
    // the process lifetime (review leftover).
    cwd.startsWith(`${recorded}/`)
  )
}

export async function listPathCandidates(fs: FileSuggestionFs, cwd: string, query: string, signal: AbortSignal | undefined, topK: number): Promise<FileCandidate[]> {
  const normalized = query.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  // `.` / `..` without a trailing separator are whole-directory queries too.
  const bareDir = slash < 0 && (normalized === '.' || normalized === '..' || normalized === '~')
  const directoryPart = slash < 0 ? (bareDir ? `${normalized}/` : '') : normalized.slice(0, slash + 1)
  const nameQuery = slash < 0 || bareDir ? '' : normalized.slice(slash + 1)
  // `~/` expands against the host home (matches the cwd resolution rules);
  // drive-letter and POSIX-absolute prefixes pass through untouched.
  const expanded = directoryPart === '~/'
    ? `${homeDir()}/`
    : directoryPart.startsWith('/') || /^[A-Za-z]:\//.test(directoryPart)
      ? directoryPart
      : join(cwd, directoryPart || '.')
  try {
    if (signal?.aborted) return []
    const target = await fs.resolve(expanded)
    const entries = (await fs.listDir(target)).slice().sort((a, b) => a.name.localeCompare(b.name))
    return rankFileCandidates(entries.filter(entry => entry.type === 'file' || entry.type === 'directory').map(entry => {
      const path = `${directoryPart}${entry.name}${entry.type === 'directory' ? '/' : ''}`
      return { id: path, path, displayPath: path, name: entry.name, kind: entry.type as 'file' | 'directory', score: 0 }
    }), nameQuery, topK)
  } catch {
    return []
  }
}

export async function listFilesDeepCandidates(fs: FileSuggestionFs | undefined, root: string, signal?: AbortSignal): Promise<FileCandidate[]> {
  if (!fs) return []
  const out: FileCandidate[] = []
  const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store', 'dist'])
  const BUILD_DIR = /^(?:build(?:[-_].*)?|cmake-build(?:[-_].*)?)$/i
  type Entry = { name: string; type: 'file' | 'directory' | 'other'; target?: { displayPath: string } }
  type Node = { dir: string; prefix: string; entries?: Entry[]; index: number }
  const queue: Node[] = [{ dir: root, prefix: '', index: 0 }]
  const visited = new Set<string>()
  const maxFiles = 100
  const maxDirectories = 100
  let fileCount = 0
  let dirCount = 0
  // Round-robin: each directory yields ONE non-skipped entry per visit before
  // it re-queues, so a large early sibling (e.g. `generated/` with 120 files)
  // cannot starve `src/` out of the per-kind budgets. This is the regression
  // contract pinned by scripts/verify-file-completion.mjs.
  while (queue.length && fileCount < maxFiles && dirCount < maxDirectories) {
    if (signal?.aborted) return []
    const current = queue.shift()!
    if (!current.entries) {
      try {
        const target = await fs.resolve(current.dir)
        if (visited.has(target.displayPath)) continue
        visited.add(target.displayPath)
        current.entries = (await fs.listDir(target)).slice().sort((a, b) => a.name.localeCompare(b.name))
      } catch { continue }
    }
    let entry: Entry | undefined
    while (current.index < current.entries.length) {
      const candidate = current.entries[current.index++]!
      if (SKIP.has(candidate.name) || BUILD_DIR.test(candidate.name)) continue
      entry = candidate
      break
    }
    if (!entry) continue
    if (current.index < current.entries.length) queue.push(current)

    const path = current.prefix ? `${current.prefix}/${entry.name}` : entry.name
    if (entry.type === 'directory') {
      if (dirCount >= maxDirectories) continue
      out.push({ id: `${path}/`, path: `${path}/`, displayPath: `${path}/`, name: entry.name, kind: 'directory', score: 0 })
      dirCount += 1
      queue.push({ dir: entry.target?.displayPath ?? join(current.dir, entry.name), prefix: path, index: 0 })
    } else if (entry.type === 'file') {
      if (fileCount >= maxFiles) continue
      out.push({ id: path, path, displayPath: path, name: entry.name, kind: 'file', score: 0 })
      fileCount += 1
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
