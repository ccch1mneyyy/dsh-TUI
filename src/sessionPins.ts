/**
 * Pinned sessions for the `/resume` browser, kept at
 * `~/.dsh-tui/session-pins.json` (a JSON array of session ids) so the pins
 * survive restarts — same best-effort pattern as model.json / last-used.json.
 *
 * The pin key is the DSH session id (`SessionSummary.id`, from the session
 * header): stable across log revisions, unlike the index cache's
 * file-identity/revision tokens. Ids whose sessions no longer exist are
 * tolerated forever — this file is a preference, not an index, so a stale
 * entry costs nothing and the browser filters pins against the live listing
 * instead of rewriting the file.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const PINS_FILE = 'session-pins.json'

/**
 * The persisted pin set, or empty when unset or unreadable.
 * @param dir - Prefs directory (injectable for tests).
 */
export function readSessionPins(dir: string = DATA_DIR): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, PINS_FILE), 'utf8'))
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))
  } catch {
    return new Set()
  }
}

/**
 * Persist the pin set (best effort — a failed write never breaks the browser;
 * the in-memory set stays and the next toggle retries the whole file).
 * @param ids - Every pinned session id, in any order.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeSessionPins(ids: Iterable<string>, dir: string = DATA_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, PINS_FILE), JSON.stringify([...ids], null, 2))
    return true
  } catch {
    return false
  }
}
