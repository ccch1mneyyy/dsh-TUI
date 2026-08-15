/**
 * Upstream compatibility contract.
 *
 * The TUI is validated against one upstream release line (0.1.0-rc.6).
 * Every official package this adapter touches is blessed here; anything
 * else must go through upstream channels or the adapter, never the UI.
 *
 * `upstreamDrift()` powers both the boot-time warning (dev visibility) and
 * the CI gate (scripts/verify-upstream-contract.ts) so a mismatched
 * install fails in CI before it fails on a user's machine.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const UPSTREAM_VALIDATED_VERSION = '0.1.0-rc.6';
/**
 * Framework packages version on their own lines; the contract validates
 * their MAJOR (breaking surface), not the harness rc number.
 */
export const UPSTREAM_FRAMEWORK_MAJORS = {
    '@deepseek-ai/cordis': 4,
    '@deepseek-ai/schemastery': 3,
};
/** Official packages the adapter consumes at runtime or as types. */
export const UPSTREAM_BLESSED_PACKAGES = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-invariants',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-agent-presets',
    '@deepseek-ai/dsh-commands',
    '@deepseek-ai/dsh-cordis-host-runner',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-skill',
    '@deepseek-ai/dsh-storage',
    '@deepseek-ai/dsh-storage-domain',
    '@deepseek-ai/dsh-storage-json',
    '@deepseek-ai/dsh-workspace',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-terminal',
    '@deepseek-ai/dsh-terminal-bash',
    '@deepseek-ai/dsh-tool-ask-user',
    '@deepseek-ai/dsh-tool-bash-persistent',
    '@deepseek-ai/dsh-tool-cordis',
    '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-user-questions',
];
function resolvePackageJson(packageName) {
    try {
        const path = import.meta.resolve(`${packageName}/package.json`);
        return path.startsWith('file:') ? fileURLToPath(path) : path;
    }
    catch {
        return undefined;
    }
}
export function installedUpstreamVersions() {
    const result = {};
    for (const packageName of UPSTREAM_BLESSED_PACKAGES) {
        let version;
        const path = resolvePackageJson(packageName);
        if (path !== undefined) {
            try {
                const manifest = JSON.parse(readFileSync(path, 'utf8'));
                version = manifest.version;
            }
            catch {
                version = undefined;
            }
        }
        result[packageName] = version;
    }
    return result;
}
function rcNumber(version) {
    const match = /0\.1\.0-rc\.(\d+)/u.exec(version ?? '');
    return match === null ? undefined : Number(match[1]);
}
/**
 * Report every blessed package whose installed version is NOT the validated
 * release line. Empty array = the running install matches the contract.
 */
export function upstreamDrift() {
    const drift = [];
    for (const [packageName, installed] of Object.entries(installedUpstreamVersions())) {
        const expected = UPSTREAM_BLESSED_PACKAGES.includes(packageName);
        if (!expected)
            continue;
        let matches;
        const frameworkMajor = UPSTREAM_FRAMEWORK_MAJORS[packageName];
        if (frameworkMajor !== undefined) {
            const installedMajor = Number((installed ?? '').split('.')[0]);
            matches = installedMajor === frameworkMajor;
        }
        else {
            matches = rcNumber(installed) === rcNumber(UPSTREAM_VALIDATED_VERSION);
        }
        if (!matches) {
            drift.push({
                package: packageName,
                installed,
                validated: frameworkMajor !== undefined ? `major ${frameworkMajor}` : UPSTREAM_VALIDATED_VERSION,
            });
        }
    }
    return drift;
}
