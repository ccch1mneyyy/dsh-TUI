import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { t } from '../i18n.js';
import { Box, Text } from '../ui.js';
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js';
import { Pane } from './design-system/Pane.js';
import { ListItem } from './design-system/ListItem.js';
import { HintLine } from './design-system/HintLine.js';
import { SearchBox } from './SearchBox.js';
import { historyEntryId } from '../history.js';
/**
 * The ctrl+r history search dialog, in the shape of the leak's
 * HistorySearchDialog/FuzzyPicker: a permission-colored Pane with a bold
 * title, the ⌕ SearchBox, the filtered history as ListItem rows (newest
 * first), and the ↑/↓ · Enter · Esc hint line. Keyboard handling lives in
 * the caller (Chat).
 */
export function HistorySearchDialog({ query, cursorOffset, matches, focusIndex, }) {
    const isTerminalFocused = useTerminalFocus();
    return (_jsx(Pane, { color: "permission", children: _jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { bold: true, color: "permission", children: t('history-search-title') }), _jsx(SearchBox, { query: query, cursorOffset: cursorOffset, isFocused: true, isTerminalFocused: isTerminalFocused, placeholder: t('history-search-placeholder') }), matches.length === 0 ? (_jsx(Text, { dimColor: true, children: t('history-search-empty') })) : (matches.map((entry, index) => (_jsx(ListItem, { isFocused: index === focusIndex, description: formatRelativeAge(entry.ts), children: entry.text }, historyEntryId(entry))))), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: t('hint-history-search') }) })] }) }));
}
/** Relative age like CC's formatRelativeTimeAgo ("now" / "5m ago" / …), localized. */
function formatRelativeAge(ts) {
    const elapsed = Date.now() - ts;
    if (elapsed < 60_000)
        return t('time-now');
    if (elapsed < 3_600_000)
        return t('time-minutes-ago', { n: Math.floor(elapsed / 60_000) });
    if (elapsed < 86_400_000)
        return t('time-hours-ago', { n: Math.floor(elapsed / 3_600_000) });
    return t('time-days-ago', { n: Math.floor(elapsed / 86_400_000) });
}
