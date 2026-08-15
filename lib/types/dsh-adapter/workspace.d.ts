/**
 * Workspace-ledger integration shared by every TUI session entry path.
 *
 * A Session header's cwd is only a membership prerequisite. Web grouping is
 * owned by the durable WorkspaceRegistry account, so a newly created Session
 * must be attached after `agents.create()` succeeds. Resuming also attaches
 * idempotently, which migrates sessions written by older TUI versions.
 *
 * @module @deepseek-harness-tui/dsh-tui/workspace
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
/**
 * Find or create the Workspace for `cwd`, then durably account `sessionId`.
 *
 * The service is optional for bare/custom compositions. Returning `false`
 * lets those deployments retain their pre-workspace behavior; the shipped
 * profile mounts the same storage/workspace stack as Web and therefore always
 * takes the durable attach path.
 */
export declare function attachSessionToWorkspace(ctx: Context, cwd: string, sessionId: SessionId): Promise<boolean>;
//# sourceMappingURL=workspace.d.ts.map