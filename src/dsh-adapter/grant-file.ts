/**
 * The write half of the plugin grant file (`~/.dsh-tui/extension-grants.json`).
 *
 * `../adapter/standard/grants.ts` answers "may this operation run"; it has
 * always been read-only, and the only writer used to be the person editing the
 * file. The lifecycle flows (`./plugin-install.ts`, `./plugin-manage.ts`) need
 * to grant a package's declared permissions on install/enable, revoke them on
 * disable and forget them on removal, so this module owns the file I/O and
 * nothing else: the document's shape and what a valid rewrite looks like stay
 * in the reader's own module.
 *
 * Three rules decide the shape of this file:
 *
 * - **Never repair the person's file.** A corrupt document (bad JSON, an
 *   unknown root key, a malformed rule, zero bytes) is refused with a reason;
 *   the caller reports it and carries on with the install/enable, because an
 *   authorization is an enhancement, not a precondition.
 * - **Never write a document the reader would call corrupt.** The rewritten
 *   text is parsed again before it reaches the disk.
 * - **Atomic, undoable, and serialized across processes.** Same-directory
 *   temporary file + rename, like `usageStats.ts`, under the same sibling file
 *   lock (`extension-grants.json.lock`) the profile's atomic writes use, so a
 *   second TUI instance cannot lose an ensure/revoke/forget between our read
 *   and our rename. `undo()` restores the previous bytes only while the file
 *   still holds what this writer put there, so a hand edit in between is
 *   reported rather than overwritten.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { loadSpecData } from '../adapter/standard/registry.js'
import {
  EXTENSION_GRANTS_FILE,
  parseGrantStore,
  rewriteGrantDocument,
  type GrantMutation,
  type GrantStore,
} from '../adapter/standard/grants.js'
import { t, type I18nKey } from '../i18n.js'
import { DATA_DIR } from '../utils/paths.js'
import type { DeclaredGrants } from './plugin-declaration.js'
import { cleanScalarText } from './sanitize.js'

/** The grants-file operations the lifecycle flows ask for. */
export type { GrantMutation, GrantPermissionWrite } from '../adapter/standard/grants.js'

export interface GrantWriteResult {
  readonly ok: true
  /** False when the document already had every requested rule (no write happened). */
  readonly changed: boolean
  /**
   * Restore the bytes this write replaced; only while the file still contains
   * exactly what was written. Returns false when it was edited since, when the
   * previous state cannot be restored, or when the lock cannot be taken.
   */
  readonly undo: () => Promise<boolean>
}

export type GrantWriteFailure =
  | { readonly ok: false; readonly reason: 'corrupt' | 'unreadable' | 'write-failed'; readonly detail?: string }

/** The grants file a lifecycle action writes (`~/.dsh-tui/extension-grants.json`). */
export function grantsFilePath(dataDir: string = DATA_DIR): string {
  return join(dataDir, EXTENSION_GRANTS_FILE)
}

/** Why one write failed, localized, with the filesystem's own words bounded and sanitized. */
export function grantFailureText(failure: GrantWriteFailure): string {
  const key: I18nKey = failure.reason === 'corrupt'
    ? 'plugins-grant-reason-corrupt'
    : failure.reason === 'unreadable' ? 'plugins-grant-reason-unreadable' : 'plugins-grant-reason-write-failed'
  const detail = failure.detail === undefined ? '' : ` (${cleanScalarText(failure.detail, 200)})`
  return `${t(key)}${detail}`
}

/** Test overrides; production resolves the packaged paths. */
export interface GrantWriteOptions {
  readonly dataDir?: string | undefined
  /** The registry's known permission names; defaults to the packaged spec data. */
  readonly knownPermissions?: readonly string[] | undefined
}

/** One permission a plan lists: what the package declares, and what is true now. */
export interface GrantPlanEntry {
  readonly name: string
  readonly scope: string
  readonly default: 'allow' | 'deny'
  /** Whether the live store already allows this exact operation scope. */
  readonly granted: boolean
}

/**
 * What the confirmation pane shows before a lifecycle action. `unknown` names
 * the declarations this host's registry does not know: they are never written
 * (the store would ignore them) and are reported instead of dropped.
 */
export interface GrantPlan {
  /** The component id the rules are keyed by — never the bundle name. */
  readonly id: string
  readonly entries: readonly GrantPlanEntry[]
  readonly unknown: readonly string[]
}

/** The registry's known permission names, or none when the spec data is unusable. */
function knownPermissionNames(): readonly string[] {
  try {
    return (loadSpecData()?.permissions.permissions ?? []).map(permission => permission.name)
  } catch {
    return []
  }
}

/**
 * The plan for one package declaration, evaluated with the same
 * activation-less principal `/plugin check` uses. Activation-scoped rules in
 * the file therefore fail closed here, while the write is a global rule — the
 * same split the report has always had.
 *
 * Unknown permission names never enter `entries`: writing one would produce a
 * rule the store ignores, and this host cannot say what it authorizes.
 */
export function planGrants(grants: GrantStore, declared: DeclaredGrants): GrantPlan {
  const known = new Set(grants.knownPermissions())
  const entries: GrantPlanEntry[] = []
  const unknown = new Set<string>()
  for (const permission of declared.permissions) {
    if (!known.has(permission.name)) {
      unknown.add(permission.name)
      continue
    }
    entries.push({
      name: permission.name,
      scope: permission.scope,
      default: grants.defaultOf(permission.name),
      granted: grants.allows({ componentId: declared.id }, permission.name, permission.scope),
    })
  }
  return { id: declared.id, entries, unknown: [...unknown] }
}

/** One grants file: bytes before the write, and whether there was a file at all. */
interface PreviousState {
  readonly text: string
  readonly existed: boolean
}

/** Atomically replace `file` with `text`, leaving no temporary behind on failure. */
function writeAtomically(file: string, text: string): void {
  const temp = `${file}.tmp`
  try {
    writeFileSync(temp, text)
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // The rename is the real failure; a leftover temporary is the temp dir's.
    }
    throw error
  }
}

/**
 * Apply one mutation to the grants file.
 *
 * A missing file is the empty document (`{}`), exactly as `readGrantStore`
 * reads it; an existing zero-byte file is corruption and is refused, also
 * exactly as the store reads it. The read-modify-write runs under
 * `extension-grants.json.lock`; the reader stays lock-free because the
 * same-directory rename makes it see either the old or the new complete bytes.
 */
export async function applyGrantMutation(
  mutation: GrantMutation,
  options: GrantWriteOptions = {},
): Promise<GrantWriteResult | GrantWriteFailure> {
  if (mutation.id === '') return { ok: false, reason: 'write-failed', detail: 'empty component id' }
  const dir = options.dataDir ?? DATA_DIR
  const file = join(dir, EXTENSION_GRANTS_FILE)
  try {
    mkdirSync(dir, { recursive: true })
    return await withFileLock<GrantWriteResult | GrantWriteFailure>(file, async () => {
      let previous: PreviousState
      try {
        previous = { text: readFileSync(file, 'utf8'), existed: true }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { ok: false, reason: 'unreadable', detail: error instanceof Error ? error.message : String(error) }
        }
        previous = { text: '{}', existed: false }
      }
      // The document this mutation targets, with declared permission names this
      // host does not know removed: a rule the store ignores must not be written.
      const applied = mutation.kind === 'ensure'
        ? {
            ...mutation,
            permissions: mutation.permissions.filter(permission =>
              (options.knownPermissions ?? knownPermissionNames()).includes(permission.name)),
          }
        : mutation
      const rewritten = rewriteGrantDocument(previous.text, applied)
      if ('error' in rewritten) return { ok: false, reason: 'corrupt' }
      if (!rewritten.changed) return { ok: true, changed: false, undo: async () => true }
      if (parseGrantStore(rewritten.text).corrupt) return { ok: false, reason: 'write-failed', detail: 'the rewrite did not round-trip' }
      writeAtomically(file, rewritten.text)
      return {
        ok: true,
        changed: true,
        undo: async (): Promise<boolean> => {
          try {
            return await withFileLock<boolean>(file, async () => {
              let current: string
              try {
                current = readFileSync(file, 'utf8')
              } catch {
                return false
              }
              // Someone edited the file after this write: restoring the old
              // bytes would silently throw their change away.
              if (current !== rewritten.text) return false
              if (previous.existed) writeAtomically(file, previous.text)
              else rmSync(file, { force: true })
              return true
            })
          } catch {
            return false
          }
        },
      }
    })
  } catch (error) {
    return { ok: false, reason: 'write-failed', detail: error instanceof Error ? error.message : String(error) }
  }
}
