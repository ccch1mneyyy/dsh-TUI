import { randomUUID } from 'node:crypto'
import { assembleContextFor, type Agent, type AgentHandle, type AgentStatus, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { createUserMessage, MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { discoverBaselineInstructionFiles } from '@deepseek-ai/dsh-agent-instructions'
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { LOCAL_COMMANDS, type LocalCommand } from './commands.js'
import { clearResumeTarget, readLastUsed, touchSession, type SessionRecord, writeResumeTarget } from './sessionHistory.js'
import { writeActivityFrames } from './activityPrefs.js'
import { readPresetPref, writePresetPref } from './presetPrefs.js'
import { composePreset, resolvePersistedPreset, rosterOf, runningPresetOf, serviceForAgent, type AgentPresetInfo } from './presets.js'
import { isPresetName } from './components/activityFrames.js'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { logForDebugging } from './utils/debug.js'
import type { SpinnerMode } from './components/Spinner/spinnerMode.js'

/** Tool-call card state, mirroring the Claude Code tool-use presentation. */
export interface ToolRow {
  readonly callId: string
  readonly name: string
  /** Raw JSON arguments as the model produced them (displayed truncated). */
  readonly argsText: string
  /** Full arguments, shown when Ctrl+O verbose mode is on; dropped when the
   *  row is folded (session log retains it). */
  argsFull?: string
  status: 'running' | 'ok' | 'error'
  resultText?: string
  /** Full result text, shown when Ctrl+O verbose mode is on. */
  resultFull?: string
  errorText?: string
  /** Wall-clock start of the call (live elapsed while running). */
  startedAt: number
  /** Settled wall-clock duration, written by tool/result. */
  durationMs?: number
}

/**
 * One rendered transcript row. The DSH session log is the source of truth:
 * rows are derived from `session/event` records (and the initial
 * `agent.session.events` replay), never from optimistic local state.
 */
export interface ChatRow {
  id: number
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'reasoning' | 'interrupt' | 'local' | 'local-output' | 'compact'
  /** Extra label for non-human user rows (e.g. `steering`). */
  label?: string
  text: string
  /** True while an assistant step is still streaming chunks. */
  streaming?: boolean
  /** Present on `tool` rows; the card model. */
  tool?: ToolRow
  /** Event wall-clock time (transcript-mode metadata, assistant rows). */
  time?: number
  /** Present on `reasoning` rows once settled: thinking wall-clock duration. */
  durationMs?: number
  /** Source session event seq — present on every log-derived row (rewind
   *  fork anchor on user rows; window-floor bookkeeping for the rest). */
  seq?: number
  /** True when the row's full text was folded to keep the transcript window
   *  bounded (see MAX_ROWS); the session log still holds the full content
   *  and loadOlder() restores it. */
  folded?: boolean
  /** True when loadOlder() restored this row from the log; restored rows are
   *  exempt from the next fold pass so a restore is not instantly undone. */
  restored?: boolean
}

/** Running token totals across the session's assistant messages. */
export interface TokenUsage {
  input: number
  output: number
}

/**
 * Latest `activity/status` snapshot (the log-only event appended by
 * `@deepseek-ai/dsh-working-activity` for any UI consumer): the model's
 * live working line — thinking copy, running tool, turn summary. cc-tui
 * renders it on the status line; nothing here requires the plugin (absent
 * events simply leave the slot empty).
 */
export interface ActivityStatus {
  readonly phase: 'idle' | 'waiting' | 'thinking' | 'tool' | 'done'
  /** Human-readable status line (plain text, no ANSI). */
  readonly line: string
  readonly label?: string
  readonly detail?: string
  readonly phrase?: string
  readonly toolCount: number
  readonly turnElapsedMs: number
}

/** A transient status message shown above the prompt input. */
export interface NotificationItem {
  id: number
  text: string
  /** Theme color key; defaults to dim. */
  color?: 'error' | 'warning' | 'success'
  /** Auto-dismiss after this many ms (default 4000). */
  timeoutMs: number
}

/**
 * Durable same-session goal projection surfaced on the channel (see
 * {@link Channel['goal']}). Mirrors the goal domain's `GoalSnapshot` +
 * replay counters; declared locally so the UI needs no dsh-goal dependency.
 */
export interface ChannelGoal {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  /** Total admitted goal-round cap. */
  maxGoalRounds: number
  /** Highest admitted continuation round so far. */
  roundsStarted: number
  /** Present exactly while `phase` is `blocked`. */
  blockedReason?: { code: string; message: string }
}

/** One entry of the latest todo-list snapshot (mirrors the session domain's
 *  `TodoItem`; declared locally for the same reason as {@link ChannelGoal}). */
export interface TodoPanelItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** One named prompt contribution with its model-visible text. */
export interface LoadedContextEntry {
  /** Provider-declared name (e.g. `harness:identity`, `deployment:persona`). */
  readonly name: string
  /** The interpolated text the model receives for this entry. */
  readonly text: string
}

/** One discovered workspace instruction file (AGENTS.md-family). */
export interface LoadedContextFile {
  /** Model-facing path (e.g. `./AGENTS.md`). */
  readonly displayPath: string
}

/** One model-invocable skill from the skill registry. */
export interface LoadedContextSkill {
  readonly name: string
  readonly description: string
}

/** One model-visible tool from the prompt assembly. */
export interface LoadedContextTool {
  readonly name: string
  readonly description: string
}

/**
 * Snapshot of everything a fresh conversation for the current agent will
 * load: the assembled system prompt (ordered sections, dynamic context,
 * tools), the workspace instruction files baseline discovery would inject,
 * and the skill catalog. Declared locally so screens and helpers consume a
 * self-contained contract instead of the dsh-system-prompt/dsh-skill types.
 */
export interface LoadedContext {
  /** Ordered system-prompt sections after strict variable interpolation. */
  readonly sections: readonly LoadedContextEntry[]
  /** Dynamic context contributions (runtime snapshot parts). */
  readonly contexts: readonly LoadedContextEntry[]
  /** Workspace instruction files (AGENTS.md-family) discovered for the cwd. */
  readonly files: readonly LoadedContextFile[]
  /** Model-invocable skills, when the skill registry is mounted. */
  readonly skills: readonly LoadedContextSkill[]
  /** Model-visible tools in assembly order. */
  readonly tools: readonly LoadedContextTool[]
}

/**
 * The public channel surface a screen renders: the full transcript and live
 * status snapshot (tokens, spinner, working activity, goals, todos, loaded
 * context) plus every action the TUI can take (submit, steer, cancel,
 * rewind, resume, model switching, …). Implementations mutate internal state
 * and bump `version` so subscribed screens re-render.
 */
export interface Channel {
  /** Monotonic version — bump on every mutation so screens can re-render. */
  readonly version: number
  readonly rows: readonly ChatRow[]
  readonly status: AgentStatus | 'starting' | 'disposed'
  readonly sessionTitle: string
  readonly agentId: string
  /** Resolved model id (from the plugin config). */
  readonly model: string
  /** Provider route of the live agent. */
  readonly provider: string
  /** Running token totals across the session's assistant messages. */
  readonly tokens: TokenUsage
  /** Working directory of the session. */
  readonly cwd: string
  /** Current git branch, when the cwd is inside a git worktree. */
  readonly gitBranch: string | undefined
  /** True between turn/start and turn/end — drives the working spinner. */
  readonly working: boolean
  /** Which phase the spinner should present while working. */
  readonly spinnerMode: SpinnerMode
  /** Chars streamed as text this turn (feeds the spinner token counter). */
  readonly responseChars: number
  /** Number of tool calls still in flight this turn. */
  readonly activeToolCount: number
  /** Wall-clock ms of turn/start (spinner elapsed timer). */
  readonly turnStart: number
  /** Last user prompt text (sticky header + statusline). */
  readonly lastUserText: string
  /** Transient notifications, newest last. */
  readonly notifications: readonly NotificationItem[]
  /** Adapter-advertised context capacity for the model route, when known. */
  readonly contextWindow: number | undefined
  /** Reasoning effort of the latest request header, when the adapter sets one. */
  readonly reasoningEffort: string | undefined
  /** Usage of the most recent request (context share + cache hits come from
   *  this, not the running totals — each request's input IS the context). */
  readonly lastUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number }
    | undefined
  /** Output tokens per second of the current/last turn's response, when known. */
  readonly tps: number | undefined
  /** Per-message tps samples (sparkline + μ/p95 readout), oldest first. */
  readonly tpsSamples: readonly { tps: number; at: number }[]
  /** Latest working-activity snapshot (log-only `activity/status` event),
   *  when the leaf mounts dsh-working-activity. */
  readonly workingActivity: ActivityStatus | undefined
  /** Working-activity indicator preset name (`claude`/`moon`/…/`random`). */
  readonly activityFrames: string | undefined
  /** Whether working-activity events are consumed (config.activity). */
  readonly activityEnabled: boolean
  /**
   * Current same-session goal projection, when a goal exists. Derived live
   * from the durable `goal/change` context events (round-zero goal-sourced
   * user messages) in the session log — every goal mutation appends one, so
   * this snapshot tracks create/edit/pause/resume/complete/block/clear in
   * real time and replays correctly on resume/rewind.
   */
  readonly goal: ChannelGoal | undefined
  /**
   * Latest todo-list snapshot (`todo/write` whole-list event, last write
   * wins). Log-only UI state, updated live and on replay.
   */
  readonly todos: readonly TodoPanelItem[]
  /**
   * Snapshot of the context a fresh conversation for this agent will load
   * (system prompt sections, dynamic context, workspace instructions, skill
   * catalog, tools), computed at boot and on every agent swap. `undefined`
   * while loading or when the snapshot could not be assembled — the startup
   * panel stays hidden until it lands.
   */
  readonly loadedContext: LoadedContext | undefined
  /**
   * Messages submitted while the model was working and not yet claimed by a
   * turn (`steer` → next step boundary of the running turn, `followup` →
   * after the turn ends). Driven by agent inbox events.
   */
  readonly pending: readonly PendingMessage[]
  /**
   * Effective slash commands: built-in locals plus plugin-registered
   * commands (plan/goal/…) merged from the DSH command registry. The
   * registry is the source of truth for external names — a plugin shadows
   * nothing here; locals win on name collisions.
   */
  readonly commandList: readonly LocalCommand[]
  /**
   * Run a plugin-registered slash command against the live agent (DSH
   * `dsh-commands` registry): logs `command/run`/`command/done` and returns
   * the handler's result text — `''` when the handler succeeded silently,
   * `undefined` when the registry has no such command (the caller falls
   * back to sending the line to the model).
   */
  runExternalCommand(name: string, rawInput: string): Promise<string | undefined>
  /** Estimated context segments by content type (pi-nano-context style bar). */
  readonly contextSegments: {
    system: number
    prompt: number
    assistant: number
    thinking: number
    tools: number
  }
  subscribe: (listener: () => void) => () => void
  submit(text: string): void
  /**
   * Steer a message into the running turn (Codex/pi semantics): injected at
   * the next step boundary, the agent continues without aborting.
   */
  steer(text: string): void
  /** Pull a pending message back out of the inbox (Alt+Up) for re-editing. */
  removePending(id: string): boolean
  /** Abort the in-flight turn (`Ctrl+C` while working). */
  cancel(): void
  /** Abort the in-flight turn and process `texts` right away (Esc/Ctrl+Enter
   *  with queued input): each text is re-queued as a followup once the abort
   *  settles, so the new turn starts immediately. Returns the count queued. */
  interruptAndDeliver(texts: readonly string[]): number
  /** Rewind the conversation to a past user message (CC's double-Esc rewind):
   *  forks the session through that message, swaps in a fresh agent, and
   *  returns the message text for re-editing — or `null` when unwritable. */
  rewindTo(row: ChatRow): Promise<string | null>
  /** Switch the live agent to a persisted session, replaying its history. */
  resumeTo(sessionId: string): Promise<boolean>
  /** Start a fresh conversation (`/new`): a brand-new agent + session, the
   *  transcript cleared, the resume marker forgotten. */
  newSession(): Promise<boolean>
  /** Switch the live model (`/model` picker): forks the conversation at its
   *  current end and continues it with a new agent routed to `provider`/`model`.
   *  The history replays unchanged; only the request route changes. */
  switchModel(provider: string, model: string): Promise<boolean>
  /** The preset the CURRENT session runs under (issue #8), resolved from its
   *  log at create/resume time; undefined when no roster is mounted. */
  readonly agentPreset: string | undefined
  /** The roster's presets for the `/preset` picker (empty without a roster). */
  listPresets(): Promise<readonly PresetOption[]>
  /** Switch the agent preset (`/preset`): a blank session swaps composition
   *  in place (official `recompose` + logged `agent-preset/selected`); a
   *  started session is locked, so the choice persists as the default for
   *  future sessions instead. False when the roster is absent, the id is
   *  unknown/broken, or a turn is running. */
  switchPreset(presetId: string): Promise<boolean>
  /** Reset the visible transcript (`/clear`). */
  clear(): void
  /**
   * Re-render rows older than the current in-memory window from the session
   * log (rows beyond {@link ChannelState.rows}' cap are folded away; this
   * restores them for review). Returns the number of rows restored, 0 when
   * the whole log is already materialized.
   */
  loadOlder(): number
  /** Push a transient notification above the prompt input. */
  notify(text: string, options?: { color?: NotificationItem['color']; timeoutMs?: number }): void
  /** Switch the working-activity indicator preset (`/activity`): validates
   *  the name, persists it to `~/.dsh-cc/working-activity.json`, and
   *  re-renders the indicator immediately; false when the name is unknown
   *  or the preference cannot be written. */
  setActivityFrames(name: string): boolean
  /** Advertised models across every registered provider route (empty when the LLM service is absent). */
  listModels(): Promise<readonly LlmModelInfo[]>
  /** Top-level entries of the session cwd for `@` file completion. */
  listFiles(): Promise<readonly string[]>
  /** Recent sessions recorded by the DSH persistence backend (for `/resume`). */
  listSessions(): Promise<readonly SessionRecord[]>
  /** Mark a session for `dsh-cc --resume` on the next launch. */
  setResumeTarget(sessionId: string): void
  /** Manually compact the session history (CC's /compact); no-op notify when the leaf lacks a compaction service. */
  compact(): void
  /** Render a multi-line local report in the transcript (`/status`,
   *  `/doctor`, …): a `local` row plus one `local-output` row per line. */
  pushLocal(title: string, lines: readonly string[]): void
  /** MCP server/tool status for /mcp: one line per server, or setup guidance. */
  mcpStatus(): string[]
  /** Write the conversation transcript to `dsh-cc-export-<ts>.md` in the
   *  session cwd; returns the written path, or null on failure. */
  exportSession(): string | null
  /** Create `AGENTS.md` in the session cwd (DSH workspace-context file);
   *  returns the path, `'exists'` when already present, or null on failure. */
  initWorkspace(): string | null
  /** Environment diagnostics for `/doctor`. */
  doctorInfo(): string[]
  /** Subagent rows for `/agents` (DSH subagent service; empty message when
   *  the service is absent). */
  listSubagents(): Promise<string[]>
}

/** @internal */
/** One roster entry in the `/preset` picker (see {@link Channel.listPresets}). */
export interface PresetOption {
  id: string
  name?: string
  description?: string
  /** Present when the roster marked this preset unloadable (shown verbatim). */
  broken?: string
  isDefault: boolean
}

/** @internal */
/** One user message submitted while the model was working, not yet claimed
 *  by a turn. `steer` lands at the next step boundary of the running turn;
 *  `followup` waits for the turn to end. */
export interface PendingMessage {
  id: string
  text: string
  placement: 'steer' | 'followup'
}

/**
 * Mutable channel state owned by {@link createChannel}: the screen's
 * reactive store. Screens subscribe and re-render on `version` bumps; the
 * fields mirror the public {@link Channel} contract, and the `@internal`
 * emit hooks belong to the implementation.
 */
export interface ChannelState {
  version: number
  rows: ChatRow[]
  status: AgentStatus | 'starting' | 'disposed'
  sessionTitle: string
  agentId: string
  model: string
  provider: string
  tokens: TokenUsage
  cwd: string
  gitBranch: string | undefined
  working: boolean
  spinnerMode: SpinnerMode
  responseChars: number
  activeToolCount: number
  turnStart: number
  lastUserText: string
  notifications: NotificationItem[]
  /** Adapter-advertised context capacity for the model route, when known. */
  contextWindow: number | undefined
  /** Reasoning effort of the latest request header, when the adapter sets one. */
  reasoningEffort: string | undefined
  /** Usage of the most recent request (context share + cache hits). */
  lastUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number }
    | undefined
  /** Output tokens per second of the current/last turn's response, when known. */
  tps: number | undefined
  /** Per-message tps samples (sparkline + μ/p95 readout), oldest first. */
  tpsSamples: { tps: number; at: number }[]
  /** Latest working-activity snapshot (see the public Channel type). */
  workingActivity: ActivityStatus | undefined
  /** Working-activity indicator preset (see the public Channel type). */
  activityFrames: string | undefined
  /** Working-activity consumption switch (see the public Channel type). */
  activityEnabled: boolean
  /** Current same-session goal projection (see the public Channel type). */
  goal: ChannelGoal | undefined
  /** Latest todo-list snapshot (see the public Channel type). */
  todos: TodoPanelItem[]
  /** Loaded-context snapshot (see the public Channel type). */
  loadedContext: LoadedContext | undefined
  /** Messages submitted while working, awaiting their turn/step boundary.
   *  Driven by agent inbox events (inserted/claimed/discarded). */
  pending: PendingMessage[]
  /** Effective slash commands (see the public Channel type). */
  commandList: readonly LocalCommand[]
  /** Run a plugin-registered command (see the public Channel type). */
  runExternalCommand(name: string, rawInput: string): Promise<string | undefined>
  /** Estimated context segments by content type (pi-nano-context style bar). */
  contextSegments: {
    system: number
    prompt: number
    assistant: number
    thinking: number
    tools: number
  }
  subscribe: (listener: () => void) => () => void
  /** @internal event bump (the public `notify(text)` posts a notification). */
  emit(): void
  /** @internal frame-aligned emit for high-frequency streaming deltas:
   *  version bumps synchronously but listeners fire at most once per 16ms
   *  window (trailing edge). */
  emitStream(): void
  submit(text: string): void
  steer(text: string): void
  removePending(id: string): boolean
  cancel(): void
  /** @internal interrupt-and-deliver (see the public Channel type). */
  interruptAndDeliver(texts: readonly string[]): number
  rewindTo(row: ChatRow): Promise<string | null>
  /** Switch the live agent to a persisted session, replaying its history. */
  resumeTo(sessionId: string): Promise<boolean>
  /** Start a fresh conversation (`/new`). */
  newSession(): Promise<boolean>
  /** Switch the live model (`/model` picker). */
  switchModel(provider: string, model: string): Promise<boolean>
  /** The preset the current session runs under (see the public Channel type). */
  agentPreset: string | undefined
  /** The roster's presets for the `/preset` picker (see the public Channel type). */
  listPresets(): Promise<readonly PresetOption[]>
  /** Switch the agent preset (see the public Channel type). */
  switchPreset(presetId: string): Promise<boolean>
  clear(): void
  /** @internal older-row restoration (see the public Channel.loadOlder). */
  loadOlder(): number
  notify(text: string, options?: { color?: NotificationItem['color']; timeoutMs?: number }): void
  /** Switch the working-activity indicator preset (see the public Channel). */
  setActivityFrames(name: string): boolean
  listModels(): Promise<readonly LlmModelInfo[]>
  listFiles(): Promise<readonly string[]>
  listSessions(): Promise<readonly SessionRecord[]>
  setResumeTarget(sessionId: string): void
  /** Manually compact the session history (CC's /compact). */
  compact(): void
  /** Multi-line local report (`/status`, `/doctor`, …). */
  pushLocal(title: string, lines: readonly string[]): void
  /** MCP server/tool status for /mcp: one line per server, or setup guidance. */
  mcpStatus(): string[]
  /** Export the transcript to a markdown file (CC's /export). */
  exportSession(): string | null
  /** Create `AGENTS.md` in the session cwd (CC's /init). */
  initWorkspace(): string | null
  /** Environment diagnostics (CC's /doctor). */
  doctorInfo(): string[]
  /** Subagent rows (CC's /agents). */
  listSubagents(): Promise<string[]>
}

const ARGS_PREVIEW_LIMIT = 160
const RESULT_PREVIEW_LIMIT = 240

/** Local `!`-command output cap (mirrors the result preview limit). */
const LOCAL_OUTPUT_LIMIT = 240

/**
 * In-memory transcript window cap. Older rows beyond this count are FOLDED:
 * their full-text fields (assistant/reasoning text, tool args/results) are
 * dropped and only the preview/status metadata kept, so a long merge/deploy
 * turn cannot grow the TUI's RAM without bound. The session log remains the
 * complete source of truth (`/export` reads it, `/resume` replays it); the
 * folded row keeps its kind/id so scrolling and selection stay stable.
 */
const MAX_ROWS = 600

function preview(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * Fold the oldest rows beyond the transcript window cap: drop each row's
 * full-text fields (assistant/reasoning text, tool args/results) and keep
 * only its preview text, kind, id, and seq. Bounds the TUI's retained text
 * without touching the session log (the source of truth for /export and
 * loadOlder). Small local/notice/interrupt rows are left intact (they hold
 * terminal-local text the log cannot restore). Restored rows are exempt so
 * a loadOlder() restore is not instantly undone. Returns the number of rows
 * folded.
 */
function foldRows(rows: ChatRow[], cap: number): number {
  const excess = rows.length - cap
  if (excess <= 0) return 0
  let folded = 0
  for (const row of rows.slice(0, excess)) {
    if (row.folded || row.restored) continue
    if (row.kind !== 'user' && row.kind !== 'assistant' && row.kind !== 'reasoning' && row.kind !== 'tool') continue
    row.folded = true
    folded += 1
    if (row.kind === 'tool' && row.tool) {
      row.tool.argsFull = undefined
      row.tool.resultFull = undefined
      row.tool.errorText = undefined
    } else if (row.text.length > 0) {
      // Keep a short preview so the transcript reads naturally; the full
      // text lives in the session log and is restored by loadOlder().
      row.text = preview(row.text, 200)
    }
  }
  return folded
}

/**
 * Restore folded rows from the session log, newest folded batch first.
 * Rebuilds each folded row's full text from its source events and clears
 * the folded mark, keeping row ids, scroll anchors, and selection stable.
 * Returns the number of rows restored.
 */
function foldBack(rows: ChatRow[], events: readonly SessionEvent[]): number {
  const folded = rows.filter(row => row.folded)
  if (folded.length === 0) return 0
  const firstFoldedSeq = folded[0]?.seq ?? 0
  const restoreEvents = events.filter(event => event.seq >= firstFoldedSeq)
  // tool results are matched by callId, not seq, because the result event
  // seq differs from the call event seq that anchored the row.
  const resultsByCall = new Map<string, SessionEvent<'tool/result'>>()
  for (const event of restoreEvents) {
    if (event.type === 'tool/result') {
      resultsByCall.set(event.data.message.source.callId, event)
    }
  }
  let restored = 0
  for (const row of folded) {
    const rowSeq = row.seq
    if (rowSeq === undefined) continue
    if (row.kind === 'tool' && row.tool !== undefined) {
      // The tool row is anchored on its tool/call seq; its result text comes
      // from the matching tool/result event.
      const call = restoreEvents.find(event => event.seq === rowSeq && event.type === 'tool/call')
      if (call === undefined || call.type !== 'tool/call') continue
      restoreRowFromEvent(row, call)
      const result = resultsByCall.get(row.tool.callId)
      if (result !== undefined) restoreToolResult(row, result)
      row.folded = false
      restored += 1
      continue
    }
    // Text rows are anchored on their first delta chunk; the settled
    // assistant/message at or after that seq carries the full text.
    const message = restoreEvents.find(event => event.seq >= rowSeq && event.type === 'assistant/message')
    if (message === undefined) continue
    restoreRowFromEvent(row, message)
    row.folded = false
    restored += 1
  }
  return restored
}

/** Rebuild a folded row's full text from its source session event. */
function restoreRowFromEvent(row: ChatRow, event: SessionEvent): void {
  switch (row.kind) {
    case 'user': {
      if (event.type !== 'user/message') break
      const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('').trim()
      if (text) row.text = text
      break
    }
    case 'assistant': {
      if (event.type !== 'assistant/message') break
      const text = event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('').trim()
      if (text) row.text = text
      break
    }
    case 'reasoning': {
      // Thinking text is carried by the assistant/message's reasoning
      // blocks, not the (ephemeral) delta chunks, so the settled message
      // restores it exactly.
      if (event.type !== 'assistant/message') break
      const text = event.data.message.content.map(block => block.type === 'reasoning' ? block.text : '').join('').trim()
      if (text) row.text = text
      break
    }
    case 'tool': {
      if (event.type !== 'tool/call' || row.tool === undefined) break
      row.tool.argsFull = event.data.arguments
      break
    }
    default:
      break
  }
}

/** Restore a folded tool row's result text from its tool/result event. */
function restoreToolResult(row: ChatRow, event: SessionEvent<'tool/result'>): void {
  if (row.tool === undefined) return
  const failure = event.data.error
  if (failure !== undefined) {
    row.tool.status = 'error'
    row.tool.errorText = `${failure.name}: ${failure.code}`
    return
  }
  row.tool.status = 'ok'
  const block = event.data.message.content[0]
  const result = block.content.map(b => b.type === 'text' ? b.text : '').join('').trim()
  row.tool.resultFull = result || undefined
}


/**
 * Coalesce runs of same-type assistant/chunk deltas into single synthetic
 * events for REPLAY only. A streamed turn logs one event per token (~100k
 * events in long sessions); replaying them one at a time costs per-chunk
 * string growth on every row (quadratic in the turn's length). Merging is
 * outcome-identical: ensureStreaming/ensureReasoning only read chunk.type
 * and the concatenated text, and the row's seq comes from the run's FIRST
 * chunk (the fork boundary rewindTo derives from it). Parts join once —
 * no quadratic concat. Live events never go through this.
 */
function coalesceReplayEvents(events: readonly SessionEvent[]): SessionEvent[] {
  type ChunkEvent = Extract<SessionEvent, { type: 'assistant/chunk' }>
  const out: SessionEvent[] = []
  let run: { event: ChunkEvent; type: string; parts: string[] } | null = null
  const flush = (): void => {
    if (run === null) return
    const chunk = run.event.data.chunk
    out.push({
      ...run.event,
      data: { ...run.event.data, chunk: { ...chunk, text: run.parts.join('') } },
    } as ChunkEvent)
    run = null
  }
  for (const event of events) {
    if (
      event.type === 'assistant/chunk' &&
      (event.data.chunk.type === 'text-delta' || event.data.chunk.type === 'reasoning-delta')
    ) {
      if (run !== null && run.type === event.data.chunk.type) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack text
        run.parts.push(event.data.chunk.text ?? '')
        continue
      }
      flush()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack text
      run = { event, type: event.data.chunk.type, parts: [event.data.chunk.text ?? ''] }
      continue
    }
    flush()
    out.push(event)
  }
  flush()
  return out
}

/** Buffer below the context window at which CC warns (autoCompact.ts). */
const CONTEXT_WARNING_BUFFER_TOKENS = 20_000

/** How many newest sessions resolve their title from the first user message
 *  (persistence.load reads the whole log — depth caps the picker latency). */
const SESSION_TITLE_DEPTH = 20
/** Picker title cap, in characters. */
const SESSION_TITLE_LIMIT = 40

/** One-line session title: whitespace folded, capped with an ellipsis. */
function shortenTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= SESSION_TITLE_LIMIT
    ? flat
    : `${flat.slice(0, SESSION_TITLE_LIMIT - 1)}…`
}

/** Resolve once a `turn/end` event newer than `fromSeq` lands in the session
 *  log (Agent.cancel closes the turn asynchronously), or when the timeout
 *  expires. Polling the session log is race-free here: fork reads the same
 *  append-only log. */
async function waitForTurnEnd(
  session: { seq: number; events: readonly SessionEvent[] },
  fromSeq: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = session.events.at(-1)
    if (last !== undefined && last.type === 'turn/end' && last.seq >= fromSeq) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

/**
 * Create the live channel state for one agent session: replay the durable
 * transcript, subscribe to the agent's events, and expose every TUI action.
 * @internal
 * @param ctx - The plugin context; optional services are resolved via ctx.get.
 * @param initialAgent - The agent whose session the channel renders; rewinds,
 *   resumes, and model switches replace it.
 * @param options - Boot options: model route, cwd, provider, and the
 *   reasoning-effort / working-activity / agent-handle preferences.
 * @returns The live channel state, subscribed and ready to render.
 */
export function createChannel(
  ctx: Context,
  initialAgent: Agent,
  options: {
    model: string
    cwd: string
    provider: string
    /** Configured reasoning effort, shown from startup until the first
     *  request/header event reports the adapter's live value. */
    effort?: string
    /** Consume `activity/status` session events (dsh-working-activity) into
     *  the status line; default on. */
    activity?: boolean
    /** Indicator preset for the working-activity line (`claude`/`moon`/
     *  `comet`/`dots`/… or `random`); default `claude`. */
    activityFrames?: string
    /** cordis.yml's static preset choice (`preset` key): wins over the
     *  persisted `/preset` preference for NEW sessions this channel starts. */
    configuredPreset?: string
    /** The preset the initial agent's session runs under (from resolveAgent). */
    agentPreset?: string
    /** Handle of the initial agent; disposed when a rewind replaces it. */
    handle?: AgentHandle
  },
): ChannelState {
  let agent = initialAgent
  let currentHandle: AgentHandle | undefined = options.handle
  // The DSH slash-command registry (optional service): /plan, /goal and
  // friends register here; the TUI merges their descriptors into the slash
  // menu and dispatches through `execute` (which logs the paired
  // command/run + command/done records). Absent the service, only the
  // built-in local commands exist.
  const commandService: CommandRuntime | undefined = ctx.get('commands')
  const listeners = new Set<() => void>()
  /** True while a frame-aligned stream notification is pending (emitStream). */
  let streamNotifyScheduled = false
  let nextNotificationId = 1
  /** One-shot context-low warning per session (CC's TokenWarning). */
  let contextWarned = false
  const checkContextWarning = (): void => {
    if (contextWarned || state.contextWindow === undefined) return
    const remaining = state.contextWindow - state.tokens.input
    if (remaining >= CONTEXT_WARNING_BUFFER_TOKENS) return
    contextWarned = true
    const percentLeft = Math.max(
      0,
      Math.round((remaining / state.contextWindow) * 100),
    )
    state.notify(
      `Context low (${percentLeft}% remaining) · Run /clear or start a new session`,
      { color: 'warning', timeoutMs: 8000 },
    )
  }
  /**
   * Register a submitted message as pending and notify the UI. The inbox
   * events (claimed/discarded) retire it; nothing here guesses timing.
   */
  const trackPending = (message: { id: string; text: string }, placement: PendingMessage['placement']): void => {
    state.pending = [...state.pending, { id: message.id, text: message.text, placement }]
    state.emit()
  }
  /** Remove one pending entry (rollback on a refused send, steering
   *  rejection, or delivery races) and notify only when it existed. */
  const untrackPending = (messageId: string): void => {
    const before = state.pending.length
    state.pending = state.pending.filter(item => item.id !== messageId)
    if (state.pending.length !== before) state.emit()
  }
  /** Monotonic token: only the latest `interruptAndDeliver` re-queues, so a
   *  second interrupt while the abort settles cannot double-deliver. */
  let interruptSeq = 0
  const state: ChannelState = {
    version: 0,
    rows: [],
    status: 'starting',
    sessionTitle: '',
    agentId: agent.id,
    model: options.model,
    provider: options.provider,
    tokens: { input: 0, output: 0 },
    cwd: options.cwd,
    gitBranch: undefined,
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: options.effort,
    workingActivity: undefined,
    activityFrames: options.activityFrames,
    activityEnabled: options.activity !== false,
    agentPreset: options.agentPreset,
    goal: undefined,
    todos: [],
    loadedContext: undefined,
    pending: [],
    commandList: LOCAL_COMMANDS,
    lastUsage: undefined,
    tps: undefined,
    tpsSamples: [],
    contextSegments: {
      system: 0,
      prompt: 0,
      assistant: 0,
      thinking: 0,
      tools: 0,
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit() {
      foldRows(state.rows, MAX_ROWS)
      state.version += 1
      for (const listener of listeners) listener()
    },
    // Frame-aligned notification for streaming deltas. LLM chunks arrive at
    // 100-300 events/s (one per token); waking React synchronously per event
    // commits the whole tree per token — the render throttle only gates
    // paint, not commits, so the event loop saturates and output stutters.
    // Data + version stay synchronous (getSnapshot always reads fresh
    // state); only the listener wakeup coalesces to paint cadence.
    emitStream() {
      state.version += 1
      if (streamNotifyScheduled) return
      streamNotifyScheduled = true
      const timer = setTimeout(() => {
        streamNotifyScheduled = false
        foldRows(state.rows, MAX_ROWS)
        for (const listener of listeners) listener()
      }, 16)
      // Never hold the process open for a pending UI wakeup.
      timer.unref()
    },
    loadOlder() {
      // Restore folded-away full text from the session log, newest folded
      // batch first, clearing the folded marks. The log is the authoritative
      // source, so restored rows match a fresh replay; live streaming rows
      // are never folded, so nothing here races a running turn.
      const restored = foldBack(state.rows, agent.session.events)
      if (restored > 0) state.emit()
      return restored
    },
    submit(text) {
      const trimmed = text.trim()
      if (!trimmed) return
      // Claude Code's `!` mode: `!cmd` runs locally and only shows the
      // output; `!!cmd` additionally sends the output to the model as a
      // user message (CC's <bash-stdout> convention).
      if (trimmed.startsWith('!!')) {
        void runLocalCommand(trimmed.slice(2).trim(), true)
        return
      }
      if (trimmed.startsWith('!')) {
        void runLocalCommand(trimmed.slice(1).trim(), false)
        return
      }
      // The current session is being used — move it to the MRU front
      // (/resume sorts by last-used).
      touchSession(state.agentId)
      const message = createUserMessage({ content: [{ type: 'text', text: trimmed }], source: { kind: 'user' } })
      // Track BEFORE the agent call: a synchronous throw inside send()
      // rolls the preview back; otherwise the inbox events retire it once
      // the message is claimed or discarded.
      trackPending({ id: message.id, text: trimmed }, 'followup')
      try {
        agent.followup(message)
      } catch (error) {
        untrackPending(message.id)
        throw error
      }
    },
    /** Steer a message into the RUNNING turn (Codex/pi semantics): it is
     *  injected at the next step boundary of the current turn and the agent
     *  continues without stopping — faster than followup, never an abort. */
    steer(text) {
      const trimmed = text.trim()
      if (!trimmed) return
      touchSession(state.agentId)
      const message = createUserMessage({ content: [{ type: 'text', text: trimmed }], source: { kind: 'user' } })
      trackPending({ id: message.id, text: trimmed }, 'steer')
      try {
        // Official dsh-agent rc.6: steer() is synchronous void — the message
        // enters the next-step inbox. A rejected step leaves it parked for the
        // next wake; the inbox events below retire the preview (claimed →
        // turn boundary, discarded → cancel).
        agent.steer(message)
      } catch (error) {
        untrackPending(message.id)
        throw error
      }
    },
    /** Pull a pending message back out of the inbox (Alt+Up): it returns to
     *  the input for editing instead of being delivered. */
    removePending(id: string): boolean {
      const index = state.pending.findIndex(item => item.id === id)
      if (index === -1) return false
      // Official dsh-agent rc.6: withdrawal goes through the agent's inbox
      // projection — `Inbox.remove(messageId)` durably records the
      // cancellation (an `agent/inbox/spliced` session event) and publishes
      // `agent/inbox/discarded`, which retires the preview. Refuse when the
      // message was already claimed (remove returns false) so the UI never
      // pretends a ghost send was pulled back.
      if (!agent.inbox.remove(MessageId(id))) return false
      state.pending = state.pending.filter(item => item.id !== id)
      state.emit()
      return true
    },
    cancel() {
      // Keep the staged queue: an interrupt aborts the running turn but the
      // queued/steered messages are delivered as the next turn (web parity).
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    },
    interruptAndDeliver(texts: readonly string[]): number {
      const queued = texts.map(text => text.trim()).filter(text => text !== '')
      if (queued.length === 0) return 0
      // No keepInbox: the parked copies are dropped (their discard events
      // retire the preview), then each text is re-queued as a fresh
      // followup. The harness parks kept inbox work until an unrelated wake
      // (official cancel.spec: "keepInbox parks queued work after an active
      // turn aborts"), and a wake issued while the driver is still aborting
      // is ignored — so the re-queue happens on `whenIdle`, whose own wake
      // starts the new turn.
      agent.cancel({ kind: 'user' })
      const token = ++interruptSeq
      const whenIdle = (agent as { whenIdle?(): Promise<void> }).whenIdle
      const deliver = (): void => {
        // A second interrupt while the abort is still settling must not
        // double-deliver: only the latest request's re-queue runs.
        if (interruptSeq !== token) return
        for (const text of queued) {
          touchSession(state.agentId)
          const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
          trackPending({ id: message.id, text }, 'followup')
          agent.followup(message)
        }
      }
      if (typeof whenIdle === 'function') {
        void whenIdle.call(agent).then(deliver)
      } else {
        // Defensive: a wake while the driver still runs is ignored, so wait
        // for the abort to settle before re-queueing.
        setTimeout(deliver, 200)
      }
      return queued.length
    },
    async rewindTo(row: ChatRow): Promise<string | null> {
      if (row.seq === undefined) return null
      const sessions = ctx.get('sessions') as
        | { fork(source: unknown, boundary?: number): { events: readonly SessionEvent[] } }
        | undefined
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!sessions || !agents) {
        state.notify('Rewind unavailable — session services not loaded', { color: 'error' })
        return null
      }
      // Stop a running turn first and WAIT for its turn/end to land — fork
      // rejects boundaries inside open turns, and Agent.cancel() closes the
      // turn asynchronously (a long thinking turn can take seconds to settle).
      const wasWorking = state.working
      const cancelSeq = agent.session.seq
      if (wasWorking) agent.cancel({ kind: 'user' })
      if (wasWorking) {
        const turnSettled = await waitForTurnEnd(agent.session, cancelSeq, 30000)
        if (!turnSettled) {
          state.notify('Cannot rewind — the turn is still settling, try again in a moment', { color: 'error' })
          return null
        }
      }
      const childId = SessionId(randomUUID())
      // DSH event order is `turn/start → user/message → … → turn/end`, so a
      // message's own seq always sits inside its turn — forking there would
      // hit OPEN_TURN. Rewind to just BEFORE the message's turn/start: the
      // conversation restarts at that point and the message itself comes
      // back into the input for re-editing (CC's rewind semantics).
      const events = agent.session.events
      let boundary = row.seq
      for (let i = row.seq; i >= 0; i--) {
        const event = events[i]
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: seq may exceed events
        if (event === undefined) break
        if (event.type === 'turn/start') {
          boundary = event.seq - 1
          break
        }
        if (event.type === 'turn/end') break
      }
      // Slice the seed ourselves instead of storing a fork: agents.create
      // must own the session (a pre-created fork session would collide on
      // the same id). The create boundary validates the seed (contiguous
      // from seq 0, no open turns), which our boundary already guarantees.
      let seed: readonly SessionEvent[]
      try {
        if (boundary < 0) {
          throw new Error('cannot rewind to the very first message')
        }
        seed = sessions.fork(agent.session, boundary).events
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(`Cannot rewind to this point · ${message}`, { color: 'error' })
        return null
      }
      let handle: AgentHandle
      // The fork continues under the source session's own preset: switches
      // are blank-only, so every `agent-preset/selected` event predates any
      // rewind boundary and the source log resolves the exact composition.
      const rewindComposed = await composePreset(ctx, runningPresetOf(agent.session))
      try {
        handle = await agents.create({
          sessionId: childId,
          seed,
          meta: {
            cwd: options.cwd,
            parentSession: agent.session.id,
            seedLength: seed.length,
            ...(rewindComposed.agentPreset === undefined
              ? {}
              : { agentPreset: rewindComposed.agentPreset }),
          },
          agentOptions: { provider: options.provider, model: options.model },
          ...(rewindComposed.setup === undefined ? {} : { setup: rewindComposed.setup }),
        })
      } catch {
        state.notify('Rewind failed — could not create the replacement session', { color: 'error' })
        return null
      }
      // Replay the forked history into a fresh transcript (tokens/spinner
      // counters land back at the rewind point, matching the fork).
      streaming = undefined
      reasoning = undefined
      toolCards.clear()
      nextRowId = 0
      state.rows.length = 0
      // Goal/todo/title are session-scoped; the replay re-derives them for
      // the session being entered (or leaves them empty).
      state.todos = []
      state.goal = undefined
      state.sessionTitle = ''
      state.tokens = { input: 0, output: 0 }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
      state.spinnerMode = 'requesting'
      state.status = handle.agent.status
      state.agentId = handle.agent.id
      state.agentPreset = rewindComposed.agentPreset
      state.tps = undefined
      state.tpsSamples = []
      state.lastUsage = undefined
      state.workingActivity = undefined
      state.contextSegments = {
        system: 0,
        prompt: 0,
        assistant: 0,
        thinking: 0,
        tools: 0,
      }
      for (const event of coalesceReplayEvents(seed)) renderEvent(event)
      // Rebind subscriptions to the new agent, then free the old one.
      const oldHandle = currentHandle
      agent = handle.agent
      currentHandle = handle
      bindAgent()
      refreshCommandList()
      void refreshLoadedContext()
      // The forked session (rewind) becomes the most recently used.
      touchSession(childId)
      state.emit()
      void oldHandle?.dispose().catch(() => {})
      return row.text
    },
    async resumeTo(sessionId: string): Promise<boolean> {
      // Switch the live agent to a persisted session: /resume picker Enter
      // loads the history immediately (the `--resume` launcher path keeps
      // resolving through DSH_CC_RESUME_SESSION at boot).
      if (state.working) {
        state.notify('Cannot resume while a turn is running', { color: 'warning' })
        return false
      }
      const agents = ctx.get('agents') as
        | {
          resume(options: {
            resumeSessionId: SessionId
            agentOptions?: { provider?: string; model?: string }
            setup?: CreateAgentOptions['setup']
          }): Promise<AgentHandle>
        }
        | undefined
      if (!agents) {
        state.notify('Resume unavailable — agents service not loaded', { color: 'error' })
        return false
      }
      let handle: AgentHandle
      // The target session's own preset (from its persisted log) — never the
      // current preference: a resume re-enters the composition its history
      // was produced under.
      const resumeComposed = await composePreset(
        ctx,
        await resolvePersistedPreset(ctx, SessionId(sessionId)),
      )
      try {
        handle = await agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions: { provider: options.provider, model: options.model },
          ...(resumeComposed.setup === undefined ? {} : { setup: resumeComposed.setup }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(`Resume failed · ${message}`, { color: 'error', timeoutMs: 8000 })
        return false
      }
      // Replay the persisted history into a fresh transcript (same reset as
      // rewindTo, plus the context window which the replay re-derives).
      streaming = undefined
      reasoning = undefined
      toolCards.clear()
      nextRowId = 0
      state.rows.length = 0
      // Goal/todo/title are session-scoped; the replay re-derives them for
      // the session being entered (or leaves them empty).
      state.todos = []
      state.goal = undefined
      state.sessionTitle = ''
      state.tokens = { input: 0, output: 0 }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
      state.spinnerMode = 'requesting'
      state.status = handle.agent.status
      state.agentId = handle.agent.id
      state.agentPreset = resumeComposed.agentPreset
      state.tps = undefined
      state.tpsSamples = []
      state.lastUsage = undefined
      state.workingActivity = undefined
      state.contextWindow = undefined
      state.contextSegments = {
        system: 0,
        prompt: 0,
        assistant: 0,
        thinking: 0,
        tools: 0,
      }
      for (const event of coalesceReplayEvents(handle.agent.session.events)) renderEvent(event)
      settleStreaming()
      // Rebind subscriptions to the resumed agent, then free the old one.
      const oldHandle = currentHandle
      agent = handle.agent
      currentHandle = handle
      bindAgent()
      refreshCommandList()
      void refreshLoadedContext()
      // Keep the `--resume` launcher contract pointing at the same session.
      writeResumeTarget(sessionId)
      // The resumed session is now the most recently used.
      touchSession(sessionId)
      state.emit()
      void oldHandle?.dispose().catch(() => {})
      return true
    },
    async newSession(): Promise<boolean> {
      // `/new` — start a fresh conversation: brand-new agent + session, the
      // transcript reset, the `--resume` marker forgotten (the old session
      // stays persisted for /resume). Same reset shape as rewindTo/resumeTo.
      if (state.working) {
        state.notify('Cannot start a new session while a turn is running', {
          color: 'warning',
        })
        return false
      }
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!agents) {
        state.notify('New session unavailable — agents service not loaded', {
          color: 'error',
        })
        return false
      }
      const sessionId = SessionId(randomUUID())
      let handle: AgentHandle
      // A fresh session composes the caller's DEFAULT preset: the cordis.yml
      // `preset` key wins over the persisted `/preset` choice, which wins
      // over the roster default (same precedence as activityFrames).
      const newComposed = await composePreset(ctx, options.configuredPreset ?? readPresetPref())
      try {
        handle = await agents.create({
          sessionId,
          meta: {
            cwd: options.cwd,
            ...(newComposed.agentPreset === undefined
              ? {}
              : { agentPreset: newComposed.agentPreset }),
          },
          agentOptions: { provider: options.provider, model: options.model },
          ...(newComposed.setup === undefined ? {} : { setup: newComposed.setup }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(`New session failed · ${message}`, {
          color: 'error',
          timeoutMs: 8000,
        })
        return false
      }
      streaming = undefined
      reasoning = undefined
      toolCards.clear()
      nextRowId = 0
      state.rows.length = 0
      // Goal/todo/title are session-scoped; the replay re-derives them for
      // the session being entered (or leaves them empty).
      state.todos = []
      state.goal = undefined
      state.sessionTitle = ''
      state.tokens = { input: 0, output: 0 }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
      state.spinnerMode = 'requesting'
      state.status = handle.agent.status
      state.agentId = handle.agent.id
      state.agentPreset = newComposed.agentPreset
      state.tps = undefined
      state.tpsSamples = []
      state.lastUsage = undefined
      state.workingActivity = undefined
      state.contextWindow = undefined
      state.contextSegments = {
        system: 0,
        prompt: 0,
        assistant: 0,
        thinking: 0,
        tools: 0,
      }
      const oldHandle = currentHandle
      agent = handle.agent
      currentHandle = handle
      bindAgent()
      refreshCommandList()
      void refreshLoadedContext()
      clearResumeTarget()
      // The brand-new session becomes the most recently used.
      touchSession(handle.agent.id)
      state.emit()
      void oldHandle?.dispose().catch(() => {})
      return true
    },
    async switchModel(provider: string, model: string): Promise<boolean> {
      // `/model` picker Enter — switch the live model by forking the
      // conversation at its current end and continuing with a new agent
      // routed to the chosen model. Same reset shape as rewindTo/resumeTo;
      // the history replays unchanged, only the request model changes.
      if (state.working) {
        state.notify('Cannot switch models while a turn is running', {
          color: 'warning',
        })
        return false
      }
      const sessions = ctx.get('sessions') as
        | { fork(source: unknown, boundary?: number): { events: readonly SessionEvent[] } }
        | undefined
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!sessions || !agents) {
        state.notify('Model switch unavailable — session services not loaded', {
          color: 'error',
        })
        return false
      }
      let seed: readonly SessionEvent[]
      try {
        // No boundary = fork the whole log (continue the conversation).
        seed = sessions.fork(agent.session).events
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(`Cannot switch models · ${message}`, { color: 'error' })
        return false
      }
      const childId = SessionId(randomUUID())
      let handle: AgentHandle
      // The forked conversation keeps the session's own preset — only the
      // request route changes (same rule as rewindTo).
      const modelComposed = await composePreset(ctx, runningPresetOf(agent.session))
      try {
        handle = await agents.create({
          sessionId: childId,
          seed,
          meta: {
            cwd: options.cwd,
            parentSession: agent.session.id,
            seedLength: seed.length,
            ...(modelComposed.agentPreset === undefined
              ? {}
              : { agentPreset: modelComposed.agentPreset }),
          },
          agentOptions: { provider, model },
          ...(modelComposed.setup === undefined ? {} : { setup: modelComposed.setup }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(`Model switch failed · ${message}`, { color: 'error', timeoutMs: 8000 })
        return false
      }
      streaming = undefined
      reasoning = undefined
      toolCards.clear()
      nextRowId = 0
      state.rows.length = 0
      // Goal/todo/title are session-scoped; the replay re-derives them for
      // the session being entered (or leaves them empty).
      state.todos = []
      state.goal = undefined
      state.sessionTitle = ''
      state.tokens = { input: 0, output: 0 }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
      state.spinnerMode = 'requesting'
      state.status = handle.agent.status
      state.agentId = handle.agent.id
      state.agentPreset = modelComposed.agentPreset
      state.model = model
      state.provider = provider
      state.tps = undefined
      state.tpsSamples = []
      state.lastUsage = undefined
      state.workingActivity = undefined
      state.contextWindow = undefined
      state.contextSegments = {
        system: 0,
        prompt: 0,
        assistant: 0,
        thinking: 0,
        tools: 0,
      }
      for (const event of coalesceReplayEvents(seed)) renderEvent(event)
      settleStreaming()
      const oldHandle = currentHandle
      agent = handle.agent
      currentHandle = handle
      bindAgent()
      refreshCommandList()
      void refreshLoadedContext()
      // The model-switched fork becomes the most recently used.
      touchSession(childId)
      state.emit()
      void oldHandle?.dispose().catch(() => {})
      return true
    },
    clear() {
      state.rows.length = 0
      nextRowId = 0
      streaming = undefined
      reasoning = undefined
      toolCards.clear()
      state.activeToolCount = 0
      state.responseChars = 0
      state.rows.push({
        id: nextRowId,
        kind: 'notice',
        text: 'Session cleared',
      })
      nextRowId += 1
      state.emit()
    },
    notify(text, options = {}) {
      const item: NotificationItem = {
        id: nextNotificationId++,
        text,
        color: options.color,
        timeoutMs: options.timeoutMs ?? 4000,
      }
      state.notifications.push(item)
      state.emit()
      setTimeout(() => {
        const index = state.notifications.indexOf(item)
        if (index >= 0) {
          state.notifications.splice(index, 1)
          state.emit()
        }
      }, item.timeoutMs)
    },
    setActivityFrames(name) {
      if (!isPresetName(name)) {
        state.notify(`未知预设「${name}」· /activity frames 查看全部`, { color: 'error' })
        return false
      }
      if (name === state.activityFrames) {
        state.notify(`指示器已是：${name}`, { color: 'success' })
        return true
      }
      // Persist first (pi behavior: a failed write refuses the switch) so a
      // preference that cannot be saved never silently disappears.
      if (!writeActivityFrames(name)) {
        state.notify('无法写入 ~/.dsh-cc/working-activity.json，切换未保存', { color: 'error' })
        return false
      }
      state.activityFrames = name
      state.emit()
      state.notify(`指示器已切换：${name}（已保存）`)
      return true
    },
    async listPresets() {
      const presets = rosterOf(ctx)
      if (presets === undefined) return []
      try {
        const list = await presets.list()
        return list.map(preset => ({
          id: preset.id,
          ...(preset.name === undefined ? {} : { name: preset.name }),
          ...(preset.description === undefined ? {} : { description: preset.description }),
          ...(preset.broken === undefined ? {} : { broken: preset.broken }),
          isDefault: preset.id === presets.defaultId,
        }))
      } catch {
        return []
      }
    },
    async switchPreset(presetId) {
      const presets = rosterOf(ctx)
      if (presets === undefined) {
        state.notify('Preset 不可用——当前组合未挂载 agent-presets 名册', { color: 'error' })
        return false
      }
      if (state.working) {
        state.notify('Agent 运行中，无法切换 preset', { color: 'warning' })
        return false
      }
      let target: AgentPresetInfo
      try {
        target = await presets.resolve(presetId)
      } catch (error) {
        state.notify(
          `Preset「${presetId}」不存在 · ${error instanceof Error ? error.message : String(error)}`,
          { color: 'error', timeoutMs: 8000 },
        )
        return false
      }
      if (target.broken !== undefined) {
        state.notify(`Preset「${presetId}」无法加载 · ${target.broken}`, { color: 'error', timeoutMs: 8000 })
        return false
      }
      if (target.id === state.agentPreset) {
        state.notify(`当前 preset 已是：${target.id}`, { color: 'success' })
        return true
      }
      // Official rule (dsh-agent-presets): only a session that has produced
      // nothing may swap compositions — a started session's logged tool calls
      // would strand under a different tool set. Blank = no turn ever ran.
      const blank = !agent.session.events.some(event => event.type === 'turn/start')
      if (!blank) {
        // Persist as the default for future sessions instead of failing.
        if (!writePresetPref(target.id)) {
          state.notify('无法写入 ~/.dsh-cc/agent-preset.json，选择未保存', { color: 'error' })
          return false
        }
        state.notify(
          `会话已开始，preset 已锁定（当前：${state.agentPreset ?? 'host'}）· 已保存为默认：${target.id}（/new 或下次启动生效）`,
          { color: 'warning', timeoutMs: 8000 },
        )
        return true
      }
      try {
        const preset = await presets.recompose(agent.ctx, target.id)
        // The switch is a logged session fact (model-visible ⟺ logged):
        // resumes/forks of this session resolve the NEW composition. The
        // type is runtime-registered in dsh-session's known-event set but
        // not yet in its typed SessionEventMap — cast the SESSION (never
        // extract the method: `append` reads the private `this.log`, so an
        // unbound call throws "Cannot read properties of undefined").
        const session = agent.session as unknown as { append(type: string, data: unknown): void }
        session.append('agent-preset/selected', { agentPreset: preset.id })
        state.agentPreset = preset.id
      } catch (error) {
        state.notify(
          `Preset 切换失败 · ${error instanceof Error ? error.message : String(error)}`,
          { color: 'error', timeoutMs: 8000 },
        )
        return false
      }
      state.emit()
      if (!writePresetPref(target.id)) {
        state.notify(`Preset 已切换：${target.id}，但默认偏好写入失败（重启后不保留）`, { color: 'warning' })
        return true
      }
      state.notify(`Preset 已切换：${target.id}（已保存为默认）`, { color: 'success' })
      return true
    },
    listModels() {
      const llm = ctx.get('llm') as
        | {
          listProviders(): readonly { id: string }[]
          listModels(provider: string): Promise<readonly LlmModelInfo[]>
        }
        | undefined
      if (!llm) return Promise.resolve([])
      const providers = llm.listProviders()
      return Promise.all(providers.map(provider => llm.listModels(provider.id).catch(() => [])))
        .then(lists => lists.flat())
    },
    listFiles() {
      const fs = ctx.get('fs') as
        | {
          resolve(path: string): Promise<{ displayPath: string }>
          listDir(target: { displayPath: string }): Promise<
            Array<{
              name: string
              type: 'file' | 'directory' | 'other'
              target: { displayPath: string }
            }>
          >
        }
        | undefined
      return listFilesDeep(fs, state.cwd)
    },
    async listSessions() {
      // DSH's own session index: the persistence backend materializes one
      // entry per durable session log (headers carry cwd + createdAt).
      const persistence = ctx.get('sessionPersistence') as
        | {
          list(signal?: AbortSignal): Promise<readonly SessionHeader[]>
          load(id: SessionId): Promise<{ events: readonly SessionEvent[] }>
        }
        | undefined
      if (!persistence) return []
      try {
        const headers = await persistence.list()
        // 按工作目录隔离（Claude Code 的项目维度）：/resume 只列出本会话
        // 目录启动的会话，别的项目的会话不出现在选择器里。
        const cwd = state.cwd.replace(/\/+$/, '')
        const local = headers.filter(header =>
          (header.cwd ?? '').replace(/\/+$/, '') === cwd,
        )
        // MRU ordering: DSH headers carry only createdAt, so cc-tui keeps its
        // own last-used timestamps (touchSession on resume/submit/new) and
        // falls back to createdAt for sessions never touched in this install.
        const lastUsed = readLastUsed()
        const records = local
          .map(header => ({
            id: header.id,
            // Titles load lazily below (first user message); until then the
            // cwd basename stands in (matching the status line), with a
            // short id when absent.
            title: basename(header.cwd ?? '') || `session ${String(header.id).slice(0, 8)}`,
            cwd: header.cwd ?? '',
            createdAt: header.createdAt,
            updatedAt: lastUsed[header.id] ?? header.createdAt,
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt)
        // Title = the session's FIRST user message — the picker's most
        // useful label. persistence.load reads the whole log (zstd), so
        // only the newest sessions pay for it; older rows keep the
        // basename fallback. A load failure degrades silently.
        const empty = new Set<string>()
        await Promise.all(
          records.slice(0, SESSION_TITLE_DEPTH).map(async (record) => {
            try {
              const { events } = await persistence.load(SessionId(record.id))
              const first = events.find(event => event.type === 'user/message')
              if (first === undefined) {
                // Launch artifact — a session with no user message holds no
                // conversation to resume, so drop it from the picker (its
                // createdAt-only updatedAt would otherwise pin it near the
                // top forever, one per dsh-cc launch).
                empty.add(record.id)
                return
              }
              const data = first.data as { content?: readonly ContentBlock[] }
              const text = textOf(data.content)
              if (text.length > 0) record.title = shortenTitle(text)
            } catch {
              // Keep the basename fallback.
            }
          }),
        )
        return records.filter(record => !empty.has(record.id))
      } catch {
        return []
      }
    },
    setResumeTarget(sessionId) {
      writeResumeTarget(sessionId)
    },
    compact() {
      // DSH compaction service key: `ctx.compaction` (dsh-compaction's
      // CompactionEngine; dsh-compaction-basic provides it in the example
      // leaf). Under agent presets the engine lives in the preset's isolate
      // realm, invisible from the root context — resolve through the agent's
      // scope chain first (minimal composes NO compaction: stays unavailable).
      const compactService = serviceForAgent<{
          // rc.6 signature: compactNow(agent: ManualCompactAgentContext,
          // signal, sourceCommandId?) — an Agent satisfies the context
          // (session/options/runMaintenance). The result shape is only used
          // for truthiness here.
          compactNow(
            agent: unknown,
            signal: AbortSignal,
          ): Promise<unknown>
        }>(ctx, agent, 'compaction')
      if (!compactService) {
        state.notify('Compaction unavailable · no compaction service in this leaf', {
          color: 'warning',
        })
        return
      }
      if (state.working) {
        state.notify('Cannot compact while a turn is running', { color: 'warning' })
        return
      }
      const signal = new AbortController().signal
      state.notify('Compacting conversation…')
      void compactService
        .compactNow(agent, signal)
        .then((result) => {
          state.notify(result ? 'Conversation compacted' : 'Nothing to compact')
        })
        .catch((error: unknown) => {
          state.notify(
            `Compaction failed · ${error instanceof Error ? error.message : String(error)}`,
            { color: 'error', timeoutMs: 8000 },
          )
        })
    },
    async runExternalCommand(name, rawInput) {
      if (!commandService) return undefined
      try {
        const execution = await commandService.execute(
          agent,
          `/${name}${rawInput}`,
          new AbortController().signal,
        )
        // `undefined` = not registered; a handler error surfaces as its
        // message so the user sees why the command failed.
        return execution?.result.text ?? ''
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    pushLocal(title, lines) {
      state.rows.push({ id: nextRowId++, kind: 'local', text: title })
      for (const line of lines) {
        state.rows.push({
          id: nextRowId++,
          kind: 'local-output',
          text: preview(line, LOCAL_OUTPUT_LIMIT),
        })
      }
      state.emit()
    },
    mcpStatus() {
      // MCP tools land on the tool runtime under mcp__<server>__<tool>
      // public names (dsh-mcp-client's naming contract); group by server.
      const runtime = ctx.get('tools') as
        | { schemas(scope?: unknown): readonly { name: string; description: string }[] }
        | undefined
      const schemas = runtime?.schemas() ?? []
      const byServer = new Map<string, string[]>()
      for (const schema of schemas) {
        const match = schema.name.match(/^mcp__([a-z0-9-]+)__(.+)$/)
        if (!match) continue
        const list = byServer.get(match[1]) ?? []
        list.push(match[2])
        byServer.set(match[1], list)
      }
      if (byServer.size === 0) {
        return [
          '未配置 MCP 服务器。',
          '在 profile 补丁层（~/.dsh/profiles/cc-tui/cordis.patch.yml）insert 一行即可，例：',
          '  - insert:',
          '      - id: mcp-context7',
          "        name: '@deepseek-ai/dsh-mcp-client'",
          '        config: { transport: stdio, serverName: context7, command: npx, args: ["-y", "@upstash/context7-mcp"] }',
          '详见仓库 README 的 MCP 章节。',
        ]
      }
      const lines: string[] = []
      for (const [server, tools] of byServer) {
        lines.push(`${server}（${tools.length} 个工具）: ${tools.join('、')}`)
      }
      return lines
    },
    exportSession() {
      // Export from the session log — the authoritative, complete record —
      // not the bounded transcript window (folded rows keep only previews).
      const parts: string[] = [
        '# dsh-cc 会话导出',
        '',
        `- 导出时间: ${new Date().toLocaleString()}`,
        `- 模型: ${state.model}`,
        `- 会话: ${state.agentId}`,
        `- 目录: ${state.cwd}`,
        '',
      ]
      for (const event of agent.session.events) {
        switch (event.type) {
          case 'user/message': {
            if (event.data.source.kind !== 'user') break
            const text = textOf(event.data.content)
            if (text) parts.push(`## 用户\n\n${text}\n`)
            break
          }
          case 'assistant/message': {
            const blocks = event.data.message.content
            for (const block of blocks) {
              if (block.type === 'reasoning' && block.text) {
                parts.push(`## 思考\n\n${block.text}\n`)
              } else if (block.type === 'text' && block.text) {
                parts.push(`## 助手\n\n${block.text}\n`)
              }
            }
            break
          }
          case 'tool/call': {
            parts.push(`## 工具 · ${event.data.name}\n\n\`\`\`json\n${event.data.arguments}\n\`\`\`\n`)
            break
          }
          case 'tool/result': {
            const block = event.data.message.content[0]
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
            if (block.type === 'tool-result') {
              const text = textOf(block.content)
              if (text) parts.push(`### 结果\n\n\`\`\`\n${text}\n\`\`\`\n`)
            }
            break
          }
          default:
            break
        }
      }
      const fileName = `dsh-cc-export-${Date.now()}.md`
      try {
        const target = join(state.cwd, fileName)
        writeFileSync(target, parts.join('\n'), 'utf8')
        return target
      } catch {
        return null
      }
    },
    initWorkspace() {
      const target = join(state.cwd, 'AGENTS.md')
      if (existsSync(target)) return 'exists'
      const template = [
        '# AGENTS.md',
        '',
        '## 项目',
        '',
        '（在此描述项目的目标、结构与约定——这份文件会注入给每个 agent 作为工作区上下文。）',
        '',
        '## 约定',
        '',
        '- 改动前先阅读相关模块',
        '- 保持与现有代码风格一致',
        '',
      ].join('\n')
      try {
        writeFileSync(target, template, 'utf8')
        return target
      } catch {
        return null
      }
    },
    doctorInfo() {
      const lines: string[] = []
      lines.push(`Node ${process.version} · ${process.platform} ${process.arch}`)
      lines.push(`API key: ${process.env.DEEPSEEK_API_KEY ? '已配置' : '未配置（DEEPSEEK_API_KEY）'}`)
      lines.push(`模型: ${state.model} · 提供方: ${options.provider}`)
      lines.push(`工作目录: ${state.cwd}`)
      lines.push(`上下文窗口: ${state.contextWindow ?? '未知'} tokens`)
      lines.push(`会话: ${state.agentId}${state.sessionTitle ? ' · ' + state.sessionTitle : ''}`)
      const userHome = process.env.USERPROFILE ?? homedir()
      const configCandidates = [
        join(userHome, '.dsh-cc/cordis.yml'),
        join(state.cwd, 'examples/cc-tui-agent/cordis.yml'),
      ]
      for (const candidate of configCandidates) {
        lines.push(`配置: ${candidate} ${existsSync(candidate) ? '✓' : '（不存在）'}`)
      }
      const sessionsDir = join(userHome, '.dsh-cc/sessions')
      lines.push(`会话存储: ${sessionsDir} ${existsSync(sessionsDir) ? '✓' : '（未初始化）'}`)
      return lines
    },
    async listSubagents() {
      const subagents = ctx.get('subagents') as
        | {
          listChildren(
            sessionId: unknown,
            signal?: AbortSignal,
          ): Promise<
            Array<{
              kind: string
              mode: string
              label?: string
              activity: string
              id: string | { value?: string }
            }>
          >
        }
        | undefined
      if (!subagents) return ['子代理服务未挂载（leaf 未启用 subagent）']
      try {
        const children = await subagents.listChildren(agent.session.id)
        if (children.length === 0) return ['当前会话暂无子代理']
        return children.map((child) => {
          const id =
            typeof child.id === 'string' ? child.id : (child.id.value ?? '')
          const label = child.label ? `「${child.label}」` : ''
          const mode = child.mode === 'continuable' ? '可续' : '一次性'
          return `${mode} ${label}${child.activity === 'running' ? ' 运行中' : ' 已归档'} · ${id.slice(0, 8)}`
        })
      } catch (error) {
        return [`查询失败 · ${error instanceof Error ? error.message : String(error)}`]
      }
    },
  }

  /**
   * Assemble the context a fresh conversation for the live agent will load,
   * for the startup panel: the system prompt (sections + dynamic context +
   * tools), the workspace instruction files baseline discovery would
   * inject, and the skill catalog. Runs at boot and on every agent swap;
   * every source degrades independently, and a total failure leaves the
   * panel hidden instead of showing a broken snapshot. A snapshot computed
   * for a previous agent is discarded (swaps rebind `agent` mid-flight).
   */
  const refreshLoadedContext = async (): Promise<void> => {
    const target = agent
    const sections: LoadedContextEntry[] = []
    const contexts: LoadedContextEntry[] = []
    const files: LoadedContextFile[] = []
    const skills: LoadedContextSkill[] = []
    const tools: LoadedContextTool[] = []
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt !== undefined) {
        const assembly = await systemPrompt.assemble(assembleContextFor(target))
        if (target !== agent) return
        // Render each section through the shared strict interpolator with
        // this assembly's variables (renderPrompt joins; a single-section
        // assembly renders exactly one section), keeping non-empty results.
        for (const section of assembly.sections) {
          const text = renderPrompt({
            sections: [section],
            contexts: [],
            tools: [],
            variables: assembly.variables,
          })
          if (text.length > 0) sections.push({ name: section.name, text })
        }
        contexts.push(...renderContextSections(assembly))
        for (const tool of assembly.tools) {
          tools.push({ name: tool.name, description: tool.description ?? '' })
        }
      }
      const discovered = await discoverBaselineInstructionFiles({ cwd: options.cwd })
      if (target !== agent) return
      files.push(...discovered.map(file => ({ displayPath: file.displayPath })))
      // The skills registry is host-plane but scope-layered: preset rows
      // (skill-filesystem) register into the preset's layer, so the catalog
      // must be read through the agent's scope chain (serviceForAgent falls
      // back to the host context when no roster is mounted).
      const skillsService = serviceForAgent<{
        list(options?: unknown): Promise<readonly { name: string; description: string }[]>
      }>(ctx, target, 'skills')
      if (skillsService !== undefined) {
        const catalog = await skillsService.list({})
        if (target !== agent) return
        skills.push(...catalog.map(skill => ({
          name: skill.name,
          description: skill.description,
        })))
      }
    } catch (error) {
      ctx.logger.warn('loaded-context snapshot failed: %o', error)
      return
    }
    state.loadedContext = { sections, contexts, files, skills, tools }
    state.emit()
  }

  /**
   * Rebuild the merged slash-command list from the registry. Registry
   * registrations are global or agent-scoped, so this runs on
   * `commands/change` and again whenever the live agent is swapped
   * (rewind/resume).
   */
  const refreshCommandList = (): void => {
    const merged: LocalCommand[] = [...LOCAL_COMMANDS]
    if (commandService) {
      for (const descriptor of commandService.list(agent)) {
        if (merged.some(command => command.name === descriptor.name)) continue
        merged.push({
          name: descriptor.name,
          description: descriptor.description,
          tag: descriptor.input?.hint,
          external: true,
        })
      }
    }
    state.commandList = merged
    state.emit()
  }
  ctx.on('commands/change', refreshCommandList)
  refreshCommandList()
  void refreshLoadedContext()

  let nextRowId = 0
  /** The leaf's bash executor (dsh-bash-local in the example leaf) — the DSH
 *  execution seam for local `!` commands and the git status breadcrumb. The
 *  service registers under `ctx.shell` (ShellExecutor; dsh-bash-local and
 *  dsh-pwsh-local are the providers). */
  const bash = ctx.get('shell') as
    | {
      resolve(request: {
        command: string
        workdir?: string
        timeoutMs?: number
      }): { command: string; timeoutMs: number }
      run(spec: { command: string; timeoutMs: number }): Promise<{
        exitCode: number | null
        stdout: { text: string }
        stderr: { text: string }
        timedOut: boolean
      }>
    }
    | undefined

  /** Claude Code's `!` mode: run a command on the user's machine and render its
 *  output in the transcript as local rows (never sent to the model). */
  const runLocalCommand = async (
    command: string,
    includeInContext: boolean,
  ): Promise<void> => {
    state.rows.push({ id: nextRowId++, kind: 'local', text: command })
    state.emit()
    let output = '(no output)'
    if (bash) {
      try {
        const spec = bash.resolve({
          command,
          workdir: state.cwd,
          timeoutMs: 30000,
        })
        const result = await bash.run(spec)
        output =
          result.stdout.text.trim() ||
          result.stderr.text.trim() ||
          (result.timedOut ? '(timed out)' : '(no output)')
      } catch (error) {
        output = error instanceof Error ? error.message : String(error)
      }
    }
    state.rows.push({
      id: nextRowId++,
      kind: 'local-output',
      text: preview(output, LOCAL_OUTPUT_LIMIT),
    })
    state.emit()
    if (includeInContext) {
      // CC's <bash-stdout> envelope: the model treats the output as the
      // result of a local command the user just ran.
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `<bash-stdout>
${output}
</bash-stdout>`,
        }],
        source: { kind: 'user' },
      }))
    }
  }
  /** The in-progress assistant text row; `undefined` when no step is streaming. */
  let streaming: ChatRow | undefined
  /** The in-progress reasoning row; `undefined` when no reasoning is streaming. */
  let reasoning: ChatRow | undefined
  /** Reasoning rows sealed by an assistant/message this turn. They stay
   *  `streaming: true` — expanded in the transcript — until turn/end folds
   *  them (WebUI AssistantMarkdown keepOpen parity: thinking holds open
   *  through the whole in-flight turn, tool-call steps included). */
  const sealedReasoning: ChatRow[] = []
  /** Wall-clock start of the current reasoning row (durationMs on settle). */
  let reasoningStart = 0
  /** First-output wall-clock + estimated output tokens of the current turn
   *  (live tps readout; refined by exact usage at assistant/message). */
  let turnOutputStart = 0
  let turnOutputTokens = 0
  /** Tool cards by callId, so tool/result can settle the running card. */
  const toolCards = new Map<string, ChatRow>()

  // ContentBlockMap is merge-extensible: plugin-added block types are
  // silently skipped (v1 renders text blocks only) — never crashes.
  const textOf = (content: readonly ContentBlock[] | undefined): string =>
    (content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('').trim()

  const ensureStreaming = (seq?: number): ChatRow => {
    if (streaming === undefined) {
      streaming = { id: nextRowId, kind: 'assistant', text: '', streaming: true, ...seq !== undefined ? { seq } : {} }
      nextRowId += 1
      state.rows.push(streaming)
    }
    return streaming
  }

  const ensureReasoning = (seq?: number): ChatRow => {
    if (reasoning === undefined) {
      reasoningStart = Date.now()
      reasoning = { id: nextRowId, kind: 'reasoning', text: '', streaming: true, ...seq !== undefined ? { seq } : {} }
      nextRowId += 1
      state.rows.push(reasoning)
      logForDebugging('thinking: reasoning row open (expanded)')
    }
    return reasoning
  }

  const settleStreaming = (): void => {
    if (streaming !== undefined) streaming.streaming = false
    streaming = undefined
    const folded = sealedReasoning.length + (reasoning !== undefined ? 1 : 0)
    for (const row of sealedReasoning) row.streaming = false
    sealedReasoning.length = 0
    if (reasoning !== undefined) {
      reasoning.streaming = false
      reasoning.durationMs = Math.max(0, Date.now() - reasoningStart)
    }
    reasoning = undefined
    if (folded > 0) logForDebugging(`thinking: folded ${folded} reasoning row(s) at turn settle`)
  }

  /** Recompute the spinner phase from live row/tool state. */
  const updateSpinnerMode = (): void => {
    if (state.activeToolCount > 0) {
      state.spinnerMode = 'tool-use'
    } else if (reasoning !== undefined) {
      // Only LIVE reasoning counts — sealed rows stay streaming=true for
      // transcript expansion until turn/end but the model is past thinking.
      state.spinnerMode = 'thinking'
    } else if (streaming !== undefined) {
      state.spinnerMode = 'responding'
    } else {
      state.spinnerMode = 'requesting'
    }
  }

  /**
   * Fold one goal-sourced message into the channel's goal projection.
   * Round-zero goal messages carry the full durable snapshot (or a clear
   * tombstone) in their source; positive-round messages are admitted
   * continuation prompts that only advance the rounds counter.
   */
  const applyGoalEvent = (event: SessionEvent<'user/message'>): void => {
    const source = event.data.source as unknown as {
      round: number
      change?: {
        kind: 'goal/change'
        version: 1
        operation:
          | 'create'
          | 'edit'
          | 'pause'
          | 'resume'
          | 'complete'
          | 'block'
          | 'clear'
        goal?: ChannelGoal
        roundsStarted?: number
      }
    }
    if (source.round > 0) {
      // Admitted continuation round — the snapshot itself is unchanged.
      if (state.goal !== undefined) {
        state.goal = {
          ...state.goal,
          roundsStarted: Math.max(state.goal.roundsStarted, source.round),
        }
      }
      return
    }
    const change = source.change
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may not match the static type
    if (change === undefined || change.kind !== 'goal/change') return
    if (change.operation === 'clear') {
      state.goal = undefined
    } else if (change.goal !== undefined) {
      state.goal = {
        ...change.goal,
        roundsStarted: change.roundsStarted ?? state.goal?.roundsStarted ?? 0,
      }
    }
  }

  const renderEvent = (event: SessionEvent): void => {
    switch (event.type) {
      case 'user/message': {
        // Compaction checkpoint: `source = { kind: 'plugin', plugin:
        // 'compact' }` (dsh-compact's COMPACT_CHECKPOINT_SOURCE). CC shows
        // the framed summary after /compact; render it as a Divider title +
        // a summary row that defaults folded (`compact` kind) instead of
        // skipping it like other injected context.
        if (
          event.data.source.kind === 'plugin' &&
          event.data.source.plugin === 'compact'
        ) {
          const summary = textOf(event.data.content)
          state.rows.push({ id: nextRowId, kind: 'notice', text: 'Conversation compacted' })
          nextRowId += 1
          if (summary) {
            state.rows.push({ id: nextRowId, kind: 'compact', text: summary })
            nextRowId += 1
          }
          // The surface replace drops the whole pre-compact history: reset
          // the context accounting NOW so the status bar (ctx bar, tokens,
          // context-low warning) drops immediately instead of waiting for
          // the next request's usage event.
          const removed =
            state.contextSegments.prompt +
            state.contextSegments.assistant +
            state.contextSegments.thinking +
            state.contextSegments.tools
          const summaryTokens = estimateTokens(summary)
          state.tokens.input = Math.max(0, state.tokens.input - removed) + summaryTokens
          state.contextSegments = {
            system: state.contextSegments.system,
            prompt: summaryTokens,
            assistant: 0,
            thinking: 0,
            tools: 0,
          }
          state.lastUsage = {
            input: state.contextSegments.system + summaryTokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          }
          contextWarned = false
          break
        }
        // Same-session goal domain: round-zero goal-sourced messages carry
        // the durable goal snapshot (or clear tombstone) in their source.
        // They are not transcript bubbles — they drive the goal panel's
        // live projection (replayed on resume/rewind like every other event).
        if ((event.data.source as { kind: string }).kind === 'goal') {
          applyGoalEvent(event)
          break
        }
        // Injected context (plugin/skill source) is not a human bubble; v1
        // renders direct human prompts only.
        if (event.data.source.kind !== 'user') break
        const text = textOf(event.data.content)
        if (text) {
          state.rows.push({ id: nextRowId, kind: 'user', text, seq: event.seq })
          state.lastUserText = text
          state.contextSegments.prompt += estimateTokens(text)
          nextRowId += 1
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          if (chunk.text) {
            ensureStreaming(event.seq).text += chunk.text
            state.responseChars += chunk.text.length
            // Live output-speed estimate (chars/4 ≈ tokens) from the first
            // output token of the turn.
            if (turnOutputStart === 0) turnOutputStart = Date.now()
            turnOutputTokens += chunk.text.length / 4
            const elapsedSec = (Date.now() - turnOutputStart) / 1000
            if (elapsedSec > 0.5) state.tps = turnOutputTokens / elapsedSec
          }
        } else if (chunk.type === 'reasoning-delta') {
          if (chunk.text) ensureReasoning(event.seq).text += chunk.text
        }
        updateSpinnerMode()
        break
      }
      case 'assistant/message': {
        const row = ensureStreaming(event.seq)
        row.time = event.time
        const text = textOf(event.data.message.content)
        if (text) row.text = text
        row.streaming = false
        streaming = undefined
        if (reasoning !== undefined) {
          // Seal, don't fold: the per-step duration settles here, but the
          // row keeps streaming=true (expanded) until turn/end — WebUI
          // keepOpen parity. The next step's reasoning opens a fresh row.
          reasoning.durationMs = Math.max(0, Date.now() - reasoningStart)
          sealedReasoning.push(reasoning)
          logForDebugging(`thinking: step sealed (${reasoning.durationMs}ms), expanded until turn/end`)
        }
        reasoning = undefined
        updateSpinnerMode()
        const usage = event.data.usage
        if (usage !== undefined) {
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
          state.tokens.input += usage.inputTokens ?? 0
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
          state.tokens.output += usage.outputTokens ?? 0
          // The most recent request's usage describes the CURRENT context:
          // input (uncached) + cache hits all occupy the window. Cache hits
          // also drive the status-line `cache N` readout.
          state.lastUsage = {
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
            input: usage.inputTokens ?? 0,
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
            output: usage.outputTokens ?? 0,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
          }
          // Refine the live estimate with the exact output total, and record
          // the message-level sample for the sparkline / μ / p95 readout.
          if (turnOutputStart !== 0) {
            const elapsedSec = (Date.now() - turnOutputStart) / 1000
            if (elapsedSec > 0.5) {
              // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
              const exactTps = (usage.outputTokens ?? 0) / elapsedSec
              state.tps = exactTps
              state.tpsSamples.push({ tps: exactTps, at: Date.now() })
              if (state.tpsSamples.length > 500) state.tpsSamples.shift()
            }
          }
        }
        // Context-bar segmentation (pi-nano-context style): assistant text
        // and tool calls in the assistant segment, thinking separately.
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text) {
            state.contextSegments.assistant += estimateTokens(block.text)
          } else if (block.type === 'reasoning' && block.text) {
            state.contextSegments.thinking += estimateTokens(block.text)
          }
        }
        break
      }
      case 'tool/call': {
        // The ask-user-question tool renders as the interactive questionnaire
        // panel (DSH user-interaction seam), not as a tool card: the model is
        // parked waiting for the human, so no running card, no active-tool
        // spinner, no args noise in the transcript. The Q&A summary is pushed
        // by the TUI once the batch is answered; tool/result for a call with
        // no card is a no-op below.
        if (event.data.name === 'ask_user_question') break
        const card: ChatRow = {
          id: nextRowId,
          kind: 'tool',
          text: '',
          seq: event.seq,
          tool: {
            callId: event.data.callId,
            name: event.data.name,
            argsText: preview(event.data.arguments, ARGS_PREVIEW_LIMIT),
            argsFull: event.data.arguments,
            status: 'running',
            startedAt: Date.now(),
          },
        }
        nextRowId += 1
        toolCards.set(event.data.callId, card)
        state.rows.push(card)
        state.activeToolCount += 1
        state.contextSegments.assistant += estimateTokens(
          `${event.data.name}${event.data.arguments}`,
        )
        updateSpinnerMode()
        break
      }
      case 'tool/result': {
        const card = toolCards.get(event.data.message.source.callId)
        if (card !== undefined && card.tool !== undefined) {
          card.tool.durationMs = Math.max(0, Date.now() - card.tool.startedAt)
          const failure = event.data.error
          if (failure !== undefined) {
            card.tool.status = 'error'
            const errorText = `${failure.name}: ${failure.code}`
            card.tool.errorText = errorText
            state.contextSegments.tools += estimateTokens(errorText)
          } else {
            card.tool.status = 'ok'
            const block = event.data.message.content[0]
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
            const result = block !== undefined && block.type === 'tool-result' ? textOf(block.content) : ''
            card.tool.resultFull = result || undefined
            card.tool.resultText = result ? preview(result, RESULT_PREVIEW_LIMIT) : undefined
            state.contextSegments.tools += estimateTokens(result)
          }
          state.activeToolCount = Math.max(0, state.activeToolCount - 1)
          // The card is settled: no later event looks it up by callId, so
          // drop the index entry. The card itself stays in state.rows
          // (bounded by MAX_ROWS + foldRows, which also drops the full
          // args/result payloads of folded cards).
          toolCards.delete(event.data.message.source.callId)
          updateSpinnerMode()
        }
        break
      }
      case 'turn/start': {
        state.working = true
        state.turnStart = Date.now()
        state.responseChars = 0
        state.spinnerMode = 'requesting'
        // New turn: fresh output-speed window; the previous turn's tps stays
        // visible until this turn produces output (it describes the last
        // completed response).
        turnOutputStart = 0
        turnOutputTokens = 0
        break
      }
      case 'turn/end': {
        settleStreaming()
        state.working = false
        state.activeToolCount = 0
        const reason = event.data.reason
        if (reason.kind === 'completed') {
          checkContextWarning()
          break
        }
        if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
          // `Agent.cancel()` closes the turn as `aborted`; `interrupted`
          // only appears for crash-orphaned turns. Claude Code renders both
          // user-interruption paths as a distinct dim row.
          state.rows.push({
            id: nextRowId,
            kind: 'interrupt',
            text: 'Interrupted · What should Claude do instead?',
          })
          nextRowId += 1
          break
        }
        const detail = reason.kind === 'error' ? reason.error.message : ''
        state.rows.push({ id: nextRowId, kind: 'notice', text: `turn ${reason.kind}${detail ? ` · ${detail}` : ''}` })
        nextRowId += 1
        state.notify(
          `Turn ${reason.kind}${detail ? ` · ${detail}` : ''}`,
          { color: 'error', timeoutMs: 8000 },
        )
        break
      }
      case 'request/context':
        // Adapter-advertised context capacity; drives the context-low
        // warning (CC's TokenWarning) when the route reports one.
        if (event.data.contextWindow !== undefined) {
          state.contextWindow = event.data.contextWindow
        }
        break
      case 'request/header': {
        // Reasoning effort readout (status line): the header carries the
        // conversation's call config (provider/model/effort/sampling). The
        // system prompt text seeds the context bar's system segment.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may lack header config
        const effort = event.data.header.config?.reasoningEffort
        if (typeof effort === 'string') {
          state.reasoningEffort = effort
        }
        if (typeof event.data.header.system === 'string') {
          state.contextSegments.system = estimateTokens(event.data.header.system)
        }
        break
      }
      case 'session/title':
        state.sessionTitle = event.data.title
        break
      case 'todo/write':
        // Whole-list snapshot — latest write wins; log-only UI state.
        state.todos = event.data.todos
        break
      default:
        // Logged preset switch (blank sessions only, issue #8): a transcript
        // marker so a replayed log shows which composition produced the
        // turns after it. Not in dsh-session's typed union — matched here by
        // name, the way `activity/status` is consumed in bindAgent.
        if ((event as { type: string }).type === 'agent-preset/selected') {
          const data = event.data as unknown as { agentPreset?: string }
          state.rows.push({
            id: nextRowId,
            kind: 'notice',
            text: `Agent preset 已切换：${data.agentPreset ?? 'unknown'}`,
          })
          nextRowId += 1
        }
        break
    }
  }

  // Replay the durable transcript first, then follow live events.
  for (const event of coalesceReplayEvents(agent.session.events)) renderEvent(event)
  settleStreaming()
  // Attached to an idle agent: any replayed turn/start belongs to a previous
  // session run, so the spinner must not come up on boot.
  state.working = false
  state.status = agent.status
  state.emit()

  // Live subscription list, rebound to a fresh agent by rewindTo.
  let agentSubscriptions: Array<() => void> = []
  const bindAgent = (): void => {
    for (const dispose of agentSubscriptions) dispose()
    agentSubscriptions = [
      ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== agent) return
        state.status = status
        state.emit()
      }),
      ctx.on('agent/disposed', ({ agent: subject }) => {
        if (subject !== agent) return
        state.status = 'disposed'
        state.emit()
      }),
      // Pending delivery is driven by the agent inbox: a claimed message
      // has landed in a turn (steer → step boundary, followup → next turn);
      // a discarded one was dropped by a cancel or withdrawn via Alt+Up.
      // Retire it from the preview. Official dsh-agent rc.6 emits these as
      // single-payload notifications `{ agent, message }`; `inserted` is not
      // handled here because trackPending already registered the preview
      // synchronously at submit time.
      (() => {
        const retirePending = (payload: { agent: unknown; message: { id?: unknown } }): void => {
          if (payload.agent !== agent) return
          const messageId = payload.message?.id
          if (typeof messageId !== 'string') return
          const before = state.pending.length
          state.pending = state.pending.filter(item => item.id !== messageId)
          if (state.pending.length !== before) state.emit()
        }
        const disposers: Array<() => boolean> = []
        for (const event of ['agent/inbox/claimed', 'agent/inbox/discarded'] as const) {
          disposers.push(ctx.on(event, retirePending))
        }
        return () => {
          for (const dispose of disposers) dispose()
        }
      })(),
      ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        // Live working-activity snapshot (log-only event, appended by
        // dsh-working-activity for UI consumers). Consumed here — NOT in
        // renderEvent — so replayed history never resurrects a stale line
        // (the renderEvent switch's default arm ignores it on replay).
        if (
          options.activity !== false &&
          (event as { type: string }).type === 'activity/status'
        ) {
          const data = event.data as unknown as {
            phase: string
            line: string
            toolCount?: number
            turnElapsedMs?: number
            label?: string
            detail?: string
            phrase?: string
          }
          state.workingActivity = {
            phase: data.phase as ActivityStatus['phase'],
            line: data.line,
            toolCount: data.toolCount ?? 0,
            turnElapsedMs: data.turnElapsedMs ?? 0,
            ...(data.label === undefined ? {} : { label: data.label }),
            ...(data.detail === undefined ? {} : { detail: data.detail }),
            ...(data.phrase === undefined ? {} : { phrase: data.phrase }),
          }
          state.emit()
          return
        }
        renderEvent(event)
        // Streaming deltas (one event per token) take the frame-aligned
        // path; every other event keeps synchronous notification.
        if (event.type === 'assistant/chunk') state.emitStream()
        else state.emit()
      }),
    ]
  }
  bindAgent()
  // Statusline breadcrumb: current git branch of the session cwd (best-effort).
  if (bash) {
    void bash
      .run(
        bash.resolve({
          command: 'git branch --show-current',
          workdir: options.cwd,
          timeoutMs: 3000,
        }),
      )
      .then((result) => {
        const branch = result.stdout.text.trim()
        if (branch !== '') {
          state.gitBranch = branch
          state.emit()
        }
      })
      .catch(() => {
        // Git branch detection is best-effort; on Windows the sandbox
        // backend may be unavailable (no confinement yet) or the cwd may
        // not be a git repo. Either way the statusline simply stays blank.
      })
  }

  return state
}

/** Path basename for the resume-list title (`C:/a/b` → `b`). */
function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** Context-bar token estimate (pi-nano-context: ~4 chars per token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Recursive `@` file listing through the leaf's fs service (dsh-fs-local):
 * walks up to MAX_DEPTH levels below `root`, skipping VCS/dependency dirs,
 * returning relative paths (directories with a trailing `/`, matching the
 * FileSuggestions tag logic) capped at MAX_FILES entries. Best-effort —
 * unreadable subtrees are skipped, not fatal.
 */
async function listFilesDeep(
  fs: {
    resolve(path: string): Promise<{ displayPath: string }>
    listDir(target: { displayPath: string }): Promise<
      Array<{
        name: string
        type: 'file' | 'directory' | 'other'
        target: { displayPath: string }
      }>
    >
  } | undefined,
  root: string,
): Promise<string[]> {
  if (!fs) return []
  const out: string[] = []
  const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store', 'dist', 'build'])
  const MAX_DEPTH = 3
  const MAX_FILES = 100

  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: Array<{
      name: string
      type: 'file' | 'directory' | 'other'
      target: { displayPath: string }
    }> = []
    try {
      const target = await fs.resolve(dir)
      entries = await fs.listDir(target)
    } catch {
      return // unreadable subtree — skip
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      if (SKIP.has(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        out.push(`${rel}/`)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: symlink targets optional
        await walk(entry.target?.displayPath ?? join(dir, entry.name), rel, depth + 1)
      } else if (entry.type === 'file') {
        out.push(rel)
      }
    }
  }

  await walk(root, '', 1)
  return out
}
