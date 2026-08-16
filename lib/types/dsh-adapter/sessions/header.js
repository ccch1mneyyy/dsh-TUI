/** A finite number, or undefined for anything else (NaN and ±Infinity included). */
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** A non-empty string, or undefined. */
function text(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Narrow one listed header.
 *
 * @param value - A header as the persistence service returned it.
 * @returns The fields this feature uses, or undefined when the value carries
 *   no usable session id — the one field nothing can substitute for.
 */
export function readHeader(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const record = value;
    const id = text(record['id']);
    if (id === undefined)
        return undefined;
    return {
        id,
        cwd: text(record['cwd']),
        createdAt: finiteNumber(record['createdAt']),
        parentSession: text(record['parentSession']),
        origin: text(record['origin']),
        delegationDepth: finiteNumber(record['delegationDepth']),
        seedLength: finiteNumber(record['seedLength']),
        agentPreset: text(record['agentPreset']),
    };
}
/**
 * Decide what a session is, from its header alone.
 *
 * Precedence is `origin` first, lineage second, and that order is the whole
 * correctness argument: a `/rewind` fork records `parentSession` exactly like
 * a delegated run does, and only `origin` separates them. Upstream documents
 * `origin` as "coarse product classification for a session created as a
 * subagent child … presentation metadata", which is precisely this decision.
 *
 * `delegationDepth` is optional upstream, so a sub-agent whose header omits it
 * is reported at depth 1: it is a delegated child by `origin`, and 1 is the
 * shallowest depth that can be.
 *
 * @param header - A narrowed header.
 * @returns The session's kind.
 */
export function classify(header) {
    if (header.origin === 'subagent') {
        return {
            kind: 'subagent',
            parent: header.parentSession,
            depth: header.delegationDepth ?? 1,
        };
    }
    if (header.parentSession !== undefined) {
        return { kind: 'fork', parent: header.parentSession };
    }
    return { kind: 'root' };
}
