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
 * resume deliberately happens only AFTER the saved file is read back and the
 * temp dir is removed: resuming stdin earlier would let keystrokes typed
 * right at editor exit race the prompt's `setValue` and get overwritten.
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
 * scripts go through an explicit `cmd.exe /d /s /c` with a shell-quoted,
 * outer-quoted command line (the cross-spawn quoting pattern) — no
 * `shell: true` anywhere.
 */
/**
 * Outcome of one editor round-trip; the caller maps these to UI feedback:
 * - `edited`: the saved content differs from the draft — adopt `text`
 * - `unchanged`: the file matches the draft, or the editor exited non-zero
 *   (`:cq` abort semantics) — keep the draft
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
 * Edit `draft` in the user's editor and report what happened. Never throws:
 * every filesystem or spawn failure maps to a `failed` outcome so the UI
 * can notify instead of dying on an unhandled rejection.
 *
 * The Ink instance is looked up lazily (same pattern as Chat's Ctrl+L
 * redraw) so the util stays usable in tests and non-TTY contexts: without a
 * live instance the handover escapes are skipped and the editor simply
 * inherits stdio.
 *
 * Newline handling: a saved file identical to the draft is `unchanged`.
 * Otherwise ONE trailing newline is stripped when the draft did not end
 * with one — that is the terminating newline editors append on save, not
 * user content. Trailing blank lines the user actually added (or had in
 * the draft, e.g. from Shift+Enter) survive untouched.
 */
export declare function editInExternalEditor(draft: string): Promise<EditorOutcome>;
//# sourceMappingURL=externalEditor.d.ts.map