/**
 * Minimal terminal-environment shim for the ported Ink core. The original
 * module computed a richer `env` object from the Claude Code app context; the
 * Ink core only reads `env.terminal` (termio/osc.ts chooses the OSC terminator
 * for Kitty).
 */
export declare const env: {
    readonly terminal: string;
};
//# sourceMappingURL=env.d.ts.map