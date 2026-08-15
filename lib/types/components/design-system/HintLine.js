import { Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
import Text from '../../ink/components/Text.js';
/**
 * Localized shortcut-hint line: renders a `t('hint-*')` string, with the
 * `**primary shortcut**` segment (the main action's key, wrapped in `**` in
 * the dict) in bold — the visual hierarchy KeyboardShortcutHint's `bold`
 * prop used to give. Wrap in `<Text dimColor italic>` for the common dim
 * styling, like the Byline it replaces.
 */
export function HintLine({ text }) {
    const parts = text.split('**');
    if (parts.length < 3)
        return _jsx(_Fragment, { children: text });
    return (_jsx(_Fragment, { children: parts.map((part, index) => index % 2 === 1 ? _jsx(Text, { bold: true, children: part }, index) : part) }));
}
