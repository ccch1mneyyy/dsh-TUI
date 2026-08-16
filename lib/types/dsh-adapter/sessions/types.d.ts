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
{
    readonly kind: 'root';
}
/**
 * A `/rewind` fork: a real conversation that inherited a prefix of its
 * parent's log. `parent` is what defines it, so it is never absent.
 */
 | {
    readonly kind: 'fork';
    readonly parent: string;
}
/**
 * A delegated sub-agent run. `origin: 'subagent'` is the authority, so the
 * lineage link is reported as it is found — a run whose header records no
 * parent is still a sub-agent run.
 */
 | {
    readonly kind: 'subagent';
    readonly parent: string | undefined;
    readonly depth: number;
};
/** Which evidence produced a session's display title. */
export type TitleSource = 
/** A `session/title` event appended after the session's own opening — a rename. */
'renamed'
/** The session's first `session/title`, written for it automatically. */
 | 'auto'
/** No title event; the opening user prompt stands in. */
 | 'prompt'
/** Nothing readable; the working directory's basename stands in. */
 | 'fallback';
/**
 * A display title and the evidence behind it.
 *
 * The source travels with the text because the UI consumes it: a `fallback`
 * title is dimmed rather than presented as if the session were named that, and
 * a reader who wonders why a row says `dsh-cc-tui` can be told. A source that
 * nothing consumed would be decoration; this one changes what is rendered.
 */
export interface SessionTitle {
    readonly text: string;
    readonly source: TitleSource;
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
    readonly id: string;
    readonly kind: SessionKind;
    readonly title: SessionTitle;
    /** Working directory recorded in the header; '' when it recorded none. */
    readonly cwd: string;
    readonly createdAt: number;
    /**
     * Last activity: the later of the log's own mtime and this install's
     * last-used note. Both are lower bounds on "when this session was last
     * touched" — the mtime catches writes by another client (dsh web appends to
     * the same store), the note catches a resume this install performed. The
     * later of two lower bounds is the best available answer, and unlike a
     * composite value there is no risk of stitching halves from different
     * origins: this is one scalar with two witnesses.
     */
    readonly updatedAt: number;
    /** Log size in bytes; undefined when the backend owns no per-session file. */
    readonly bytes: number | undefined;
    /**
     * Whether the log holds a user prompt at all.
     *
     * `list()` reports *materialized* sessions, not conversations: a session
     * that only ever recorded its own boot policy is a real stored session with
     * nothing to resume. Answering this is the consumer's job — the header does
     * not promise it — and getting it wrong is why one empty row per launch used
     * to accumulate in the picker.
     */
    readonly hasPrompt: boolean;
    /** Agent preset the session was composed from, when the deployment records one. */
    readonly agentPreset: string | undefined;
    /** Model last seen in the log's trailing window, when one is recorded. */
    readonly model: string | undefined;
    /** Sub-agent label from the run's descriptor (`subagent` kind only). */
    readonly label: string | undefined;
    /** Git branch noted when this install last used the session. */
    readonly branch: string | undefined;
    /** How many sub-agent runs name this session as their parent. */
    readonly childCount: number;
}
/**
 * Facts a bounded read can recover from one session log.
 *
 * No "last event time" here on purpose: for an append-only log the file's
 * mtime says the same thing, is already read for {@link SessionSummary.bytes},
 * and needs no cache entry of its own.
 */
export interface SessionDigest {
    readonly title: SessionTitle | undefined;
    readonly hasPrompt: boolean;
    readonly model: string | undefined;
    readonly label: string | undefined;
}
/** One exchange in the preview pane, newest last. */
export interface PreviewEntry {
    readonly role: 'user' | 'assistant';
    readonly text: string;
    readonly at: number | undefined;
}
//# sourceMappingURL=types.d.ts.map