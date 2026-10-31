/**
 * Data-directory paths for the dsh-tui profile. All preferences and history
 * live under `~/.dsh-tui`.
 *
 * The compiled copy (lib/types/utils/paths.js) is also imported by the bin
 * launcher, mirroring the shellQuote precedent.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The user's home directory. `os.homedir()` first; the USERPROFILE/HOME
 * spellings are the last-resort fallback for stripped-down environments.
 * @returns Absolute home path.
 */
export function homeDir(): string {
  return homedir() || process.env.USERPROFILE || process.env.HOME || ''
}

/** Data directory all preferences/history live in (`~/.dsh-tui`). */
export const DATA_DIR = join(homeDir(), '.dsh-tui')

/**
 * Expand a leading literal `~/` or `~\` to the user's home directory.
 *
 * Only the literal prefix is expanded: `~user/`, a bare `~` and environment
 * variables are left alone (the shell semantics users expect from `@` paths).
 * Both separators are recognized on every platform — whether the prefix
 * expands must not depend on `path.sep`, because typed input can carry either
 * spelling. `@` completion and `@` mention resolution both go through here, so
 * `~/…` means the same thing in the menu and in the attachment it produces
 * (issue #1706).
 *
 * @param path - User-typed path, possibly starting with `~/` or `~\`.
 * @returns Absolute home path when the prefix was `~/`/`~\`; `path` otherwise.
 */
export function expandHomePrefix(path: string): string {
  if (!path.startsWith('~/') && !path.startsWith('~\\')) return path
  // The remainder keeps the user's spelling, separators aside: once the prefix
  // has declared a home path, `~\Downloads\note.txt` names the same file as
  // `~/Downloads/note.txt` on every host (`@` completion already normalizes
  // backslashes this way), so the rest is normalized to `/` and `join` applies
  // the platform separator. A bare `~`, `~user/` and env vars are still left
  // alone.
  return join(homeDir(), path.slice(2).replaceAll('\\', '/'))
}

/**
 * Where one backend keeps its own files: `<dataRoot>/backends/<id>`, keyed by
 * the backend's declared id (the `x-dsh-tui` Backend entry's `spec.id` field).
 * The single construction point, so a check for what a removal
 * left behind reads the same path the backend wrote to (C-5).
 *
 * `dataRoot` defaults to this profile's own `~/.dsh-tui`. It is a parameter so
 * that a regression can point the whole check at a temporary tree, exactly like
 * the diagnostics' own `dataDir` override.
 */
export function backendDataDir(backendId: string, dataRoot: string = DATA_DIR): string {
  return join(dataRoot, 'backends', backendId)
}
