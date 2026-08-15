/**
 * Compat patch: pre-resume session-log repair for third-party event types.
 *
 * Background: plugins like dsh-working-activity append `activity/status`
 * through `session.append`, but rc.6's append exposes no `ignorable` flag
 * and the type is absent from KNOWN_SESSION_EVENT_TYPES — so resume's seed
 * validation rejects the WHOLE session ("unknown to this harness and not
 * marked ignorable"). The event envelope legally accepts `ignorable: true`
 * (seed validator at dsh-session/lib), which tells the read path to skip
 * the event: exactly the right semantics for ephemeral UI frames.
 *
 * This patch repairs the target session's jsonl.zstd log in place before
 * `agents.resume`: every event whose type is unknown to the harness gets
 * `ignorable: true`. It is inherently self-adjusting — the capability probe
 * IS the known-types list, so types upstream later adopts stop being
 * marked, and already-known events are never touched.
 *
 * Storage notes: the jsonl persistence flushes by APPENDING zstd frames, so
 * the file is a concatenation of frames. Frame layout is load-bearing: the
 * backend asserts frame 0 holds EXACTLY the header line (listings read only
 * that frame; `assertZstdHeaderFrame`), so the repair re-encodes each frame
 * with its original line set — frame boundaries are preserved 1:1, and any
 * frame whose lines were untouched is copied verbatim. Any decode/parse
 * anomaly aborts the repair and resume proceeds unpatched — the failure
 * mode degrades to the pre-patch behavior.
 * @module @deepseek-harness-tui/dsh-tui/compat/sessionLog
 */
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
/** Zstd frame magic number, little-endian (0xFD2FB528). */
const ZSTD_MAGIC = 0xfd2fb528;
/**
 * Session-log storage root, mirroring the persistence plugin's `root`
 * resolution in cordis.yml: DSH_CC_SESSION_ROOT, else ~/.dsh-cc/sessions.
 */
function sessionsRoot() {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    return process.env.DSH_CC_SESSION_ROOT ?? join(home, '.dsh-cc', 'sessions');
}
/**
 * Locate a session's log by scanning workspace directories for the session
 * id — deliberately NOT replicating the persistence plugin's workspace-key
 * sanitization, so the repair survives upstream key-scheme changes.
 * @param sessionId - Session id (directory name under each workspace dir).
 * @returns Absolute path of session.jsonl.zstd, or undefined when absent.
 */
function findSessionLogFile(sessionId) {
    const root = sessionsRoot();
    let workspaces;
    try {
        workspaces = readdirSync(root);
    }
    catch {
        return undefined;
    }
    for (const ws of workspaces) {
        const candidate = join(root, ws, sessionId, 'session.jsonl.zstd');
        if (existsSync(candidate))
            return candidate;
    }
    return undefined;
}
/**
 * Decode a (possibly multi-frame) zstd jsonl log, keeping frames separate.
 * Frames are split by magic scan; any frame failing to decode or any line
 * failing to parse throws, so callers abort instead of rewriting a log they
 * did not fully understand.
 * @param buf - Raw file bytes.
 * @returns Per-frame byte spans and parsed event envelopes, in log order.
 */
function decodeFrames(buf) {
    const offsets = [];
    for (let i = 0; i + 4 <= buf.length; i++) {
        if (buf.readUInt32LE(i) === ZSTD_MAGIC)
            offsets.push(i);
    }
    if (offsets.length === 0)
        throw new Error('no zstd frame found');
    return offsets.map((start, i) => {
        const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
        const raw = buf.subarray(start, end);
        const text = zstdDecompressSync(raw).toString('utf8');
        const events = text
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => {
            const parsed = JSON.parse(line);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('session log line is not an event envelope');
            }
            return parsed;
        });
        return { raw, events };
    });
}
/**
 * Repair one session's persisted log ahead of `agents.resume`: mark every
 * event whose type is absent from KNOWN_SESSION_EVENT_TYPES as
 * `ignorable: true` (envelope-legal, read path skips it). Never throws.
 * @param sessionId - Session about to be resumed.
 * @returns The repair outcome; 'unavailable' leaves the file untouched.
 */
export function repairSessionLogForResume(sessionId) {
    try {
        const file = findSessionLogFile(sessionId);
        if (file === undefined)
            return 'unavailable';
        const frames = decodeFrames(readFileSync(file));
        // Mark unknown types in place, tracking which frames actually changed:
        // untouched frames are copied back verbatim, so the header frame keeps
        // its exact original bytes (and the one-header-line invariant with it).
        const dirty = new Set();
        frames.forEach((frame, index) => {
            for (const event of frame.events) {
                const type = event['type'];
                // Only real log entries carry a numeric seq — the seq-less header row
                // is parsed by a separate path that must not see an extra field.
                if (typeof type === 'string' &&
                    typeof event['seq'] === 'number' &&
                    !KNOWN_SESSION_EVENT_TYPES.has(type) &&
                    event['ignorable'] === undefined) {
                    event['ignorable'] = true;
                    dirty.add(index);
                }
            }
        });
        if (dirty.size === 0)
            return 'clean';
        const parts = frames.map((frame, index) => {
            if (!dirty.has(index))
                return frame.raw;
            const payload = frame.events.map((event) => JSON.stringify(event)).join('\n') + '\n';
            return zstdCompressSync(Buffer.from(payload, 'utf8'));
        });
        const tmp = `${file}.compat-${randomUUID()}.tmp`;
        writeFileSync(tmp, Buffer.concat(parts));
        renameSync(tmp, file);
        return 'repaired';
    }
    catch {
        return 'unavailable';
    }
}
/**
 * Compat entry for the resume path: repair the target session's log, then
 * let resume proceed regardless of outcome. Never throws, never blocks on
 * anything but one small file — a repair miss degrades to the exact
 * pre-patch behavior (resume may still succeed or fail as before).
 * @param sessionId - Session about to be resumed.
 */
export async function prepareSessionForResume(sessionId) {
    repairSessionLogForResume(sessionId);
}
