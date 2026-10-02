/**
 * Workspace files and slash completion for every session: the `fs` surface
 * `@` mentions and file completion read (the host fs service, else the local
 * disk where the backend runs on it), the fenced file queries, and the slash
 * completion tree with whatever catalog the composition offers for
 * `/model`, `/preset`, `/effort` and `/workspace` arguments. The backend's
 * own commands join the command list itself (core/session-controls.ts), so
 * completion lists them like any other entry.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandCompletionNode } from '../../../commands.js'
import type { ChannelBinding } from '../binding.js'
import { createCommandCompletions } from '../command-completions.js'
import { createFileActions } from '../file-actions.js'
import { createLocalFs } from '../local-fs.js'
import { mentionFs } from '../mentions.js'
import type { ChannelOwner } from '../owner.js'
import type { ChannelState, MentionFs } from '../types.js'
import type { CoreHost } from './host.js'

/** Argument catalogs the slash completion tree warms and reads. */
export interface CompletionCatalog {
  workspaceCommands(): readonly { name: string; aliases?: readonly string[]; description?: string }[]
  model: {
    warmModelNodes(): void
    modelNodes(): readonly CommandCompletionNode[]
    warmPresetOptions(): void
    presetOptions(): readonly { id: string; description?: string; name?: string; isDefault?: boolean }[]
    warmEffortLevels(): void
  }
}

/** No argument catalogs: the tree offers its static nodes only. */
export const NO_COMPLETION_CATALOG: CompletionCatalog = {
  workspaceCommands: () => [],
  model: {
    warmModelNodes: () => undefined,
    modelNodes: () => [],
    warmPresetOptions: () => undefined,
    presetOptions: () => [],
    warmEffortLevels: () => undefined,
  },
}

export function createCoreFiles(ctx: Context, deps: {
  owner: Pick<ChannelOwner, 'current' | 'signal'>
  binding: Pick<ChannelBinding, 'capture' | 'isCurrent'>
  state: () => ChannelState
  host: Pick<CoreHost, 'themeHost' | 'commandTrees'>
  /** Whether the local disk stands in for a missing host fs service. */
  localFallback(): boolean
}) {
  // The session's working directory is the local disk when the host mounts
  // no fs service and the backend runs here (mentions and `@` completion).
  const localFs = createLocalFs()
  const fallbackFs = (): MentionFs | undefined => deps.localFallback() ? localFs : undefined
  const fs = (): MentionFs | undefined => mentionFs(ctx) ?? fallbackFs()
  const fileActions = createFileActions({
    owner: deps.owner,
    capture: () => deps.binding.capture(),
    current: capture => deps.binding.isCurrent(capture as ReturnType<typeof deps.binding.capture>),
    cwd: () => deps.state().cwd,
    fs,
  })
  return {
    fallbackFs,
    listFileCandidates: fileActions.listFileCandidates,
    listFiles: fileActions.listFiles,
    /** The slash completion over the composition's argument catalogs. */
    commandCompletions(catalog: CompletionCatalog): ChannelState['commandCompletions'] {
      return createCommandCompletions({
        state: deps.state,
        themeHost: deps.host.themeHost,
        commandTrees: deps.host.commandTrees,
        workspaceCommands: catalog.workspaceCommands,
        model: catalog.model,
      })
    },
  }
}
