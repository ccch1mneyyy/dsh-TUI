/** Host-owned in-process Channel contract. No runtime or upstream imports. */


export interface TuiWorkspaceTarget {
  /** Stable, user-pasteable target identifier. */
  uri: string
  /** Host-side cwd recorded in the DSH session header. */
  cwd: string
  /** Compact picker/status label. */
  label: string
  /** Optional secondary picker copy. */
  description?: string
  kind: TuiWorkspaceKind
  /** Provider-owned compact badge; the TUI does not interpret it. */
  badge: string
}

export type TuiWorkspaceKind = 'local' | 'provider'

/**
 * One durable workspace as the home screen's sidebar sees it.
 *
 * Distinct from {@link TuiWorkspaceTarget} on purpose: a target answers "where
 * could a session run" (providers included, plus the live cwd), while an entry
 * answers "what did the user register" — the ledger's own order, ids, titles,
 * and how many sessions currently hang off it. A workspace with no sessions is
 * a real row here (and invisible to every session-derived listing), and a
 * registered directory that has since been deleted is still a row so the user
 * can remove it.
 */
export interface TuiWorkspaceEntry {
  /** Ledger record id (a uuid); stable across renames. */
  id: string
  /** Canonical directory path recorded at create time. */
  path: string
  /** Durable display title, already defaulted by the registry. */
  title: string
  /** False when the recorded directory no longer exists on disk. */
  present: boolean
  /** Sessions currently attached to this workspace. */
  sessionCount: number
}

export interface TuiWorkspaceCommand {
  name: string
  aliases?: readonly string[]
  description: string
  run(input: string, context: { cwd: string }, signal?: AbortSignal): Promise<TuiWorkspaceCommandResult> | TuiWorkspaceCommandResult
}

export type TuiWorkspaceCommandResult =
  | { kind: 'choices'; title: string; choices: readonly TuiWorkspaceChoice[] }
  | { kind: 'target'; target: TuiWorkspaceTarget }

export interface TuiWorkspaceChoice {
  id: string
  label: string
  description?: string
  badge?: string
  choose(signal?: AbortSignal): Promise<TuiWorkspaceCommandResult> | TuiWorkspaceCommandResult
  /** Optional inline editor entered with Tab while this choice is focused. */
  input?: {
    initialValue?: string
    placeholder?: string
    submit(value: string, signal?: AbortSignal): Promise<TuiWorkspaceCommandResult> | TuiWorkspaceCommandResult
  }
}
