import React from 'react'
import type { ClickEvent } from '../../ink/events/click-event.js'
import type { ToolRow } from '../../dsh-adapter/channel.js'
import type { ToolBackground } from '../../tuiDisplayPrefs.js'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { AssistantTextMessage } from './AssistantTextMessage.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from './AssistantToolUseMessage.js'
import { TranscriptImages } from './TranscriptImages.js'

/**
 * Neutral transcript leaf rows (agent-team panels design §2): the main
 * MessageList and the subagent Agent-Transcript page render thinking / tool /
 * text rows through the SAME thin adapters over the leaf components, so a
 * child transcript reads exactly like the main one. The leaves stay
 * presentation-only — fold state, reveal cursors and row anchoring stay with
 * their owners, which pass them in as props.
 */

/** A settled/live thinking row (`⚓ Thinking` preview or expanded body). */
export function ThinkingLeafRow({
  thinking,
  textFull,
  marginTopOnTurn,
  streaming = false,
  preview = false,
  verbose,
  durationMs,
  reasoningTokens,
  isSelected = false,
  onClick,
}: {
  thinking: string
  /** The full un-revealed text the live preview ticker follows. */
  textFull?: string
  marginTopOnTurn: boolean
  streaming?: boolean
  preview?: boolean
  verbose: boolean
  durationMs?: number
  /** Thinking reported only as a count (no body) — the one-line header. */
  reasoningTokens?: number
  isSelected?: boolean
  onClick?(event: ClickEvent): void
}): React.ReactNode {
  return (
    <AssistantThinkingMessage
      thinking={thinking}
      textFull={textFull}
      marginTopOnTurn={marginTopOnTurn}
      streaming={streaming}
      preview={preview}
      verbose={verbose}
      durationMs={durationMs}
      reasoningTokens={reasoningTokens}
      isSelected={isSelected}
      onClick={onClick}
    />
  )
}

/** A tool-call card (args / result / error / diff), optionally with images. */
export function ToolLeafRow({
  tool,
  marginTopOnTurn,
  verbose,
  isSelected = false,
  isExpanded = false,
  footnote,
  diffLayout,
  toolBackground,
  smoothReveal,
  fresh,
  revealVersion,
  foldTerminalCommand,
  onClick,
  onOpenFile,
  images,
  onPreviewImage,
  suppressImageGraphics,
}: {
  tool: ToolRow
  marginTopOnTurn: boolean
  verbose: boolean
  isSelected?: boolean
  isExpanded?: boolean
  footnote?: string
  diffLayout?: 'auto' | 'split' | 'unified'
  toolBackground?: ToolBackground
  smoothReveal?: boolean
  fresh?: boolean
  revealVersion?: number
  foldTerminalCommand?: boolean
  onClick?(event: ClickEvent): void
  onOpenFile?: (path: string) => void
  images?: readonly TranscriptImage[]
  onPreviewImage?(image: TranscriptImage): void
  suppressImageGraphics?: boolean
}): React.ReactNode {
  return (
    <>
      <AssistantToolUseMessage
        tool={tool}
        marginTopOnTurn={marginTopOnTurn}
        verbose={verbose}
        isSelected={isSelected}
        isExpanded={isExpanded}
        footnote={footnote}
        diffLayout={diffLayout}
        toolBackground={toolBackground}
        smoothReveal={smoothReveal}
        fresh={fresh}
        revealVersion={revealVersion}
        foldTerminalCommand={foldTerminalCommand}
        onClick={onClick}
        onOpenFile={onOpenFile}
      />
      {images !== undefined && <TranscriptImages images={images} indent={4} onPreview={onPreviewImage} suppressGraphics={suppressImageGraphics} />}
    </>
  )
}

/** An assistant text row (`●` bullet + markdown body). */
export function AssistantTextLeafRow({
  text,
  marginTopOnTurn,
  isSelected = false,
  isExpanded = false,
}: {
  text: string
  marginTopOnTurn: boolean
  isSelected?: boolean
  isExpanded?: boolean
}): React.ReactNode {
  return (
    <AssistantTextMessage
      text={text}
      marginTopOnTurn={marginTopOnTurn}
      isSelected={isSelected}
      isExpanded={isExpanded}
    />
  )
}
