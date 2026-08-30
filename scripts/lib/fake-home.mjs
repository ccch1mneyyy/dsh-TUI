/**
 * Redirect HOME/USERPROFILE to a fresh temp dir BEFORE any lib import, so
 * DATA_DIR-derived prefs (`~/.dsh-tui/session-pins.json`, …) resolve inside
 * a throwaway sandbox instead of the real user home. Import this module
 * FIRST: `DATA_DIR` and friends are module-level constants resolved at
 * import time (same isolation trick as verify-data-file-perms.tsx).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'verify-session-browser-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

export default fakeHome
