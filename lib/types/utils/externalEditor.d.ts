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
/**
 * Outcome of one editor round-trip; the caller maps these to UI feedback:
 * - `edited`: the saved content differs from the draft — adopt `text`
 * - `unchanged`: the file matches the draft (modulo newline convention), or
 *   the editor exited non-zero (`:cq` abort semantics) — keep the draft
 * - `unavailable`: no editor could be resolved (Windows without `$EDITOR`)
 * - `failed`: the editor process or the temp-file round-trip errored
 *   (`message` names the failed command or carries the fs error)
 */
export type EditorOutcome = {
    kind: 'edited';
    text: string;
} | {
    kind: 'unchanged';
} | {
    kind: 'unavailable';
} | {
    kind: 'failed';
    message: string;
};
/**
 * Split an `$EDITOR`-style command line into argv, honoring single/double
 * quotes (`code --wait`, `"C:\Program Files\...\nvim.exe" -f`).
 */
export declare function splitEditorCommand(commandLine: string): string[];
/**
 * Resolve the editor argv from the environment. `$VISUAL` wins over
 * `$EDITOR` (readline convention); POSIX falls back to `vi`, Windows has no
 * blocking console editor fallback and returns undefined. `platform` is a
 * parameter so the Windows branch is unit-testable from CI's Linux runners.
 */
export declare function resolveEditorCommand(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[] | undefined;
/**
 * Windows shim resolution: a bare command like `code` usually lives on PATH
 * as `code.cmd`, which libuv refuses to execute directly. Walk PATH with
 * PATHEXT (case-insensitive on Windows; both casings tried for tests on
 * case-sensitive filesystems) and report whether the resolved file needs
 * cmd.exe to run. Commands carrying an explicit extension are used as-is;
 * unresolved names fall back to the bare command (spawn then resolves
 * `.exe`, or fails into the `failed` outcome).
 */
export declare function resolveWindowsShim(command: string, env?: NodeJS.ProcessEnv): {
    command: string;
    viaCmd: boolean;
};
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
export declare function buildCmdExeSpawn(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): {
    file: string;
    args: string[];
    verbatim: true;
};
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
export declare function editInExternalEditor(draft: string): Promise<EditorOutcome>;
//# sourceMappingURL=externalEditor.d.ts.map