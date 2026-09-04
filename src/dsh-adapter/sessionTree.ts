/**
 * Session family tree — the model behind the /tree screen
 * (pi's Session Tree ported to DSH's cross-session fork model).
 *
 * DSH sessions are linear event logs; a rewind forks a NEW session whose
 * header records `parentSession` + `seedLength` (the inherited prefix). The
 * tree stitches the whole family back together: each session contributes its
 * OWN entries (events at seq >= seedLength when the parent is known), a fork
 * attaches at the parent's last entry with seq <= seedLength-1, and the
 * parent's own tail past that point is the abandoned "main" branch.
 *
 * Pure module: no Ink, no channel state — channel.ts gathers the logs, this
 * file shapes them. Rendering lives in screens/SessionTree.tsx.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessionTree
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Displayable entry kinds (a subset of ChatRow kinds, plus fork structure). */
export type TreeEntryKind = 'user' | 'assistant' | 'tool' | 'compact' | 'interrupt' | 'notice'

/** Filter modes cycled in the tree screen (pi parity, minus labels). */
export type TreeFilter = 'default' | 'no-tools' | 'user-only' | 'all'
export const TREE_FILTERS: readonly TreeFilter[] = ['default', 'no-tools', 'user-only', 'all']

/** One displayable log entry; identity = (sessionId, seq). */
export interface TreeEntry {
  readonly sessionId: string
  /** Source event seq inside that session's log (the fork anchor). */
  readonly seq: number
  readonly kind: TreeEntryKind
  /** One-line preview (whitespace folded, capped). */
  readonly text: string
  /** Uncapped searchable text (kind + tool name + content). */
  readonly searchText: string
  /** Event wall-clock time. */
  readonly time: number
  /** Tool outcome for kind 'tool' (settled by tool/result during extraction). */
  readonly toolStatus?: 'running' | 'ok' | 'error'
  /** Extra marker (e.g. `aborted` for chunk-only assistant text). */
  readonly label?: string
  /** True on entries of the log's OWN first turn (a complete log's turn 0).
   *  Only USER entries among them are unrewindable (dropping turn 0 needs
   *  boundary -1, "cannot rewind to the very first message"), so the screen
   *  refuses those up front instead of failing at confirm time; non-user
   *  turn-0 entries rewind fine (a mid-turn cut at their step's step/end, or
   *  turn 0's closing turn/end). Never set on a truncated tail: its first
   *  VISIBLE turn rewinds fine against the full log, which is where
   *  rewindToNode computes boundaries. */
  readonly firstTurn?: boolean
}

/** One family member's log, as channel.buildSessionTree gathered it. */
export interface FamilySession {
  readonly id: string
  readonly createdAt: number
  readonly parentSession?: string
  readonly seedLength?: number
  /** This log's events (inherited seed prefix + own events), in log order.
   *  A coverage-skipped read starts at the first seq no ancestor displays —
   *  possibly mid-log — with only rare session/title events below the
   *  cutoff. Never trust events[0].seq === 0. */
  readonly events: readonly SessionEvent[]
  /** True for the live session (events from memory, not persistence). */
  readonly live: boolean
  /** True when the log could not be read — structure-only node, no entries. */
  readonly unreadable?: boolean
  /** True when the log was never read because the tree's event/scan budget
   *  was already spent — structure-only placeholder, distinct from
   *  unreadable (the log is fine; the browse budget is not). */
  readonly unloaded?: boolean
  /** True when `events` reaches the log's tip. Live memory logs always
   *  qualify (the tail window trims the HEAD only); bounded reads of dead
   *  branches slice the tail off when the event budget runs out. The
   *  branch-adopt target (tipBoundary) and the drop-turn confirm warning are
   *  only safe to derive when this holds — otherwise the unseen tail could
   *  hold content the UX claims does not exist. */
  readonly tailComplete?: boolean
}

export interface TreeNode {
  /** `${sessionId}:${seq}`, or `${sessionId}:head` for a placeholder. */
  readonly id: string
  /** Null only on a session's placeholder node (empty fork / unreadable log). */
  readonly entry: TreeEntry | null
  /** Session whose chain this node belongs to. */
  readonly sessionId: string
  /** True on a session chain's first node (renders the fork/session marker). */
  branchHead: boolean
  children: TreeNode[]
}

export interface SessionTreeData {
  readonly roots: readonly TreeNode[]
  /** Node ids on the path from the family root to the live tip (`•` marker). */
  readonly activePath: ReadonlySet<string>
  /** Live session's last node (initial cursor target). */
  readonly activeLeafId: string | null
  /** Per-session display facts (branch-head labels in the screen). */
  readonly sessions: ReadonlyMap<string, SessionTreeMeta>
  /** Per-session rewind UX facts (drop-turn warning, branch-adopt target). */
  readonly rewindFacts: ReadonlyMap<string, SessionRewindFacts>
  /** True when the family exceeded a cap and distant branches were dropped. */
  readonly truncated: boolean
  readonly sessionCount: number
}

/** One own turn of a session, as far as the loaded events show it. */
export interface TurnRange {
  /** turn/start seq. */
  readonly start: number
  /** turn/end seq, or the last loaded event's seq while the turn is open. */
  readonly end: number
  /** Displayable own entries inside (start, end]. */
  readonly entries: number
  /** The turn/end was seen (an open turn's end is only the loaded tail). */
  readonly closed: boolean
}

/** Per-session rewind UX facts, derived from the loaded events at build time. */
export interface SessionRewindFacts {
  /** Own turns in seq order. A turn whose start was trimmed away (coverage /
   *  budget head cut) has no range — its entries find no match and the
   *  confirm UX stays silent rather than guessing. */
  readonly turns: readonly TurnRange[]
  /** Own entries displayed for this session. */
  readonly ownEntries: number
  /** The loaded events reach the log tip (see FamilySession.tailComplete). */
  readonly tailComplete: boolean
  /** Adopt-this-branch fork target: the log's last turn/end seq. Only set
   *  when tailComplete holds and a closed turn exists — a tail-cut read's
   *  last turn/end is NOT the branch tip, and forking there would silently
   *  drop the unseen tail the user means to keep. */
  readonly tipBoundary?: number
}

/** What dropping a user-message pick's turn removes (the confirm warning). */
export interface DropTurnInfo {
  /** Own entries of the session inside the dropped turn. */
  readonly droppedEntries: number
  /** Every own entry of the session sits inside the dropped turn, and the
   *  loaded log reaches the tip — so the fork will show NONE of this
   *  branch's own content. (The user's "click the branch message → lose the
   *  whole branch" trap: a branch whose own content is one turn.) */
  readonly coversBranch: boolean
}

/**
 * Confirm-time preview for a USER-message pick: how much of its branch the
 * drop removes. Undefined for non-user entries (they keep through their
 * step) and whenever the turn cannot be located in the loaded events.
 */
export function droppedTurnInfo(data: SessionTreeData, entry: TreeEntry): DropTurnInfo | undefined {
  if (entry.kind !== 'user') return undefined
  const facts = data.rewindFacts.get(entry.sessionId)
  if (facts === undefined) return undefined
  const turn = facts.turns.find(range => entry.seq > range.start && entry.seq <= range.end)
  if (turn === undefined) return undefined
  return {
    droppedEntries: turn.entries,
    coversBranch: facts.tailComplete && facts.ownEntries > 0 && turn.entries === facts.ownEntries,
  }
}

export interface SessionTreeMeta {
  readonly title?: string
  readonly createdAt: number
  readonly live: boolean
  readonly unreadable: boolean
  /** Log unread because the browse budget was spent (placeholder node). */
  readonly unloaded: boolean
}

/** One flattened, render-ready row with its tree-drawing geometry. */
export interface FlatNode {
  readonly node: TreeNode
  /** Tree-parent node id (null for roots) — cursor preservation walks this.
   *  Set by flattenTree and NEVER rewritten by filterTree (rows are shared
   *  across filter passes; a rewritten hop would skip ancestors). */
  readonly parentId: string | null
  /** Indentation level (each level = 3 chars), pi's rules. */
  indent: number
  /** Whether to draw a connector (├─/└─) — parent has multiple children. */
  showConnector: boolean
  /** Under a connector: true = last sibling (└─). */
  isLast: boolean
  /** Ancestor branch points: position (indent level) + whether │ continues. */
  gutters: readonly GutterInfo[]
  /** Root under a virtual branching root (multiple roots). */
  isVirtualRootChild: boolean
  /** True when this pass produced multiple roots (screen shifts display). */
  multipleRoots: boolean
}

export interface GutterInfo {
  position: number
  show: boolean
}

/** Preview cap for one entry line (the screen truncates further to width). */
const ENTRY_PREVIEW_LIMIT = 120
/** Tool arguments preview cap inside a tool entry line. */
const TOOL_ARGS_PREVIEW_LIMIT = 60

/** Whitespace-folded, capped one-line preview. */
function preview(text: string, limit = ENTRY_PREVIEW_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** Structural view of a content block (dsh-llm ContentBlock is plugin-extensible). */
type Block = { readonly type: string; readonly text?: string }

/** All text blocks joined (assistant messages, compact summaries). */
function textOf(content: readonly Block[] | undefined): string {
  return (content ?? []).map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('').trim()
}

/** FIRST text block only — `@`-mention attachments ride as later blocks
 *  (channel.ts firstTextOf, issue #15). */
function firstTextOf(content: readonly Block[] | undefined): string {
  return (content ?? []).find(block => block.type === 'text')?.text?.trim() ?? ''
}

/**
 * Coalesce runs of same-type assistant/chunk deltas into single synthetic
 * events for REPLAY only. A streamed turn logs one event per token (~100k
 * events in long sessions); replaying them one at a time costs per-chunk
 * string growth on every row (quadratic in the turn's length). Merging is
 * outcome-identical: ensureStreaming/ensureReasoning only read chunk.type
 * and the concatenated text, and the row's seq comes from the run's FIRST
 * chunk (the fork boundary rewindToNode derives from it). Parts join once —
 * no quadratic concat. Live events never go through this.
 *
 * (Moved from channel.ts: the transcript replay and the tree extraction
 * share it.)
 */
export function coalesceReplayEvents(events: readonly SessionEvent[]): SessionEvent[] {
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

/**
 * Fork boundary for rewinding to the entry at `seq`: the seq just before its
 * enclosing turn/start (DSH logs `turn/start → user/message → … → turn/end`,
 * so a message's own seq sits inside an open turn and fork would reject it).
 * This is the DROP-THE-TURN boundary — used for user messages (the turn is
 * dropped, its prompt returns to the input) and as the fallback for entries
 * of a still-open turn. Falls back to `seq` itself when no enclosing
 * turn/start exists (bookkeeping between turns).
 */
export function turnBoundary(events: readonly SessionEvent[], seq: number): number {
  const start = events[seq]?.type === 'turn/end' ? seq - 1 : seq
  for (let i = start; i >= 0; i--) {
    const event = events[i]
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: seq may exceed events
    if (event === undefined) break
    if (event.type === 'turn/start') return event.seq - 1
    if (event.type === 'turn/end') break
  }
  return seq
}

/** Where rewinding to a tree entry lands — see rewindTarget. */
export interface RewindTarget {
  /** Inclusive seed boundary (a seq into the FULL contiguous log). */
  readonly boundary: number
  /**
   * Set when the boundary cuts a turn in the middle: the fork must append a
   * synthetic turn/end for this turn number (the exact shape a real user
   * cancellation writes). Undefined when the seed already ends turn-closed.
   */
  readonly closeTurn?: number
}

/**
 * Rewind target for a tree entry — pi's navigateTree semantics mapped onto
 * DSH's turn-closed fork constraint (the seed must not end inside an open
 * turn). Callers must pass the FULL session log (seq === array index).
 *
 *  - user message → DROP its turn: the seq just before the enclosing
 *    turn/start (turnBoundary); the turn's prompt returns to the input for
 *    re-editing. -1 when that turn is the log's own first turn.
 *  - any other entry inside a CLOSED turn (assistant/tool/notice/interrupt)
 *    → KEEP through the entry's enclosing STEP: the boundary is that step's
 *    step/end, with closeTurn set. DSH agentic turns are marathons (one
 *    prompt → N steps → thousands of events), so turn-granular keeping is
 *    useless mid-turn — picking a bash call of step 2 in a 6-step turn must
 *    not retain steps 3-6. The step is the finest SAFE cut: a step closes
 *    with every tool call answered, so the replayed context never dangles a
 *    tool_call the API would reject. When no step/end follows the entry
 *    inside its turn (no-step turns, or the entry sits past the last step),
 *    the boundary is the turn/end as before (no closeTurn).
 *  - entry between turns (a compact checkpoint) → its own seq.
 *  - entry inside the still-OPEN last turn → a closed step ahead of it is
 *    still a valid mid-turn cut (closeTurn set; the open tail drops); with no
 *    step/end ahead the turn cannot be kept at all, so it falls back to
 *    dropping the turn (turnBoundary) and restoring its prompt.
 */
export function rewindTarget(events: readonly SessionEvent[], seq: number): RewindTarget {
  const selected = events[seq]
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: seq may exceed events
  if (selected === undefined || selected.type === 'user/message') {
    return { boundary: turnBoundary(events, seq) }
  }
  if (selected.type === 'turn/end') return { boundary: seq } // interrupt/notice entries keep through their turn's end
  // The enclosing turn's number — needed to close a mid-turn cut.
  let turn: number | undefined
  for (let i = seq; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'turn/start') {
      turn = event.data.turn
      break
    }
    if (event.type === 'turn/end') break // between turns: no enclosing turn
  }
  for (let i = seq + 1; i < events.length; i++) {
    const event = events[i]!
    if (event.type === 'step/end' && turn !== undefined) {
      return { boundary: event.seq, closeTurn: turn }
    }
    if (event.type === 'turn/end') return { boundary: event.seq }
    if (event.type === 'turn/start') break // between turns: keep through the entry
  }
  return { boundary: turnBoundary(events, seq) }
}

/**
 * Fork target for a tree entry — pi's `/fork` semantics: the picked entry is
 * KEPT (a fork branches the conversation; it does not re-edit the past).
 *
 *  - user message → keep THROUGH the message itself: the boundary is the
 *    entry's own seq and the turn's reply drops. The cut ends inside the
 *    still-open turn, so closeTurn carries the enclosing turn's number for
 *    the synthetic turn/end (the same shape a real interrupt writes). A
 *    between-turns plugin message (a compact checkpoint) is already
 *    turn-closed — no closer.
 *  - any other entry → identical to rewindTarget (keep through the
 *    entry's enclosing step / turn end).
 *
 * Unlike a rewind pick, a turn-0 user message forks fine (boundary = its own
 * seq, never -1), and nothing returns to the input for re-editing.
 */
export function forkTarget(events: readonly SessionEvent[], seq: number): RewindTarget {
  const selected = events[seq]
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: seq may exceed events
  if (selected === undefined || selected.type !== 'user/message') {
    return rewindTarget(events, seq)
  }
  // The enclosing turn's number — needed to close the mid-turn cut. A
  // turn/end encountered first means the entry sits between turns.
  let turn: number | undefined
  for (let i = seq; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'turn/start') {
      turn = event.data.turn
      break
    }
    if (event.type === 'turn/end') break // between turns: already closed
  }
  return turn === undefined ? { boundary: seq } : { boundary: seq, closeTurn: turn }
}

/**
 * Tail window of an over-budget LIVE session's events, aligned to whole
 * turns. Recent turns are the likely rewind targets, so the budget keeps
 * the tail — but a slice can open mid-turn, and entries of a partial turn
 * make broken rows: when that partial turn is the log's OWN first turn its
 * rewind boundary is -1 ("cannot rewind to the very first message"), yet
 * the slice hides the turn/start@0 that firstTurn marking keys on — the
 * row would confirm and then fail inside rewindToNode. So: align to the
 * first whole turn inside the window. When the window holds no turn/start
 * at all, the log's LAST turn alone overflows the budget — retry over the
 * log before that turn: its earlier complete turns are perfectly good
 * rewind targets and must not vanish behind one giant turn. Only when the
 * oversized turn IS the log's own first turn does the window drop to empty
 * — no complete turn in view means no safe rewind target to show. Entries
 * dropped here stay rewindable through the real session; the slice only
 * narrows what the tree displays.
 */
export function liveTailWindow(
  events: readonly SessionEvent[],
  remaining: number,
): readonly SessionEvent[] {
  if (events.length <= remaining) return events
  if (remaining <= 0) return []
  let scope = events
  for (;;) {
    const sliced = scope.slice(scope.length - remaining)
    const firstStart = sliced.findIndex(event => event.type === 'turn/start')
    if (firstStart === 0) return sliced
    if (firstStart > 0) return sliced.slice(firstStart)
    // No turn/start in the window: the oversized turn spans it whole. Cut
    // the log just before that turn and retry — the window over the shorter
    // scope either fits complete earlier turns or overflows again into an
    // even earlier oversized turn (the loop converges: each cut removes at
    // least one turn).
    let lastStart = -1
    for (let i = scope.length - 1; i >= 0; i--) {
      if (scope[i]!.type === 'turn/start') {
        lastStart = i
        break
      }
    }
    if (lastStart <= 0) return []
    scope = scope.slice(0, lastStart)
    if (scope.length <= remaining) return scope
  }
}

/** The turn's first human-typed text (the prompt rewind restores for editing). */
export function turnUserText(events: readonly SessionEvent[], seq: number): string {
  const boundary = rewindTarget(events, seq).boundary
  // A boundary at/after the entry means its turn is KEPT (assistant/tool
  // targets, between-turns checkpoints) — pi restores editor text only for
  // dropped user messages, and scanning on from here would cross the NEXT
  // turn/start and steal that turn's prompt.
  if (boundary >= seq) return ''
  for (let i = boundary + 1; i < events.length; i++) {
    const event = events[i]!
    if (event.type === 'turn/end') break
    if (event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    const text = firstTextOf(event.data.content as readonly Block[])
    if (text) return text
  }
  return ''
}

/**
 * One session's displayable entries, in seq order. Mirrors renderEvent's
 * choices (channel.ts): human user messages only, compaction checkpoints as
 * compact rows, assistant text (chunk-only text from aborted turns kept with
 * an `aborted` label), tool cards minus ask_user_question, interrupts and
 * failed turns. Bookkeeping events (turn/step markers, titles, requests,
 * `session/end-seed`, activity frames…) never become entries.
 */
export function extractEntries(sessionId: string, events: readonly SessionEvent[]): TreeEntry[] {
  const entries: TreeEntry[] = []
  // First-turn marking applies only when the log still starts at seq 0 — the
  // complete history, whose turn 0 can never rewind. A budget-truncated tail
  // opens mid-log; its first visible turn has a valid boundary in the full
  // log (rewindToNode computes it there), so it must stay selectable.
  const markFirstTurn = events.find(event => event.type === 'turn/start')?.seq === 0
  let turnsSeen = 0
  let inFirstTurn = false
  const push = (entry: Omit<TreeEntry, 'sessionId' | 'firstTurn'>): number => {
    entries.push({ ...entry, sessionId, ...(inFirstTurn ? { firstTurn: true } : {}) })
    return entries.length - 1
  }
  /** Steps with a settled assistant/message (chunk-run tentatives drop). */
  const seenSteps = new Set<string>()
  /** stepKey → entry indices of chunk-synthesized assistant texts. One step
   *  can yield SEVERAL runs when a non-chunk event interleaves the deltas
   *  (coalescing flushes at the boundary) — track them all, or earlier runs
   *  survive as ghost duplicates of the settled message. */
  const tentatives = new Map<string, number[]>()
  /** callId → entry index of an unsettled tool card. */
  const openTools = new Map<string, number>()
  /** Turns whose turn/end said aborted/interrupted. */
  const abortedTurns = new Set<number>()

  for (const event of coalesceReplayEvents(events)) {
    if (event.type === 'turn/start') {
      turnsSeen += 1
      inFirstTurn = markFirstTurn && turnsSeen === 1
      continue
    }
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source as { kind: string; plugin?: string }
        if (source.kind === 'plugin' && source.plugin === 'compact') {
          const summary = textOf(event.data.content as readonly Block[])
          push({
            seq: event.seq,
            kind: 'compact',
            text: preview(summary || '(compaction)'),
            searchText: `compact ${summary}`,
            time: event.time,
          })
          break
        }
        if (source.kind !== 'user') break
        const text = firstTextOf(event.data.content as readonly Block[])
        if (text) {
          push({
            seq: event.seq,
            kind: 'user',
            text: preview(text),
            searchText: `user ${text}`,
            time: event.time,
          })
        }
        break
      }
      case 'assistant/message': {
        const { turn, step } = event.data
        seenSteps.add(`${turn}:${step}`)
        const text = textOf(event.data.message.content as readonly Block[])
        // pi hides assistant messages with only tool calls (no text).
        if (text) {
          push({
            seq: event.seq,
            kind: 'assistant',
            text: preview(text),
            searchText: `assistant ${text}`,
            time: event.time,
          })
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type !== 'text-delta') break
        const text = 'text' in chunk ? (chunk.text ?? '') : ''
        if (!text.trim()) break
        const key = `${event.data.turn}:${event.data.step}`
        const index = push({
          seq: event.seq,
          kind: 'assistant',
          text: preview(text),
          searchText: `assistant ${text}`,
          time: event.time,
        })
        const group = tentatives.get(key)
        if (group === undefined) tentatives.set(key, [index])
        else group.push(index)
        break
      }
      case 'tool/call': {
        if (event.data.name === 'ask_user_question') break
        const args = preview(event.data.arguments, TOOL_ARGS_PREVIEW_LIMIT)
        const index = push({
          seq: event.seq,
          kind: 'tool',
          text: `[${event.data.name}] ${args}`,
          searchText: `tool ${event.data.name} ${event.data.arguments}`,
          time: event.time,
          toolStatus: 'running',
        })
        openTools.set(event.data.callId, index)
        break
      }
      case 'tool/result': {
        const index = openTools.get(event.data.message.source.callId)
        if (index === undefined) break
        const entry = entries[index]!
        entries[index] = {
          ...entry,
          toolStatus: event.data.error === undefined ? 'ok' : 'error',
        }
        openTools.delete(event.data.message.source.callId)
        break
      }
      case 'turn/end': {
        const reason = event.data.reason
        if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
          abortedTurns.add(event.data.turn)
          push({ seq: event.seq, kind: 'interrupt', text: 'interrupted', searchText: 'interrupt interrupted', time: event.time })
        } else if (reason.kind !== 'completed') {
          const detail = reason.kind === 'error' ? reason.error.message : ''
          push({
            seq: event.seq,
            kind: 'notice',
            text: preview(`turn ${reason.kind}${detail ? ` · ${detail}` : ''}`),
            searchText: `notice turn ${reason.kind} ${detail}`,
            time: event.time,
          })
        }
        // The turn CLOSES here — including turn 0. Entries logged BETWEEN
        // turns (a compact checkpoint) are not turn-0 entries: their rewind
        // boundary is the entry itself, perfectly valid, so the flag must
        // not leak past this point and get them refused as "first message".
        inFirstTurn = false
        break
      }
      default:
        break
    }
  }

  // Chunk-synthesized assistant entries lose to a settled assistant/message
  // for the same step; survivors of an aborted turn get the marker.
  const drop = new Set<number>()
  for (const [key, indices] of tentatives) {
    if (seenSteps.has(key)) {
      for (const index of indices) drop.add(index)
      continue
    }
    const turn = Number(key.slice(0, key.indexOf(':')))
    if (abortedTurns.has(turn)) {
      for (const index of indices) {
        entries[index] = { ...entries[index]!, label: 'aborted' }
      }
    }
  }
  return drop.size === 0 ? entries : entries.filter((_, index) => !drop.has(index))
}

/** A session's title event, if it ever got one (manual /rename or auto). */
function titleOf(events: readonly SessionEvent[]): string | undefined {
  let title: string | undefined
  for (const event of events) {
    if (event.type === 'session/title') {
      const data = event.data as { title?: string }
      if (typeof data.title === 'string' && data.title !== '') title = data.title
    }
  }
  return title
}

/**
 * Assemble the family tree. Roots are sessions with no parentSession (or a
 * parent missing from the family — a deleted log; the orphan's self-contained
 * prefix keeps its history whole). Fork chains attach at the last entry with
 * seq <= seedLength-1, walking UP the ancestor chain when the direct parent
 * no longer displays that entry (seed-prefix trimming — the fork point lives
 * in the shared prefix an ancestor shows); the anchored session's own tail
 * past the anchor stays the first (main) branch. Sessions with no own
 * entries get one placeholder node so the fork structure stays visible.
 */
export function buildSessionTree(
  sessions: readonly FamilySession[],
  liveSessionId: string,
  truncated = false,
): SessionTreeData {
  const byId = new Map(sessions.map(session => [session.id, session]))

  // Corrupt headers can close a parent LOOP (a self-reference, or A↔B):
  // attached under each other with no topmost member, every session in the
  // loop is skipped by root selection and the whole loop — live chain
  // included — vanishes from the panel. Cut the edge that closes each loop
  // before anything hangs off parent links; walking in input order keeps the
  // surviving root deterministic, and every structural read below goes
  // through parentOf so the cut is observed consistently.
  const cutEdges = new Set<string>()
  const parentOf = (session: FamilySession): string | undefined => {
    if (cutEdges.has(session.id)) return undefined
    // A parent id without the exact inherited cut proves ancestry, but not
    // where the fork belongs. Treat that unprovable edge as detached: the
    // self-contained child remains visible as a root instead of silently
    // inventing `seedLength = 0`, duplicating/anchoring the branch wrongly.
    if (session.parentSession !== undefined && session.seedLength === undefined) return undefined
    return session.parentSession
  }
  for (const session of sessions) {
    const seen = new Set<string>([session.id])
    let cursor: FamilySession = session
    for (;;) {
      const parentId = parentOf(cursor)
      if (parentId === undefined) break
      const parent = byId.get(parentId)
      if (parent === undefined) break
      if (seen.has(parent.id)) {
        cutEdges.add(cursor.id)
        break
      }
      seen.add(parent.id)
      cursor = parent
    }
  }

  // Coverage bookkeeping: coveredThrough(S) = the highest K such that every
  // seq in [0..K] is displayed by S's chain or an ancestor's. A fork's
  // inherited seed prefix duplicates that range, so the fork's own chain
  // trims it — but ONLY the covered part: an unreadable/unloaded or
  // budget-truncated parent shows nothing (or less than the full prefix),
  // and trimming the full seedLength would hide inherited history nobody
  // displays (the child's log is self-contained). Transparent sessions
  // (unreadable/unloaded/empty) forward their own ancestors' coverage, so a
  // fork of a dead branch still dedups against the grandparent's chain.
  const coveredThrough = new Map<string, number>()
  const covering = new Set<string>()
  const coverOf = (id: string): number => {
    const known = coveredThrough.get(id)
    if (known !== undefined) return known
    const session = byId.get(id)
    if (session === undefined || covering.has(id)) return -1
    covering.add(id)
    const parentId = parentOf(session)
    const parentCover = parentId !== undefined && byId.has(parentId) ? coverOf(parentId) : -1
    covering.delete(id)
    let cover: number
    if (session.unreadable === true || session.unloaded === true || session.events.length === 0) {
      cover = parentCover
    } else {
      const firstSeq = session.events[0]!.seq
      const lastSeq = session.events[session.events.length - 1]!.seq
      // The events claim [0..lastSeq] only when they CONNECT to the parent's
      // coverage (a full log starts at 0; a coverage-skipped read starts at
      // the parent's cutoff). Otherwise the range is an island and coverage
      // stays at the parent's — the events still display, they just cannot
      // vouch for a contiguous prefix.
      cover = firstSeq <= parentCover + 1 ? Math.max(parentCover, lastSeq) : parentCover
    }
    coveredThrough.set(id, cover)
    return cover
  }

  // Per-session chains: extracted entries, with the inherited seed prefix
  // trimmed by what the ancestor chain ACTUALLY covers (never past the seed
  // prefix — events beyond it are this session's own).
  const chains = new Map<string, TreeNode[]>()
  const metas = new Map<string, SessionTreeMeta>()
  const rewindFacts = new Map<string, SessionRewindFacts>()
  for (const session of sessions) {
    metas.set(session.id, {
      title: titleOf(session.events),
      createdAt: session.createdAt,
      live: session.live,
      unreadable: session.unreadable === true,
      unloaded: session.unloaded === true,
    })
    const parentId = parentOf(session)
    const trimFrom = parentId !== undefined && byId.has(parentId) && session.seedLength !== undefined
      ? Math.min(session.seedLength, coverOf(parentId) + 1)
      : 0
    const own = session.unreadable === true ? [] : extractEntries(session.id, session.events).filter(entry => entry.seq >= trimFrom)
    // Rewind UX facts: own turn ranges (drop-turn confirm warning) and the
    // branch-adopt target. A coverage/budget head cut can open the loaded
    // events MID-turn — a turn/end then has no matching start; that turn
    // gets no range and droppedTurnInfo stays silent for its entries rather
    // than blaming the wrong span. Open turns end at the loaded tail.
    {
      const mutableTurns: { start: number; end: number; entries: number; closed: boolean }[] = []
      const lastSeq = session.events.length > 0 ? session.events[session.events.length - 1]!.seq : -1
      let lastTurnEnd = -1
      for (const event of session.events) {
        if (event.type === 'turn/start') {
          mutableTurns.push({ start: event.seq, end: lastSeq, entries: 0, closed: false })
        } else if (event.type === 'turn/end') {
          lastTurnEnd = event.seq
          const open = mutableTurns[mutableTurns.length - 1]
          if (open !== undefined && !open.closed) {
            open.end = event.seq
            open.closed = true
          }
        }
      }
      // Both lists are seq-ordered: two-pointer the own entries into turns.
      let turnIndex = 0
      for (const entry of own) {
        while (turnIndex < mutableTurns.length && entry.seq > mutableTurns[turnIndex]!.end) turnIndex++
        const turn = mutableTurns[turnIndex]
        if (turn !== undefined && entry.seq > turn.start) turn.entries++
      }
      rewindFacts.set(session.id, {
        turns: mutableTurns,
        ownEntries: own.length,
        tailComplete: session.tailComplete === true,
        ...(session.tailComplete === true && lastTurnEnd >= 0 ? { tipBoundary: lastTurnEnd } : {}),
      })
    }
    if (own.length === 0) {
      chains.set(session.id, [
        { id: `${session.id}:head`, entry: null, sessionId: session.id, branchHead: true, children: [] },
      ])
      continue
    }
    chains.set(
      session.id,
      own.map((entry, index) => ({
        id: `${session.id}:${entry.seq}`,
        entry,
        sessionId: session.id,
        branchHead: index === 0,
        children: [],
      })),
    )
  }
  // Linear links first: node[i].children = [node[i+1]].
  for (const chain of chains.values()) {
    for (let i = 0; i + 1 < chain.length; i++) {
      chain[i]!.children.push(chain[i + 1]!)
    }
  }

  // Fork attachments, oldest fork first at each anchor. The parent's own
  // continuation (linked above) stays child #0 — the main branch.
  //
  // Anchor search walks UP the ancestor chain when the direct parent does
  // not display the fork point: seed-prefix trimming moved those entries to
  // an ancestor's chain (seqs are shared across the self-contained logs), so
  // a fork whose boundary predates the parent's own entries correctly becomes
  // a sibling of the branch it diverged from. Only when NO ancestor displays
  // an entry at or before the boundary does the fork hang off a synthesized
  // session-start head. Heads are synthesized in a separate pass BEFORE any
  // attachment — attaching through a chain head that is later unshifted
  // would leave the new head (and its subtree) disconnected.
  const childrenOf = new Map<string, FamilySession[]>()
  for (const session of sessions) {
    const parentId = parentOf(session)
    if (parentId === undefined || !byId.has(parentId)) continue
    const siblings = childrenOf.get(parentId)
    if (siblings === undefined) childrenOf.set(parentId, [session])
    else siblings.push(session)
  }
  /** Last displayed entry with seq <= boundary, walking up from the parent. */
  const findAnchor = (fork: FamilySession): TreeNode | undefined => {
    if (fork.seedLength === undefined) return undefined
    const boundary = fork.seedLength - 1
    const visited = new Set<string>()
    let cursorId = parentOf(fork)
    while (cursorId !== undefined && !visited.has(cursorId)) {
      visited.add(cursorId)
      const holder = byId.get(cursorId)
      if (holder === undefined) break
      const chain = chains.get(cursorId)!
      for (let i = chain.length - 1; i >= 0; i--) {
        const entry = chain[i]!.entry
        if (entry !== null && entry.seq <= boundary) return chain[i]
      }
      cursorId = parentOf(holder)
    }
    return undefined
  }
  // Pass A: resolve anchors, marking parents whose fork predates everything
  // displayable (those need a session-start head).
  const headlessParents = new Set<string>()
  const resolved = new Map<string, { anchor: TreeNode | undefined; fork: FamilySession }[]>()
  for (const [parentId, forks] of childrenOf) {
    const list = forks.sort((a, b) => a.createdAt - b.createdAt)
      .map(fork => {
        const anchor = findAnchor(fork)
        if (anchor === undefined) headlessParents.add(parentId)
        return { anchor, fork }
      })
    resolved.set(parentId, list)
  }
  // Pass B: synthesize the session-start heads (skipped when the parent's
  // chain already opens with a placeholder).
  for (const parentId of headlessParents) {
    const parentChain = chains.get(parentId)!
    const first = parentChain[0]!
    if (first.entry === null) continue
    const head: TreeNode = { id: `${parentId}:head`, entry: null, sessionId: parentId, branchHead: true, children: [] }
    first.branchHead = false
    head.children.push(first)
    parentChain.unshift(head)
  }
  // Pass C: attach — chain heads are final now, no capture can go stale.
  for (const [parentId, list] of resolved) {
    for (const { anchor, fork } of list) {
      const forkHead = chains.get(fork.id)![0]!
      ;(anchor ?? chains.get(parentId)![0]!).children.push(forkHead)
    }
  }

  const roots: TreeNode[] = []
  for (const session of sessions) {
    const parentId = parentOf(session)
    if (parentId !== undefined && byId.has(parentId)) continue
    roots.push(chains.get(session.id)![0]!)
  }

  // Active path: live session's whole chain, then each ancestor up to the
  // fork boundary the next hop inherited. The boundary only NARROWS walking
  // up: a descendant that forked inside its parent's INHERITED prefix caps
  // the path at its own fork point — the parent's own entries past it (and
  // the grandparent's entries past that) belong to dead branches, not the
  // path to the live tip. Cycle-guarded (corrupt headers).
  const activePath = new Set<string>()
  let activeLeafId: string | null = null
  const liveChain = chains.get(liveSessionId)
  if (liveChain !== undefined) {
    activeLeafId = liveChain.at(-1)!.id
    for (const node of liveChain) activePath.add(node.id)
    const visited = new Set<string>([liveSessionId])
    let current = byId.get(liveSessionId)
    let boundary = Number.POSITIVE_INFINITY
    while (current !== undefined) {
      const parentId = parentOf(current)
      if (parentId === undefined || !byId.has(parentId)) break
      if (visited.has(parentId)) break
      if (current.seedLength === undefined) break
      visited.add(parentId)
      boundary = Math.min(boundary, current.seedLength - 1)
      for (const node of chains.get(parentId)!) {
        if (node.entry !== null && node.entry.seq <= boundary) activePath.add(node.id)
      }
      current = byId.get(parentId)
    }
  }

  return { roots, activePath, activeLeafId, sessions: metas, rewindFacts, truncated, sessionCount: sessions.length }
}

/**
 * Flatten the tree into render rows, pi-style: the subtree containing the
 * active leaf sorts first at every branch point; single-child chains keep
 * their indent, branch points indent +1 (plus the first generation after a
 * branch); gutters record where ancestor │ lines continue.
 */
export function flattenTree(roots: readonly TreeNode[], activeLeafId: string | null): FlatNode[] {
  const multipleRoots = roots.length > 1

  // Post-order: which subtrees contain the active leaf (sorted first below).
  const containsActive = new Map<TreeNode, boolean>()
  {
    const all: TreeNode[] = []
    const stack: TreeNode[] = [...roots]
    while (stack.length > 0) {
      const node = stack.pop()!
      all.push(node)
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!)
    }
    for (let i = all.length - 1; i >= 0; i--) {
      const node = all[i]!
      let has = node.id === activeLeafId
      for (const child of node.children) {
        if (containsActive.get(child) === true) has = true
      }
      containsActive.set(node, has)
    }
  }
  const activeFirst = (nodes: readonly TreeNode[]): TreeNode[] => {
    const prioritized: TreeNode[] = []
    const rest: TreeNode[] = []
    for (const node of nodes) {
      if (containsActive.get(node) === true) prioritized.push(node)
      else rest.push(node)
    }
    return [...prioritized, ...rest]
  }

  type StackItem = [TreeNode, number, boolean, boolean, boolean, readonly GutterInfo[], boolean, string | null]
  const stack: StackItem[] = []
  const orderedRoots = activeFirst(roots)
  for (let i = orderedRoots.length - 1; i >= 0; i--) {
    stack.push([
      orderedRoots[i]!,
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      i === orderedRoots.length - 1,
      [],
      multipleRoots,
      null,
    ])
  }

  const flat: FlatNode[] = []
  while (stack.length > 0) {
    const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild, parentId] = stack.pop()!
    flat.push({
      node,
      parentId,
      indent,
      showConnector,
      isLast,
      gutters,
      isVirtualRootChild,
      multipleRoots,
    })

    const children = activeFirst(node.children)
    const multipleChildren = children.length > 1
    let childIndent: number
    if (multipleChildren) childIndent = indent + 1
    else if (justBranched && indent > 0) childIndent = indent + 1
    else childIndent = indent

    const connectorDisplayed = showConnector && !isVirtualRootChild
    const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent
    const connectorPosition = Math.max(0, currentDisplayIndent - 1)
    const childGutters: readonly GutterInfo[] = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters

    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([
        children[i]!,
        childIndent,
        multipleChildren,
        multipleChildren,
        i === children.length - 1,
        childGutters,
        false,
        node.id,
      ])
    }
  }
  return flat
}

/**
 * Filter + search the flattened tree, then recompute the tree drawing over
 * the visible rows (each visible node re-hangs under its nearest visible
 * ancestor, so hidden intermediates don't drift the indent). The active leaf
 * always survives filtering (pi keeps the current position visible).
 */
export function filterTree(
  flat: readonly FlatNode[],
  activeLeafId: string | null,
  filter: TreeFilter,
  query: string,
): FlatNode[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const visible = flat.filter(flatNode => {
    const { node } = flatNode
    if (node.id === activeLeafId) return true
    if (node.entry === null) {
      // Placeholders: structure-only rows. `all` shows them; any search
      // query hides them (no text to match) so they don't become stray
      // roots; other modes drop them unless a visible descendant re-hangs.
      return filter === 'all' && tokens.length === 0
    }
    switch (filter) {
      case 'user-only':
        if (node.entry.kind !== 'user') return false
        break
      case 'no-tools':
        if (node.entry.kind === 'tool' || node.entry.kind === 'notice') return false
        break
      case 'all':
        break
      default:
        if (node.entry.kind === 'notice') return false
        break
    }
    if (tokens.length > 0) {
      const haystack = node.entry.searchText.toLowerCase()
      return tokens.every(token => haystack.includes(token))
    }
    return true
  })

  if (visible.length === 0) return visible

  // Re-hang visible nodes under their nearest visible ancestor.
  const visibleIds = new Set(visible.map(flatNode => flatNode.node.id))
  const byNodeId = new Map(flat.map(flatNode => [flatNode.node.id, flatNode]))
  const visibleParent = new Map<string, string | null>()
  const visibleChildren = new Map<string | null, string[]>()
  visibleChildren.set(null, [])
  const nearestVisible = (id: string): string | null => {
    let current = byNodeId.get(id)?.parentId ?? null
    while (current !== null) {
      if (visibleIds.has(current)) return current
      current = byNodeId.get(current)?.parentId ?? null
    }
    return null
  }
  for (const flatNode of visible) {
    const ancestor = nearestVisible(flatNode.node.id)
    visibleParent.set(flatNode.node.id, ancestor)
    const siblings = visibleChildren.get(ancestor)
    if (siblings === undefined) visibleChildren.set(ancestor, [flatNode.node.id])
    else siblings.push(flatNode.node.id)
  }

  // Recompute indent/connectors/gutters over the visible tree, same rules as
  // flattenTree (roots = children of the virtual null parent).
  const visibleRoots = visibleChildren.get(null)!
  const multipleRoots = visibleRoots.length > 1
  const visibleById = new Map(visible.map(flatNode => [flatNode.node.id, flatNode]))
  type StackItem = [string, number, boolean, boolean, boolean, readonly GutterInfo[], boolean]
  const stack: StackItem[] = []
  for (let i = visibleRoots.length - 1; i >= 0; i--) {
    stack.push([visibleRoots[i]!, multipleRoots ? 1 : 0, multipleRoots, multipleRoots, i === visibleRoots.length - 1, [], multipleRoots])
  }
  const out: FlatNode[] = []
  while (stack.length > 0) {
    const [id, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!
    const flatNode = visibleById.get(id)!
    flatNode.indent = indent
    flatNode.showConnector = showConnector
    flatNode.isLast = isLast
    flatNode.gutters = gutters
    flatNode.isVirtualRootChild = isVirtualRootChild
    flatNode.multipleRoots = multipleRoots
    out.push(flatNode)

    const children = visibleChildren.get(id) ?? []
    const multipleChildren = children.length > 1
    let childIndent: number
    if (multipleChildren) childIndent = indent + 1
    else if (justBranched && indent > 0) childIndent = indent + 1
    else childIndent = indent

    const connectorDisplayed = showConnector && !isVirtualRootChild
    const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent
    const connectorPosition = Math.max(0, currentDisplayIndent - 1)
    const childGutters: readonly GutterInfo[] = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([children[i]!, childIndent, multipleChildren, multipleChildren, i === children.length - 1, childGutters, false])
    }
  }
  return out
}

/**
 * Index of `targetId` in `visible`, walking the FULL list's parent chain when
 * the exact node was filtered out; falls back to the last visible row
 * (pi's findNearestVisibleIndex).
 */
export function nearestVisibleIndex(
  visible: readonly FlatNode[],
  full: readonly FlatNode[],
  targetId: string | null,
): number {
  if (visible.length === 0) return 0
  const visibleIndexById = new Map(visible.map((flatNode, index) => [flatNode.node.id, index]))
  const fullById = new Map(full.map(flatNode => [flatNode.node.id, flatNode]))
  let current = targetId
  while (current !== null) {
    const index = visibleIndexById.get(current)
    if (index !== undefined) return index
    const parent = fullById.get(current)?.parentId ?? null
    if (parent === current) break // corrupt self-parent guard
    current = parent
  }
  return visible.length - 1
}
