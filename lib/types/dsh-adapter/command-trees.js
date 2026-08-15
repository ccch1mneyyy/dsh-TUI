/** Provider-neutral subcommand completion registry for terminal front doors. */
import { Service } from '@deepseek-ai/cordis';
export const name = 'dsh-tui-command-trees';
/** Small host-only registry; command execution remains owned by dsh-commands. */
export class TuiCommandTreeRuntime extends Service {
    providers = new Map();
    constructor(ctx) {
        super(ctx, 'tuiCommandTrees');
    }
    register(provider) {
        const root = provider.root.trim().toLowerCase();
        if (!/^[a-z][a-z0-9_-]*$/u.test(root))
            throw new TypeError(`invalid TUI command-tree root: ${provider.root}`);
        if (this.providers.has(root))
            throw new Error(`TUI command-tree root "${root}" is already registered`);
        const normalized = { ...provider, root };
        this.providers.set(root, normalized);
        return () => {
            if (this.providers.get(root) === normalized)
                this.providers.delete(root);
        };
    }
    children(canonicalPath) {
        const root = canonicalPath[0]?.toLowerCase();
        if (root === undefined)
            return [];
        const provider = this.providers.get(root);
        if (provider === undefined)
            return [];
        try {
            return provider.children(canonicalPath);
        }
        catch {
            // Completion is optional UI metadata and must never block execution.
            return [];
        }
    }
    descriptions(root) {
        return this.providers.get(root.trim().toLowerCase())?.descriptions;
    }
}
export default TuiCommandTreeRuntime;
