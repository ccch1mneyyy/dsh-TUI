import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
/**
 * The `?` help menu, ported from the leak's `PromptInputHelpMenu.tsx`
 * (three-column shortcut layout, trimmed to the keys dsh-tui actually binds).
 * The command column lists the merged slash-command surface: built-in
 * commands plus plugin-registered ones from the DSH registry (plan/goal/…).
 */
export function HelpMenu({ commands, }) {
    return (_jsxs(Box, { paddingX: 2, flexDirection: "row", gap: 4, children: [_jsxs(Box, { flexDirection: "column", width: 26, flexShrink: 0, children: [_jsx(Box, { children: _jsx(Text, { dimColor: true, children: "/ for commands" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "? for this help" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "ctrl+o for verbose output" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "ctrl+t to toggle context" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "ctrl+r to search history" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "ctrl+c to interrupt" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "ctrl+d to exit" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "ctrl+l to redraw" }) })] }), _jsxs(Box, { flexDirection: "column", width: 24, flexShrink: 0, children: [_jsx(Box, { children: _jsx(Text, { dimColor: true, children: "esc to clear input" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "\u2191/\u2193 for history" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "\u2190/\u2192 to move cursor" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "ctrl+\u2190/\u2192 for word jumps" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "tab to complete command" }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "shift+tab to cycle effort" }) })] }), _jsxs(Box, { flexDirection: "column", flexShrink: 1, children: [_jsx(Text, { dimColor: true, children: "commands:" }), commands.map(command => (_jsx(Box, { children: _jsxs(Text, { dimColor: true, wrap: "truncate-end", children: ["/", command.name, " \u2014 ", command.description] }) }, command.name)))] })] }));
}
