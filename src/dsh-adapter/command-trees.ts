/** Provider-neutral subcommand completion registry for terminal front doors. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CommandCompletionNode, LocalizedDescriptions } from '../commands.js'

export interface TuiCommandTreeProvider {
  /** Root command name without `/`. Must match the command registry entry. */
  root: string
  /** Optional provider-owned translations for the root command row. */
  descriptions?: LocalizedDescriptions
  /** Children for the full canonical path, including `root` at index zero. */
  children(canonicalPath: readonly string[]): readonly CommandCompletionNode[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiCommandTrees: TuiCommandTreeRuntime
  }
}

export const name = 'dsh-tui-command-trees'

/** Small host-only registry; command execution remains owned by dsh-commands. */
export class TuiCommandTreeRuntime extends Service {
  private readonly providers = new Map<string, TuiCommandTreeProvider>()

  constructor(ctx: Context) {
    super(ctx, 'tuiCommandTrees')
  }

  register(provider: TuiCommandTreeProvider): () => void {
    const root = provider.root.trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]*$/u.test(root)) throw new TypeError(`invalid TUI command-tree root: ${provider.root}`)
    if (this.providers.has(root)) throw new Error(`TUI command-tree root "${root}" is already registered`)
    const normalized = { ...provider, root }
    this.providers.set(root, normalized)
    return () => {
      if (this.providers.get(root) === normalized) this.providers.delete(root)
    }
  }

  children(canonicalPath: readonly string[]): readonly CommandCompletionNode[] {
    const root = canonicalPath[0]?.toLowerCase()
    if (root === undefined) return []
    const provider = this.providers.get(root)
    if (provider === undefined) return []
    try {
      return provider.children(canonicalPath)
    } catch {
      // Completion is optional UI metadata and must never block execution.
      return []
    }
  }

  descriptions(root: string): LocalizedDescriptions | undefined {
    return this.providers.get(root.trim().toLowerCase())?.descriptions
  }
}

export default TuiCommandTreeRuntime
