/** One persisted input-history entry. */
export type HistoryEntry = {
    text: string;
    /** Unix ms timestamp. */
    ts: number;
};
/**
 * Append an input to the persisted history, deduping the immediately
 * previous entry and capping the file at 200 entries.
 *
 * File IO is ASYNCHRONOUS and serialized: the sync read+rewrite of the whole
 * file on every submit used to block the UI thread at the exact Enter
 * moment (and grew slower as the file grew). Callers keep the sync void
 * signature — the write drains in the background.
 * @param text - Input to persist; blank inputs are ignored.
 */
export declare function appendHistory(text: string): void;
/**
 * Read the persisted history, newest first.
 * @returns The persisted entries in reverse-chronological order.
 */
export declare function loadHistory(): HistoryEntry[];
/**
 * Stable id for a history entry (dedupes React keys across identical texts).
 * @param entry - The history entry to hash.
 * @returns A 12-char hex id derived from the entry text.
 */
export declare function historyEntryId(entry: HistoryEntry): string;
//# sourceMappingURL=history.d.ts.map