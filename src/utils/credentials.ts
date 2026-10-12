/**
 * DSH credential-store presence checks.
 *
 * The store is a small YAML document at `$DSH_HOME/.credentials.yaml` whose
 * top-level `refs:` block maps reference names (for example `DEEPSEEK_API_KEY`)
 * to stored secrets. dsh resolves those refs into a session at launch, so an
 * environment-only check reports "missing" for a key that works. A read also
 * consults the default `~/.dsh` store ({@link credentialStoreFiles}), so a
 * `DSH_HOME` override does not orphan keys stored at the documented location.
 * This module only ever answers "is a ref declared": the value is never read,
 * formatted, or logged. The launcher keeps a mirror of this check in
 * `bin/dsh-tui.js` (it is dependency-free and cannot import `lib/`); the two
 * must not diverge.
 * @module dsh-tui/utils/credentials
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The DSH home that owns the credential store, following the launcher's rule. */
export function dshHomeDir(): string {
  // `||`, not `??`: the launcher resolves the same root as
  // `process.env.DSH_HOME || join(homedir(), '.dsh')` (bin/dsh-tui.js), so an
  // empty `DSH_HOME=` — a common way to spell "unset" in scripts — must fall
  // back here too instead of turning every path into a relative one.
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * The credential documents a read may consult, most authoritative first: the
 * active home's store, then the default `~/.dsh` store.
 *
 * A `DSH_HOME` override moves the harness home, but the codex bridge and
 * `/doctor` are dsh-tui's own surfaces: a key the user stored at the location
 * both READMEs name (`~/.dsh/.credentials.yaml`) must keep working instead of
 * reporting "missing" for a key that is sitting right there.
 * @param home - DSH home override; defaults to {@link dshHomeDir}.
 * @returns Candidate file paths, most authoritative first.
 */
export function credentialStoreFiles(home: string = dshHomeDir()): readonly string[] {
  const active = join(home, '.credentials.yaml')
  const fallback = join(homedir(), '.dsh', '.credentials.yaml')
  return active === fallback ? [active] : [active, fallback]
}

/** Whether one document declares `name` in its top-level `refs:` block. */
function refDeclaredIn(file: string, name: string): boolean {
  try {
    const text = readFileSync(file, 'utf8')
    const block = /^refs:[ \t]*\r?\n((?:[ \t]+\S.*(?:\r?\n|$))*)/mu.exec(text)
    if (block === null) return false
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`^[ \t]+${escaped}[ \t]*:`, 'mu').test(block[1] ?? '')
  } catch {
    return false
  }
}

/**
 * Whether any credential store declares a reference by this name.
 *
 * Only the top-level `refs:` block is inspected — the bare name also appears in
 * grants and payloads, where a match would be a false positive.
 * @param name - Reference name to look for (for example `DEEPSEEK_API_KEY`).
 * @param home - DSH home override; defaults to {@link dshHomeDir}.
 * @returns True when a `refs` entry with that name exists in any store.
 */
export function credentialRefDeclared(name: string, home: string = dshHomeDir()): boolean {
  return credentialStoreFiles(home).some(file => refDeclaredIn(file, name))
}
