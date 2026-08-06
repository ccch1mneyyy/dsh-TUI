import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from '../../ui.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js';
import { ToolUseLoader } from '../ToolUseLoader.js';
import { useTerminalSize } from '../../ink/hooks/use-terminal-size.js';
import { renderTruncatedContent } from '../../cc/terminal.js';
import { formatDuration } from '../../cc/format.js';
/** Tool display names: DSH emits lowercase tool ids (`bash`); Claude Code
 *  shows capitalized names (`Bash`). Map the common ones, fall back to the
 *  id with its first letter uppercased. */
function displayName(name) {
    const KNOWN = {
        bash: 'Bash',
        powershell: 'PowerShell',
        read: 'Read',
        glob: 'Glob',
        grep: 'Grep',
        write: 'Write',
        edit: 'Edit',
        todo_write: 'TodoWrite',
        subagent: 'Task',
        web_search: 'WebSearch',
    };
    const mapped = KNOWN[name];
    if (mapped)
        return mapped;
    if (name.length === 0)
        return name;
    return name[0].toUpperCase() + name.slice(1);
}
/**
 * Tool-call card: `● Bash("args")` header with a blinking status dot, then a
 * `Running…`/result/error line (ported from the leak's
 * `AssistantToolUseMessage.tsx` + the BashTool UI, collapsed into one card
 * because cc-tui's channel settles tool/result into a single row).
 */
export function AssistantToolUseMessage({ tool, addMargin, verbose, isSelected = false, isExpanded = false, }) {
    const { columns } = useTerminalSize();
    const isRunning = tool.status === 'running';
    const isError = tool.status === 'error';
    const displayArgs = verbose ? tool.argsFull ?? tool.argsText : tool.argsText;
    const result = tool.resultFull ?? tool.resultText;
    const name = displayName(tool.name);
    const minWidth = stringWidth(name) + 2;
    // Live elapsed clock while the call runs (CC's bash elapsed timer): the
    // 1s tick re-renders the card; elapsed derives from wall-clock refs.
    const [viewportRef] = useAnimationFrame(isRunning ? 1000 : null);
    const elapsedMs = isRunning
        ? tool.startedAt !== undefined
            ? Date.now() - tool.startedAt
            : undefined
        : tool.durationMs;
    const elapsedText = elapsedMs !== undefined ? ` · ${formatDuration(elapsedMs)}` : '';
    return (_jsx(Box, { ref: viewportRef, flexDirection: "row", justifyContent: "space-between", marginTop: addMargin ? 1 : 0, width: "100%", backgroundColor: isSelected
            ? 'messageActionsBackground'
            : isExpanded
                ? 'userMessageBackgroundHover'
                : undefined, children: _jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { flexDirection: "row", flexWrap: "nowrap", minWidth: minWidth, children: [_jsx(ToolUseLoader, { shouldAnimate: isRunning, isUnresolved: isRunning, isError: isError }), _jsx(Box, { flexShrink: 0, children: _jsx(Text, { bold: true, wrap: "truncate-end", children: name }) }), displayArgs && (_jsx(Box, { flexWrap: "nowrap", children: _jsxs(Text, { children: ["(", displayArgs, ")"] }) })), !isRunning && (_jsx(Box, { flexWrap: "nowrap", children: _jsx(Text, { dimColor: true, children: elapsedText }) }))] }), isRunning && (_jsx(Box, { children: _jsxs(Text, { dimColor: true, children: ["Running\u2026 (", formatDuration(Math.max(0, Date.now() - (tool.startedAt ?? Date.now()))), ")"] }) })), !isRunning && tool.status === 'ok' && result && (_jsx(Box, { children: _jsx(Text, { dimColor: true, children: verbose
                            ? result
                            : renderTruncatedContent(result, columns) }) })), isError && tool.errorText && (_jsx(Box, { children: _jsx(Text, { color: "error", children: tool.errorText }) }))] }) }));
}
//# sourceMappingURL=AssistantToolUseMessage.js.map