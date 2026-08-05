/**
 * Local slash commands for the dsh-cc TUI. Claude Code's command system is
 * deeply wired into its engine; cc-tui ships a small built-in set with the
 * same `/name — description` suggestion chrome, and `runCommand` is the seam
 * where `ctx.commands` integration can land later.
 */
export const LOCAL_COMMANDS = [
    { name: 'clear', description: 'Clear the conversation' },
    { name: 'compact', description: 'Compact the conversation history' },
    { name: 'help', description: 'Show shortcuts and commands' },
    { name: 'model', description: 'Show the active model' },
    { name: 'thinking', description: 'Toggle extended thinking display' },
    { name: 'tokens', description: 'Show session token usage' },
    { name: 'resume', description: 'Resume a previous session' },
    { name: 'exit', description: 'Exit dsh-cc' },
];
/** Commands that must not be sent to the model when typed alone. */
export function isLocalCommandName(input) {
    // Trailing whitespace is legal (Tab completion leaves a space after the
    // name so the user can type arguments).
    const name = input.replace(/^\//, '').trim();
    return LOCAL_COMMANDS.some(command => command.name === name);
}
/** Filter commands by a `/…` input prefix (matches the CC overlay behavior). */
export function filterCommands(input) {
    const prefix = input.replace(/^\//, '').trim().toLowerCase();
    return LOCAL_COMMANDS.filter(command => command.name.toLowerCase().startsWith(prefix));
}
