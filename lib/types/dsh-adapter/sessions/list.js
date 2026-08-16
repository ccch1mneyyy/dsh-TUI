/**
 * Building the session list.
 *
 * One resolution path produces one complete, honestly-classified record per
 * stored session — every kind, empties included — and callers decide what to
 * show. That split is deliberate: the old picker filtered while it resolved,
 * so "hide sub-agent runs" and "resolve a title" were the same pass and
 * neither could change without disturbing the other. Here the browser can
 * toggle sub-agent runs into view, or offer to clean up boot artifacts,
 * without re-deriving anything.
 *
 * Cost: one `stat` per session always, plus one bounded log read per session
 * whose revision moved since the last listing. On a warm index that is zero
 * log reads. The path this replaces decompressed every frame of the twenty
 * most recent logs on every open — 3.9 s over a 31 MB history.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/list
 */
import { basename } from 'node:path';
import { digestSession } from './digest.js';
import { fileFacts } from './frames.js';
import { classify, readHeader } from './header.js';
import { findSessionLogFile } from '../compat/sessionLog.js';
import { readIndex, writeIndex } from './store.js';
import { readLastUsed } from '../../sessionHistory.js';
/** Pull `{ header, revision }` out of one `listSnapshots()` element. */
function readSnapshot(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const record = value;
    const raw = record['header'];
    const header = readHeader(raw);
    if (header === undefined)
        return undefined;
    const revision = record['revision'];
    return { header, raw, revision: typeof revision === 'string' ? revision : undefined };
}
/**
 * Enumerate stored sessions.
 *
 * Prefers `listSnapshots()` because its revision is the backend's own answer
 * to "has this log changed", and falls back to `list()` when the resolved
 * service predates it — in which case the change token is derived from the
 * file's own size and mtime further down. Both are honest change tokens for an
 * append-only log; only the authority differs.
 */
async function enumerate(source, signal) {
    if (typeof source.listSnapshots === 'function') {
        const snapshots = await source.listSnapshots(signal);
        return snapshots.map(readSnapshot).filter((entry) => entry !== undefined);
    }
    if (typeof source.list === 'function') {
        const headers = await source.list(signal);
        return headers
            .map((raw) => {
            const header = readHeader(raw);
            return header === undefined ? undefined : { header, raw, revision: undefined };
        })
            .filter((entry) => entry !== undefined);
    }
    return [];
}
/**
 * Absolute artifact path for one session.
 *
 * The backend's own `locate()` is authoritative and is asked first. The
 * fallback scans the session roots for the id, which is what the compat layer
 * has always done and is deliberately independent of the backend's
 * workspace-key scheme — so a runtime whose persistence service predates
 * `locate`, or whose key sanitization changes, still resolves.
 *
 * A backend that stores no per-session artifact (SQLite) answers neither, and
 * its sessions are summarized from their headers alone.
 */
function locate(source, raw, sessionId) {
    if (typeof source.locate === 'function') {
        let location;
        try {
            location = source.locate(raw);
        }
        catch {
            location = undefined;
        }
        if (location !== null && typeof location === 'object') {
            const path = location['path'];
            if (typeof path === 'string' && path.length > 0)
                return path;
        }
    }
    return findSessionLogFile(sessionId);
}
/**
 * Read every stored session into a complete summary.
 *
 * @param source - The persistence service.
 * @param signal - Optional cancellation for the backend's own listing work.
 * @returns One summary per stored session, most recently active first. No
 *   filtering of any kind is applied — sub-agent runs and sessions with no
 *   conversation are present and labelled as such.
 */
export async function listSummaries(source, signal) {
    let listed;
    try {
        listed = await enumerate(source, signal);
    }
    catch {
        return [];
    }
    // Children are counted from the same listing rather than by walking logs:
    // lineage lives in the header, so a parent's sub-agent count is free.
    const children = new Map();
    for (const entry of listed) {
        if (entry.header.origin !== 'subagent')
            continue;
        const parent = entry.header.parentSession;
        if (parent === undefined)
            continue;
        children.set(parent, (children.get(parent) ?? 0) + 1);
    }
    const index = readIndex();
    const next = new Map();
    const lastUsed = readLastUsed();
    let changed = false;
    const summaries = [];
    for (const { header, raw, revision } of listed) {
        const cached = index.get(header.id);
        const path = locate(source, raw, header.id);
        const facts = path === undefined ? undefined : fileFacts(path);
        // Falls back to the file's own identity when the backend offered no token.
        const token = revision ?? (facts === undefined ? undefined : `${facts.bytes}:${facts.modifiedAt}`);
        let derived;
        if (cached?.derived !== undefined && token !== undefined && cached.derived.revision === token) {
            derived = cached.derived;
        }
        else if (path !== undefined && token !== undefined) {
            const digest = digestSession(path, header.cwd ?? '');
            derived = {
                revision: token,
                title: digest.title?.text ?? '',
                titleSource: digest.title?.source ?? 'fallback',
                hasPrompt: digest.hasPrompt,
                model: digest.model,
                label: digest.label,
            };
            changed = true;
        }
        // Carry every entry that holds anything worth keeping — including a pure
        // cache hit, which must survive into the next index or the following
        // listing would re-derive everything it just reused.
        if (derived !== undefined || cached?.branch !== undefined) {
            next.set(header.id, { derived, branch: cached?.branch });
        }
        const createdAt = header.createdAt ?? facts?.modifiedAt ?? 0;
        summaries.push({
            id: header.id,
            kind: classify(header),
            title: {
                text: derived?.title !== undefined && derived.title.length > 0
                    ? derived.title
                    : basename(header.cwd ?? '') || header.id.slice(0, 8),
                source: derived?.titleSource ?? 'fallback',
            },
            cwd: header.cwd ?? '',
            createdAt,
            updatedAt: Math.max(facts?.modifiedAt ?? 0, lastUsed[header.id] ?? 0, createdAt),
            bytes: facts?.bytes,
            // Without a readable artifact nothing can be proven empty, and hiding a
            // real session is the worse error — so an unreadable log is listed.
            hasPrompt: derived?.hasPrompt ?? true,
            agentPreset: header.agentPreset,
            model: derived?.model,
            label: derived?.label,
            branch: cached?.branch,
            childCount: children.get(header.id) ?? 0,
        });
    }
    // Entries for sessions the backend no longer lists are dropped here; that is
    // the whole of the cache's garbage collection, and it runs on every listing.
    if (changed || next.size !== index.size)
        writeIndex(next);
    // A total order, not just a sort key. `updatedAt` is dominated by the log's
    // mtime, and sessions written inside the same millisecond tie on it — which
    // would leave their relative order down to whatever the backend happened to
    // enumerate first, so the same history could list differently twice in a
    // row. Creation time breaks the tie, and the id breaks that.
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt ||
        right.createdAt - left.createdAt ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
/**
 * Resolve one session's artifact path.
 *
 * Listing headers is a first-line-only read per log — about 2 ms across a
 * fifty-session history — so the preview pane resolves its target this way
 * rather than making every summary carry a filesystem path it has no business
 * knowing about.
 *
 * @param source - The persistence service.
 * @param sessionId - Session to locate.
 * @returns The absolute artifact path, or undefined when the backend owns no
 *   per-session file or the session is gone.
 */
export async function locateSession(source, sessionId, signal) {
    let listed;
    try {
        listed = await enumerate(source, signal);
    }
    catch {
        return undefined;
    }
    const match = listed.find(entry => entry.header.id === sessionId);
    return match === undefined ? undefined : locate(source, match.raw, sessionId);
}
