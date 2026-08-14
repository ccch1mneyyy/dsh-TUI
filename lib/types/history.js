import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const HISTORY_DIR = join(homedir(), '.dsh-cc');
const HISTORY_FILE = join(HISTORY_DIR, 'history.jsonl');
const HISTORY_LIMIT = 200;
function parseHistory(text) {
    const entries = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed.text === 'string' && parsed.text.length > 0) {
                entries.push({ text: parsed.text, ts: typeof parsed.ts === 'number' ? parsed.ts : 0 });
            }
        }
        catch {
            // Skip malformed lines; the file is best-effort.
        }
    }
    return entries;
}
function loadRaw() {
    if (!existsSync(HISTORY_FILE))
        return [];
    try {
        return parseHistory(readFileSync(HISTORY_FILE, 'utf8'));
    }
    catch {
        return [];
    }
}
async function loadRawAsync() {
    try {
        return parseHistory(await fsp.readFile(HISTORY_FILE, 'utf8'));
    }
    catch {
        return [];
    }
}
// Serialized read-modify-write: rapid submits (Enter / steer / queue) must
// not interleave and lose entries. The chain never rejects — persistence is
// best-effort and a failed write must not break the in-session history.
let historyWriteChain = Promise.resolve();
// Latest computed state, for the exit flush below: a chain still draining
// when the process exits must not silently drop the newest entries.
let lastComputed = null;
process.on('exit', () => {
    if (lastComputed === null)
        return;
    try {
        writeFileSync(HISTORY_FILE, lastComputed.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    }
    catch {
        // Best effort — the in-session history is unaffected.
    }
});
/**
 * Append an input to the persisted history, deduping the immediately
 * previous entry and capping the file at 200 entries.
 *
 * File IO is ASYNCHRONOUS and serialized: the sync read+rewrite of the whole
 * file on every submit used to block the UI thread at the exact Enter
 * moment (and grew slower as the file grew). Callers keep the sync void
 * signature — the write drains in the background; a process exit while the
 * chain drains flushes the latest computed state synchronously.
 * @param text - Input to persist; blank inputs are ignored.
 */
export function appendHistory(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return;
    historyWriteChain = historyWriteChain
        .then(async () => {
        const entries = await loadRawAsync();
        // Skip consecutive duplicates (CC behavior: repeated submits of the
        // same command only advance the existing entry's timestamp).
        const last = entries[entries.length - 1];
        if (last && last.text === trimmed) {
            last.ts = Date.now();
        }
        else {
            entries.push({ text: trimmed, ts: Date.now() });
        }
        const sliced = entries.slice(-HISTORY_LIMIT);
        // Snapshot the intended state BEFORE the await: the exit flush above
        // can then always persist at least everything computed so far.
        lastComputed = sliced;
        await fsp.mkdir(HISTORY_DIR, { recursive: true });
        await fsp.writeFile(HISTORY_FILE, sliced.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    })
        .catch(() => {
        // Best-effort persistence; history still works for the session.
    });
}
/**
 * Read the persisted history, newest first.
 * @returns The persisted entries in reverse-chronological order.
 */
export function loadHistory() {
    return loadRaw().reverse();
}
/**
 * Stable id for a history entry (dedupes React keys across identical texts).
 * @param entry - The history entry to hash.
 * @returns A 12-char hex id derived from the entry text.
 */
export function historyEntryId(entry) {
    return createHash('sha1').update(entry.text).digest('hex').slice(0, 12);
}
