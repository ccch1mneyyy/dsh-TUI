/**
 * Workspace-target extension seam for terminal front doors.
 *
 * The TUI owns local URI parsing and session switching. Optional plugins add
 * providers for external schemes without coupling the TUI to them.
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'

export type TuiWorkspaceKind = 'local' | 'provider'

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

export type TuiWorkspaceCommandResult =
  | { kind: 'choices'; title: string; choices: readonly TuiWorkspaceChoice[] }
  | { kind: 'target'; target: TuiWorkspaceTarget }

export interface TuiWorkspaceCommand {
  name: string
  aliases?: readonly string[]
  description: string
  run(input: string, context: { cwd: string }, signal?: AbortSignal): Promise<TuiWorkspaceCommandResult> | TuiWorkspaceCommandResult
}

export interface TuiCommandShell {
  resolve(request: {
    command: string
    workdir?: string
    timeoutMs?: number
  }): unknown
  run(spec: unknown): Promise<{
    exitCode: number | null
    stdout: { text: string }
    stderr: { text: string }
    timedOut: boolean
  }>
}

export interface TuiWorkspaceProvider {
  /** URI schemes owned by this provider, without the trailing colon. */
  schemes: readonly string[]
  /** Enumerate targets owned by this provider. */
  list(signal?: AbortSignal): Promise<readonly TuiWorkspaceTarget[]> | readonly TuiWorkspaceTarget[]
  /** Resolve a provider URI, or return undefined when its scheme is not owned. */
  resolve(uri: string, signal?: AbortSignal): Promise<TuiWorkspaceTarget | undefined> | TuiWorkspaceTarget | undefined
  /** Resolve a path relative to a cwd already owned by this provider. */
  resolvePath?(path: string, cwd: string, signal?: AbortSignal): Promise<TuiWorkspaceTarget | undefined> | TuiWorkspaceTarget | undefined
  /** Describe an already-recorded cwd without performing I/O. */
  describe(cwd: string): TuiWorkspaceTarget | undefined
  /** Override `!command` execution for a provider-owned cwd. */
  commandShell?(cwd: string): Promise<TuiCommandShell | undefined> | TuiCommandShell | undefined
  /** Rename a provider-owned workspace durably. */
  rename?(cwd: string, title: string): Promise<TuiWorkspaceTarget | undefined> | TuiWorkspaceTarget | undefined
  /** Provider-owned `/workspace <command>` extensions. */
  commands?: readonly TuiWorkspaceCommand[]
}

interface WorkspaceRecordLike {
  path: string
  title: string
  setTitle(title: string): Promise<void>
}

interface WorkspaceRegistryLike {
  list(): readonly WorkspaceRecordLike[]
  create(path: string, title?: string): Promise<WorkspaceRecordLike>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiWorkspaces: TuiWorkspaceRuntime
  }
}

export const name = 'dsh-tui-workspaces'

/** Registry and local fallback shared by the TUI and workspace plugins. */
export class TuiWorkspaceRuntime extends Service {
  private readonly providers = new Set<TuiWorkspaceProvider>()
  private readonly providerWaiters = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'tuiWorkspaces')
  }

  register(provider: TuiWorkspaceProvider): () => void {
    this.providers.add(provider)
    this.notifyProviderWaiters()
    return () => {
      this.providers.delete(provider)
      this.notifyProviderWaiters()
    }
  }

  async list(currentCwd: string, signal?: AbortSignal): Promise<readonly TuiWorkspaceTarget[]> {
    signal?.throwIfAborted()
    const targets = new Map<string, TuiWorkspaceTarget>()
    for (const provider of this.providers) {
      try {
        for (const target of await provider.list(signal)) targets.set(target.uri, this.withStoredTitle(target))
      } catch (error) {
        this.ctx.logger.warn(`dsh-tui: workspace provider list failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // The official registry is the durable catalog. Provider-owned aliases
    // have already been added above with richer URI/badge metadata; remaining
    // records are ordinary local workspaces.
    for (const workspace of this.workspaceRegistry()?.list() ?? []) {
      if ([...targets.values()].some(target => sameCwd(target.cwd, workspace.path))) continue
      targets.set(localWorkspaceUri(workspace.path), {
        ...localWorkspaceTarget(workspace.path),
        label: workspace.title,
      })
    }

    // The current local directory is always selectable, even in a bare TUI
    // composition without dsh-workspace or another provider.
    if (![...targets.values()].some(target => sameCwd(target.cwd, currentCwd))) {
      const local = localWorkspaceTarget(currentCwd)
      targets.set(local.uri, local)
    }

    return [...targets.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'local' ? -1 : 1
      return left.label.localeCompare(right.label)
    })
  }

  /** Resolve a URI, briefly allowing concurrently mounted providers to register. */
  async resolve(reference: string, currentCwd = process.cwd(), signal?: AbortSignal): Promise<TuiWorkspaceTarget | undefined> {
    if (isAbsolute(reference)) return localWorkspaceTarget(reference)
    const deadline = Date.now() + 5000
    const scheme = uriScheme(reference)
    if (scheme === undefined) {
      const owner = [...this.providers].find((provider) => {
        try {
          return provider.describe(currentCwd) !== undefined
        } catch {
          return false
        }
      })
      if (owner !== undefined) return owner.resolvePath?.(reference, currentCwd, signal)
      return localWorkspaceTarget(resolve(currentCwd, reference))
    }

    const local = parseLocalWorkspaceReference(reference)
    if (local !== undefined) return local
    for (;;) {
      signal?.throwIfAborted()
      const owners = [...this.providers].filter(provider =>
        provider.schemes.some(candidate => candidate.toLowerCase() === scheme))
      for (const provider of owners) {
        const target = await provider.resolve(reference, signal)
        if (target !== undefined) return target
      }
      if (owners.length > 0) return undefined
      if (Date.now() >= deadline) return undefined
      await this.waitForProvider(Math.min(100, deadline - Date.now()), signal)
    }
  }

  describe(cwd: string): TuiWorkspaceTarget {
    for (const provider of this.providers) {
      let target: TuiWorkspaceTarget | undefined
      try {
        target = provider.describe(cwd)
      } catch (error) {
        this.ctx.logger.warn(`dsh-tui: workspace provider describe failed: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (target !== undefined) return this.withStoredTitle(target)
    }
    return this.withStoredTitle(localWorkspaceTarget(cwd))
  }

  async commandShell(cwd: string): Promise<TuiCommandShell | undefined> {
    for (const provider of this.providers) {
      let shell: TuiCommandShell | undefined
      try {
        shell = await provider.commandShell?.(cwd)
      } catch (error) {
        this.ctx.logger.warn(`dsh-tui: workspace provider commandShell failed: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (shell !== undefined) return shell
    }
    return undefined
  }

  async rename(cwd: string, title: string): Promise<TuiWorkspaceTarget> {
    const normalizedTitle = title.trim()
    if (normalizedTitle.length === 0) throw new Error('workspace title must not be empty')
    for (const provider of this.providers) {
      let owned = false
      try {
        owned = provider.describe(cwd) !== undefined
      } catch {
        continue
      }
      if (!owned) continue
      // A provider without rename (or returning undefined) falls through to
      // the local durable ledger below — the title stays visible everywhere
      // this runtime runs. A rename that THROWS propagates to the caller's
      // failure notification instead of silently writing a local record.
      const renamed = await provider.rename?.(cwd, normalizedTitle)
      if (renamed !== undefined) return this.withStoredTitle(renamed)
      break
    }
    const registry = this.workspaceRegistry()
    if (registry === undefined) throw new Error('workspace registry is unavailable')
    const workspace = registry.list().find(candidate => sameCwd(candidate.path, cwd))
      ?? await registry.create(cwd, normalizedTitle)
    await workspace.setTitle(normalizedTitle)
    return { ...this.describe(cwd), label: normalizedTitle }
  }

  commands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[] {
    return [...this.providers].flatMap(provider => provider.commands ?? []).map(command => ({
      name: command.name,
      aliases: command.aliases,
      description: command.description,
    }))
  }

  async runCommand(name: string, input: string, cwd: string, signal?: AbortSignal): Promise<TuiWorkspaceCommandResult | undefined> {
    const normalized = name.toLowerCase()
    for (const provider of this.providers) {
      const command = provider.commands?.find(candidate =>
        candidate.name.toLowerCase() === normalized
        || candidate.aliases?.some(alias => alias.toLowerCase() === normalized))
      if (command !== undefined) return command.run(input, { cwd }, signal)
    }
    return undefined
  }

  private workspaceRegistry(): WorkspaceRegistryLike | undefined {
    return this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  }

  private withStoredTitle(target: TuiWorkspaceTarget): TuiWorkspaceTarget {
    const workspace = this.workspaceRegistry()?.list().find(candidate => sameCwd(candidate.path, target.cwd))
    return workspace === undefined ? target : { ...target, label: workspace.title }
  }

  private notifyProviderWaiters(): void {
    for (const waiter of this.providerWaiters) waiter()
    this.providerWaiters.clear()
  }

  private waitForProvider(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (timeoutMs <= 0) return Promise.resolve()
    return new Promise((resolveWait, reject) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.providerWaiters.delete(finish)
        resolveWait()
      }
      const abort = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.providerWaiters.delete(finish)
        reject(signal?.reason instanceof Error ? signal.reason : new Error('workspace resolution aborted'))
      }
      const timer = setTimeout(finish, timeoutMs)
      this.providerWaiters.add(finish)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

/** Local-only fallback for direct embedders that call createChannel() without
 * mounting the optional workspace registry/provider service. */
export function createLocalWorkspaceRuntime(): Pick<
  TuiWorkspaceRuntime,
  'list' | 'resolve' | 'describe' | 'commandShell' | 'rename' | 'commands' | 'runCommand'
> {
  return {
    async list(currentCwd) {
      return [localWorkspaceTarget(currentCwd)]
    },
    async resolve(reference, currentCwd = process.cwd()) {
      if (isAbsolute(reference)) return localWorkspaceTarget(reference)
      const local = parseLocalWorkspaceReference(reference)
      if (local !== undefined) return local
      if (uriScheme(reference) !== undefined) return undefined
      return localWorkspaceTarget(resolve(currentCwd, reference))
    },
    describe(cwd) {
      return localWorkspaceTarget(cwd)
    },
    async commandShell() {
      return undefined
    },
    async rename() {
      throw new Error('workspace registry is unavailable')
    },
    commands() {
      return []
    },
    async runCommand() {
      return undefined
    },
  }
}

export function localWorkspaceUri(path: string): string {
  return pathToFileURL(resolve(path)).href
}

/** Resolve a native absolute path or the standard file URL form. */
export function parseLocalWorkspaceReference(reference: string): TuiWorkspaceTarget | undefined {
  if (isAbsolute(reference)) return localWorkspaceTarget(reference)
  let parsed: URL
  try {
    parsed = new URL(reference)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'file:') return undefined
  const cwd = fileURLToPath(parsed)
  if (!isAbsolute(cwd)) throw new Error(`file workspace URI must resolve to an absolute path: ${reference}`)
  return localWorkspaceTarget(cwd)
}

function localWorkspaceTarget(cwd: string): TuiWorkspaceTarget {
  const absolute = resolve(cwd)
  return {
    uri: localWorkspaceUri(absolute),
    cwd: absolute,
    label: basename(absolute) || absolute,
    description: absolute,
    kind: 'local',
    badge: 'LOCAL',
  }
}

function uriScheme(uri: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/iu.exec(uri)?.[1]?.toLowerCase()
}

function sameCwd(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

export default TuiWorkspaceRuntime
