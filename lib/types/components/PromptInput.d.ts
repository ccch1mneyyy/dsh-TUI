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
 * Empty input: a solid block caret on a blank cell and nothing else — no
 * placeholder text, so the terminal-painted IME preedit (pinyin) at the
 * parked cursor can never be overlaid on anything.
 *
 * Multi-line: Shift+Enter inserts a newline; ↑/↓ move between lines while
 * the input spans multiple lines (history/command selection otherwise); the
 * visible window scrolls to keep the caret row on screen past
 * MAX_VISIBLE_LINES. Enter submits, backspace/delete edit, ←/→ move the
 * cursor, Tab completes the selected command, Escape clears (or closes the
 * help menu), `?` toggles the help menu. Windows ConPTY pipelines deliver
 * whole lines with the Enter key lost: a trailing CR/LF in the input marks
 * a complete line to submit.
 *
 * While the model is working, Enter does NOT submit: it stages the text into
 * a pending queue above the input (visible, cancellable with Esc), and a
 * second Enter on the empty input formally sends the queue. Sent messages
 * go through channel.submit → agent.followup, which is DSH's `next-turn`
 * inbox semantics — the running turn finishes first, then queued messages
 * are processed in order, so the model is never cut off mid-response.
 */
export declare function PromptInput({ channel, helpOpen, onToggleHelp, onRunCommand, selectionActive, fillText, onFillConsumed, onRewindRequest, }: PromptInputProps): React.JSX.Element;
//# sourceMappingURL=PromptInput.d.ts.map