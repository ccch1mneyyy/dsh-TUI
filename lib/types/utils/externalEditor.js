/**
 * External editor round-trip for the prompt input (issue #123): Ctrl+X dumps
 * the current draft into a temp file, hands the terminal to `$VISUAL` /
 * `$EDITOR` (nvim, vim, nano, `code --wait`, …), and returns the saved text
 * for the input to adopt.
 *
 * Terminal handover reuses the Ink core's editor handoff pair —
 * `enterAlternateScreen()` pauses rendering, suspends raw-mode stdin, and
 * drops the extended key reporting that non-CSI-u editors (nano) choke on;
 * `exitAlternateScreen()` re-enters the alt screen (vim's rmcup pops back to
 * the main screen on quit), repaints, and resumes stdin. See ink.tsx. The
 * saved file is read back BEFORE stdin is resumed: resuming earlier would
 * let keystrokes typed right at editor exit race the prompt's `setValue`
 * and get overwritten. The restore is attempted whenever the handover was
 * attempted (a partially-failed enter still gets an exit pass), and a
 * failing restore never overrides the outcome.
 *
 * Editor resolution order mirrors readline's edit-and-execute-command:
 * `$VISUAL` → `$EDITOR` → `vi` on POSIX (always present). Windows has no
 * console-editor guarantee and `notepad` does not block, so an unresolved
 * editor there reports `unavailable` and the UI asks the user to set
 * `$EDITOR`. The variable may carry arguments (`EDITOR="code --wait"`), so
 * the command line is split quote-aware before spawning.
 *
 * Windows launch: libuv resolves bare names to `.exe` on PATH but will NOT
 * execute `.cmd`/`.bat` shims (VS Code's `code` on PATH is `code.cmd`), and
 * `spawn(..., {shell: true})` with arguments triggers DEP0190 on Node 24+.
 * So bare commands are resolved against PATH/PATHEXT up front, and shim
 * scripts go through an explicit `$comspec /d /s /c` whose payload is built
 * with the cross-spawn quoting protocol (vendored in shellQuote.ts) and
 * passed with `windowsVerbatimArguments: true` — without verbatim, libuv
 * re-quotes the already-quoted payload and corrupts paths containing
 * spaces (a stock VS Code install path has them).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, win32 } from 'node:path';
import instances from '../ink/instances.js';
import { cmdEscapeArgument, cmdEscapeCommand } from './shellQuote.js';
/**
 * Split an `$EDITOR`-style command line into argv, honoring single/double
 * quotes (`code --wait`, `"C:\Program Files\...\nvim.exe" -f`).
 */
export function splitEditorCommand(commandLine) {
    const args = [];
    let current = '';
    let quote = null;
    let hasToken = false;
    for (const ch of commandLine) {
        if (quote !== null) {
            if (ch === quote)
                quote = null;
            else
                current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            hasToken = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current !== '' || hasToken)
                args.push(current);
            current = '';
            hasToken = false;
            continue;
        }
        current += ch;
    }
    if (current !== '' || hasToken)
        args.push(current);
    return args;
}
/**
 * Resolve the editor argv from the environment. `$VISUAL` wins over
 * `$EDITOR` (readline convention); POSIX falls back to `vi`, Windows has no
 * blocking console editor fallback and returns undefined. `platform` is a
 * parameter so the Windows branch is unit-testable from CI's Linux runners.
 */
export function resolveEditorCommand(env = process.env, platform = process.platform) {
    const raw = (env.VISUAL ?? '').trim() || (env.EDITOR ?? '').trim();
    if (raw !== '') {
        const args = splitEditorCommand(raw);
        return args.length > 0 ? args : undefined;
    }
    return platform === 'win32' ? undefined : ['vi'];
}
/**
 * Windows shim resolution: a bare command like `code` usually lives on PATH
 * as `code.cmd`, which libuv refuses to execute directly. Walk PATH with
 * PATHEXT (case-insensitive on Windows; both casings tried for tests on
 * case-sensitive filesystems) and report whether the resolved file needs
 * cmd.exe to run. Commands carrying an explicit extension are used as-is;
 * unresolved names fall back to the bare command (spawn then resolves
 * `.exe`, or fails into the `failed` outcome).
 */
export function resolveWindowsShim(command, env = process.env) {
    if (/\.[a-z0-9]+$/i.test(command)) {
        return { command, viaCmd: /\.(cmd|bat)$/i.test(command) };
    }
    const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map(ext => ext.trim())
        .filter(ext => ext !== '');
    const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
    for (const dir of pathValue.split(delimiter)) {
        if (dir === '')
            continue;
        for (const ext of extensions) {
            for (const casing of [ext, ext.toLowerCase()]) {
                const candidate = join(dir, command + casing);
                if (existsSync(candidate)) {
                    return { command: candidate, viaCmd: /\.(cmd|bat)$/i.test(candidate) };
                }
            }
        }
    }
    return { command, viaCmd: false };
}
/** npm-generated node shims re-invoke node, parsing the line a second time. */
const CMD_SHIM_RE = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
/**
 * Build the `comspec /d /s /c` spawn descriptor for a `.cmd`/`.bat` editor,
 * following the cross-spawn protocol: the command is normalized first
 * (explicit forward-slash paths like `C:/Program Files/.../code.cmd` must
 * become backslash form — cross-spawn's path.normalize step, without which
 * Windows can ENOENT), then command and arguments are escaped, joined, and
 * wrapped in one pair of quotes (`/s` strips exactly those), and passed
 * with `windowsVerbatimArguments` so libuv does not re-quote the payload.
 * Exported for tests — the assembly is pure.
 */
export function buildCmdExeSpawn(command, args, env = process.env) {
    const normalized = win32.normalize(command);
    const line = [
        cmdEscapeCommand(normalized),
        ...args.map(arg => cmdEscapeArgument(arg, CMD_SHIM_RE.test(normalized))),
    ].join(' ');
    return {
        // `||`, not `??`: a present-but-empty ComSpec must fall back too
        // (cross-spawn semantics); spawning an empty file name fails outright.
        file: env.comspec || 'cmd.exe',
        args: ['/d', '/s', '/c', `"${line}"`],
        verbatim: true,
    };
}
/**
 * Run the editor to completion with the terminal attached; resolves to the
 * exit code, or -1 when the process could not start — including a
 * SYNCHRONOUS spawn failure (e.g. an empty command string), which would
 * otherwise reject the promise and skip every cleanup step.
 */
function runEditor(argv, file) {
    return new Promise(resolve => {
        let settled = false;
        const finish = (code) => {
            if (settled)
                return;
            settled = true;
            resolve(code);
        };
        let child;
        try {
            if (process.platform === 'win32') {
                const shim = resolveWindowsShim(argv[0]);
                if (shim.viaCmd) {
                    const cmd = buildCmdExeSpawn(shim.command, [...argv.slice(1), file]);
                    child = spawn(cmd.file, cmd.args, {
                        stdio: 'inherit',
                        windowsVerbatimArguments: cmd.verbatim,
                    });
                }
                else {
                    child = spawn(shim.command, [...argv.slice(1), file], { stdio: 'inherit' });
                }
            }
            else {
                child = spawn(argv[0], [...argv.slice(1), file], { stdio: 'inherit' });
            }
        }
        catch {
            finish(-1);
            return;
        }
        child.once('error', () => finish(-1));
        child.once('close', code => finish(code ?? 1));
    });
}
/** Error text for the `failed` outcome, err.message when available. */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Edit `draft` in the user's editor and report what happened. Never throws:
 * every filesystem, spawn, or terminal-restore failure maps to a `failed`
 * outcome (or is swallowed in the finally) so the UI notifies instead of
 * dying on an unhandled rejection.
 *
 * The Ink instance is looked up lazily (same pattern as Chat's Ctrl+L
 * redraw) so the util stays usable in tests and non-TTY contexts: without a
 * live instance the handover escapes are skipped and the editor simply
 * inherits stdio.
 *
 * Newline handling: the saved file is compared against the draft with BOTH
 * sides CRLF-normalized, so an editor that only converts line endings (or
 * a draft that already carries `\r\n`) never counts as an edit. Otherwise
 * ONE trailing newline is stripped when the normalized draft did not end
 * with one — that is the terminating newline editors append on save, not
 * user content. Trailing blank lines the user actually added (or had in
 * the draft, e.g. from Shift+Enter) survive untouched.
 */
export async function editInExternalEditor(draft) {
    const argv = resolveEditorCommand();
    if (argv === undefined)
        return { kind: 'unavailable' };
    const ink = instances.get(process.stdout) ??
        // Test harnesses render onto a fake stdout — fall back to the process's
        // single live instance so the handover path stays exercisable there.
        (instances.size === 1 ? [...instances.values()][0] : undefined);
    let handed = false;
    let dir;
    try {
        dir = await mkdtemp(join(tmpdir(), 'dsh-tui-prompt-'));
        // .md so markdown-aware editors highlight the draft like a chat message.
        const file = join(dir, 'input.md');
        await writeFile(file, draft, 'utf8');
        // Mark the handover as attempted BEFORE entering: if enter fails after
        // suspending stdin, the finally must still run the restore pass.
        handed = ink !== undefined;
        ink?.enterAlternateScreen();
        const code = await runEditor(argv, file);
        // Read back BEFORE the finally resumes stdin — keystrokes typed the
        // moment the editor exits must not race the prompt adopting the result.
        const saved = await readFile(file, 'utf8').catch(() => null);
        if (code === -1)
            return { kind: 'failed', message: argv[0] };
        if (code !== 0 || saved === null)
            return { kind: 'unchanged' };
        const normalized = saved.replace(/\r\n/g, '\n');
        const draftNormalized = draft.replace(/\r\n/g, '\n');
        if (normalized === draftNormalized)
            return { kind: 'unchanged' };
        const text = !draftNormalized.endsWith('\n') && normalized.endsWith('\n')
            ? normalized.slice(0, -1)
            : normalized;
        return text === draftNormalized ? { kind: 'unchanged' } : { kind: 'edited', text };
    }
    catch (error) {
        return { kind: 'failed', message: errorMessage(error) };
    }
    finally {
        // Cleanup runs before the restore: when the finally ends, stdin must
        // come back to a fully settled state. Both steps are best-effort — a
        // failure here never overrides the outcome produced above.
        if (dir !== undefined) {
            await rm(dir, { recursive: true, force: true }).catch(() => { });
        }
        if (handed) {
            try {
                ink?.exitAlternateScreen();
            }
            catch {
                // A stuck alt screen is visible to the user; a rejection on top of
                // a valid outcome is strictly worse — swallow and keep the outcome.
            }
        }
    }
}
