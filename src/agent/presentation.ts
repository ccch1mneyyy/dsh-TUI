/**
 * Backend-neutral tool-card presentation (docs/agent-backend-design.md §3.2,
 * §5.2). The card SHAPES are the host-plane view types the UI already renders
 * (`ToolCallView`/`ToolResultView`); a backend translator decides which shape
 * a call gets, so neither the shared projector nor the UI ever picks a card by
 * tool name.
 */
import type { ToolCallView, ToolResultView } from '../adapter/ports/channel-view.js'

export type { ToolCallView, ToolResultView }

/** Optional decoration a backend may attach to a structured card. */
export interface ToolPresentationMeta {
  /** i18n key of the display name (`tool-name-*` family); absent = raw name. */
  readonly displayKey?: string
  /** Colour family: file mutations, command execution, everything else. */
  readonly category?: 'mutate' | 'exec' | 'other'
}

/**
 * The call renders through another surface, never as a tool card:
 * `question` — the interactive questionnaire panel (the answered record is
 * projected from the paired result); `subagent` — the live subagent row.
 */
export interface SuppressedToolPresentation {
  readonly card: 'question' | 'subagent'
}

/** How one tool call renders: a structured card shape, or suppression. */
export type ToolCallPresentation = (ToolCallView & ToolPresentationMeta) | SuppressedToolPresentation

/** How one settled tool result renders (wins over the call view once set). */
export type ToolResultPresentation = ToolResultView & ToolPresentationMeta

/** Either half of a tool's presentation. */
export type ToolPresentation = ToolCallPresentation | ToolResultPresentation

/** Whether a call presentation suppresses the tool card. */
export function isSuppressedPresentation(
  presentation: ToolCallPresentation | undefined,
): presentation is SuppressedToolPresentation {
  return presentation !== undefined && (presentation.card === 'question' || presentation.card === 'subagent')
}
