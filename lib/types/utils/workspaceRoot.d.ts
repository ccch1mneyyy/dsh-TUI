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
/**
 * Resolve the session cwd: an explicit `configured` value wins (resolved
 * against the launch directory); otherwise the nearest ancestor of `start`
 * containing a `.git` entry — a DIRECTORY for a plain clone, a FILE for a
 * linked worktree or submodule — and `start` itself when no worktree
 * encloses it.
 */
export declare function resolveSessionCwd(configured: string | undefined, start?: string): string;
//# sourceMappingURL=workspaceRoot.d.ts.map