/**
 * External editor round-trip for the prompt input (issue #123): Ctrl+X dumps
 * the current draft into a temp file, hands the terminal to `$VISUAL` /
 * `$EDITOR` (nvim, vim, nano, `code --wait`, …), and returns the saved text
 * for the input to adopt.
 *
 * Terminal handover reuses the Ink core's editor handoff pair —
 * `enterAlternateScreen()` pauses rendering, suspends raw-mode stdin, and
 * drops the extended key reporting that non-C SI-u editors (nano) choke on;
 * `exitAlternateScreen()` re-enters the alt screen (vim's rmcup pops back to
 * the main screen on quit), repaints, and resumes stdin. See ink.tsx.
 *
 * Editor resolution order mirrors readline's edit-and-execute-command:
 * `$VISUAL` → `$EDITOR` → `vi` on POSIX (always present). Windows has no
 * console-editor guarantee and `notepad` does not block, so an unresolved
 * editor there reports `unavailable` and the UI asks the user to set
 * `$EDITOR`. The variable may carry arguments (`EDITOR="code --wait"`), so
 * the command line is split quote-aware before spawning.
 */
/** Outcome of one editor round-trip; the caller maps these to UI feedback. */
export type EditorOutcome = 
/** The saved content differs from the draft — adopt `text`. */
{
    kind: 'edited';
    text: string;
}
/** Unchanged, emptied-file kept as-is, or a non-zero exit (`:cq`) — keep the draft. */
 | {
    kind: 'unchanged';
}
/** No editor could be resolved (Windows without `$EDITOR`). */
 | {
    kind: 'unavailable';
}
/** The editor process failed to start. */
 | {
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
 * blocking console editor fallback and returns undefined.
 */
export declare function resolveEditorCommand(env?: NodeJS.ProcessEnv): string[] | undefined;
/**
 * Edit `draft` in the user's editor and report what happened. The Ink
 * instance is looked up lazily (same pattern as Chat's Ctrl+L redraw) so the
 * util stays usable in tests and non-TTY contexts: without a live instance
 * the handover escapes are skipped and the editor simply inherits stdio.
 *
 * A trailing newline the editor appends on save is stripped; trailing
 * whitespace-only tail beyond that is left to the user. Saving the file
 * unchanged (or quitting without saving) keeps the caller's draft.
 */
export declare function editInExternalEditor(draft: string): Promise<EditorOutcome>;
//# sourceMappingURL=externalEditor.d.ts.map