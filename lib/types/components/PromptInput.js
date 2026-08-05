import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text, useInput, useTerminalSize } from '../ui.js';
import { stringWidth } from '../ink/stringWidth.js';
import { filterCommands, isLocalCommandName } from '../commands.js';
import { appendHistory } from '../history.js';
import { CommandSuggestions } from './CommandSuggestions.js';
import { FileSuggestions } from './FileSuggestions.js';
import { HelpMenu } from './HelpMenu.js';
const HISTORY_LIMIT = 50;
/** Index of the word boundary at or before `cursor` (readline alt+b). */
function wordBoundaryLeft(text, cursor) {
    let index = cursor;
    while (index > 0 && /\s/.test(text[index - 1]))
        index--;
    while (index > 0 && !/\s/.test(text[index - 1]))
        index--;
    return index;
}
/** Index of the word boundary after `cursor` (readline alt+f). */
function wordBoundaryRight(text, cursor) {
    const length = text.length;
    let index = cursor;
    while (index < length && !/\s/.test(text[index]))
        index++;
    while (index < length && /\s/.test(text[index]))
        index++;
    return index;
}
/**
 * Idle placeholder in Claude Code's example-command style. CC generates a
 * context-aware example from git history; cc-tui picks one at random per
 * launch from the same spirit of prompts (stable for the process lifetime).
 */
const EXAMPLE_COMMANDS = [
    'Summarize the changes in this branch',
    'Explain the code in this repository',
    'Find and fix the bug in this project',
    'Write tests for the core module',
    'Review my recent changes',
    'What does this function do?',
    'Refactor this to be more maintainable',
    'Update the documentation',
    'Help me debug this error',
    'Add a feature to this project',
];
const PLACEHOLDER = EXAMPLE_COMMANDS[Math.floor(Math.random() * EXAMPLE_COMMANDS.length)] ??
    EXAMPLE_COMMANDS[0];
/** Max input rows before the visible viewport starts scrolling (CC's
 *  maxVisibleLines behavior — the box keeps a stable height). */
const MAX_VISIBLE_LINES = 5;
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
export function PromptInput({ channel, helpOpen, onToggleHelp, onRunCommand, selectionActive, fillText, onFillConsumed, onRewindRequest, }) {
    const [value, setValue] = React.useState('');
    const [cursor, setCursor] = React.useState(0);
    const [selectedCommand, setSelectedCommand] = React.useState(0);
    const history = React.useRef([]);
    const historyIndex = React.useRef(-1);
    // ctrl+r history fill: replace the input when a new fill arrives, then
    // tell the caller to clear it.
    const lastFill = React.useRef(null);
    React.useEffect(() => {
        if (fillText && fillText !== lastFill.current) {
            lastFill.current = fillText;
            setValue(fillText);
            setCursor(fillText.length);
            onFillConsumed?.();
        }
    }, [fillText, onFillConsumed]);
    // Double-tap Esc to clear (CC semantics).
    const escPendingRef = React.useRef(false);
    const escTimerRef = React.useRef(null);
    React.useEffect(() => {
        return () => {
            if (escTimerRef.current)
                clearTimeout(escTimerRef.current);
        };
    }, []);
    const { columns } = useTerminalSize();
    const suggestions = value.startsWith('/') ? filterCommands(value) : [];
    const overlayOpen = suggestions.length > 0 &&
        !helpOpen &&
        !selectionActive &&
        !value.includes('\n');
    // `@` file completion: load the cwd listing once when the trigger appears.
    const [fileList, setFileList] = React.useState([]);
    const [fileSelected, setFileSelected] = React.useState(0);
    const atTrigger = value.startsWith('@') && !value.includes('\n');
    React.useEffect(() => {
        if (atTrigger) {
            void channel.listFiles().then(setFileList);
        }
    }, [atTrigger, channel]);
    const atRest = value.replace(/^@/, '').toLowerCase();
    // Match the relative path prefix OR the basename (CC's IDE suggestions do
    // both): `@src/ink` and `@ink` both find `src/ink/Box.js`.
    const fileMatches = atTrigger
        ? fileList.filter(file => {
            const lower = file.toLowerCase();
            if (lower.startsWith(atRest))
                return true;
            if (atRest.includes('/'))
                return false;
            const base = lower.split('/').pop() ?? '';
            return base.startsWith(atRest);
        })
        : [];
    const fileOverlayOpen = fileMatches.length > 0 && !helpOpen && !selectionActive;
    const submitText = (text) => {
        const trimmed = text.trim();
        if (!trimmed)
            return;
        history.current.push(trimmed);
        if (history.current.length > HISTORY_LIMIT)
            history.current.shift();
        historyIndex.current = -1;
        setValue('');
        setCursor(0);
        setSelectedCommand(0);
        appendHistory(trimmed);
        channel.submit(trimmed);
    };
    /** Execute a local command when the input matches one exactly. */
    const tryRunCommand = (text) => {
        if (!text.startsWith('/'))
            return false;
        if (isLocalCommandName(text)) {
            const handled = onRunCommand(text.replace(/^\//, ''));
            if (handled) {
                history.current.push(text.trim());
                if (history.current.length > HISTORY_LIMIT)
                    history.current.shift();
                historyIndex.current = -1;
                setValue('');
                setCursor(0);
                setSelectedCommand(0);
                appendHistory(text.trim());
            }
            return handled;
        }
        return false;
    };
    const setInput = (next, cursorOffset = next.length) => {
        setValue(next);
        setCursor(Math.max(0, Math.min(cursorOffset, next.length)));
    };
    /** Line index of the cursor; -1 when the cursor is at the very end. */
    const cursorLine = () => {
        const before = value.slice(0, cursor);
        return before.split('\n').length - 1;
    };
    /** Column of the cursor within its line. */
    const cursorColumn = () => {
        const before = value.slice(0, cursor);
        const line = before.split('\n').pop() ?? '';
        return line.length;
    };
    useInput((input, key) => {
        if (selectionActive)
            return;
        // Whole-line input from Windows ConPTY pipelines (cmd batch -> node):
        // the trailing CR/LF marks a complete line to submit. A `/`-prefixed
        // line with a UNIQUE command match runs that command (the menu cannot
        // appear mid-line here, so the unique-match rule stands in for the
        // selected-command Enter semantics); ambiguous or unknown prefixes
        // flow through the normal path.
        if (input.includes('\n') || input.includes('\r')) {
            const line = (value + input).trim();
            if (line.startsWith('/')) {
                const matches = filterCommands(line);
                if (matches.length === 1) {
                    tryRunCommand(`/${matches[0].name}`);
                    return;
                }
            }
            if (!tryRunCommand(line))
                submitText(line);
            return;
        }
        if (key.return && key.shift) {
            // Insert a newline at the caret (multi-line input).
            const next = value.slice(0, cursor) + '\n' + value.slice(cursor);
            setValue(next);
            setCursor(cursor + 1);
            setSelectedCommand(0);
            return;
        }
        if (key.return) {
            // With the command menu open, Enter runs the SELECTED command (CC/pi
            // semantics) — never sends a partial `/mo` to the model.
            if (overlayOpen) {
                const command = suggestions[selectedCommand];
                if (command) {
                    tryRunCommand(`/${command.name}`);
                    return;
                }
            }
            if (!tryRunCommand(value))
                submitText(value);
            return;
        }
        if (key.tab && fileOverlayOpen) {
            const file = fileMatches[fileSelected];
            if (file)
                setInput(`@${file} `);
            return;
        }
        if (key.tab && overlayOpen) {
            const command = suggestions[selectedCommand];
            if (command)
                setInput(`/${command.name} `);
            return;
        }
        if (key.upArrow) {
            if (fileOverlayOpen) {
                setFileSelected(index => index <= 0 ? fileMatches.length - 1 : index - 1);
                return;
            }
            const line = cursorLine();
            if (line > 0) {
                // Move to the previous line, clamping to its length.
                const upToLineStart = value.lastIndexOf('\n', cursor - 1);
                const prevLineStart = upToLineStart === -1 ? 0 : value.lastIndexOf('\n', upToLineStart - 1) + 1;
                const prevLine = value.slice(prevLineStart, upToLineStart);
                setCursor(prevLineStart + Math.min(cursorColumn(), prevLine.length));
                return;
            }
            if (overlayOpen) {
                setSelectedCommand(index => index <= 0 ? suggestions.length - 1 : index - 1);
                return;
            }
            if (history.current.length === 0)
                return;
            historyIndex.current = historyIndex.current < 0
                ? history.current.length - 1
                : Math.max(0, historyIndex.current - 1);
            const entry = history.current[historyIndex.current] ?? '';
            setValue(entry);
            setCursor(entry.length);
            return;
        }
        if (key.downArrow) {
            if (fileOverlayOpen) {
                setFileSelected(index => index >= fileMatches.length - 1 ? 0 : index + 1);
                return;
            }
            const line = cursorLine();
            const lines = value.split('\n');
            if (line < lines.length - 1) {
                const nextLineStart = value.indexOf('\n', cursor) + 1;
                const nextLineEnd = value.indexOf('\n', nextLineStart);
                const nextLine = value.slice(nextLineStart, nextLineEnd === -1 ? value.length : nextLineEnd);
                setCursor(nextLineStart + Math.min(cursorColumn(), nextLine.length));
                return;
            }
            if (overlayOpen) {
                setSelectedCommand(index => index >= suggestions.length - 1 ? 0 : index + 1);
                return;
            }
            if (historyIndex.current < 0)
                return;
            historyIndex.current += 1;
            const entry = historyIndex.current >= history.current.length
                ? ''
                : (history.current[historyIndex.current] ?? '');
            setValue(entry);
            setCursor(entry.length);
            return;
        }
        if (key.leftArrow) {
            setCursor(previous => Math.max(0, previous - 1));
            return;
        }
        if (key.rightArrow) {
            setCursor(previous => Math.min(value.length, previous + 1));
            return;
        }
        if (key.ctrl && key.leftArrow) {
            // Jump to the previous word boundary (readline alt+b).
            setCursor(previous => wordBoundaryLeft(value, previous));
            return;
        }
        if (key.ctrl && key.rightArrow) {
            // Jump to the next word boundary (readline alt+f).
            setCursor(previous => wordBoundaryRight(value, previous));
            return;
        }
        if (key.backspace) {
            if (cursor === 0)
                return;
            setValue(value.slice(0, cursor - 1) + value.slice(cursor));
            setCursor(cursor - 1);
            return;
        }
        if (key.delete) {
            if (cursor >= value.length)
                return;
            setValue(value.slice(0, cursor) + value.slice(cursor + 1));
            return;
        }
        if (key.home) {
            // Start of the current line.
            const lineStart = value.lastIndexOf('\n', cursor - 1) + 1;
            setCursor(lineStart);
            return;
        }
        if (key.end) {
            // End of the current line.
            const nextLine = value.indexOf('\n', cursor);
            setCursor(nextLine === -1 ? value.length : nextLine);
            return;
        }
        if (key.ctrl && input === 'a') {
            const lineStart = value.lastIndexOf('\n', cursor - 1) + 1;
            setCursor(lineStart);
            return;
        }
        if (key.ctrl && input === 'e') {
            const nextLine = value.indexOf('\n', cursor);
            setCursor(nextLine === -1 ? value.length : nextLine);
            return;
        }
        if (key.ctrl && input === 'u') {
            // Delete to start of line.
            const lineStart = value.lastIndexOf('\n', cursor - 1) + 1;
            setValue(value.slice(0, lineStart) + value.slice(cursor));
            setCursor(lineStart);
            return;
        }
        if (key.ctrl && input === 'k') {
            // Delete to end of line.
            const nextLine = value.indexOf('\n', cursor);
            const end = nextLine === -1 ? value.length : nextLine;
            setValue(value.slice(0, cursor) + value.slice(end));
            return;
        }
        if (key.ctrl && input === 'w') {
            // Delete the word before the cursor (CC/readline behavior).
            const before = value.slice(0, cursor);
            const trimmed = before.replace(/\s+$/, '');
            const wordStart = trimmed.search(/\S\s*$/);
            const start = wordStart === -1 ? 0 : wordStart + 1;
            setValue(value.slice(0, start) + value.slice(cursor));
            setCursor(start);
            return;
        }
        if (key.escape) {
            if (helpOpen) {
                onToggleHelp();
                return;
            }
            // A single Esc closes the open command menu first (CC/pi behavior);
            // the double-tap-clear semantics only apply to ordinary input.
            if (overlayOpen || fileOverlayOpen) {
                setValue('');
                setCursor(0);
                setSelectedCommand(0);
                setFileSelected(0);
                return;
            }
            // Double-tap Esc: clear the input when it has content; when empty,
            // open the rewind picker (CC's "Double-tap esc to rewind the code
            // and/or conversation to a previous point in time").
            if (escPendingRef.current) {
                escPendingRef.current = false;
                if (escTimerRef.current)
                    clearTimeout(escTimerRef.current);
                if (value.length === 0) {
                    onRewindRequest?.();
                }
                else {
                    setValue('');
                    setCursor(0);
                }
                return;
            }
            escPendingRef.current = true;
            channel.notify(value.length === 0
                ? 'Press Esc again to rewind'
                : 'Press Esc again to clear');
            escTimerRef.current = setTimeout(() => {
                escPendingRef.current = false;
            }, 3000);
            return;
        }
        if (input === '?' && value.length === 0) {
            onToggleHelp();
            return;
        }
        if (input && !key.ctrl && !key.meta && !key.tab && !key.escape) {
            // Typing anything else dismisses the help menu (CC behavior).
            if (helpOpen)
                onToggleHelp();
            const next = value.slice(0, cursor) + input + value.slice(cursor);
            setValue(next);
            setCursor(cursor + input.length);
            setSelectedCommand(0);
            setFileSelected(0);
        }
    });
    // === Render: hard-wrap every logical line at the input width, then show
    // the window of visual lines with the caret row always visible (CC's
    // maxVisibleLines behavior with automatic wrapping).
    const inputWidth = Math.max(10, columns - 3);
    const visualLines = wrapToWidth(value, inputWidth);
    const caretVisualLine = wrapToWidth(value.slice(0, cursor), inputWidth).length - 1;
    const caretVisualCol = () => {
        const before = value.slice(0, cursor);
        const rows = wrapToWidth(before, inputWidth);
        const last = rows[rows.length - 1] ?? '';
        return last.length;
    };
    const windowStart = Math.max(0, Math.min(caretVisualLine - MAX_VISIBLE_LINES + 1, visualLines.length - MAX_VISIBLE_LINES));
    const visibleLines = visualLines.slice(windowStart, windowStart + MAX_VISIBLE_LINES);
    const rendered = visibleLines.map((line, index) => {
        const absoluteLine = windowStart + index;
        if (absoluteLine !== caretVisualLine) {
            return (_jsx(Text, { wrap: "truncate-end", children: line }, absoluteLine));
        }
        // Caret row: invert the char at the caret column (solid block).
        const col = caretVisualCol();
        const before = line.slice(0, col);
        const at = line[col] ?? ' ';
        const after = line.slice(col + 1);
        return (_jsxs(Text, { wrap: "truncate-end", children: [before, _jsx(Text, { inverse: true, children: at }), after] }, absoluteLine));
    });
    const lastNotification = channel.notifications[channel.notifications.length - 1];
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [lastNotification && (_jsx(Box, { position: "absolute", marginTop: -1, height: 1, width: "100%", paddingLeft: 2, paddingRight: 1, flexDirection: "column", justifyContent: "flex-end", overflow: "hidden", children: _jsx(Box, { justifyContent: "flex-end", children: _jsx(Text, { color: lastNotification.color, dimColor: !lastNotification.color, wrap: "truncate", children: lastNotification.text }) }) })), helpOpen && (_jsx(Box, { marginBottom: 1, children: _jsx(HelpMenu, {}) })), fileOverlayOpen && (_jsx(Box, { paddingLeft: 2, paddingBottom: 1, children: _jsx(FileSuggestions, { files: fileMatches, selectedIndex: fileSelected, columns: columns }) })), overlayOpen && (_jsx(Box, { paddingLeft: 2, paddingBottom: 1, children: _jsx(CommandSuggestions, { commands: suggestions, selectedIndex: selectedCommand, columns: columns }) })), _jsx(Box, { flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", borderColor: "promptBorder", borderStyle: "round", borderLeft: false, borderRight: false, borderBottom: true, width: "100%", children: _jsxs(Box, { flexDirection: "row", alignItems: "flex-start", width: "100%", children: [_jsx(Text, { dimColor: channel.working, children: "\u276F " }), _jsx(Box, { flexGrow: 1, flexShrink: 1, children: value.length === 0 ? (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { inverse: true, children: "H" }), _jsx(Text, { dimColor: true, children: PLACEHOLDER.slice(1) })] })) : (_jsx(Box, { flexDirection: "column", children: rendered })) })] }) })] }));
}
/**
 * Hard-wrap text into visual rows of at most `width` columns (CJK-aware via
 * stringWidth). Used by the input renderer so long lines wrap instead of
 * truncating, with exact caret-row mapping.
 */
function wrapToWidth(text, width) {
    const rows = [];
    for (const line of text.split('\n')) {
        if (line === '') {
            rows.push('');
            continue;
        }
        let current = '';
        let currentWidth = 0;
        for (const ch of line) {
            const w = stringWidth(ch);
            if (currentWidth + w > width && current !== '') {
                rows.push(current);
                current = ch;
                currentWidth = w;
            }
            else {
                current += ch;
                currentWidth += w;
            }
        }
        rows.push(current);
    }
    return rows;
}
