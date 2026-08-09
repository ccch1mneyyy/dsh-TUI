import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
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
 * The startup `已加载上下文` panel: a collapsed one-line summary of what a
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
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, marginBottom: 1, children: [_jsxs(Box, { paddingX: 1, backgroundColor: open ? 'userMessageBackground' : undefined, children: [_jsxs(Text, { bold: open, children: [open ? '▼' : '▶', " \u5DF2\u52A0\u8F7D\u4E0A\u4E0B\u6587 \u00B7 ", summary] }), _jsxs(Text, { dimColor: true, children: [" \uFF08Ctrl+T", open ? '折叠' : '展开', "\uFF09"] })] }), open && (_jsxs(Box, { flexDirection: "column", paddingX: 1, paddingTop: 1, children: [context.sections.length > 0 && (_jsx(Group, { title: `系统提示词 · ${context.sections.length} 段`, children: context.sections.map(section => (_jsx(Entry, { entry: section }, section.name))) })), context.files.length > 0 && (_jsx(Group, { title: `工作区指令 · ${context.files.length} 个文件`, children: context.files.map(file => (_jsx(Text, { dimColor: true, children: file.displayPath }, file.displayPath))) })), context.contexts.length > 0 && (_jsx(Group, { title: `运行时上下文 · ${context.contexts.length} 项`, children: context.contexts.map(entry => (_jsx(Entry, { entry: entry }, entry.name))) })), context.skills.length > 0 && (_jsx(Group, { title: `技能 · ${context.skills.length}`, children: context.skills.map(skill => (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: skill.name }), _jsx(Text, { dimColor: true, wrap: "wrap", children: skill.description })] }, skill.name))) })), context.tools.length > 0 && (_jsx(Group, { title: `工具 · ${context.tools.length}`, children: context.tools.map(tool => (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: tool.name }), _jsx(Text, { dimColor: true, wrap: "wrap", children: truncateContextText(tool.description, 160) })] }, tool.name))) }))] }))] }));
}
//# sourceMappingURL=LoadedContextPanel.js.map