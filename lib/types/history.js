import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const HISTORY_DIR = join(homedir(), '.dsh-cc');
const HISTORY_FILE = join(HISTORY_DIR, 'history.jsonl');
const HISTORY_LIMIT = 200;
function loadRaw() {
    if (!existsSync(HISTORY_FILE))
        return [];
    const entries = [];
    try {
        for (const line of readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
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
    }
    catch {
        return [];
    }
    return entries;
}
/** Append an input to the persisted history (dedupes the immediately-previous entry). */
export function appendHistory(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return;
    const entries = loadRaw();
    // Skip consecutive duplicates (CC behavior: repeated submits of the same
    // command only advance the existing entry's timestamp).
    const last = entries[entries.length - 1];
    if (last && last.text === trimmed) {
        last.ts = Date.now();
    }
    else {
        entries.push({ text: trimmed, ts: Date.now() });
    }
    const sliced = entries.slice(-HISTORY_LIMIT);
    try {
        mkdirSync(HISTORY_DIR, { recursive: true });
        writeFileSync(HISTORY_FILE, sliced.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    }
    catch {
        // Best-effort persistence; history still works for the session.
    }
}
/** Read the persisted history, newest first. */
export function loadHistory() {
    return loadRaw().reverse();
}
/** Stable id for a history entry (dedupe React keys across identical texts). */
export function historyEntryId(entry) {
    return createHash('sha1').update(entry.text).digest('hex').slice(0, 12);
}
//# sourceMappingURL=history.js.map