import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { t } from '../i18n.js';
import { Box, Text } from '../ui.js';
import { summarizeLoadedContext, truncateContextText } from '../utils/loaded-context.js';
/** One named entry (section or dynamic context) with its full text. */
function Entry({ entry }) {
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: entry.name }), _jsx(Text, { dimColor: true, wrap: "wrap", children: truncateContextText(entry.text) })] }));
}
/** A titled group of rows inside the expanded panel. */
function Group({ title, children }) {
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { bold: true, color: "subtle", children: title }), _jsx(Box, { flexDirection: "column", paddingLeft: 2, children: children })] }));
}
/**
 * The startup context panel: a collapsed one-line summary of what a
 * fresh conversation will load for the current agent (system prompt
 * sections, workspace instruction files, dynamic context, skill catalog,
 * tools). Toggle with Ctrl+T (see HelpMenu; the ported ink core has no
 * mouse-click handling, so the header is not clickable); the panel renders
 * only while the transcript is still empty — the first message's rows take
 * over. Renders nothing for an empty snapshot.
 * @param context - the channel's loaded-context snapshot.
 * @param open - whether the grouped details are shown.
 * @param onToggle - flips `open`; fired by the Ctrl+T keybinding.
 */
export function LoadedContextPanel({ context, open, onToggle, }) {
    const summary = summarizeLoadedContext(context);
    if (summary === '')
        return null;
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, marginBottom: 1, children: [_jsxs(Box, { paddingX: 1, backgroundColor: open ? 'userMessageBackground' : undefined, children: [_jsxs(Text, { bold: open, children: [open ? '▼' : '▶', " ", t('context-loaded'), " \u00B7 ", summary] }), _jsxs(Text, { dimColor: true, children: [" \uFF08Ctrl+T", open ? t('context-panel-collapse') : t('context-panel-expand'), "\uFF09"] })] }), open && (_jsxs(Box, { flexDirection: "column", paddingX: 1, paddingTop: 1, children: [context.sections.length > 0 && (_jsx(Group, { title: t('context-panel-sections', { n: context.sections.length }), children: context.sections.map(section => (_jsx(Entry, { entry: section }, section.name))) })), context.files.length > 0 && (_jsx(Group, { title: t('context-panel-files', { n: context.files.length }), children: context.files.map(file => (_jsx(Text, { dimColor: true, children: file.displayPath }, file.displayPath))) })), context.contexts.length > 0 && (_jsx(Group, { title: t('context-panel-runtime', { n: context.contexts.length }), children: context.contexts.map(entry => (_jsx(Entry, { entry: entry }, entry.name))) })), context.skills.length > 0 && (_jsx(Group, { title: t('context-panel-skills', { n: context.skills.length }), children: context.skills.map(skill => (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: skill.name }), _jsx(Text, { dimColor: true, wrap: "wrap", children: skill.description })] }, skill.name))) })), context.tools.length > 0 && (_jsx(Group, { title: t('context-panel-tools', { n: context.tools.length }), children: context.tools.map(tool => (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: tool.name }), _jsx(Text, { dimColor: true, wrap: "wrap", children: truncateContextText(tool.description, 160) })] }, tool.name))) }))] }))] }));
}
