import { jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from '../../ui.js';
import { t } from '../../i18n.js';
import { formatProject, formatWhen, kindLabel, truncateWidth, wrapWidth } from '../../sessions/format.js';
/** Role marker and colour for a preview entry. */
const ROLE = {
    user: { glyph: '❯', color: 'suggestion' },
    assistant: { glyph: '✦', color: 'claude' },
};
/**
 * The preview pane: what this session actually says.
 *
 * It shows the END of the conversation, not the beginning, for two reasons.
 * The title already carries the beginning — it is usually the first prompt —
 * so repeating it would spend the pane on something the list already said. And
 * the question a person asks at this moment is "is this the one I was in the
 * middle of", which only the last exchange answers.
 *
 * It is also the reason the pane costs nothing: the tail of a log is exactly
 * what a bounded read already has in hand, so opening the preview on a 4 MB
 * session is the same amount of work as on a 40 KB one.
 */
export function SessionPreview({ session, entries, loading, width, height, home, now, }) {
    const body = Math.max(8, width - 2);
    // The pane is a fixed-height box, so its content is laid out as a flat list
    // of lines and cut to fit. Letting several adaptive paragraphs share a fixed
    // box lets them overlap once their natural height exceeds it.
    const lines = [];
    let key = 0;
    const push = (node) => {
        lines.push(_jsx(Box, { flexShrink: 0, children: node }, key++));
    };
    push(_jsx(Text, { color: "remember", bold: true, children: truncateWidth(session.title.text, body) }));
    push(_jsx(Text, { dimColor: true, children: truncateWidth([kindLabel(session.kind), formatProject(session.cwd, home)].join(' · '), body) }));
    push(_jsx(Text, { dimColor: true, children: truncateWidth(t('session-preview-times', {
            created: formatWhen(session.createdAt, now),
            updated: formatWhen(session.updatedAt, now),
        }), body) }));
    push(_jsx(Text, { children: " " }));
    if (loading) {
        push(_jsx(Text, { dimColor: true, italic: true, children: t('session-preview-loading') }));
    }
    else if (entries.length === 0) {
        push(_jsx(Text, { dimColor: true, italic: true, children: t('session-preview-empty') }));
    }
    else {
        for (const entry of entries) {
            const role = ROLE[entry.role];
            const wrapped = wrapWidth(entry.text, body - 2);
            wrapped.forEach((line, index) => {
                push(_jsx(Text, { color: index === 0 ? role.color : undefined, dimColor: entry.role === 'assistant', children: `${index === 0 ? `${role.glyph} ` : '  '}${line}` }));
            });
            push(_jsx(Text, { children: " " }));
        }
    }
    // Keep the newest content: an overlong preview is cut at the TOP, so the
    // last thing said is always the last thing visible.
    const visible = lines.length > height ? lines.slice(lines.length - height) : lines;
    return (_jsx(Box, { flexDirection: "column", width: width, height: height, flexShrink: 0, paddingLeft: 2, children: visible }));
}
