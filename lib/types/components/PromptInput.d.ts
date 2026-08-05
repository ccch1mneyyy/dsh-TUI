import React from 'react';
import type { Channel } from '../channel.js';
export interface PromptInputProps {
    channel: Channel;
    /** Whether the `?` help menu is open (state lives in the Chat screen). */
    helpOpen: boolean;
    onToggleHelp(): void;
    /**
     * Execute a slash command (built-in or plugin-registered) with its raw
     * argument text; returns false when the input should be sent to the model.
     */
    onRunCommand(name: string, rawInput: string): boolean;
    /** Message-selection mode (Shift+↑): the input ignores keys while active. */
    selectionActive: boolean;
    /**
     * External fill from the ctrl+r history dialog: when this prop changes to
     * a non-null string, the input replaces its value and moves the caret to
     * the end. The caller clears it via onFillConsumed once consumed.
     */
    fillText?: string | null;
    onFillConsumed?(): void;
    /** Double-tap Esc with an empty input: open the rewind picker (CC rewind). */
    onRewindRequest?(): void;
}
/**
 * Claude Code style prompt input: rounded border box (top+bottom borders
 * only), `❯ ` prompt char (dimmed while a turn is working), the text with a
 * block cursor at the cursor position, and below it the slash-command
 * suggestion overlay (name column + description, selected row in the
 * `suggestion` color — ported from the leak's PromptInputFooterSuggestions).
 *
 * Multi-line: Shift+Enter inserts a newline; ↑/↓ move between lines while
 * the input spans multiple lines (history/command selection otherwise); the
 * visible window scrolls to keep the caret row on screen past
 * MAX_VISIBLE_LINES. Enter submits, backspace/delete edit, ←/→ move the
 * cursor, Tab completes the selected command, Escape clears (or closes the
 * help menu), `?` toggles the help menu. Windows ConPTY pipelines deliver
 * whole lines with the Enter key lost: a trailing CR/LF in the input marks
 * a complete line to submit.
 */
export declare function PromptInput({ channel, helpOpen, onToggleHelp, onRunCommand, selectionActive, fillText, onFillConsumed, onRewindRequest, }: PromptInputProps): React.JSX.Element;
//# sourceMappingURL=PromptInput.d.ts.map