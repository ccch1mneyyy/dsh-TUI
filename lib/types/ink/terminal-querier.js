/**
 * Query the terminal and await responses without timeouts.
 *
 * Terminal queries (DECRQM, DA1, OSC 11, etc.) share the stdin stream
 * with keyboard input. Response sequences are syntactically
 * distinguishable from key events, so the input parser recognizes them
 * and dispatches them here.
 *
 * To avoid timeouts, each query batch is terminated by a DA1 sentinel
 * (CSI c) — every terminal since VT100 responds to DA1, and terminals
 * answer queries in order. So: if your query's response arrives before
 * DA1's, the terminal supports it; if DA1 arrives first, it doesn't.
 *
 * Usage:
 *   const [sync, grapheme] = await Promise.all([
 *     querier.send(decrqm(2026)),
 *     querier.send(decrqm(2027)),
 *     querier.flush(),
 *   ])
 *   // sync and grapheme are DECRPM responses or undefined if unsupported
 */
import { csi } from './termio/csi.js';
import { osc } from './termio/osc.js';
// -- Query builders --
/** DECRQM: request DEC private mode status (CSI ? mode $ p).
 *  Terminal replies with DECRPM (CSI ? mode ; status $ y) or ignores. */
export function decrqm(mode) {
    return {
        request: csi(`?${mode}$p`),
        match: (r) => r.type === 'decrpm' && r.mode === mode,
    };
}
/** Primary Device Attributes query (CSI c). Every terminal answers this —
 *  used internally by flush() as a universal sentinel. Call directly if
 *  you want the DA1 params. */
export function da1() {
    return {
        request: csi('c'),
        match: (r) => r.type === 'da1',
    };
}
/** Secondary Device Attributes query (CSI > c). Returns terminal version. */
export function da2() {
    return {
        request: csi('>c'),
        match: (r) => r.type === 'da2',
    };
}
/** Query current Kitty keyboard protocol flags (CSI ? u).
 *  Terminal replies with CSI ? flags u or ignores. */
export function kittyKeyboard() {
    return {
        request: csi('?u'),
        match: (r) => r.type === 'kittyKeyboard',
    };
}
/** DECXCPR: request cursor position with DEC-private marker (CSI ? 6 n).
 *  Terminal replies with CSI ? row ; col R. The `?` marker is critical —
 *  the plain DSR form (CSI 6 n → CSI row;col R) is ambiguous with
 *  modified F3 keys (Shift+F3 = CSI 1;2 R, etc.). */
export function cursorPosition() {
    return {
        request: csi('?6n'),
        match: (r) => r.type === 'cursorPosition',
    };
}
/** OSC dynamic color query (e.g. OSC 11 for bg color, OSC 10 for fg).
 *  The `?` data slot asks the terminal to reply with the current value. */
export function oscColor(code) {
    return {
        request: osc(code, '?'),
        match: (r) => r.type === 'osc' && r.code === code,
    };
}
/** XTVERSION: request terminal name/version (CSI > 0 q).
 *  Terminal replies with DCS > | name ST (e.g. "xterm.js(5.5.0)") or ignores.
 *  This survives SSH — the query goes through the pty, not the environment,
 *  so it identifies the *client* terminal even when TERM_PROGRAM isn't
 *  forwarded. Used to detect xterm.js for wheel-scroll compensation. */
export function xtversion() {
    return {
        request: csi('>0q'),
        match: (r) => r.type === 'xtversion',
    };
}
// -- Querier --
/** Sentinel request sequence (DA1). Kept internal; flush() writes it. */
const SENTINEL = csi('c');
export class TerminalQuerier {
    stdout;
    /**
     * Interleaved queue of queries and sentinels in send order. Terminals
     * respond in order, so each flush() barrier only drains queries queued
     * before it — concurrent batches from independent callers stay isolated.
     */
    queue = [];
    constructor(stdout) {
        this.stdout = stdout;
    }
    /**
     * Send a query and wait for its response.
     *
     * Resolves with the response when `query.match` matches an incoming
     * TerminalResponse, or with `undefined` when a flush() sentinel arrives
     * before any matching response (meaning the terminal ignored the query).
     *
     * Never rejects; never times out on its own. If you never call flush()
     * and the terminal doesn't respond, the promise remains pending.
     */
    send(query) {
        return new Promise(resolve => {
            this.queue.push({
                kind: 'query',
                match: query.match,
                resolve: r => resolve(r),
            });
            this.stdout.write(query.request);
        });
    }
    /**
     * Send the DA1 sentinel. Resolves when DA1's response arrives.
     *
     * As a side effect, all queries still pending when DA1 arrives are
     * resolved with `undefined` (terminal didn't respond → doesn't support
     * the query). This is the barrier that makes send() timeout-free.
     *
     * Safe to call with no pending queries — still waits for a round-trip.
     */
    flush() {
        return new Promise(resolve => {
            this.queue.push({ kind: 'sentinel', resolve });
            this.stdout.write(SENTINEL);
        });
    }
    /**
     * Dispatch a response parsed from stdin. Called by App.tsx's
     * processKeysInBatch for every `kind: 'response'` item.
     *
     * Matching strategy:
     * - First, try to match a pending query (FIFO, first match wins).
     *   This lets callers send(da1()) explicitly if they want the DA1
     *   params — a separate DA1 write means the terminal sends TWO DA1
     *   responses. The first matches the explicit query; the second
     *   (unmatched) fires the sentinel.
     * - Otherwise, if this is a DA1, fire the FIRST pending sentinel:
     *   resolve any queries queued before that sentinel with undefined
     *   (the terminal answered DA1 without answering them → unsupported)
     *   and signal its flush() completion. Only draining up to the first
     *   sentinel keeps later batches intact when multiple callers have
     *   concurrent queries in flight.
     * - Unsolicited responses (no match, no sentinel) are silently dropped.
     */
    onResponse(r) {
        const idx = this.queue.findIndex(p => p.kind === 'query' && p.match(r));
        if (idx !== -1) {
            const [q] = this.queue.splice(idx, 1);
            if (q?.kind === 'query')
                q.resolve(r);
            return;
        }
        if (r.type === 'da1') {
            const s = this.queue.findIndex(p => p.kind === 'sentinel');
            if (s === -1)
                return;
            for (const p of this.queue.splice(0, s + 1)) {
                if (p.kind === 'query')
                    p.resolve(undefined);
                else
                    p.resolve();
            }
        }
    }
}
//# sourceMappingURL=terminal-querier.js.map