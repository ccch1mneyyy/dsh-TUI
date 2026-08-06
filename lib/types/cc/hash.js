/**
 * djb2 string hash — fast non-cryptographic hash returning a signed 32-bit int.
 * Deterministic across runtimes (unlike Bun.hash which uses wyhash). Use as a
 * fallback when Bun.hash isn't available, or when you need on-disk-stable
 * output (e.g. cache directory names that must survive runtime upgrades).
 */
import { createHash } from 'node:crypto';
export function djb2Hash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
}
/**
 * Hash arbitrary content for change detection. Bun.hash is ~100x faster than
 * sha256 and collision-resistant enough for diff detection (not crypto-safe).
 * The original used `require('crypto')`; cc-tui runs ESM so node:crypto is
 * imported statically and Bun.hash is skipped entirely.
 */
export function hashContent(content) {
    return createHash('sha256').update(content).digest('hex');
}
/**
 * Hash two strings without allocating a concatenated temp string. Seed-chains
 * naturally disambiguate ("ts","code") vs ("tsc","ode") via the NUL separator.
 */
export function hashPair(a, b) {
    return createHash('sha256').update(a).update('\0').update(b).digest('hex');
}
//# sourceMappingURL=hash.js.map