/** Host-owned in-process Channel contract. No runtime or upstream imports. */


/** One extra rewind mode offered by a plugin (e.g. "also restore files"). */
export interface TuiRewindMode {
  /** Stable id reported back in `TuiRewindDoneEvent.mode`. */
  id: string
  /** One-line label shown in the confirm pane. */
  label: string
  /** Optional dimmed description under the label. */
  description?: string
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

/** Displayable entry kinds (a subset of ChatRow kinds, plus fork structure). */
export type TreeEntryKind = 'user' | 'assistant' | 'tool' | 'compact' | 'interrupt' | 'notice'

export interface SessionTreeMeta {
  readonly title?: string
  readonly createdAt: number
  readonly live: boolean
  readonly unreadable: boolean
  /** Log unread because the browse budget was spent (placeholder node). */
  readonly unloaded: boolean
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

/**
 * Everything the browser shows for one session, and nothing that costs an
 * unbounded read to learn.
 *
 * That second half is an invariant, not an accident: every field here comes
 * from the persistence header, one `stat`, or a bounded window at one end of
 * the log. A session's full statistics (turn counts, tool totals, token spend)
 * require folding the entire event log, which is what the trajectory scene is
 * for — the browser stays responsive on a 4 MB log because it never asks a
 * question that big.
 */
export interface SessionSummary {
  readonly id: string
  readonly kind: SessionKind
  readonly title: SessionTitle
  /** Working directory recorded in the header; '' when it recorded none. */
  readonly cwd: string
  readonly createdAt: number
  /**
   * Last activity: the later of the log's own mtime and this install's
   * last-used note. Both are lower bounds on "when this session was last
   * touched" — the mtime catches writes by another client (dsh web appends to
   * the same store), the note catches a resume this install performed. The
   * later of two lower bounds is the best available answer, and unlike a
   * composite value there is no risk of stitching halves from different
   * origins: this is one scalar with two witnesses.
   */
  readonly updatedAt: number
  /** Log size in bytes; undefined when the backend owns no per-session file. */
  readonly bytes: number | undefined
  /**
   * Whether the log holds a user prompt at all.
   *
   * `list()` reports *materialized* sessions, not conversations: a session
   * that only ever recorded its own boot policy is a real stored session with
   * nothing to resume. Answering this is the consumer's job — the header does
   * not promise it — and getting it wrong is why one empty row per launch used
   * to accumulate in the picker.
   */
  readonly hasPrompt: boolean
  /** Agent preset the session was composed from, when the deployment records one. */
  readonly agentPreset: string | undefined
  /** Model last seen in the log's trailing window, when one is recorded. */
  readonly model: string | undefined
  /** Sub-agent label from the run's descriptor (`subagent` kind only). */
  readonly label: string | undefined
  /** Git branch noted when this install last used the session. */
  readonly branch: string | undefined
  /** How many sub-agent runs name this session as their parent. */
  readonly childCount: number
}

/**
 * What the TUI knows about a persisted session before opening it.
 *
 * The shape here is the whole point of this feature. The picker used to run on
 * `{ id, title, cwd, createdAt, updatedAt }`, and every defect it had was
 * downstream of that: it could not tell a delegated sub-agent run from a
 * conversation because it never carried the distinction, and it could not show
 * why a row was labelled the way it was because the label arrived without its
 * provenance. So the types below carry both — the kind as a closed sum, and
 * every derived label together with the evidence that produced it.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/types
 */

/**
 * What a persisted session *is*, decided once from its immutable header.
 *
 * A closed sum rather than a pair of booleans: `isSubagent`/`isFork` would
 * admit a fourth, meaningless combination, and every reader would have to
 * re-derive the precedence between them. Deciding once, here, is also the fix
 * for the defect that started this work — `origin` and `parentSession` reached
 * the picker and were dropped on the floor.
 *
 * The discriminator is `origin`, never `parentSession`. A `/rewind` fork
 * carries `parentSession` and no `origin`, so filtering on lineage alone would
 * silently hide the user's own rewound branches along with the sub-agents.
 */
export type SessionKind =
  /** A conversation the user started. */
  | { readonly kind: 'root' }
  /**
   * A `/rewind` fork: a real conversation that inherited a prefix of its
   * parent's log. `parent` is what defines it, so it is never absent.
   */
  | { readonly kind: 'fork'; readonly parent: string }
  /**
   * A delegated sub-agent run. `origin: 'subagent'` is the authority, so the
   * lineage link is reported as it is found — a run whose header records no
   * parent is still a sub-agent run.
   */
  | {
    readonly kind: 'subagent'
    readonly parent: string | undefined
    readonly depth: number
  }

/**
 * A display title and the evidence behind it.
 *
 * The source travels with the text because the UI consumes it: a `fallback`
 * title is dimmed rather than presented as if the session were named that, and
 * a reader who wonders why a row carries a fallback label can be told. A source that
 * nothing consumed would be decoration; this one changes what is rendered.
 */
export interface SessionTitle {
  readonly text: string
  readonly source: TitleSource
}

/** Which evidence produced a session's display title. */
export type TitleSource =
  /** A `session/title` event appended after the session's own opening — a rename. */
  | 'renamed'
  /** The session's first `session/title`, written for it automatically. */
  | 'auto'
  /** No title event; the opening user prompt stands in. */
  | 'prompt'
  /** Nothing readable; the working directory's basename stands in. */
  | 'fallback'

/** One exchange in the preview pane, newest last. */
export interface PreviewEntry {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly at: number | undefined
}
