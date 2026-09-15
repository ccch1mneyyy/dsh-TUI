/**
 * Local directory browsing for the workspace home screen's "add workspace"
 * picker.
 *
 * Read-only and local: the picker only ever needs to show what directories
 * exist under a path so the user can click one. It is deliberately NOT a
 * provider seam — a remote/host directory picker is what `TuiWorkspaceProvider`
 * exists for, and this module is the LOCAL provider's own listing, matching
 * `createLocalWorkspaceRuntime`'s precedence (local paths first, provider URIs
 * routed to their owner).
 *
 * @module @deepseek-harness-tui/dsh-tui/utils/directoryBrowse
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'

/** One subdirectory row in the picker. */
export interface DirectoryEntry {
  /** Directory name (the final segment). */
  readonly name: string
  /** Absolute path, resolved against the directory the listing came from. */
  readonly path: string
}

/**
 * Expand a `~`-prefixed path against the user's home directory.
 *
 * Only a leading `~` or `~/` (`~\` on Windows) is expanded — a `~` elsewhere is
 * a literal character in a directory name, and rewriting it would invent a path
 * the user did not type.
 *
 * @param path - Raw user input.
 * @returns An absolute path when the input is absolute (or `~`-prefixed),
 *   otherwise the input resolved against `cwd`.
 */
export function expandUserPath(path: string, cwd: string = process.cwd()): string {
  const trimmed = path.trim()
  if (trimmed === '') return resolve(cwd)
  if (trimmed === '~') return resolve(homedir())
  if (/^~[\\/]/u.test(trimmed)) return resolve(homedir(), trimmed.slice(2))
  if (isAbsolute(trimmed)) return resolve(trimmed)
  return resolve(cwd, trimmed)
}

/** Whether `path` is a filesystem root (has no parent). */
export function isRootPath(path: string): boolean {
  const parsed = parse(resolve(path))
  return parsed.root === parsed.dir
}

/**
 * The parent directory, or `path` itself when it is a root.
 *
 * `dirname` on a root returns the root, which is what the picker's "up" action
 * needs — a dead end rather than a crash.
 */
export function parentOf(path: string): string {
  const resolved = resolve(path)
  return isRootPath(resolved) ? resolved : resolve(dirname(resolved))
}

/**
 * Every directory directly under `path`, case-insensitively sorted by name.
 *
 * Unreadable subdirectories are filtered out by their own `stat`-free type
 * check: `readdirSync(withFileTypes)` reports a symlink to a directory as a
 * symlink, so entries are re-checked with `statSync` and anything that throws
 * (a broken link, a permission wall) is skipped rather than failing the whole
 * listing. Files and non-directory specials are never returned.
 *
 * @param path - Absolute directory to list.
 * @returns The subdirectories; empty when the directory holds none.
 * @throws The underlying `fs` error when `path` itself cannot be read (the
 *   caller reports it as a notice, which is why this is not swallowed here).
 */
export function listDirectories(path: string): DirectoryEntry[] {
  const base = resolve(path)
  const out: DirectoryEntry[] = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      // Hidden directories are noise in a workspace picker; a dot-directory is
      // almost never the project root. Dotfiles are not listed at all.
      continue
    }
    let isDirectory = entry.isDirectory()
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(join(base, entry.name)).isDirectory()
      } catch {
        continue
      }
    }
    if (!isDirectory) continue
    out.push({ name: entry.name, path: join(base, entry.name) })
  }
  out.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  return out
}

/** Absolute path for a child of `parent` (display helper for the picker). */
export function childPath(parent: string, name: string): string {
  return join(parent, name)
}
