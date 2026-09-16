/**
 * DSH credential-store presence checks.
 *
 * The store is a small YAML document at `$DSH_HOME/.credentials.yaml` whose
 * top-level `refs:` block maps reference names (for example `DEEPSEEK_API_KEY`)
 * to stored secrets. dsh resolves those refs into a session at launch, so an
 * environment-only check reports "missing" for a key that works. This module
 * only ever answers "is a ref declared": the value is never read, formatted, or
 * logged. The launcher keeps a mirror of this check in `bin/dsh-tui.js` (it is
 * dependency-free and cannot import `lib/`); the two must not diverge.
 * @module dsh-tui/utils/credentials
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The DSH home that owns the credential store, following the launcher's rule. */
export function dshHomeDir(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Whether the DSH credential store declares a reference by this name.
 *
 * Only the top-level `refs:` block is inspected — the bare name also appears in
 * grants and payloads, where a match would be a false positive.
 * @param name - Reference name to look for (for example `DEEPSEEK_API_KEY`).
 * @param home - DSH home override; defaults to {@link dshHomeDir}.
 * @returns True when a `refs` entry with that name exists.
 */
export function credentialRefDeclared(name: string, home: string = dshHomeDir()): boolean {
  try {
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const block = /^refs:[ \t]*\r?\n((?:[ \t]+\S.*(?:\r?\n|$))*)/mu.exec(text)
    if (block === null) return false
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`^[ \t]+${escaped}[ \t]*:`, 'mu').test(block[1] ?? '')
  } catch {
    return false
  }
}
