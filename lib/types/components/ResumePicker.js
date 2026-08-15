import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from '../ui.js';
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js';
import { t, getLang } from '../i18n.js';
import { Pane } from './design-system/Pane.js';
import { ListItem } from './design-system/ListItem.js';
import { HintLine } from './design-system/HintLine.js';
import { SearchBox } from './SearchBox.js';
import { modLabel } from '../utils/modifiers.js';
/** Compact timestamp like `Jan 2, 03:04` (en) / `1月2日 03:04` (zh). */
function formatTimestamp(ms) {
    const date = new Date(ms);
    return date.toLocaleString(getLang() === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
}
/** Visible list window: the picker scrolls instead of dumping every session
 *  (long histories would fill the whole screen otherwise). */
const WINDOW = 8;
/**
 * `/resume` session picker in the CC ModelPicker style: a Pane with the
 * recent sessions as Select rows (title + time description, ✓ on the
 * current session), plus the hint line. Only WINDOW rows render; the window
 * follows the focused row, with `↑ N more` / `↓ N more` markers at the
 * edges.
 *
 * Beyond plain selection (pi-tui style session management, issue #112):
 *  - `confirm-delete` replaces the hints with a delete confirmation for the
 *    focused session (Enter deletes, Esc backs out);
 *  - `rename` shows an inline SearchBox editing the focused session's title
 *    (Enter saves, Esc discards).
 * Keyboard handling lives in the caller (Chat).
 */
export function ResumePicker({ sessions, focusIndex, currentSessionId, mode, renameText, }) {
    const isTerminalFocused = useTerminalFocus();
    const start = Math.max(0, Math.min(focusIndex - Math.floor(WINDOW / 2), sessions.length - WINDOW));
    const visible = sessions.slice(start, start + WINDOW);
    const above = start;
    const below = Math.max(0, sessions.length - (start + WINDOW));
    const focused = sessions[focusIndex];
    return (_jsxs(Pane, { color: "permission", children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: t('resume-title') }) }), above > 0 && (_jsx(Text, { dimColor: true, italic: true, children: t('resume-more-above', { n: above }) })), visible.map(session => (_jsx(ListItem, { isFocused: session.id === sessions[focusIndex]?.id, isSelected: session.id === currentSessionId, description: formatTimestamp(session.updatedAt), children: session.title || session.id }, session.id))), below > 0 && (_jsx(Text, { dimColor: true, italic: true, children: t('resume-more-below', { n: below }) })), mode === 'confirm-delete' && focused !== undefined && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "error", children: t('resume-delete-confirm', { name: focused.title || focused.id }) }) })), mode === 'rename' && (_jsx(Box, { marginTop: 1, children: _jsx(SearchBox, { query: renameText, isFocused: true, isTerminalFocused: isTerminalFocused, placeholder: t('resume-rename-placeholder'), prefix: "\u270E", borderless: true }) }))] }), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: mode === 'list'
                        ? t('resume-hint-list', { mod: modLabel })
                        : mode === 'confirm-delete'
                            ? t('resume-hint-delete')
                            : t('resume-hint-rename') }) })] }));
}
