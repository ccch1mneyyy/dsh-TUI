/**
 * Minimal semver `>=` comparison for the ported Ink core (ink/terminal.ts
 * gates hyperlink support on TERM_PROGRAM_VERSION).
 * @param a - First version string (optional `v` prefix and pre-release suffix tolerated).
 * @param b - Second version string.
 * @returns True when `a` is greater than or equal to `b`.
 */
export function gte(a, b) {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i])
            return pa[i] > pb[i];
    }
    return true;
}
function parts(version) {
    const [major = 0, minor = 0, patch = 0] = version
        .replace(/^v/, '')
        .split('-')[0]
        .split('.')
        .map(part => Number.parseInt(part, 10) || 0);
    return [major, minor, patch];
}
