/**
 * Minimal terminal-environment shim for the ported Ink core. The original
 * module computed a richer `env` object from the Claude Code app context; the
 * Ink core only reads `env.terminal` (termio/osc.ts chooses the OSC terminator
 * for Kitty).
 */
export const env = {
    terminal: (process.env.TERM_PROGRAM ?? process.env.TERM ?? 'unknown').toLowerCase(),
};
