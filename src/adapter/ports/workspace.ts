/**
 * Internal Host Port for workspace enumeration/resolution.
 *
 * This port is a TUI-internal capability interface. It does not define
 * dsh-std/dsh-ecosystem-spec protocol types, negotiation, permissions, or
 * caller-supplied owner identities.
 */

import type { HostDisposer } from './owner.js'

export interface HostWorkspaceTarget {
  readonly uri: string
  readonly cwd: string
  readonly label: string
  readonly description?: string
  readonly kind: 'local' | 'provider'
  readonly badge: string
}

export type HostWorkspaceCommandResult =
  | { readonly kind: 'choices'; readonly title: string; readonly choices: readonly unknown[] }
  | { readonly kind: 'target'; readonly target: HostWorkspaceTarget }

export interface HostWorkspaceCommand {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  run(input: string, context: { readonly cwd: string }, signal?: AbortSignal): Promise<HostWorkspaceCommandResult> | HostWorkspaceCommandResult
}

export interface HostCommandShell {
  resolve(request: {
    readonly command: string
    readonly workdir?: string
    readonly timeoutMs?: number
  }): unknown
  run(spec: unknown): Promise<{
    readonly exitCode: number | null
    readonly stdout: { readonly text: string }
    readonly stderr: { readonly text: string }
    readonly timedOut: boolean
  }>
}

export interface HostWorkspacePort {
  list(currentCwd: string, signal?: AbortSignal): Promise<readonly HostWorkspaceTarget[]>
  resolve(reference: string, currentCwd?: string, signal?: AbortSignal): Promise<HostWorkspaceTarget | undefined>
  describe(cwd: string): HostWorkspaceTarget
  commandShell(cwd: string): Promise<HostCommandShell | undefined>
  rename(cwd: string, title: string): Promise<HostWorkspaceTarget>
  commands(): readonly Pick<HostWorkspaceCommand, 'name' | 'aliases' | 'description'>[]
  runCommand(name: string, input: string, cwd: string, signal?: AbortSignal): Promise<HostWorkspaceCommandResult | undefined>
}

export type HostWorkspaceDisposer = HostDisposer
