/**
 * Maintainer cost rule (2026-10-02): every real-CLI run — live tests, probes,
 * fixture recordings — uses haiku only, never sonnet or opus. Live tests call
 * {@link pinHaikuOrExit} before opening a session: it pins the child's
 * `ANTHROPIC_MODEL` to haiku and refuses to run when anything would point the
 * session elsewhere (an `ANTHROPIC_MODEL` / alias override in the
 * environment, or a persisted `/model` choice in the Claude backend's prefs
 * file, which wins over the environment at session start).
 *
 * Real model SWITCHING is covered by the fake-SDK `verify-claude-controls`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The only model a real-CLI run may use. */
export const LIVE_MODEL = 'haiku'

/** Whether a model id / alias names haiku. */
export function isHaiku(model) {
  return typeof model === 'string' && /haiku/iu.test(model)
}

/**
 * Pin haiku for this process's Claude children, or exit (status 2) when the
 * requested model is not haiku.
 * @param {string} label - The script name for the refusal message.
 * @param {string} dataDir - The dsh-tui data directory (`~/.dsh-tui`).
 */
export function pinHaikuOrExit(label, dataDir) {
  const refuse = (what) => {
    console.error(`${label}: refusing to run — ${what}; real-CLI runs use haiku only`)
    process.exit(2)
  }
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
    const value = process.env[name]
    if (value !== undefined && value !== '' && !isHaiku(value)) refuse(`${name}=${value}`)
  }
  let persisted
  try {
    persisted = JSON.parse(readFileSync(join(dataDir, 'backends', 'claude', 'prefs.json'), 'utf8')).model
  } catch {
    persisted = undefined
  }
  if (persisted !== undefined && persisted !== null && persisted !== '' && !isHaiku(persisted)) {
    refuse(`the persisted /model choice is ${persisted} (backends/claude/prefs.json)`)
  }
  process.env.ANTHROPIC_MODEL = LIVE_MODEL
}
