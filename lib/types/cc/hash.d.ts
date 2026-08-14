/**
 * Compute the djb2 hash of a string: a fast non-cryptographic signed 32-bit hash.
 * Deterministic across runtimes, unlike runtime-specific hashes.
 * @param str - The string to hash.
 * @returns The signed 32-bit hash value.
 */
export declare function djb2Hash(str: string): number;
/**
 * Hash arbitrary content for change detection. Bun.hash is ~100x faster than
 * sha256 and collision-resistant enough for diff detection (not crypto-safe).
 * The original used `require('crypto')`; dsh-tui runs ESM so node:crypto is
 * imported statically and Bun.hash is skipped entirely.
 * @param content - The content to hash.
 * @returns The lowercase hex SHA-256 digest of `content`.
 */
export declare function hashContent(content: string): string;
/**
 * Hash two strings without allocating a concatenated temp string. Seed-chains
 * naturally disambiguate ("ts","code") vs ("tsc","ode") via the NUL separator.
 * @param a - The first string.
 * @param b - The second string.
 * @returns The lowercase hex SHA-256 digest of the NUL-separated pair.
 */
export declare function hashPair(a: string, b: string): string;
//# sourceMappingURL=hash.d.ts.map