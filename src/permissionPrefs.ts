/**
 * Persisted DSH permission-preset preference (`~/.dsh-tui/permission.json`,
 * `{ "permission": "danger-full-access" }`): the last permission preset the
 * user switched to through `/permission` (picker or typed) or the Shift+Tab
 * mode cycle, so the next session STARTS where the last one ended instead of
 * the composition default. The Claude and Codex backends keep the same
 * memory inside their own `~/.dsh-tui/backends/<id>/prefs.json`; this file
 * is the DSH twin, consumed on the channel's first bind per session.
 *
 * Only the identity is stored — never sandbox/approval atoms — and it is
 * re-applied exclusively through the official `/permission` switch path
 * (mode-permission.ts), so the durable session log remains the source of
 * truth. A value the running preset roster no longer offers is skipped, and
 * an explicit `DSH_PERMISSION_MODE` deployment pin outranks the file.
 *
 * Best effort like the other ~/.dsh-tui preferences: a missing or corrupt
 * file reads as no preference; a failed write is silent (debug log).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCommandCompletionToken } from './commands.js'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR

/**
 * The persisted permission-preset identity, or undefined when unset or
 * invalid. Only safe command tokens survive (the value is re-driven through
 * the official `/permission <preset>` path, which requires one).
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted preset id, if any.
 */
export function readPermissionPref(dir: string = PREFS_DIR): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'permission.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const permission = (parsed as Record<string, unknown>).permission
    if (typeof permission !== 'string') return undefined
    const id = permission.trim()
    return id !== '' && isCommandCompletionToken(id) ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the chosen permission-preset identity (best effort).
 * @param permission - Preset id to persist (already validated by the caller).
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writePermissionPref(permission: string, dir: string = PREFS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'permission.json'), JSON.stringify({ permission }, null, 2))
    return true
  } catch {
    return false
  }
}
