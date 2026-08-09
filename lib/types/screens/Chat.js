import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text, useInput, ScrollBox } from '../ui.js';
import { POINTER } from '../cc/figures.js';
import { formatTokens } from '../cc/format.js';
import { AskUserQuestionPanel } from '../components/questions/AskUserQuestionPanel.js';
import { useSearchHighlight } from '../ink/hooks/use-search-highlight.js';
import { useTerminalTitle } from '../ink/hooks/use-terminal-title.js';
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js';
import { NoSelect } from '../ink/components/NoSelect.js';
import instances from '../ink/instances.js';
import { LogoHeader, MessageList } from '../components/MessageList.js';
import { PromptInput } from '../components/PromptInput.js';
import { GoalTodoPanel } from '../components/GoalTodoPanel.js';
import { StatusLine } from './StatusLine.js';
import { WorkingSpinner, useThinkingStatus } from '../components/WorkingSpinner.js';
import { ActivityLine, contextPressurePct } from '../components/ActivityLine.js';
import { ModelPicker } from '../components/ModelPicker.js';
import { ResumePicker } from '../components/ResumePicker.js';
import { ActivityPicker } from '../components/ActivityPicker.js';
import { FRAME_PRESETS, PRESET_NAMES } from '../components/activityFrames.js';
import { ThinkingToggle } from '../components/ThinkingToggle.js';
import { HistorySearchDialog } from '../components/HistorySearchDialog.js';
import { RewindPicker } from '../components/RewindPicker.js';
import { LoadingState } from '../components/design-system/LoadingState.js';
import { Pane } from '../components/design-system/Pane.js';
import { loadHistory } from '../history.js';
/** Row kinds the message-selection cursor can land on. */
const SELECTABLE_KINDS = new Set([
    'user',
    'assistant',
    'tool',
    'reasoning',
    'interrupt',
    'local',
    'local-output',
    'compact',
]);
/** Shared empty list for mode-gated derived rows (stable reference, so
 *  downstream consumers never see a changing prop when the mode is off). */
const NO_ROWS = [];
/** `max` → `Max` (effort levels arrive lower-case from the adapter). */
function capitalize(text) {
    return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}
/**
 * CC's built-in skill commands, driven through the DSH skill system: each
 * submits an activation prompt the model resolves via its skill catalog/load
 * tools (the corresponding SKILL.md ships under ~/.dsh/skills with dsh-cc).
 */
const SKILL_PROMPTS = {
    audit: '请使用 audit 技能对当前项目做一次全面的代码审计，找出安全、正确性与质量问题。',
    bug: '请使用 bug 技能协助我记录一份完整的 bug 报告（现象、复现步骤、期望行为）。',
    practice: '请使用 practice 技能陪我进行一轮编程练习。',
    review: '请使用 review 技能对当前项目做一次全面的代码评审。',
    pr_comments: '请使用 pr_comments 技能审查当前分支的拉取请求评论并给出改进建议。',
    'release-notes': '请使用 release-notes 技能为当前项目生成发布说明。',
    'vuln-check': '请使用 vuln-check 技能对当前项目做一次安全漏洞检查。',
};
/** Terminal-title spinner frames (CC's TITLE_ANIMATION_FRAMES). */
const TITLE_ANIMATION_FRAMES = ['⠂', '⠐'];
/** Searchable transcript text for one row (`/` incsearch, CC semantics:
 *  user text, assistant text, thinking, tool args/results, local output). */
function searchableText(row) {
    switch (row.kind) {
        case 'tool':
            return row.tool
                ? `${row.tool.name} ${row.tool.argsText} ${row.tool.resultText ?? ''} ${row.tool.errorText ?? ''}`
                : '';
        default:
            return row.text;
    }
}
/**
 * Main chat screen in the Claude Code layout: a scrollable transcript
 * (with the current turn's prompt pinned above the viewport while scrolled
 * up), transient notifications, the working spinner, the bordered prompt
 * input (with slash-command overlay) and the status line pinned at the
 * bottom.
 *
 * Ctrl+O toggles expanded detail globally; Shift+↑ enters message-selection
 * mode (↑/↓ move, Enter expands the selected row, Esc exits); Ctrl+C
 * interrupts the running turn, or (when idle) asks for a second Ctrl+C to
 * exit; Enter while scrolled up jumps back to the bottom.
 */
export function Chat({ channel, questionStore, onExit, }) {
    // Re-render whenever the channel mutates; rows/status are read fresh below.
    React.useSyncExternalStore(channel.subscribe, () => channel.version);
    // The pending ask-user-question (DSH user-interaction seam): the model's
    // `ask_user_question` tool parks here until the panel is answered.
    const questionSnapshot = React.useSyncExternalStore(listener => questionStore.subscribe(listener), () => questionStore.getSnapshot());
    // When a questionnaire batch completes, fold a Q&A summary into the
    // transcript (the tool card itself is hidden from the message list).
    const questionOpenRef = React.useRef(questionSnapshot !== null);
    React.useEffect(() => {
        const wasOpen = questionOpenRef.current;
        questionOpenRef.current = questionSnapshot !== null;
        if (wasOpen && questionSnapshot === null) {
            for (const summary of questionStore.takeSummaries()) {
                channel.pushLocal(summary.title, summary.lines);
            }
        }
    }, [channel, questionSnapshot, questionStore]);
    const [expanded, setExpanded] = React.useState(false);
    const [helpOpen, setHelpOpen] = React.useState(false);
    const [handle, setHandle] = React.useState(null);
    const [selectionActive, setSelectionActive] = React.useState(false);
    const [selectedId, setSelectedId] = React.useState(null);
    const [expandedRows, setExpandedRows] = React.useState(() => new Set());
    const [modelPickerOpen, setModelPickerOpen] = React.useState(false);
    const [models, setModels] = React.useState([]);
    const [modelIndex, setModelIndex] = React.useState(0);
    const [resumePickerOpen, setResumePickerOpen] = React.useState(false);
    const [resumeSessions, setResumeSessions] = React.useState([]);
    const [resumeIndex, setResumeIndex] = React.useState(0);
    /** `/activity` indicator picker (pi extension's interactive select). */
    const [activityPickerOpen, setActivityPickerOpen] = React.useState(false);
    const [activityIndex, setActivityIndex] = React.useState(0);
    /** `/new` confirmation: a conversation with content needs a second `/new`
     *  (CC asks before discarding). Auto-disarms after a few seconds. */
    const newConfirmRef = React.useRef(false);
    const [showAllMessages, setShowAllMessages] = React.useState(false);
    const [thinkingVisible, setThinkingVisible] = React.useState(true);
    const [thinkingOpen, setThinkingOpen] = React.useState(false);
    const [thinkingFocus, setThinkingFocus] = React.useState(0);
    /** Mid-conversation toggle waiting for Enter confirmation (CC semantics). */
    const [thinkingConfirm, setThinkingConfirm] = React.useState(null);
    /** ctrl+r history search dialog (ported from CC's HistorySearchDialog). */
    const [historyOpen, setHistoryOpen] = React.useState(false);
    const [historyQuery, setHistoryQuery] = React.useState('');
    const [historyCursor, setHistoryCursor] = React.useState(0);
    const [historyFocus, setHistoryFocus] = React.useState(0);
    const [historyEntries, setHistoryEntries] = React.useState([]);
    const [historyFill, setHistoryFill] = React.useState(null);
    /** Double-Esc rewind picker (CC rewind): open state + focused row + confirm. */
    const [rewindOpen, setRewindOpen] = React.useState(false);
    const [rewindIndex, setRewindIndex] = React.useState(0);
    const [rewindConfirm, setRewindConfirm] = React.useState(null);
    /** `/` transcript search (less-style incsearch, ported from CC's REPL). */
    const [searchOpen, setSearchOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchCursor, setSearchCursor] = React.useState(0);
    const [searchCount, setSearchCount] = React.useState(0);
    const [searchCurrent, setSearchCurrent] = React.useState(0);
    const searchAnchorRef = React.useRef(0);
    const rowRefsRef = React.useRef(new Map());
    const { setQuery: setHighlight } = useSearchHighlight();
    // Sticky (pinned-to-bottom) scroll state, subscribed imperatively so
    // wheel events don't re-render React — only the header/pill flip.
    const isSticky = React.useSyncExternalStore(cb => (handle ? handle.subscribe(cb) : () => { }), () => (handle ? handle.isSticky() : true));
    // "N new messages" pill: messages arriving while the user scrolled up.
    const baseAtScrollAway = React.useRef(null);
    React.useEffect(() => {
        if (isSticky) {
            baseAtScrollAway.current = null;
        }
        else if (baseAtScrollAway.current === null) {
            baseAtScrollAway.current = channel.rows.length;
        }
    }, [isSticky, channel.rows.length]);
    const newCount = baseAtScrollAway.current === null
        ? 0
        : Math.max(0, channel.rows.length - baseAtScrollAway.current);
    const showPill = !isSticky && newCount > 0;
    // Idle Ctrl+C: first press arms an exit, second press exits (CC's
    // double-press semantics, simplified). Under Windows ConPTY the key
    // arrives as stdin data (key.ctrl && input === 'c') — the useInput
    // branch below is the only path; SIGINT is not emitted.
    const exitPendingRef = React.useRef(false);
    const exitTimerRef = React.useRef(null);
    const requestExit = () => {
        if (exitPendingRef.current) {
            onExit();
        }
        else {
            exitPendingRef.current = true;
            channel.notify('Press Ctrl+C again to exit');
            exitTimerRef.current = setTimeout(() => {
                exitPendingRef.current = false;
            }, 3000);
        }
    };
    React.useEffect(() => {
        return () => {
            if (exitTimerRef.current)
                clearTimeout(exitTimerRef.current);
        };
    }, []);
    // Spinner timing refs, fed from channel state each render (the spinner
    // only mounts while working, so values are stable for the mount).
    const responseLengthRef = React.useRef(0);
    const loadingStartTimeRef = React.useRef(0);
    const totalPausedMsRef = React.useRef(0);
    const pauseStartTimeRef = React.useRef(null);
    responseLengthRef.current = channel.responseChars;
    loadingStartTimeRef.current = channel.turnStart;
    const thinkingStatus = useThinkingStatus(channel.spinnerMode === 'thinking');
    // Terminal tab title (ported from CC's AnimatedTerminalTitle): the session
    // title when set, else "dsh-cc"; a `⠂/⠐` spinner prefix while a turn is
    // working (960ms cadence, only while the terminal is focused), a static
    // `✦` otherwise. cc-tui brands the idle prefix with the DeepSeek whale.
    const [titleFrame, setTitleFrame] = React.useState(0);
    const terminalFocused = useTerminalFocus();
    React.useEffect(() => {
        if (!channel.working || !terminalFocused)
            return;
        const interval = setInterval(() => {
            setTitleFrame(f => (f + 1) % TITLE_ANIMATION_FRAMES.length);
        }, 960);
        return () => { clearInterval(interval); };
    }, [channel.working, terminalFocused]);
    const titlePrefix = channel.working
        ? (TITLE_ANIMATION_FRAMES[titleFrame] ?? '✦')
        : '✦';
    useTerminalTitle(`${titlePrefix} 🐋 ${channel.sessionTitle}`);
    /**
     * Dispatch a slash command; false lets the input flow to the model.
     * Built-in names run the local switch; anything registered by a DSH
     * plugin (plan/goal/…) dispatches through the command registry, whose
     * result text lands as a notification. `rawInput` carries the text after
     * the command name (`/plan off` → ` off`).
     */
    const runCommand = (name, rawInput = '') => {
        switch (name) {
            case 'activity': {
                // Ported from the pi working-activity extension: bare `/activity`
                // opens the interactive indicator picker; `/activity frames <名>`
                // switches directly; `/activity frames` lists presets; `/activity
                // status` shows the current choice. The choice persists to
                // ~/.dsh-cc/working-activity.json and survives restarts.
                const parts = rawInput.trim().split(/\s+/).filter(Boolean);
                if (parts[0] === 'status') {
                    setHelpOpen(false);
                    channel.pushLocal('/activity', [
                        `当前预设  ${channel.activityFrames ?? 'claude'}`,
                        '切换      /activity（选择器）或 /activity frames <名>',
                        '持久化    ~/.dsh-cc/working-activity.json（重启后仍生效）',
                    ]);
                    return true;
                }
                if (parts[0] === 'frames') {
                    setHelpOpen(false);
                    if (parts[1]) {
                        channel.setActivityFrames(parts[1].toLowerCase());
                        return true;
                    }
                    const current = channel.activityFrames;
                    channel.pushLocal('/activity', [
                        `当前预设：${current ?? 'claude'} · /activity frames <名> 直接切换：`,
                        ...PRESET_NAMES.map(name => `${name.padEnd(10)} ${name === 'random' ? '每次随机' : FRAME_PRESETS[name].frames.slice(0, 5).join(' ')}${name === current ? '  ← 当前' : ''}`),
                    ]);
                    return true;
                }
                if (parts.length > 0) {
                    channel.notify('用法：/activity | /activity frames <名> | /activity status', { color: 'warning' });
                    return true;
                }
                setHelpOpen(false);
                setActivityIndex(Math.max(0, PRESET_NAMES.indexOf(channel.activityFrames ?? 'random')));
                setActivityPickerOpen(true);
                return true;
            }
            case 'new': {
                // CC confirms before discarding a conversation with content: the
                // first /new arms, a second /new within 4s executes.
                setHelpOpen(false);
                const hasContent = channel.rows.some(row => row.kind === 'user' || row.kind === 'assistant');
                if (hasContent && !newConfirmRef.current) {
                    newConfirmRef.current = true;
                    channel.notify('Press /new again to confirm — this starts a fresh conversation', {
                        color: 'warning',
                        timeoutMs: 4000,
                    });
                    setTimeout(() => {
                        newConfirmRef.current = false;
                    }, 4000);
                    return true;
                }
                newConfirmRef.current = false;
                void channel.newSession().then((ok) => {
                    if (ok)
                        channel.notify('New session started');
                });
                return true;
            }
            case 'clear':
                channel.clear();
                // channel.clear() resets row ids to 0; stale expanded/selection
                // state would mis-highlight fresh rows (known-limitation fix).
                setExpandedRows(new Set());
                setSelectedId(null);
                setSelectionActive(false);
                return true;
            case 'compact':
                channel.compact();
                return true;
            case 'help':
                setHelpOpen(true);
                return true;
            case 'model':
                setHelpOpen(false);
                setModelPickerOpen(true);
                void channel.listModels().then((list) => {
                    setModels(list);
                    const index = list.findIndex(model => model.id === channel.model);
                    setModelIndex(index >= 0 ? index : 0);
                });
                return true;
            case 'thinking':
                setHelpOpen(false);
                setThinkingOpen(true);
                setThinkingFocus(thinkingVisible ? 0 : 1);
                return true;
            case 'tokens': {
                const usage = `Tokens: ${formatTokens(channel.tokens.input)} in · ${formatTokens(channel.tokens.output)} out`;
                if (channel.contextWindow === undefined) {
                    channel.notify(usage);
                }
                else {
                    const percent = Math.max(0, Math.min(100, Math.round((channel.tokens.input / channel.contextWindow) * 100)));
                    channel.notify(`${usage} · ${percent}% of context`);
                }
                return true;
            }
            case 'resume': {
                setHelpOpen(false);
                void (async () => {
                    const sessions = await channel.listSessions();
                    // The current session cannot be resumed into itself (agents.resume
                    // rejects a live session), so it is excluded from the picker —
                    // otherwise the fresh empty session of this launch always tops the
                    // list as an unopenable row.
                    const pickable = sessions.filter(session => session.id !== channel.agentId);
                    setResumeSessions(pickable);
                    if (pickable.length === 0) {
                        channel.notify('No previous sessions found');
                        return;
                    }
                    setResumePickerOpen(true);
                    setResumeIndex(0);
                })();
                return true;
            }
            case 'exit':
                onExit();
                return true;
            case 'status': {
                const usage = channel.lastUsage;
                const pct = channel.contextWindow === undefined
                    ? undefined
                    : Math.max(0, Math.min(100, Math.round((channel.tokens.input / channel.contextWindow) * 100)));
                const lines = [
                    `模型   ${channel.model}${channel.reasoningEffort ? ` · ${capitalize(channel.reasoningEffort)} effort` : ''}`,
                    `状态   ${channel.working ? '工作中' : '空闲'}`,
                    `会话   ${channel.agentId}`,
                    `目录   ${channel.cwd}${channel.gitBranch ? ` · ${channel.gitBranch}` : ''}`,
                    `Tokens ${formatTokens(channel.tokens.input)} in → ${formatTokens(channel.tokens.output)} out`,
                ];
                if (usage !== undefined) {
                    const total = usage.input + usage.cacheRead + usage.cacheWrite;
                    const rate = total > 0 ? ((usage.cacheRead / total) * 100).toFixed(1) : '0.0';
                    lines.push(`缓存率 ${rate}% · ${formatTokens(usage.cacheRead)} 读 / ${formatTokens(usage.cacheWrite)} 写`);
                }
                if (pct !== undefined)
                    lines.push(`上下文 ${pct}%`);
                if (channel.sessionTitle)
                    lines.push(`标题   ${channel.sessionTitle}`);
                setHelpOpen(false);
                channel.pushLocal('/status', lines);
                return true;
            }
            case 'cost': {
                const usage = channel.lastUsage;
                const lines = [
                    `Tokens ${formatTokens(channel.tokens.input)} in → ${formatTokens(channel.tokens.output)} out`,
                ];
                if (usage !== undefined) {
                    const total = usage.input + usage.cacheRead + usage.cacheWrite;
                    const rate = total > 0 ? ((usage.cacheRead / total) * 100).toFixed(1) : '0.0';
                    lines.push(`缓存命中率 ${rate}% · 缓存 ${formatTokens(usage.cacheRead)} 读 / ${formatTokens(usage.cacheWrite)} 写`);
                }
                lines.push('注：DSH 不提供 API 费用计量，以上为 token 用量（按 provider 账单计费）');
                setHelpOpen(false);
                channel.pushLocal('/cost', lines);
                return true;
            }
            case 'config': {
                const userHome = process.env.USERPROFILE ?? '';
                const lines = [
                    `示例配置  ${channel.cwd}/examples/cc-tui-agent/cordis.yml`,
                    `用户配置  ${userHome}\\.dsh-cc\\cordis.yml（install.sh --full 生成）`,
                    '',
                    '启动方式  dsh-cc.cmd / dsh --config <上述任一配置>',
                    '模型路由  由 cordis.yml 的 llm-deepseek 段决定（/model 仅提示重启生效）',
                ];
                setHelpOpen(false);
                channel.pushLocal('/config', lines);
                return true;
            }
            case 'doctor':
                setHelpOpen(false);
                channel.pushLocal('/doctor', channel.doctorInfo());
                return true;
            case 'export': {
                const target = channel.exportSession();
                channel.notify(target === null
                    ? '导出失败（无法写入工作目录）'
                    : `已导出: ${target}`, target === null ? { color: 'error', timeoutMs: 8000 } : { timeoutMs: 8000 });
                return true;
            }
            case 'init': {
                const result = channel.initWorkspace();
                if (result === null)
                    channel.notify('创建 AGENTS.md 失败', { color: 'error' });
                else if (result === 'exists')
                    channel.notify('AGENTS.md 已存在，未覆盖');
                else
                    channel.notify(`已创建 ${result}`);
                return true;
            }
            case 'agents':
                setHelpOpen(false);
                void channel.listSubagents().then((lines) => {
                    channel.pushLocal('/agents', lines);
                });
                return true;
            case 'login': {
                const key = process.env.DEEPSEEK_API_KEY;
                const lines = [
                    `API key: ${key ? key.slice(0, 6) + '…' + key.slice(-4) : '未配置（DEEPSEEK_API_KEY）'}`,
                    `Base URL: ${process.env.DEEPSEEK_BASE_URL ?? '官方端点'}`,
                    '来源：环境变量 → 工作区 .env（run.ts 兜底读取）',
                ];
                setHelpOpen(false);
                channel.pushLocal('/login', lines);
                return true;
            }
            case 'logout':
                channel.notify('DSH 凭证来自环境变量 DEEPSEEK_API_KEY — 删除该环境变量后重启 dsh-cc 即登出');
                return true;
            case 'permissions':
                setHelpOpen(false);
                channel.pushLocal('/permissions', [
                    'DSH 权限策略由 fs-policy / bash-sandbox 配置决定（当前 leaf：workspace 内读写、写入需已读文件）。',
                    'DSH 的 /permission 预设切换需要 approval 服务 + 审批 UI，dsh-cc 未挂载。',
                ]);
                return true;
            case 'add-dir':
                setHelpOpen(false);
                channel.pushLocal('/add-dir', [
                    `当前文件系统策略以工作目录为根：${channel.cwd}`,
                    '模型工具相对路径均解析自该目录；跨目录访问由 fs-policy 拦截。',
                ]);
                return true;
            case 'hooks':
                setHelpOpen(false);
                channel.pushLocal('/hooks', [
                    'DSH hooks（dsh-hooks-claude / dsh-hooks-codex）未在本 leaf 挂载。',
                    '需要时可在 cordis.yml 挂载对应 hooks 插件。',
                ]);
                return true;
            case 'mcp':
                setHelpOpen(false);
                channel.pushLocal('/mcp', ['DSH 暂无 MCP 服务支持。']);
                return true;
            case 'memory':
                setHelpOpen(false);
                channel.pushLocal('/memory', [
                    'DSH 暂无持久记忆服务。',
                    '长期约定可写入 AGENTS.md（工作区上下文）或技能（~/.dsh/skills）。',
                ]);
                return true;
            case 'vim':
                channel.notify('vim 模式暂未实现');
                return true;
            case 'terminal-setup':
                setHelpOpen(false);
                channel.pushLocal('/terminal-setup', [
                    '推荐 Windows Terminal（≥110 列、等宽字体、TrueColor）。',
                    'Ctrl+V 粘贴文本/文件路径；Ctrl+Shift+V 终端原生粘贴；右键粘贴同样可用。',
                ]);
                return true;
            case 'connect':
                setHelpOpen(false);
                channel.pushLocal('/connect', ['DSH 暂无远程连接机制（CC 的 /connect 对应能力未适配）。']);
                return true;
            case 'audit':
            case 'bug':
            case 'practice':
            case 'review':
            case 'pr_comments':
            case 'release-notes':
            case 'vuln-check': {
                // CC's skill commands: drive the DSH skill system by sending the
                // activation prompt to the model (it loads the skill via its skill
                // catalog/load tools when the SKILL.md ships in ~/.dsh/skills).
                const prompt = SKILL_PROMPTS[name];
                if (prompt)
                    channel.submit(prompt);
                return true;
            }
            default: {
                // Plugin-registered command (DSH command registry): dispatch through
                // the channel, whose execution logs command/run + command/done (the
                // plan-mode projection folds those records, so /plan state stays
                // consistent). Unknown names fall through to the model.
                const external = channel.commandList.find(command => command.external && command.name === name);
                if (external) {
                    setHelpOpen(false);
                    void channel.runExternalCommand(name, rawInput).then((text) => {
                        if (text !== undefined && text !== '') {
                            channel.notify(text);
                        }
                        else if (text === undefined) {
                            channel.notify(`/${name}: no such command`, { color: 'error' });
                        }
                    });
                    return true;
                }
                return false;
            }
        }
    };
    // === Message-selection mode (CC's Shift+↑ message actions) ===
    // NOTE: rows is a live in-place array on the channel (no new reference per
    // update), so derived lists must be computed per render — a useMemo keyed
    // on `channel.rows` would freeze at the first empty snapshot forever.
    // Both lists only feed their respective modes; computing them
    // unconditionally cost an O(rows) scan + array allocation per render
    // (every streamed chunk), so they are gated on the consuming mode.
    const selectableRows = selectionActive
        ? channel.rows.filter(row => SELECTABLE_KINDS.has(row.kind))
        : NO_ROWS;
    // ctrl+r history search: substring match on the query, newest first.
    const historyMatches = React.useMemo(() => {
        const q = historyQuery.trim().toLowerCase();
        return q ? historyEntries.filter(e => e.text.toLowerCase().includes(q)) : historyEntries;
    }, [historyEntries, historyQuery]);
    // Double-Esc rewind: the user's own messages, newest first (CC lists the
    // selectable user turns; steering side-questions are excluded). Computed
    // per render while the picker is open — `channel.rows` is a live in-place
    // array (see selectableRows).
    const rewindRows = rewindOpen
        ? channel.rows
            .filter(row => row.kind === 'user' && row.label === undefined)
            .reverse()
        : NO_ROWS;
    /** Open the rewind picker (from PromptInput's double-Esc on an empty input). */
    const openRewind = () => {
        // rewindOpen is still false this render, so rewindRows is empty — scan
        // directly instead of reading the gated list.
        const candidates = channel.rows
            .filter(row => row.kind === 'user' && row.label === undefined)
            .reverse();
        if (candidates.length === 0) {
            channel.notify('Nothing to rewind yet');
            return;
        }
        setRewindIndex(0);
        setRewindConfirm(null);
        setRewindOpen(true);
    };
    /** Execute the confirmed rewind; the message comes back into the input. */
    const performRewind = async (row) => {
        const text = await channel.rewindTo(row);
        if (text !== null) {
            // CC puts the restored message back in the prompt for re-editing.
            setHistoryFill(text);
            channel.notify('Rewound — edit and press Enter to resend');
        }
    };
    // Row seeking under layout virtualization: a mounted row seeks directly;
    // an unmounted one is force-mounted first, then sought by the completion
    // effect below once its ref lands.
    const [forceMountRowId, setForceMountRowId] = React.useState(null);
    const seekRow = (rowId) => {
        const el = rowRefsRef.current.get(rowId);
        if (el) {
            handle?.scrollToElement(el);
            return;
        }
        setForceMountRowId(rowId);
    };
    React.useLayoutEffect(() => {
        if (forceMountRowId === null)
            return;
        const el = rowRefsRef.current.get(forceMountRowId);
        if (el) {
            handle?.scrollToElement(el);
            setForceMountRowId(null);
        }
    });
    // `/` transcript search: rows whose searchable text contains the query.
    // Computed per render — `channel.rows` is a live in-place array (see
    // selectableRows); a useMemo would freeze the match list at mount.
    const searchMatches = (() => {
        const q = searchQuery.toLowerCase();
        if (!q)
            return [];
        return channel.rows
            .map((row, index) => ({ row, index, text: searchableText(row).toLowerCase() }))
            .filter(m => m.text.includes(q));
    })();
    // Incsearch: highlight all matches (screen-space overlay) and keep the
    // current match row in view as the query changes (CC semantics).
    React.useEffect(() => {
        if (!searchOpen)
            return;
        setHighlight(searchQuery);
        const count = searchMatches.length;
        setSearchCount(count);
        const current = Math.min(searchCurrent, Math.max(0, count - 1));
        setSearchCurrent(current);
        const target = searchMatches[current];
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty/filtered list
        if (target) {
            seekRow(target.row.id);
        }
    }, [searchQuery, searchOpen]);
    // n/N navigation: move the current match into view.
    React.useEffect(() => {
        if (!searchOpen)
            return;
        const target = searchMatches[searchCurrent];
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty/filtered list
        if (target) {
            seekRow(target.row.id);
        }
    }, [searchCurrent]);
    const enterSelection = () => {
        setSelectionActive(true);
        const last = selectableRows[selectableRows.length - 1];
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: empty selectable list
        setSelectedId(last ? last.id : null);
    };
    const moveSelection = (delta) => {
        if (selectedId === null)
            return;
        const index = selectableRows.findIndex(row => row.id === selectedId);
        if (index < 0)
            return;
        const next = selectableRows[index + delta];
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index
        if (next)
            setSelectedId(next.id);
    };
    // useCallback: these feed MessageList → MemoRow's shallow compare; fresh
    // closures each render would defeat every row's memo.
    const toggleRowExpanded = React.useCallback((rowId) => {
        setExpandedRows((previous) => {
            const next = new Set(previous);
            if (next.has(rowId))
                next.delete(rowId);
            else
                next.add(rowId);
            return next;
        });
    }, []);
    const registerRowRef = React.useCallback((rowId, el) => {
        if (el)
            rowRefsRef.current.set(rowId, el);
        else
            rowRefsRef.current.delete(rowId);
    }, []);
    useInput((input, key, event) => {
        // The questionnaire owns the keyboard while a question is pending (the
        // panel's own useInput handles ↑/↓/Space/Tab/Enter/Esc; the prompt
        // input is unmounted, so nothing else should see these keys).
        if (questionSnapshot !== null)
            return;
        if (searchOpen) {
            // Transcript search bar (less-style): edit the query, Enter commits
            // (query persists for n/N), Esc/ctrl+c cancels back to the anchor.
            if (key.escape || (key.ctrl && input === 'c')) {
                setSearchOpen(false);
                setHighlight('');
                handle?.scrollTo(searchAnchorRef.current);
            }
            else if (key.return) {
                // Enter commits; 0-match junk queries don't persist (CC behavior).
                if (searchCount === 0)
                    setSearchQuery('');
                setSearchOpen(false);
            }
            else if (key.backspace) {
                if (searchCursor > 0) {
                    setSearchQuery(searchQuery.slice(0, searchCursor - 1) + searchQuery.slice(searchCursor));
                    setSearchCursor(searchCursor - 1);
                }
            }
            else if (key.delete) {
                if (searchCursor < searchQuery.length) {
                    setSearchQuery(searchQuery.slice(0, searchCursor) + searchQuery.slice(searchCursor + 1));
                }
            }
            else if (key.leftArrow) {
                setSearchCursor(c => Math.max(0, c - 1));
            }
            else if (key.rightArrow) {
                setSearchCursor(c => Math.min(searchQuery.length, c + 1));
            }
            else if (key.home) {
                setSearchCursor(0);
            }
            else if (key.end) {
                setSearchCursor(searchQuery.length);
            }
            else if (!key.ctrl && !key.meta && input) {
                const next = searchQuery.slice(0, searchCursor) + input + searchQuery.slice(searchCursor);
                setSearchQuery(next);
                setSearchCursor(searchCursor + input.length);
            }
            event.stopImmediatePropagation();
            return;
        }
        // After Enter closed the search bar, n/N keep walking the matches
        // (CC: "Query persists across bar open/close so n/N keep working").
        // Transcript mode only — in prompt mode n/N are ordinary input chars.
        if (expanded && input === 'n' && searchQuery && searchCount > 0 && !key.ctrl && !key.meta) {
            setSearchCurrent(i => (i >= searchCount - 1 ? 0 : i + 1));
            event.stopImmediatePropagation();
            return;
        }
        if (expanded && input === 'N' && searchQuery && searchCount > 0 && !key.ctrl && !key.meta) {
            setSearchCurrent(i => (i <= 0 ? searchCount - 1 : i - 1));
            event.stopImmediatePropagation();
            return;
        }
        if (thinkingOpen) {
            if (thinkingConfirm !== null) {
                // Confirmation state: Enter applies, Esc backs out to the select.
                if (key.return) {
                    const enabled = thinkingConfirm;
                    setThinkingVisible(enabled);
                    setThinkingConfirm(null);
                    setThinkingOpen(false);
                    channel.notify(`Thinking ${enabled ? 'on' : 'off'}`);
                }
                else if (key.escape) {
                    setThinkingConfirm(null);
                }
            }
            else if (key.upArrow || key.downArrow) {
                setThinkingFocus(index => (index === 0 ? 1 : 0));
            }
            else if (key.return) {
                const enabled = thinkingFocus === 0;
                const midConversation = channel.rows.some(row => row.kind === 'assistant');
                if (midConversation && enabled !== thinkingVisible) {
                    setThinkingConfirm(enabled);
                }
                else {
                    setThinkingVisible(enabled);
                    setThinkingOpen(false);
                    channel.notify(`Thinking ${enabled ? 'on' : 'off'}`);
                }
            }
            else if (key.escape) {
                setThinkingOpen(false);
            }
            return;
        }
        if (resumePickerOpen) {
            if (key.upArrow) {
                setResumeIndex(index => (index <= 0 ? resumeSessions.length - 1 : index - 1));
            }
            else if (key.downArrow) {
                setResumeIndex(index => (index >= resumeSessions.length - 1 ? 0 : index + 1));
            }
            else if (key.return) {
                const session = resumeSessions[resumeIndex];
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
                if (session) {
                    // Enter switches the live agent to the persisted session right
                    // away (the history replays into the transcript); the resume.txt
                    // launcher marker is refreshed by resumeTo so `--resume` on the
                    // next launch opens the same session.
                    setResumePickerOpen(false);
                    void channel.resumeTo(session.id).then((ok) => {
                        if (ok)
                            channel.notify('Session resumed');
                    });
                }
                else {
                    setResumePickerOpen(false);
                }
            }
            else if (key.escape) {
                setResumePickerOpen(false);
            }
            return;
        }
        if (modelPickerOpen) {
            if (key.upArrow) {
                setModelIndex(index => (index <= 0 ? models.length - 1 : index - 1));
            }
            else if (key.downArrow) {
                setModelIndex(index => (index >= models.length - 1 ? 0 : index + 1));
            }
            else if (key.return) {
                const model = models[modelIndex];
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
                if (model) {
                    // Enter switches the live model right away: the conversation is
                    // forked at its end and continued with an agent routed to the new
                    // model (history replays unchanged).
                    setModelPickerOpen(false);
                    channel.notify(`Switching model to ${model.name}…`);
                    void channel.switchModel(model.id).then((ok) => {
                        if (ok)
                            channel.notify(`Model switched to ${model.name}`);
                    });
                }
                else {
                    setModelPickerOpen(false);
                }
            }
            else if (key.escape) {
                setModelPickerOpen(false);
            }
            return;
        }
        if (activityPickerOpen) {
            if (key.upArrow) {
                setActivityIndex(index => (index <= 0 ? PRESET_NAMES.length - 1 : index - 1));
            }
            else if (key.downArrow) {
                setActivityIndex(index => (index >= PRESET_NAMES.length - 1 ? 0 : index + 1));
            }
            else if (key.return) {
                const name = PRESET_NAMES[activityIndex];
                setActivityPickerOpen(false);
                if (name)
                    channel.setActivityFrames(name);
            }
            else if (key.escape) {
                setActivityPickerOpen(false);
            }
            return;
        }
        if (historyOpen) {
            if (key.escape) {
                setHistoryOpen(false);
            }
            else if (key.ctrl && (input === 'c' || input === 'd')) {
                // CC's history search cancels on ctrl+c/ctrl+d too.
                setHistoryOpen(false);
            }
            else if (key.return) {
                const entry = historyMatches[historyFocus];
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty match list
                if (entry) {
                    setHistoryFill(entry.text);
                    setHistoryOpen(false);
                }
            }
            else if (key.upArrow) {
                setHistoryFocus(index => historyMatches.length === 0 ? 0 : (index <= 0 ? historyMatches.length - 1 : index - 1));
            }
            else if (key.downArrow || (key.ctrl && input === 'r')) {
                // CC's historySearch:next — ↓ and repeat ctrl+r walk to the next match.
                setHistoryFocus(index => historyMatches.length === 0 ? 0 : (index >= historyMatches.length - 1 ? 0 : index + 1));
            }
            else if (key.backspace) {
                if (historyCursor > 0) {
                    const next = historyQuery.slice(0, historyCursor - 1) + historyQuery.slice(historyCursor);
                    setHistoryQuery(next);
                    setHistoryCursor(historyCursor - 1);
                    setHistoryFocus(0);
                }
            }
            else if (key.delete) {
                if (historyCursor < historyQuery.length) {
                    setHistoryQuery(historyQuery.slice(0, historyCursor) + historyQuery.slice(historyCursor + 1));
                    setHistoryFocus(0);
                }
            }
            else if (key.leftArrow) {
                setHistoryCursor(cursor => Math.max(0, cursor - 1));
            }
            else if (key.rightArrow) {
                setHistoryCursor(cursor => Math.min(historyQuery.length, cursor + 1));
            }
            else if (key.home) {
                setHistoryCursor(0);
            }
            else if (key.end) {
                setHistoryCursor(historyQuery.length);
            }
            else if (!key.ctrl && !key.meta && input) {
                const next = historyQuery.slice(0, historyCursor) + input + historyQuery.slice(historyCursor);
                setHistoryQuery(next);
                setHistoryCursor(historyCursor + input.length);
                setHistoryFocus(0);
            }
            return;
        }
        if (rewindOpen) {
            if (rewindConfirm !== null) {
                // Confirmation state: Enter rewinds, Esc backs out to the list.
                if (key.return) {
                    const row = rewindConfirm;
                    setRewindOpen(false);
                    setRewindConfirm(null);
                    void performRewind(row);
                }
                else if (key.escape) {
                    setRewindConfirm(null);
                }
            }
            else if (key.upArrow) {
                setRewindIndex(index => (index <= 0 ? rewindRows.length - 1 : index - 1));
            }
            else if (key.downArrow) {
                setRewindIndex(index => (index >= rewindRows.length - 1 ? 0 : index + 1));
            }
            else if (key.return) {
                const row = rewindRows[rewindIndex];
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: out-of-range index on an empty list
                if (row)
                    setRewindConfirm(row);
            }
            else if (key.escape) {
                setRewindOpen(false);
                setRewindConfirm(null);
            }
            return;
        }
        if (key.ctrl && input === 'r' && !helpOpen) {
            setHistoryQuery('');
            setHistoryCursor(0);
            setHistoryFocus(0);
            setHistoryEntries(loadHistory());
            setHistoryOpen(true);
            return;
        }
        if (key.shift && key.upArrow && !selectionActive) {
            enterSelection();
        }
        else if (selectionActive) {
            if (key.upArrow) {
                moveSelection(-1);
            }
            else if (key.downArrow) {
                moveSelection(1);
            }
            else if (key.return && selectedId !== null) {
                toggleRowExpanded(selectedId);
            }
            else if (key.escape) {
                setSelectionActive(false);
                setSelectedId(null);
            }
        }
        else if (key.escape && channel.working) {
            // CC's chat:cancel — esc interrupts a running turn (the prompt input
            // only sees esc when idle, where it has the double-tap-clear meaning).
            // With messages queued for delivery, interrupt-and-deliver them right
            // away (Codex behavior); otherwise a plain interrupt parks the queue.
            if (channel.pending.length > 0) {
                const count = channel.interruptAndDeliver(channel.pending.map(item => item.text));
                if (count > 0) {
                    channel.notify(`已打断当前回合，${count} 条消息立即处理`, { timeoutMs: 2500 });
                }
            }
            else {
                channel.cancel();
            }
            event.stopImmediatePropagation();
        }
        else if (key.ctrl && input === 'o') {
            // Leaving transcript mode (Ctrl+O) — search was already handled above.
            setExpanded(previous => !previous);
        }
        else if (input === '/' && !key.ctrl && !key.meta) {
            // `/` in transcript mode (Ctrl+O expanded, CC's REPL semantics:
            // search is active on the transcript screen where `/` isn't a command).
            if (expanded) {
                searchAnchorRef.current = handle?.getScrollTop() ?? 0;
                setSearchQuery('');
                setSearchCursor(0);
                setSearchCurrent(0);
                setSearchCount(0);
                setSearchOpen(true);
                event.stopImmediatePropagation();
            }
        }
        else if (key.ctrl && (input === 'c' || input === 'd')) {
            // CC's app:exit — ctrl+c interrupts a running turn, or (idle-only)
            // asks for a second press; ctrl+d is the time-based double press.
            if (channel.working) {
                channel.cancel();
            }
            else {
                requestExit();
            }
        }
        else if (key.ctrl && input === 'l') {
            // CC's app:redraw — clear the physical terminal and repaint.
            instances.get(process.stdout)?.forceRedraw();
        }
        else if (key.ctrl && input === 'e') {
            setShowAllMessages(previous => !previous);
        }
        else if (key.return && showPill) {
            handle?.scrollToBottom();
        }
    });
    // Working-activity line (spinner slot): context-pressure prefix shares the
    // StatusLine thresholds (amber ≥ 80, red ≥ 95).
    const activityWarnPct = contextPressurePct(channel.lastUsage, channel.contextWindow);
    /** Prompt input is inert while a modal dialog owns the keyboard. */
    const promptSelectionActive = selectionActive || modelPickerOpen || resumePickerOpen || activityPickerOpen ||
        thinkingOpen || historyOpen || rewindOpen || searchOpen;
    return (_jsxs(Box, { flexDirection: "column", flexGrow: 1, width: "100%", children: [!isSticky && channel.lastUserText && (_jsx(StickyPromptHeader, { text: channel.lastUserText, onClick: () => {
                    // Click jumps back to the pinned prompt (CC's StickyPromptHeader).
                    const lastUser = [...channel.rows].reverse().find(row => row.kind === 'user');
                    if (lastUser)
                        seekRow(lastUser.id);
                    else
                        handle?.scrollToBottom();
                } })), _jsxs(ScrollBox, { ref: setHandle, flexGrow: 1, flexShrink: 1, stickyScroll: true, children: [_jsx(LogoHeader, { model: channel.model, effort: channel.reasoningEffort, cwd: channel.cwd }), _jsx(MessageList, { rows: channel.rows, expanded: expanded, expandedRows: expandedRows, selectedId: selectionActive ? selectedId : null, onToggleRow: toggleRowExpanded, model: channel.model, showAll: showAllMessages, thinkingVisible: thinkingVisible, onToggleAll: () => { setShowAllMessages(previous => !previous); }, onLoadOlder: () => channel.loadOlder(), registerRowRef: registerRowRef, scrollHandle: handle, forceMountRowId: forceMountRowId })] }), showPill && (_jsx(NewMessagesPill, { count: newCount, onClick: () => handle?.scrollToBottom() })), channel.working &&
                (channel.activityEnabled &&
                    channel.workingActivity !== undefined &&
                    channel.workingActivity.line !== '' &&
                    channel.workingActivity.phase !== 'idle' ? (_jsx(Box, { marginTop: 1, children: _jsx(ActivityLine, { activity: channel.workingActivity, activityFrames: channel.activityFrames, warnPct: activityWarnPct, warnDanger: activityWarnPct !== undefined && activityWarnPct >= 95, suffix: ` · ↓ ${channel.responseChars} tokens` }) })) : (_jsx(WorkingSpinner, { mode: channel.spinnerMode, hasActiveTools: channel.activeToolCount > 0, responseLengthRef: responseLengthRef, loadingStartTimeRef: loadingStartTimeRef, totalPausedMsRef: totalPausedMsRef, pauseStartTimeRef: pauseStartTimeRef, thinkingStatus: thinkingStatus }))), thinkingOpen && (_jsx(ThinkingToggle, { currentValue: thinkingVisible, focusIndex: thinkingFocus, confirmationPending: thinkingConfirm })), resumePickerOpen && resumeSessions.length > 0 && (_jsx(Box, { flexDirection: "column", marginTop: 1, children: _jsx(ResumePicker, { sessions: resumeSessions, focusIndex: resumeIndex, currentSessionId: channel.agentId }) })), modelPickerOpen && (_jsx(Box, { flexDirection: "column", marginTop: 1, children: models.length === 0 ? (_jsx(ModelPickerLoading, {})) : (_jsx(ModelPicker, { models: models, focusIndex: modelIndex, currentModel: channel.model })) })), activityPickerOpen && (_jsx(Box, { flexDirection: "column", marginTop: 1, children: _jsx(ActivityPicker, { focusIndex: activityIndex, currentPreset: channel.activityFrames }) })), historyOpen && (_jsx(Box, { flexDirection: "column", marginTop: 1, children: _jsx(HistorySearchDialog, { query: historyQuery, cursorOffset: historyCursor, matches: historyMatches, focusIndex: historyFocus }) })), rewindOpen && (_jsx(Box, { flexDirection: "column", marginTop: 1, children: _jsx(RewindPicker, { rows: rewindRows, focusIndex: rewindIndex, confirmRow: rewindConfirm }) })), searchOpen && _jsx(TranscriptSearchBar, { query: searchQuery, cursorOffset: searchCursor, count: searchCount, current: searchCurrent }), _jsx(GoalTodoPanel, { channel: channel }), questionSnapshot !== null && (_jsx(AskUserQuestionPanel, { question: questionSnapshot.question, position: questionSnapshot.position, total: questionSnapshot.total, answered: questionSnapshot.answered, onAnswer: selection => questionStore.answerCurrent(selection), onCancel: () => questionStore.cancelCurrent() }, questionSnapshot.key)), questionSnapshot === null && (_jsx(PromptInput, { channel: channel, helpOpen: helpOpen, onToggleHelp: () => { setHelpOpen(previous => !previous); }, onRunCommand: runCommand, selectionActive: promptSelectionActive, fillText: historyFill, onFillConsumed: () => { setHistoryFill(null); }, onRewindRequest: openRewind })), _jsx(StatusLine, { channel: channel, selectionActive: selectionActive, helpOpen: helpOpen })] }));
}
/**
 * The pinned prompt header shown above the ScrollBox while the user has
 * scrolled up (ported from the leak's FullscreenLayout.StickyPromptHeader).
 * Fixed at 1 row so the ScrollBox never shifts when the text changes.
 */
function StickyPromptHeader({ text, onClick, }) {
    const [hover, setHover] = React.useState(false);
    return (_jsx(Box, { flexShrink: 0, width: "100%", height: 1, paddingRight: 1, backgroundColor: hover ? 'userMessageBackgroundHover' : 'userMessageBackground', onMouseEnter: () => { setHover(true); }, onMouseLeave: () => { setHover(false); }, onClick: onClick, children: _jsxs(Text, { color: "subtle", wrap: "truncate-end", children: [POINTER, " ", text] }) }));
}
/** The `↓ N new messages` pill shown while scrolled up with new content. */
function NewMessagesPill({ count, onClick, }) {
    const [hover, setHover] = React.useState(false);
    return (_jsx(Box, { paddingX: 2, paddingTop: 1, children: _jsx(Box, { backgroundColor: hover ? 'userMessageBackgroundHover' : 'background', onClick: onClick, onMouseEnter: () => { setHover(true); }, onMouseLeave: () => { setHover(false); }, children: _jsxs(Text, { color: "inverseText", bold: true, children: [' ', "\u2193 ", count === 1 ? '1 new message' : `${count} new messages`, ' '] }) }) }));
}
/** /model while the provider catalog is still loading (CC's LoadingState). */
function ModelPickerLoading() {
    return (_jsx(Pane, { color: "permission", children: _jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { bold: true, color: "permission", children: "Model" }), _jsx(LoadingState, { message: "Loading models", bold: true, subtitle: "Querying the provider\u2026" })] }) }));
}
/**
 * The `/` incsearch bar (ported from CC's REPL TranscriptSearchBar): a
 * single row above the prompt input with the query, a block cursor, and the
 * match counter (`current/count`) or a red `no matches` when nothing hits.
 */ function TranscriptSearchBar({ query, cursorOffset, count, current, }) {
    const cursorChar = cursorOffset < query.length ? query[cursorOffset] : ' ';
    return (_jsxs(NoSelect, { borderTopDimColor: true, borderBottom: false, borderLeft: false, borderRight: false, borderStyle: "single", marginTop: 1, paddingLeft: 2, width: "100%", children: [_jsx(Text, { children: "/" }), _jsx(Text, { children: query.slice(0, cursorOffset) }), _jsx(Text, { inverse: true, children: cursorChar }), cursorOffset < query.length && _jsx(Text, { children: query.slice(cursorOffset + 1) }), _jsx(Box, { flexGrow: 1 }), query && count === 0 ? (_jsx(Text, { color: "error", children: "no matches " })) : count > 0 ? (_jsxs(Text, { dimColor: true, children: [Math.min(current + 1, count), "/", count, '  '] })) : null] }));
}
//# sourceMappingURL=Chat.js.map