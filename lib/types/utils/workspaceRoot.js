/**
 * Session working-directory resolution (issue #96, bug 2).
 *
 * The bare `process.cwd()` default made `@` file completion, mention
 * expansion, and the statusline all relative to wherever `dsh` happened to
 * be launched — launching from a repo SUBDIRECTORY listed that subdirectory
 * instead of the repository the user is working in. The default now walks
 * up from the launch directory to the nearest git worktree root (the
 * workspace a coding agent is expected to operate on, Codex-style), falling
 * back to the launch directory itself outside any worktree. An explicit
 * cordis.yml `cwd` always wins.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
/**
 * Resolve the session cwd: an explicit `configured` value wins (resolved
 * against the launch directory); otherwise the nearest ancestor of `start`
 * containing a `.git` entry — a DIRECTORY for a plain clone, a FILE for a
 * linked worktree or submodule — and `start` itself when no worktree
 * encloses it.
 */
export function resolveSessionCwd(configured, start = process.cwd()) {
    if (configured !== undefined && configured !== '')
        return resolve(configured);
    return gitWorktreeRoot(start) ?? start;
}
/** Nearest ancestor of `start` (itself included) that is a git worktree root. */
function gitWorktreeRoot(start) {
    let dir = resolve(start);
    const home = homedir();
    for (;;) {
        // Dotfiles guard: a ~/.git (dotfiles management repo) must NOT promote
        // the whole home directory to the workspace — /resume would list every
        // session ever recorded under $HOME and @ completion would widen just
        // as far. Stop the climb at home entirely: a worktree above $HOME is
        // never a sensible session root either (review leftover).
        if (dir === home)
            return undefined;
        if (existsSync(join(dir, '.git')))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
