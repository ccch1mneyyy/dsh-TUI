import React from 'react';
import type { Channel } from '../channel.js';
/**
 * Imperative handle for the Chat-level Ctrl+C rule: Chat's useInput listener
 * runs BEFORE this component's (EventEmitter registration order), so Chat
 * asks the prompt whether it holds text (→ clear it) or not (→ arm the
 * double-press exit). Populated every render; null while unmounted.
 */
export interface PromptController {
    hasText(): boolean;
    clear(): void;
}
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
    /** Filled with the live controller each render (see PromptController). */
    controllerRef?: React.RefObject<PromptController | null>;
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
 * Enter submits immediately even while the model is streaming — as a STEER
 * (Codex/pi semantics): the message is injected at the next step boundary
 * of the running turn and the agent continues without aborting; Tab instead
 * queues the message for after the turn (followup). Both appear in a
 * pending preview above the input until delivered. Alt+Up pulls the last
 * pending message back for editing; Esc (with pending messages while
 * working) interrupts the turn and delivers them right away; Ctrl+Enter
 * aborts the turn and sends the current input immediately.
 */
export declare function PromptInput({ channel, helpOpen, onToggleHelp, onRunCommand, selectionActive, fillText, onFillConsumed, onRewindRequest, controllerRef, }: PromptInputProps): React.JSX.Element;
//# sourceMappingURL=PromptInput.d.ts.map