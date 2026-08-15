/**
 * Find or create the Workspace for `cwd`, then durably account `sessionId`.
 *
 * The service is optional for bare/custom compositions. Returning `false`
 * lets those deployments retain their pre-workspace behavior; the shipped
 * profile mounts the same storage/workspace stack as Web and therefore always
 * takes the durable attach path.
 */
export async function attachSessionToWorkspace(ctx, cwd, sessionId) {
    const registry = ctx.get('workspaceRegistry');
    if (registry === undefined)
        return false;
    const workspace = await registry.resolveByPath(cwd) ?? await registry.create(cwd);
    await workspace.attachSession(sessionId);
    return true;
}
