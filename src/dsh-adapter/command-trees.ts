/** Provider-neutral subcommand completion registry for terminal front doors. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CommandCompletionNode, LocalizedDescriptions } from '../commands.js'
import { activationFiber, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'

export interface TuiCommandTreeProvider {
  /** Root command name without `/`. Must match the command registry entry. */
  root: string
  /** Optional provider-owned translations for the root command row. */
  descriptions?: LocalizedDescriptions
  /** Children for the full canonical path, including `root` at index zero. */
  children(canonicalPath: readonly string[]): readonly CommandCompletionNode[]
}

/** Host-only completion access. Plugins see only their own provider through
 * the traceable service; the channel uses this facade to merge all providers. */
export interface TuiCommandTreeHost {
  children(canonicalPath: readonly string[]): readonly CommandCompletionNode[]
  descriptions(root: string): LocalizedDescriptions | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiCommandTrees: TuiCommandTreeRuntime
  }
}

export const name = 'dsh-tui-command-trees'

/** Small host-only registry; command execution remains owned by dsh-commands. */
export class TuiCommandTreeRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiCommandTrees')
    compositionRoot(ctx)
    const runtime = this
    const state: CommandTreeState = { providers: new Map(), owners: new Map(), host: undefined }
    state.host = Object.freeze({
      children: path => childrenFor(runtime, path),
      descriptions: root => descriptionsFor(runtime, root),
    })
    commandTreeStates.set(this, state)
  }

  register(provider: TuiCommandTreeProvider): () => void {
    const caller = requirePluginCaller(this.ctx, 'tuiCommandTrees.register', this)
    const state = commandTreeStateFor(this)
    const owner = activationFiber(caller)
    if (owner === undefined) throw new Error('dsh-tui: tuiCommandTrees.register requires a live activation')
    const root = provider.root.trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]*$/u.test(root)) throw new TypeError(`invalid TUI command-tree root: ${provider.root}`)
    if (state.providers.has(root)) throw new Error(`TUI command-tree root "${root}" is already registered`)
    const normalized = { ...provider, root }
    state.providers.set(root, normalized)
    state.owners.set(root, owner)
    const dispose = () => {
      if (state.providers.get(root) !== normalized) return
      state.providers.delete(root)
      state.owners.delete(root)
    }
    bindCallerEffect(caller, dispose)
    return dispose
  }

  children(canonicalPath: readonly string[]): readonly CommandCompletionNode[] {
    const caller = requirePluginCaller(this.ctx, 'tuiCommandTrees.children', this)
    const owner = activationFiber(caller)
    return childrenFor(this, canonicalPath, owner)
  }

  descriptions(root: string): LocalizedDescriptions | undefined {
    const caller = requirePluginCaller(this.ctx, 'tuiCommandTrees.descriptions', this)
    const owner = activationFiber(caller)
    return descriptionsFor(this, root, owner)
  }
}

interface CommandTreeState {
  readonly providers: Map<string, TuiCommandTreeProvider>
  readonly owners: Map<string, object>
  host: TuiCommandTreeHost | undefined
}

const commandTreeStates = new WeakMap<TuiCommandTreeRuntime, CommandTreeState>()

function commandTreeStateFor(runtime: TuiCommandTreeRuntime): CommandTreeState {
  const state = commandTreeStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiCommandTrees host state is unavailable')
  return state
}

function childrenFor(
  runtime: TuiCommandTreeRuntime,
  canonicalPath: readonly string[],
  owner?: object,
): readonly CommandCompletionNode[] {
  const state = commandTreeStateFor(runtime)
  const root = canonicalPath[0]?.toLowerCase()
  if (root === undefined || (owner !== undefined && state.owners.get(root) !== owner)) return []
  const provider = state.providers.get(root)
  if (provider === undefined) return []
  try {
    return provider.children(canonicalPath)
  } catch {
    // Completion is optional UI metadata and must never block execution.
    return []
  }
}

function descriptionsFor(runtime: TuiCommandTreeRuntime, root: string, owner?: object): LocalizedDescriptions | undefined {
  const state = commandTreeStateFor(runtime)
  const normalized = root.trim().toLowerCase()
  if (owner !== undefined && state.owners.get(normalized) !== owner) return undefined
  return state.providers.get(normalized)?.descriptions
}

export function getHostCommandTrees(runtime: TuiCommandTreeRuntime | undefined): TuiCommandTreeHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return commandTreeStateFor(runtime).host
  } catch {
    return undefined
  }
}

export default TuiCommandTreeRuntime
