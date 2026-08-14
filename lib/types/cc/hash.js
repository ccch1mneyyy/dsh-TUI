/**
 * djb2 string hash — fast non-cryptographic hash returning a signed 32-bit int.
 * Deterministic across runtimes (unlike Bun.hash which uses wyhash). Use as a
 * fallback when Bun.hash isn't available, or when you need on-disk-stable
 * output (e.g. cache directory names that must survive runtime upgrades).
 */
import { createHash } from 'node:crypto';
/**
 * Compute the djb2 hash of a string: a fast non-cryptographic signed 32-bit hash.
 * Deterministic across runtimes, unlike runtime-specific hashes.
 * @param str - The string to hash.
 * @returns The signed 32-bit hash value.
 */
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
 * The original used `require('crypto')`; dsh-tui runs ESM so node:crypto is
 * imported statically and Bun.hash is skipped entirely.
 * @param content - The content to hash.
 * @returns The lowercase hex SHA-256 digest of `content`.
 */
export function hashContent(content) {
    return createHash('sha256').update(content).digest('hex');
}
/**
 * Hash two strings without allocating a concatenated temp string. Seed-chains
 * naturally disambiguate ("ts","code") vs ("tsc","ode") via the NUL separator.
 * @param a - The first string.
 * @param b - The second string.
 * @returns The lowercase hex SHA-256 digest of the NUL-separated pair.
 */
export function hashPair(a, b) {
    return createHash('sha256').update(a).update('\0').update(b).digest('hex');
}
