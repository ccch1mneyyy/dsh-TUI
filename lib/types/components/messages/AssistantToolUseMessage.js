import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Box, Text } from '../../ui.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js';
import { ToolUseLoader } from '../ToolUseLoader.js';
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
/** CC's collapsed text body keeps 3 lines (renderTruncatedContent). */
const TEXT_BODY_MAX_LINES = 3;
/** Diff bodies cap at the upstream chat row's 8 (dsh-client-ui-tool's
 *  CHAT_DIFF_MAX_LINES) — denser information than log output. */
const DIFF_BODY_MAX_LINES = 8;
const GUTTER_FIRST = '  ⎿  ';
const GUTTER_REST = '     ';
const add = (text) => ({ text, tone: 'add' });
const del = (text) => ({ text, tone: 'del' });
const dim = (text) => ({ text, tone: 'dim' });
const plain = (text) => ({ text, tone: 'plain' });
/** One side's text → display lines (upstream contentLines rule: empty text
 *  is zero lines; a single trailing newline is a terminator, not a line;
 *  interior blanks survive). */
function sideLines(text) {
    if (text === '')
        return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
/** Diff hunks → add/del rows. The header already carries the path for the
 *  common single-hunk case; with several hunks a path row separates files
 *  and `⋯` separates scattered hunks of one file (upstream DiffBlock). */
function diffLines(diffs) {
    const out = [];
    let prevPath;
    for (const diff of diffs) {
        if (diffs.length > 1) {
            if (diff.path !== prevPath)
                out.push(plain(diff.path));
            else
                out.push(dim('⋯'));
        }
        prevPath = diff.path;
        if (diff.oldText !== null) {
            for (const line of sideLines(diff.oldText))
                out.push(del(`- ${line}`));
        }
        for (const line of sideLines(diff.newText))
            out.push(add(`+ ${line}`));
    }
    return out;
}
/** Join the text blocks of a view's content payload (read/generic cards). */
function contentLines(content) {
    const text = (content ?? []).map(block => (block.type === 'text' ? block.text ?? '' : '')).join('').trimEnd();
    if (text === '')
        return [];
    return text.split('\n').map(dim);
}
/** Per-card body lines; unknown/absent shapes yield [] so the caller falls
 *  back to the raw result text. */
function viewLines(view) {
    switch (view.card) {
        case 'diff':
            return diffLines(view.diffs);
        case 'terminal': {
            // The call-side terminal card has no output yet; only presentResult's
            // does. `in` narrows the call/result union without extra types.
            const out = (('output' in view ? view.output : undefined) ?? '').trimEnd();
            const lines = out === '' ? [] : out.split('\n').map(dim);
            if ('exitCode' in view && view.exitCode !== undefined && view.exitCode !== 0) {
                lines.push({ text: `Exit code ${view.exitCode}`, tone: 'error' });
            }
            if ('signal' in view && view.signal !== undefined) {
                lines.push({ text: `Killed by signal ${view.signal}`, tone: 'error' });
            }
            return lines;
        }
        case 'read':
            return contentLines('content' in view ? view.content : undefined);
        case 'generic':
            return contentLines('content' in view ? view.content : undefined);
        case 'search': {
            if (view.shape === 'paths') {
                const lines = view.paths.map(plain);
                if (view.truncated)
                    lines.push(dim(`… (${view.total} total)`));
                return lines;
            }
            const lines = [];
            for (const file of view.files) {
                lines.push(plain(file.path));
                for (const match of file.matches) {
                    lines.push(dim(`${match.lineNumber}: ${match.line}`));
                }
            }
            if (view.truncated)
                lines.push(dim(`… (${view.total} total)`));
            return lines;
        }
        default:
            return [];
    }
}
/** Collapsed bodies fold past the card's line budget; verbose (Ctrl+O) is
 *  always uncapped. Mirrors wrapText's "one extra line is shown directly". */
function capLines(lines, max, verbose) {
    if (verbose || lines.length <= max)
        return lines;
    if (lines.length - max === 1)
        return lines;
    return [
        ...lines.slice(0, max),
        dim(`… +${lines.length - max} lines (ctrl+o to expand)`),
    ];
}
/** Header title from the presentation view: terminal cards keep the
 *  `Name(command)` shape; everything else renders the tool's own title
 *  (`Edit /path`, `Read /path (1 - 100)`) with the first word bold. The
 *  result view's title replaces the call view's only when present — a
 *  settled terminal card carries output but no title of its own. */
function HeaderTitle({ name, title, isTerminal, displayArgs }) {
    if (title === undefined) {
        return (_jsxs(_Fragment, { children: [_jsx(Box, { flexShrink: 0, children: _jsx(Text, { bold: true, wrap: "truncate-end", children: name }) }), displayArgs !== '' && (_jsx(Box, { flexWrap: "nowrap", children: _jsxs(Text, { children: ["(", displayArgs, ")"] }) }))] }));
    }
    if (isTerminal) {
        return (_jsxs(_Fragment, { children: [_jsx(Box, { flexShrink: 0, children: _jsx(Text, { bold: true, wrap: "truncate-end", children: name }) }), _jsx(Box, { flexWrap: "nowrap", children: _jsxs(Text, { children: ["(", title, ")"] }) })] }));
    }
    const trimmed = title.trim();
    if (trimmed === '') {
        return (_jsx(Box, { flexShrink: 0, children: _jsx(Text, { bold: true, wrap: "truncate-end", children: name }) }));
    }
    const space = trimmed.indexOf(' ');
    const head = space === -1 ? trimmed : trimmed.slice(0, space);
    const tail = space === -1 ? '' : trimmed.slice(space);
    return (_jsx(Box, { flexWrap: "nowrap", children: _jsxs(Text, { bold: true, wrap: "truncate-end", children: [head, _jsx(Text, { bold: false, children: tail })] }) }));
}
/**
 * Tool-call card: `● Edit /path` header with a blinking status dot, then the
 * structured body under a `  ⎿  ` gutter — diff hunks in red/green, terminal
 * output, read content — instead of the raw result dump (ported from the
 * leak's `AssistantToolUseMessage.tsx` + the dsh-tools presentation views the
 * channel captures per call).
 */
export function AssistantToolUseMessage({ tool, addMargin, verbose, isSelected = false, isExpanded = false, }) {
    const isRunning = tool.status === 'running';
    const isError = tool.status === 'error';
    const displayArgs = verbose ? tool.argsFull ?? tool.argsText : tool.argsText;
    const result = tool.resultFull ?? tool.resultText;
    const name = displayName(tool.name);
    const minWidth = stringWidth(name) + 2;
    // The settled view carries the applied diff / actual output; while running,
    // the call view already shows the pending change (CC's pending Edit diff).
    const view = tool.resultView ?? tool.callView;
    // presentResult may omit a title (terminal results carry output, not a
    // command) — then the call view's title stands.
    const headerTitle = tool.resultView?.title ?? tool.callView?.title;
    const headerIsTerminal = view?.card === 'terminal';
    // Live elapsed clock while the call runs (CC's bash elapsed timer): the
    // 1s tick re-renders the card; elapsed derives from wall-clock refs.
    const [viewportRef] = useAnimationFrame(isRunning ? 1000 : null);
    const elapsedMs = isRunning
        ? tool.startedAt !== undefined
            ? Date.now() - tool.startedAt
            : undefined
        : tool.durationMs;
    const elapsedText = elapsedMs !== undefined ? ` · ${formatDuration(elapsedMs)}` : '';
    // Body lines: the structured view first, raw result text as the fallback
    // (tools without a presenter, or a folded row awaiting loadOlder).
    let body = [];
    if (isError) {
        if (tool.errorText)
            body = [{ text: tool.errorText, tone: 'error' }];
    }
    else {
        if (view !== undefined)
            body = viewLines(view);
        if (body.length === 0 && result) {
            body = result.trimEnd().split('\n').map(dim);
        }
        if (isRunning && body.length === 0) {
            body = [dim(`Running… (${formatDuration(Math.max(0, Date.now() - (tool.startedAt ?? Date.now())))})`)];
        }
    }
    const cap = view?.card === 'diff' ? DIFF_BODY_MAX_LINES : TEXT_BODY_MAX_LINES;
    const lines = capLines(body, cap, verbose);
    return (_jsx(Box, { ref: viewportRef, flexDirection: "row", justifyContent: "space-between", marginTop: addMargin ? 1 : 0, width: "100%", backgroundColor: isSelected
            ? 'messageActionsBackground'
            : isExpanded
                ? 'userMessageBackgroundHover'
                : undefined, children: _jsxs(Box, { flexDirection: "column", flexGrow: 1, children: [_jsxs(Box, { flexDirection: "row", flexWrap: "nowrap", minWidth: minWidth, children: [_jsx(ToolUseLoader, { shouldAnimate: isRunning, isUnresolved: isRunning, isError: isError }), _jsx(HeaderTitle, { name: name, title: headerTitle, isTerminal: headerIsTerminal, displayArgs: displayArgs }), !isRunning && (_jsx(Box, { flexWrap: "nowrap", children: _jsx(Text, { dimColor: true, children: elapsedText }) }))] }), lines.map((line, index) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Box, { width: 5, flexShrink: 0, children: _jsx(Text, { dimColor: true, children: index === 0 ? GUTTER_FIRST : GUTTER_REST }) }), _jsx(Box, { flexGrow: 1, children: _jsx(Text, { color: line.tone === 'add'
                                    ? 'diffAddedWord'
                                    : line.tone === 'del'
                                        ? 'diffRemovedWord'
                                        : line.tone === 'error'
                                            ? 'error'
                                            : undefined, dimColor: line.tone === 'dim', wrap: "wrap", children: line.text === '' ? ' ' : line.text }) })] }, index)))] }) }));
}
