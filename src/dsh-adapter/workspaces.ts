import type { TuiWorkspaceTarget, TuiWorkspaceKind, TuiWorkspaceCommand, TuiWorkspaceCommandResult, TuiWorkspaceChoice, TuiWorkspaceEntry } from '../adapter/ports/channel-workspace.js'
export type { TuiWorkspaceTarget, TuiWorkspaceKind, TuiWorkspaceCommand, TuiWorkspaceCommandResult, TuiWorkspaceChoice, TuiWorkspaceEntry } from '../adapter/ports/channel-workspace.js'
/**
 * Workspace-target extension seam for terminal front doors.
 *
 * The TUI owns local URI parsing and session switching. Optional plugins add
 * providers for external schemes without coupling the TUI to them.
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { activationFiber, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'

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

/** Host-only workspace controls used by the TUI front door.  Plugin-facing
 * service methods below are intentionally scoped to their calling activation;
 * the channel must use this facade to enumerate and route all providers. */
export interface TuiWorkspaceHost {
  list(currentCwd: string, signal?: AbortSignal): Promise<readonly TuiWorkspaceTarget[]>
  resolve(request: string, currentCwd?: string, signal?: AbortSignal): Promise<TuiWorkspaceTarget | undefined>
  describe(cwd: string): TuiWorkspaceTarget
  commandShell(cwd: string): Promise<TuiCommandShell | undefined>
  rename(cwd: string, title: string): Promise<TuiWorkspaceTarget>
  /** Drop a workspace registration (never the directory or its session logs). */
  remove(cwd: string): Promise<boolean>
  /**
   * The durable ledger's own listing, in its own order.
   *
   * Unlike `list`, this merges nothing and appends nothing: it is the set of
   * registrations the sidebar manages, including entries with no sessions and
   * entries whose directory has disappeared.
   */
  listRegistry(): Promise<readonly TuiWorkspaceEntry[]>
  commands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[]
  runCommand(name: string, input: string, cwd: string, signal?: AbortSignal): Promise<TuiWorkspaceCommandResult | undefined>
}

interface WorkspaceRecordLike {
  id: unknown
  path: string
  title: string
  setTitle(title: string): Promise<void>
  /** Whether the recorded directory still exists (`missing-dir` when not). */
  status?(): Promise<'ok' | 'missing-dir'>
}

interface WorkspaceRegistryLike {
  list(): readonly WorkspaceRecordLike[]
  create(path: string, title?: string): Promise<WorkspaceRecordLike>
  delete(id: never): Promise<boolean>
}

/** Registry-backed list surface for the workspace home screen. */
type RegistryWorkspaceEntry = TuiWorkspaceEntry

/**
 * Enumerate the durable workspace registry, in its own display order.
 *
 * The sidebar needs the *registry* (every workspace the user ever registered,
 * including ones with no sessions yet), not the session-derived grouping the
 * `/resume` browser builds. Order, ids and titles come from the ledger;
 * `sessionCount` is filled in by the caller (the adapter holds no session
 * index), and `present` is derived here.
 */
export async function listRegistryWorkspaces(
  runtime: TuiWorkspaceRuntime | undefined,
): Promise<readonly RegistryWorkspaceEntry[]> {
  if (runtime === undefined) return []
  const registry = workspaceRegistry(runtime)
  if (registry === undefined) return []
  const out: RegistryWorkspaceEntry[] = []
  for (const workspace of registry.list()) {
    let present = true
    try {
      present = (await workspace.status?.()) !== 'missing-dir'
    } catch {
      // An unreadable status is not evidence of absence.
      present = true
    }
    out.push({
      id: String(workspace.id),
      path: workspace.path,
      title: workspace.title,
      present,
      sessionCount: 0,
    })
  }
  return out
}

/**
 * Remove a workspace registration by path. Sessions and the directory survive:
 * only the ledger entry goes away, so the sessions reappear as ungrouped.
 *
 * @returns True when a record was removed, false when no record owned `cwd`
 *   (or the ledger is unmounted).
 */
export async function removeRegistryWorkspace(
  runtime: TuiWorkspaceRuntime | undefined,
  cwd: string,
  owner?: object,
): Promise<boolean> {
  if (runtime === undefined) return false
  const registry = workspaceRegistry(runtime)
  if (registry === undefined) return false
  const workspace = registry.list().find(candidate => sameCwd(candidate.path, cwd))
  if (workspace === undefined) return false
  // The durable ledger is host-owned: a plugin may only drop a registration
  // for a cwd one of ITS OWN providers still vouches for. `owner === undefined`
  // is the host facade's own call (the sidebar's remove action).
  if (owner !== undefined && !ownsWorkspace(runtime, owner, cwd)) {
    throw new Error('workspace is not owned by the calling activation')
  }
  return registry.delete(workspace.id as never)
}

/**
 * Whether a calling activation's own providers still vouch for `cwd`.
 *
 * This is the same evidence `renameWorkspace` accepts, and the only ownership
 * fact the local ledger records 鈥?the registry entry itself carries no creator.
 * A provider `describe()` that returns a target means the cwd belongs to that
 * provider's scheme, so the activation behind it is the one entitled to mutate
 * the registration.
 * @param runtime - The workspace service.
 * @param owner - Live activation fiber of the caller.
 * @param cwd - Directory to test.
 * @returns True when one of the caller's providers owns `cwd`.
 */
function ownsWorkspace(runtime: TuiWorkspaceRuntime, owner: object, cwd: string): boolean {
  for (const provider of providersFor(workspaceStateFor(runtime), owner)) {
    try {
      if (provider.describe(cwd) !== undefined) return true
    } catch {
      // A provider that throws on describe vouches for nothing.
    }
  }
  return false
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiWorkspaces: TuiWorkspaceRuntime
  }
}

export const name = 'dsh-tui-workspaces'
/** Bound every provider promise so one plugin cannot park workspace flows. */
export const WORKSPACE_PROVIDER_TIMEOUT_MS = 2000

async function providerWithBudget<T>(
  task: () => T | Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs = WORKSPACE_PROVIDER_TIMEOUT_MS,
): Promise<T | undefined> {
  signal?.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = Promise.resolve().then(task)
  const timeout = new Promise<undefined>(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout(undefined), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Registry and local fallback shared by the TUI and workspace plugins. */
export class TuiWorkspaceRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiWorkspaces')
    const runtime = this
    const state: WorkspaceState = {
      hostContext: compositionRoot(ctx),
      providers: new Set(),
      providerOwners: new Map(),
      providerWaiters: new Set(),
      host: undefined,
      runtime: adapterRuntimeFor(ctx),
    }
    state.host = Object.freeze({
      list: (currentCwd: string, signal?: AbortSignal) => listWorkspaces(runtime, currentCwd, signal, undefined),
      resolve: (reference: string, currentCwd?: string, signal?: AbortSignal) =>
        resolveWorkspace(runtime, reference, currentCwd ?? process.cwd(), signal, undefined),
      describe: (cwd: string) => describeWorkspace(runtime, cwd, undefined),
      commandShell: (cwd: string) => {
        assertCapabilityShadowPolicy('host.workspaces.commandShell', state.runtime.mode, state.runtime.slices)
        return commandShellFor(runtime, cwd, undefined)
      },
      rename: (cwd: string, title: string) => {
        assertCapabilityShadowPolicy('host.workspaces.rename', state.runtime.mode, state.runtime.slices)
        return renameWorkspace(runtime, cwd, title, undefined)
      },
      remove: (cwd: string) => {
        assertCapabilityShadowPolicy('host.workspaces.remove', state.runtime.mode, state.runtime.slices)
        return removeRegistryWorkspace(runtime, cwd)
      },
      listRegistry: () => listRegistryWorkspaces(runtime),
      commands: () => workspaceCommands(runtime, undefined),
      runCommand: (name: string, input: string, cwd: string, signal?: AbortSignal) => {
        assertCapabilityShadowPolicy('host.workspaces.runCommand', state.runtime.mode, state.runtime.slices)
        return runWorkspaceCommand(runtime, name, input, cwd, signal, undefined)
      },
    })
    workspaceStates.set(this, state)
  }

  register(provider: TuiWorkspaceProvider): () => void {
    assertCapabilityShadowPolicy('host.workspaces.register', workspaceStateFor(this).runtime.mode, workspaceStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiWorkspaces.register', this)
    const state = workspaceStateFor(this)
    state.providers.add(provider)
    const owner = activationFiber(caller)
    if (owner === undefined) {
      state.providers.delete(provider)
      throw new Error('dsh-tui: tuiWorkspaces.register requires a live activation')
    }
    state.providerOwners.set(provider, owner)
    this.notifyProviderWaiters()
    const dispose = () => {
      state.providers.delete(provider)
      state.providerOwners.delete(provider)
      this.notifyProviderWaiters()
    }
    bindCallerEffect(caller, dispose)
    return dispose
  }

  async list(currentCwd: string, signal?: AbortSignal): Promise<readonly TuiWorkspaceTarget[]> {
    assertCapabilityShadowPolicy('host.workspaces.list', workspaceStateFor(this).runtime.mode, workspaceStateFor(this).runtime.slices)
    const owner = workspaceCaller(this, 'tuiWorkspaces.list')
    return listWorkspaces(this, currentCwd, signal, owner)
  }

  /** Resolve a URI, briefly allowing concurrently mounted providers to register. */
  async resolve(reference: string, currentCwd = process.cwd(), signal?: AbortSignal): Promise<TuiWorkspaceTarget | undefined> {
    assertCapabilityShadowPolicy('host.workspaces.resolve', workspaceStateFor(this).runtime.mode, workspaceStateFor(this).runtime.slices)
    const owner = workspaceCaller(this, 'tuiWorkspaces.resolve')
    return resolveWorkspace(this, reference, currentCwd, signal, owner)
  }

  describe(cwd: string): TuiWorkspaceTarget {
    assertCapabilityShadowPolicy('host.workspaces.describe', workspaceStateFor(this).runtime.mode, workspaceStateFor(this).runtime.slices)
    const owner = workspaceCaller(this, 'tuiWorkspaces.describe')
    return describeWorkspace(this, cwd, owner)
  }

  async commandShell(cwd: string): Promise<TuiCommandShell | undefined> {
    assertCapabilityShadowPolicy('host.workspaces.commandShell', workspaceStateFor(this).runtime.mode, workspaceStateFor(this).runtime.slices)
    const owner = workspaceCaller(this, 'tuiWorkspaces.commandShell')
    return commandShellFor(this, cwd, owner)
  }

  async rename(cwd: string, title: string): Promise<TuiWorkspaceTarget> {
    assertCapabilityShadowPolicy('host.workspaces.rename', workspaceStateFor(this).runtime.mode, workspaceStateFor(this).runtime.slices)
    const owner = workspaceCaller(this, 'tuiWorkspaces.rename')
    return renameWorkspace(this, cwd, title, owner)
  }

  /**
   * Drop a workspace registration; the directory and session logs survive.
   *
   * Plugin-facing, and therefore bound by the SAME rule as {@link rename}: a
   * live calling activation is required, and the target must be a cwd one of
   * that activation's own providers vouches for. Without both, a plugin that
   * never owned the workspace 鈥?including one whose fiber was already disposed
   * and whose caller context is a retained handle 鈥?could delete a host
   * registration. Shadow policy alone is not caller authentication.
   */
  async remove(cwd: string): Promise<boolean> {
    assertCapabilityShadowPolicy('host.workspaces.remove', workspaceStateFor(this).runtime.mode, workspaceStateFor(this).runtime.slices)
    const owner = workspaceCaller(this, 'tuiWorkspaces.remove')
    return removeRegistryWorkspace(this, cwd, owner)
  }

  /** The durable ledger's own listing, in its own order. */
  async listRegistry(): Promise<readonly TuiWorkspaceEntry[]> {
    assertCapabilityShadowPolicy('host.workspaces.list', workspaceStateFor(this).runtime.mode, workspaceStateFor(this).runtime.slices)
    workspaceCaller(this, 'tuiWorkspaces.listRegistry')
    return listRegistryWorkspaces(this)
  }

  commands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[] {
    assertCapabilityShadowPolicy('host.workspaces.commands', workspaceStateFor(this).runtime.mode, workspaceStateFor(this).runtime.slices)
    const owner = workspaceCaller(this, 'tuiWorkspaces.commands')
    return workspaceCommands(this, owner)
  }

  async runCommand(name: string, input: string, cwd: string, signal?: AbortSignal): Promise<TuiWorkspaceCommandResult | undefined> {
    assertCapabilityShadowPolicy('host.workspaces.runCommand', workspaceStateFor(this).runtime.mode, workspaceStateFor(this).runtime.slices)
    const owner = workspaceCaller(this, 'tuiWorkspaces.runCommand')
    return runWorkspaceCommand(this, name, input, cwd, signal, owner)
  }

  private notifyProviderWaiters(): void {
    const state = workspaceStateFor(this)
    for (const waiter of state.providerWaiters) waiter()
    state.providerWaiters.clear()
  }

}

interface WorkspaceState {
  readonly runtime: AdapterRuntimeOptions
  readonly hostContext: Context
  readonly providers: Set<TuiWorkspaceProvider>
  readonly providerOwners: Map<TuiWorkspaceProvider, object>
  readonly providerWaiters: Set<() => void>
  host: TuiWorkspaceHost | undefined
}

const workspaceStates = new WeakMap<TuiWorkspaceRuntime, WorkspaceState>()

function workspaceStateFor(runtime: TuiWorkspaceRuntime): WorkspaceState {
  const state = workspaceStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiWorkspaces host state is unavailable')
  return state
}

/** Resolve the host-only facade for channel/plugin bootstrap code. */
export function getHostWorkspaceRuntime(runtime: TuiWorkspaceRuntime | undefined): TuiWorkspaceHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return workspaceStateFor(runtime).host
  } catch {
    return undefined
  }
}

function workspaceCaller(runtime: TuiWorkspaceRuntime, capability: string): object {
  const caller = requirePluginCaller(runtimeContext(runtime), capability, runtime)
  const owner = activationFiber(caller)
  if (owner === undefined) throw new Error(`dsh-tui: ${capability} requires a live activation`)
  return owner
}

function runtimeContext(runtime: TuiWorkspaceRuntime): Context {
  return (runtime as unknown as { ctx: Context }).ctx
}

function providersFor(state: WorkspaceState, owner: object | undefined): readonly TuiWorkspaceProvider[] {
  if (owner === undefined) return [...state.providers]
  return [...state.providers].filter(provider => state.providerOwners.get(provider) === owner)
}

async function listWorkspaces(
  runtime: TuiWorkspaceRuntime,
  currentCwd: string,
  signal: AbortSignal | undefined,
  owner: object | undefined,
): Promise<readonly TuiWorkspaceTarget[]> {
  signal?.throwIfAborted()
  const state = workspaceStateFor(runtime)
  const targets = new Map<string, TuiWorkspaceTarget>()
  for (const provider of providersFor(state, owner)) {
    try {
      const listed = await providerWithBudget(() => provider.list(signal), signal)
      if (listed === undefined) continue
      for (const target of listed) targets.set(target.uri, withStoredTitle(runtime, target))
    } catch (error) {
      runtimeContext(runtime).logger.warn(`dsh-tui: workspace provider list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const workspace of workspaceRegistry(runtime)?.list() ?? []) {
    if ([...targets.values()].some(target => sameCwd(target.cwd, workspace.path))) continue
    targets.set(localWorkspaceUri(workspace.path), {
      ...localWorkspaceTarget(workspace.path),
      label: workspace.title,
    })
  }
  if (![...targets.values()].some(target => sameCwd(target.cwd, currentCwd))) {
    const local = localWorkspaceTarget(currentCwd)
    targets.set(local.uri, local)
  }
  return [...targets.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'local' ? -1 : 1
    return left.label.localeCompare(right.label)
  })
}

async function resolveWorkspace(
  runtime: TuiWorkspaceRuntime,
  reference: string,
  currentCwd: string,
  signal: AbortSignal | undefined,
  owner: object | undefined,
): Promise<TuiWorkspaceTarget | undefined> {
  const state = workspaceStateFor(runtime)
  const providers = () => providersFor(state, owner)
  if (isAbsolute(reference)) return localWorkspaceTarget(reference)
  const deadline = Date.now() + 5000
  const scheme = uriScheme(reference)
  if (scheme === undefined) {
    const provider = providers().find(candidate => {
      try {
        return candidate.describe(currentCwd) !== undefined
      } catch {
        return false
      }
    })
    if (provider !== undefined) {
      return provider.resolvePath === undefined
        ? undefined
        : providerWithBudget(() => provider.resolvePath!(reference, currentCwd, signal), signal)
    }
    return localWorkspaceTarget(resolve(currentCwd, reference))
  }
  const local = parseLocalWorkspaceReference(reference)
  if (local !== undefined) return local
  for (;;) {
    signal?.throwIfAborted()
    const owners = providers().filter(provider =>
      provider.schemes.some(candidate => candidate.toLowerCase() === scheme))
    for (const provider of owners) {
      const target = await providerWithBudget(
        () => provider.resolve(reference, signal),
        signal,
        Math.max(1, deadline - Date.now()),
      )
      if (target !== undefined) return target
    }
    if (owners.length > 0) return undefined
    if (Date.now() >= deadline) return undefined
    await waitForProvider(runtime, Math.min(100, deadline - Date.now()), signal)
  }
}

function describeWorkspace(runtime: TuiWorkspaceRuntime, cwd: string, owner: object | undefined): TuiWorkspaceTarget {
  const state = workspaceStateFor(runtime)
  for (const provider of providersFor(state, owner)) {
    let target: TuiWorkspaceTarget | undefined
    try {
      target = provider.describe(cwd)
    } catch (error) {
      runtimeContext(runtime).logger.warn(`dsh-tui: workspace provider describe failed: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (target !== undefined) return withStoredTitle(runtime, target)
  }
  return withStoredTitle(runtime, localWorkspaceTarget(cwd))
}

async function commandShellFor(runtime: TuiWorkspaceRuntime, cwd: string, owner: object | undefined): Promise<TuiCommandShell | undefined> {
  const state = workspaceStateFor(runtime)
  for (const provider of providersFor(state, owner)) {
    let shell: TuiCommandShell | undefined
    try {
      shell = await providerWithBudget(() => provider.commandShell?.(cwd), undefined)
    } catch (error) {
      runtimeContext(runtime).logger.warn(`dsh-tui: workspace provider commandShell failed: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (shell !== undefined) return shell
  }
  return undefined
}

async function renameWorkspace(
  runtime: TuiWorkspaceRuntime,
  cwd: string,
  title: string,
  owner: object | undefined,
): Promise<TuiWorkspaceTarget> {
  const normalizedTitle = title.trim()
  if (normalizedTitle.length === 0) throw new Error('workspace title must not be empty')
  const state = workspaceStateFor(runtime)
  let providerOwned = false
  for (const provider of providersFor(state, owner)) {
    let owned = false
    try {
      owned = provider.describe(cwd) !== undefined
    } catch {
      continue
    }
    if (!owned) continue
    providerOwned = true
    const renamed = await providerWithBudget(() => provider.rename?.(cwd, normalizedTitle), undefined)
    if (renamed !== undefined) return withStoredTitle(runtime, renamed)
    break
  }
  // A plugin may only mutate the durable title ledger for a workspace it
  // owns. Host callers retain the historical local-registry behavior.
  if (owner !== undefined && !providerOwned) {
    throw new Error('workspace is not owned by the calling activation')
  }
  const registry = workspaceRegistry(runtime)
  if (registry === undefined) throw new Error('workspace registry is unavailable')
  const workspace = registry.list().find(candidate => sameCwd(candidate.path, cwd))
    ?? await registry.create(cwd, normalizedTitle)
  await workspace.setTitle(normalizedTitle)
  return { ...describeWorkspace(runtime, cwd, owner), label: normalizedTitle }
}

function workspaceCommands(runtime: TuiWorkspaceRuntime, owner: object | undefined): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[] {
  return providersFor(workspaceStateFor(runtime), owner).flatMap(provider => provider.commands ?? []).map(command => ({
    name: command.name,
    aliases: command.aliases,
    description: command.description,
  }))
}

async function runWorkspaceCommand(
  runtime: TuiWorkspaceRuntime,
  name: string,
  input: string,
  cwd: string,
  signal: AbortSignal | undefined,
  owner: object | undefined,
): Promise<TuiWorkspaceCommandResult | undefined> {
  const normalized = name.toLowerCase()
  for (const provider of providersFor(workspaceStateFor(runtime), owner)) {
    const command = provider.commands?.find(candidate =>
      candidate.name.toLowerCase() === normalized
      || candidate.aliases?.some(alias => alias.toLowerCase() === normalized))
    if (command !== undefined) return providerWithBudget(() => command.run(input, { cwd }, signal), signal)
  }
  return undefined
}

function workspaceRegistry(runtime: TuiWorkspaceRuntime): WorkspaceRegistryLike | undefined {
  return workspaceStateFor(runtime).hostContext.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
}

function withStoredTitle(runtime: TuiWorkspaceRuntime, target: TuiWorkspaceTarget): TuiWorkspaceTarget {
  const workspace = workspaceRegistry(runtime)?.list().find(candidate => sameCwd(candidate.path, target.cwd))
  return workspace === undefined ? target : { ...target, label: workspace.title }
}

function waitForProvider(runtime: TuiWorkspaceRuntime, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (timeoutMs <= 0) return Promise.resolve()
  return new Promise((resolveWait, reject) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      workspaceStateFor(runtime).providerWaiters.delete(finish)
      resolveWait()
    }
    const abort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      workspaceStateFor(runtime).providerWaiters.delete(finish)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('workspace resolution aborted'))
    }
    const timer = setTimeout(finish, timeoutMs)
    workspaceStateFor(runtime).providerWaiters.add(finish)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Local-only fallback for direct embedders that call createChannel() without
 * mounting the optional workspace registry/provider service. */
export function createLocalWorkspaceRuntime(): Pick<
  TuiWorkspaceRuntime,
  'list' | 'resolve' | 'describe' | 'commandShell' | 'rename' | 'remove' | 'listRegistry' | 'commands' | 'runCommand'> {
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
    async remove() {
      return false
    },
    async listRegistry() {
      return []
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
