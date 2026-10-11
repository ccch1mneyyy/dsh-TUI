/** Input, attempt and activity types carried by the Claude translator. */
import type { ImageRef, PendingItem, UsageDelta } from '../../../agent/events.js'
import type { TodoPanelItem } from '../../../agent/index.js'

/** How confirmed user inputs become user rows. */
export type ClaudeUserRows =
  /** On `command_lifecycle{started}` (CLI capability `msg_lifecycle_v1`). */
  | 'lifecycle'
  /** On the CLI's `user{isReplay:true}` echo of our message (fallback). */
  | 'replay'

export interface ClaudeTranslatorOptions {
  readonly cwd: string
  readonly userRows: ClaudeUserRows
  /** Wall clock for event times (injected by fixtures for determinism). */
  readonly now?: () => number
  readonly debug?: (message: string) => void
  /**
   * Where a resumed session's numbering continues: the turn
   * and sequence counters the replayed history ended at, and the model it
   * last ran. Live events after a resume must neither reuse a replayed
   * (turn, step) — the projector binds attempts by position — nor a
   * replayed `seq` (settled assistant messages are deduplicated by it).
   */
  readonly start?: { readonly turn: number; readonly seq: number; readonly model?: string
    /** The replayed conversation's task table (replay.ts `taskSeeds()`):
     * seeded as the live table so a resumed TaskUpdate finds its id. */
    readonly tasks?: readonly ClaudeTaskSeed[] }
}

/** A pushed input awaiting the CLI's confirmation. */
export interface RegisteredInput {
  readonly text: string
  readonly placement: PendingItem['placement'] | 'turn' | 'now'
  /** Images the message carries (facades for the user row). */
  readonly images?: readonly ImageRef[]
}

/** The attempt (one API response) being assembled. */
export interface OpenAttempt {
  readonly id: string
  readonly step: number
  readonly model?: string
  reasoning: string
  text: string
  /** Visible TEXT streamed for this attempt (the settled blocks land in
   *  `text` only when the CLI sends the whole assistant message; a streamed
   *  response never does, so the narration window reads this). */
  streamText: string
  /** Blocks received via `assistant` messages. */
  blocks: number
  aborted: boolean
  /** Usage from `message_start` / `assistant` (input side). */
  usage: UsageDelta | undefined
  /** Cumulative output tokens from `message_delta`. */
  outputTokens: number | undefined
  /** Stream block index → tool call (for `input_json_delta`). */
  readonly streamTools: Map<number, string>
}

/**
 * One task of the CLI's task family (2.1.284+: TaskCreate/TaskUpdate/
 * TaskList/TaskGet replaced TodoWrite for plan tracking), as the todo panel
 * projects it. Keyed by the id the CLI assigned (a TaskCreate result).
 */
export interface TrackedTask {
  /** The `subject` line (the panel's content). */
  content: string
  status: TodoPanelItem['status']
  /** The spinner line while in_progress — tracked for parity with the
   *  family's input contract, never emitted (the panel shape is
   *  content/status only, exactly like TodoWrite's path). */
  activeForm?: string
  /** Creation order: the snapshot's row order. */
  seq: number
}

/**
 * One tracked task as a resumed session hands it to its live translator (a
 * resumed TaskUpdate names an id the replay tracked). Serializable: the
 * replay and the live session are two translator instances.
 */
export interface ClaudeTaskSeed {
  readonly id: string
  readonly content: string
  readonly status: TodoPanelItem['status']
  readonly activeForm?: string
  /** Creation order: the snapshot's row order. */
  readonly seq: number
}

/**
 * The translator's own state as the working-activity fold reads it (the
 * Claude counterpart of the DSH working-activity plugin's inputs): everything
 * the working line shows, already tracked here, so the fold (activity.ts)
 * re-parses nothing. A snapshot is taken after each translated message.
 */
export interface ClaudeActivityState {
  /** A turn is open (the line works only inside one). */
  readonly turnOpen: boolean
  /** Wall clock the open (or last) turn began (0 before the first). */
  readonly turnStartedAt: number
  /** The newest tool call not yet settled, main lane or subagent lane. */
  readonly openTool: { readonly name: string; readonly input: unknown } | undefined
  /** Tool results settled in the current turn (main lane). */
  readonly toolCount: number
  /** The in_progress tracked task's `activeForm` — the CLI's own spinner
   *  wording, the closest thing to a DSH phrase this backend has. */
  readonly activeForm: string | undefined
  /** The leading `⏵` self-narration line of the streaming reply, if any
   *  (the narrate contract: exactly one, at the very top). */
  readonly narration: string | undefined
}
