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
