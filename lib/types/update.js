import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gt, valid } from 'semver';
import { shellQuote } from './utils/shellQuote.js';
// Re-exported for scripts/verify-update.mjs and the bin launcher, which reads
// the compiled copy at lib/types/utils/shellQuote.js.
export { shellQuote };
const PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const UPDATE_CHECK_TIMEOUT_MS = 4000;
/** env marker set on the /update restart; the new process verifies it at boot. */
const UPDATED_FROM_ENV = 'DSH_TUI_UPDATED_FROM';
/** Read the version from either the compiled package or the source checkout. */
export function installedTuiVersion() {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const relativePath of ['../../package.json', '../package.json']) {
        try {
            const parsed = JSON.parse(readFileSync(join(here, relativePath), 'utf8'));
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const packageJson = parsed;
                const version = packageJson.version;
                if (packageJson.name === PACKAGE_NAME && typeof version === 'string' && valid(version) !== null) {
                    return version;
                }
            }
        }
        catch {
            // Try the source-layout fallback after the compiled-layout path.
        }
    }
    return undefined;
}
/**
 * The profile this TUI was booted with (`dsh --profile <name>`), read from
 * the launcher argv the process inherited. dsh sets no profile env var, and
 * its launcher parses its own flags first, so the first `--profile` token in
 * argv is the launcher's. Undefined for non-profile launches (source
 * checkouts, `--config` overlays) — there is no profile installation for
 * `/update` to act on, so the command must stay disabled there.
 */
export function resolveDshProfileName(argv = process.argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--profile') {
            const value = argv[i + 1];
            return value !== undefined && value !== '' && !value.startsWith('-') ? value : undefined;
        }
        if (arg.startsWith('--profile=')) {
            const value = arg.slice('--profile='.length);
            return value !== '' ? value : undefined;
        }
    }
    return undefined;
}
/**
 * Resolve the registry base URL the way npm/pnpm would: `NPM_CONFIG_REGISTRY`
 * (both spellings) over the `registry=` line in ~/.npmrc over npmjs.org, so
 * mirror users see the same `latest` their package manager would install.
 */
export function resolveRegistryBase() {
    const fromEnv = process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry;
    if (fromEnv !== undefined && fromEnv !== '')
        return fromEnv.replace(/\/+$/, '');
    try {
        const npmrc = readFileSync(join(homedir(), '.npmrc'), 'utf8');
        const match = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(npmrc);
        if (match !== null)
            return match[1].replace(/\/+$/, '');
    }
    catch {
        // No readable user .npmrc — the default registry applies.
    }
    return DEFAULT_REGISTRY;
}
/** True when `current` is a strictly newer valid version than `previous`. */
export function isVersionNewer(current, previous) {
    const a = valid(current);
    const b = valid(previous);
    return a !== null && b !== null && gt(a, b);
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Fetch `latest` from the configured registry; undefined on any failure. */
async function fetchLatestVersion() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
    try {
        const response = await fetch(`${resolveRegistryBase()}/${PACKAGE_NAME}/latest`, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
        });
        if (!response.ok)
            return undefined;
        const payload = await response.json();
        const latest = isRecord(payload) && typeof payload.version === 'string'
            ? valid(payload.version)
            : null;
        return latest ?? undefined;
    }
    catch {
        return undefined;
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * Classify this install against a fresh registry lookup: an update is
 * available, the install is already latest, or the answer is unknown
 * (offline / registry error / unreadable own version).
 */
export async function resolveTuiUpdateTarget() {
    const current = installedTuiVersion();
    const currentVersion = current === undefined ? null : valid(current);
    if (currentVersion === null)
        return { kind: 'unknown' };
    const latest = await fetchLatestVersion();
    if (latest === undefined)
        return { kind: 'unknown' };
    if (!gt(latest, currentVersion))
        return { kind: 'latest', current: currentVersion };
    return { kind: 'update', current: currentVersion, latest };
}
/**
 * Check npm for a newer published TUI version. Network and registry errors
 * are intentionally treated as "no result" so an offline launch never delays
 * or blocks the interactive TUI.
 */
export async function checkForTuiUpdate() {
    const target = await resolveTuiUpdateTarget();
    return target.kind === 'update' ? { current: target.current, latest: target.latest } : undefined;
}
/**
 * Run a child process with its output attached to the user's terminal. The
 * shell is opt-in per call: `dsh.cmd` needs it, but the node restart must
 * never go through cmd.exe — the standard install path
 * `C:\Program Files\nodejs\node.exe` splits on the space and the replacement
 * process never starts, leaving an updated package and a dead TUI.
 */
function runProcess(command, args, options = {}) {
    return new Promise(resolve => {
        let settled = false;
        const useShell = options.shell === true && process.platform === 'win32';
        const child = spawn(command, useShell ? shellQuote(args) : args, {
            env: options.env,
            stdio: 'inherit',
            shell: useShell,
        });
        const finish = (code) => {
            if (settled)
                return;
            settled = true;
            resolve(code);
        };
        child.once('error', error => {
            process.stderr.write(`dsh-tui: failed to run ${command}: ${error.message}\n`);
            finish(127);
        });
        child.once('close', code => finish(code ?? 1));
    });
}
/**
 * Update the installed dsh-tui package and restart the same launcher while
 * preserving the active session. The TUI must already be unmounted before
 * this is called so pnpm output cannot corrupt the rendered terminal frame.
 *
 * `--latest` is required: `pnpm add` writes a caret range into the profile
 * manifest, and a plain `pnpm update` stays inside that range — with this
 * project's minor-per-release cadence the TUI would restart unchanged while
 * reporting success. The restart carries `DSH_TUI_UPDATED_FROM` so the new
 * process can warn when the version did not actually move (e.g. a mirror
 * registry still serving the old `latest`).
 *
 * @param sessionId - Session to resume in the replacement process.
 * @param profile - The dsh profile this TUI was launched with; updating any
 *   other profile would leave the running install untouched.
 * @returns Exit codes for the update run and the replacement process.
 */
export async function updateTuiAndRestart(sessionId, profile) {
    const dsh = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
    const updateCode = await runProcess(dsh, [
        'plugin',
        '--profile',
        profile,
        'update',
        '--latest',
        PACKAGE_NAME,
    ], { shell: true });
    if (updateCode !== 0)
        return { updateCode, restartCode: updateCode };
    const restartCode = await runProcess(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        env: {
            ...process.env,
            // Dual-write the resume contract (issue #120): the cordis layer of a
            // still-old TUI build reads only DSH_CC_RESUME_SESSION.
            DSH_TUI_RESUME_SESSION: sessionId,
            DSH_CC_RESUME_SESSION: sessionId,
            [UPDATED_FROM_ENV]: installedTuiVersion() ?? '',
        },
    });
    return { updateCode, restartCode };
}
